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

function numQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function makeCheckinRouter(db: Database.Database): Hono {
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
  r.get('/checkin', requireAuth, requireAdmin, (c) => {
    const facilityId = c.req.query('facility') || undefined;
    const from = numQuery(c.req.query('from'));
    const to = numQuery(c.req.query('to'));
    return c.json({ items: listAttendance(db, { facilityId, from, to }) });
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
