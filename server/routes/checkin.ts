// /api/checkin/* + /api/admin/gateways — 出席チェックイン (CONTRACTS §4)。
//
// route は薄く保ち、 検証ロジックは server/checkin/ に置く。 このルーターは
// `/api` に mount する (内部で /checkin/* と /admin/gateways をまとめて定義)。

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { getIdentity, requireAdmin, requireAuth } from '../auth.ts';
import {
  listAttendance,
  listAttendanceForUser,
  listGateways,
  upsertGateway,
} from '../db.ts';
import { isValidPublicKeyPem } from '../checkin/attestation.ts';
import { processCheckin } from '../checkin/service.ts';
import type { VantanUserProfile } from '../lib/cernere-project-client.ts';

function numQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * makeCheckinRouter が必要とする最小のプロフィール取得インターフェース。
 * 具象クラス (CernereProjectClient) ではなくこの形に依存することで、
 * ルーター側はテスト時にフェイクを注入しやすく、 未接続でも動作を保てる。
 */
export interface VantanProfileLookup {
  getVantanUserProfile(userId: string): Promise<VantanUserProfile | null>;
}

/**
 * userId ごとに vantanProfiles.getVantanUserProfile を呼び、 見つかった分だけ
 * userId → profile の Map を返す。 個々の失敗 (未接続 / lookup エラー) は
 * warn ログのみで握りつぶす — 出席一覧が Cernere 障害で丸ごと 500 にならないように。
 */
async function fetchVantanProfiles(
  vantanProfiles: VantanProfileLookup | undefined,
  userIds: readonly string[],
): Promise<Map<string, VantanUserProfile>> {
  const result = new Map<string, VantanUserProfile>();
  if (!vantanProfiles) return result;
  const uniqueIds = Array.from(new Set(userIds));
  await Promise.all(
    uniqueIds.map(async (userId) => {
      try {
        const profile = await vantanProfiles.getVantanUserProfile(userId);
        if (profile) result.set(userId, profile);
      } catch (err) {
        console.warn(`[aedilis] vantan_user profile lookup failed for ${userId}: ${(err as Error).message}`);
      }
    }),
  );
  return result;
}

export function makeCheckinRouter(db: Database.Database, vantanProfiles?: VantanProfileLookup): Hono {
  const r = new Hono();

  // 出席チェックイン本体 — attestation を検証して記録する。
  r.post('/checkin/verify', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { attestation?: unknown }
      | null;
    if (!body || typeof body.attestation !== 'string' || !body.attestation) {
      return c.json({ error: 'bad_request', code: 'ATTESTATION_REQUIRED' }, 400);
    }
    const id = getIdentity(c);
    const result = processCheckin(db, body.attestation, id.userId);
    if (!result.ok) {
      return c.json({ error: result.error, code: result.code }, result.status);
    }
    return c.json({
      ok: true,
      attendanceId: result.attendanceId,
      matchedReservation: result.matchedReservation,
    });
  });

  // 自分の出席履歴
  r.get('/checkin/mine', requireAuth, (c) => {
    const id = getIdentity(c);
    return c.json({ items: listAttendanceForUser(db, id.userId) });
  });

  // 出席一覧 (admin) — ?facility=&from=&to=
  // vantanProfiles が渡されていれば各行に vantan_user のプロフィール
  // (department/grade/name/desiredJob) を enrich する。 未接続/lookup失敗時は
  // 該当行の vantanProfile が null になるだけで一覧自体は返す (fetchVantanProfiles 参照)。
  r.get('/checkin', requireAuth, requireAdmin, async (c) => {
    const facilityId = c.req.query('facility') || undefined;
    const from = numQuery(c.req.query('from'));
    const to = numQuery(c.req.query('to'));
    const rows = listAttendance(db, { facilityId, from, to });
    const profiles = await fetchVantanProfiles(vantanProfiles, rows.map((row) => row.user_id));
    const items = rows.map((row) => ({
      ...row,
      vantanProfile: profiles.get(row.user_id) ?? null,
    }));
    return c.json({ items });
  });

  // ゲートウェイ登録 (admin) — 公開鍵 PEM を upsert
  r.post('/admin/gateways', requireAuth, requireAdmin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { lanId?: unknown; publicKeyPem?: unknown; facilityId?: unknown; label?: unknown }
      | null;
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const { lanId, publicKeyPem, facilityId, label } = body;
    if (
      typeof lanId !== 'string' || !lanId ||
      typeof publicKeyPem !== 'string' || !publicKeyPem ||
      typeof facilityId !== 'string' || !facilityId
    ) {
      return c.json(
        { error: 'bad_request', code: 'lanId/publicKeyPem/facilityId required' },
        400,
      );
    }
    if (!isValidPublicKeyPem(publicKeyPem)) {
      return c.json({ error: 'bad_request', code: 'INVALID_PUBLIC_KEY' }, 400);
    }
    const gateway = upsertGateway(db, {
      lanId,
      publicKeyPem,
      facilityId,
      label: typeof label === 'string' ? label : '',
    });
    return c.json({ gateway });
  });

  // ゲートウェイ一覧 (admin)
  r.get('/admin/gateways', requireAuth, requireAdmin, (c) => {
    return c.json({ items: listGateways(db) });
  });

  return r;
}
