// /api/reservations — 予約の作成 / 一覧 / 更新 / キャンセル。
//
// 予約は本人が行う (Cernere identity から owner を確定)。 作成・時刻変更時に
// 同一施設 × 時間帯の重複を検知して 409。 重複可フラグ付き施設はスキップ。
// キャンセルは本人 or admin。 時刻は分単位に丸める (秒切り捨て、 §3.4)。

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { getIdentity, requireAuth } from '../auth.ts';
import {
  cancelReservation,
  createReservation,
  findConflicts,
  getFacilityCache,
  getReservation,
  getUserDisplay,
  listReservations,
  listReservationsForUser,
  updateReservation,
  upsertFacilityCache,
  type ReservationRow,
} from '../db.ts';
import type { FacilitySource } from '../facility/source.ts';

const MINUTE_MS = 60_000;

/** ISO 8601 文字列 → epoch ms (分丸め)。 不正なら null。 */
function parseMinute(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

interface ReservationView extends ReservationRow {
  facility_name: string | null;
  owner_display_name: string | null;
}

function decorate(
  db: Database.Database,
  rows: ReservationRow[],
): ReservationView[] {
  return rows.map((row) => ({
    ...row,
    facility_name: getFacilityCache(db, row.facility_id)?.display_name ?? null,
    owner_display_name: getUserDisplay(db, row.owner_user_id),
  }));
}

/** 施設を source から取得し cache へ同期。 allow_overlap は cache の値を返す。 */
async function resolveFacility(
  db: Database.Database,
  source: FacilitySource,
  facilityId: string,
): Promise<{ exists: boolean; allowOverlap: boolean }> {
  const facility = await source.getFacility(facilityId);
  if (!facility) return { exists: false, allowOverlap: false };
  upsertFacilityCache(db, {
    facilityId: facility.id,
    displayName: facility.name,
    source: source.sourceName,
    allowOverlap: facility.allowOverlap === true,
    rawJson: JSON.stringify(facility),
  });
  const cached = getFacilityCache(db, facilityId);
  return { exists: true, allowOverlap: (cached?.allow_overlap ?? 0) === 1 };
}

export function makeReservationRouter(
  db: Database.Database,
  source: FacilitySource,
): Hono {
  const r = new Hono();

  // 予約一覧 (期間 + 施設 filter)
  r.get('/', requireAuth, (c) => {
    const facilityId = c.req.query('facility') || undefined;
    const from = parseMinute(c.req.query('from')) ?? undefined;
    const to = parseMinute(c.req.query('to')) ?? undefined;
    const rows = listReservations(db, { facilityId, from, to });
    return c.json({ items: decorate(db, rows) });
  });

  // 自分の予約
  r.get('/mine', requireAuth, (c) => {
    const id = getIdentity(c);
    const rows = listReservationsForUser(db, id.userId);
    return c.json({ items: decorate(db, rows) });
  });

  // 新規予約 (重複検知 → confirmed)
  r.post('/', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { facilityId?: string; startAt?: string; endAt?: string; purpose?: string }
      | null;
    if (!body) return c.json({ error: 'bad_json' }, 400);

    const facilityId = body.facilityId;
    if (!facilityId) {
      return c.json({ error: 'bad_request', code: 'facilityId required' }, 400);
    }
    const startAt = parseMinute(body.startAt);
    const endAt = parseMinute(body.endAt);
    if (startAt === null || endAt === null) {
      return c.json({ error: 'bad_request', code: 'startAt/endAt invalid' }, 400);
    }
    if (startAt >= endAt) {
      return c.json({ error: 'bad_request', code: 'startAt must precede endAt' }, 400);
    }

    const facility = await resolveFacility(db, source, facilityId);
    if (!facility.exists) return c.json({ error: 'facility_not_found' }, 404);

    if (!facility.allowOverlap) {
      const conflicts = findConflicts(db, facilityId, startAt, endAt);
      if (conflicts.length > 0) {
        return c.json(
          { error: 'reservation_conflict', code: 'RESERVATION_CONFLICT', conflicts },
          409,
        );
      }
    }

    const id = getIdentity(c);
    const reservation = createReservation(db, {
      facilityId,
      ownerUserId: id.userId,
      startAt,
      endAt,
      purpose: typeof body.purpose === 'string' ? body.purpose : '',
      state: 'confirmed',
    });
    return c.json({ reservation: decorate(db, [reservation])[0] }, 201);
  });

  // 時刻 / 目的の修正 (本人のみ)
  r.patch('/:id', requireAuth, async (c) => {
    const id = getIdentity(c);
    const reservationId = c.req.param('id');
    const current = getReservation(db, reservationId);
    if (!current || current.state === 'cancelled') {
      return c.json({ error: 'not_found' }, 404);
    }
    if (current.owner_user_id !== id.userId) {
      return c.json({ error: 'forbidden', code: 'owner only' }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as
      | { startAt?: string; endAt?: string; purpose?: string }
      | null;
    if (!body) return c.json({ error: 'bad_json' }, 400);

    const startAt = body.startAt === undefined ? current.start_at : parseMinute(body.startAt);
    const endAt = body.endAt === undefined ? current.end_at : parseMinute(body.endAt);
    if (startAt === null || endAt === null) {
      return c.json({ error: 'bad_request', code: 'startAt/endAt invalid' }, 400);
    }
    if (startAt >= endAt) {
      return c.json({ error: 'bad_request', code: 'startAt must precede endAt' }, 400);
    }

    // 時刻が変わるなら重複再検知
    if (startAt !== current.start_at || endAt !== current.end_at) {
      const facility = await resolveFacility(db, source, current.facility_id);
      if (!facility.allowOverlap) {
        const conflicts = findConflicts(
          db, current.facility_id, startAt, endAt, reservationId,
        );
        if (conflicts.length > 0) {
          return c.json(
            { error: 'reservation_conflict', code: 'RESERVATION_CONFLICT', conflicts },
            409,
          );
        }
      }
    }

    const updated = updateReservation(db, reservationId, {
      startAt,
      endAt,
      purpose: body.purpose,
    });
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ reservation: decorate(db, [updated])[0] });
  });

  // キャンセル (本人 or admin)
  r.delete('/:id', requireAuth, (c) => {
    const id = getIdentity(c);
    const reservationId = c.req.param('id');
    const current = getReservation(db, reservationId);
    if (!current || current.state === 'cancelled') {
      return c.json({ error: 'not_found' }, 404);
    }
    if (current.owner_user_id !== id.userId && !id.isAdmin) {
      return c.json({ error: 'forbidden', code: 'owner or admin only' }, 403);
    }
    const cancelled = cancelReservation(db, reservationId);
    if (!cancelled) return c.json({ error: 'not_found' }, 404);
    return c.json({ reservation: decorate(db, [cancelled])[0] });
  });

  return r;
}
