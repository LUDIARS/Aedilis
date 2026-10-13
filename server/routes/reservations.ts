import { filterAsync } from '../lib/async-collection.ts';
import { prepare, transaction, type DatabaseInput } from '../persistence/database.ts';
// /api/reservations — 予約の作成 / 一覧 / 更新 / キャンセル。
//
// 予約は本人が行う (Cernere identity から owner を確定)。 作成・時刻変更時に
// 同一施設 × 時間帯の重複を検知して 409。 重複可フラグ付き施設はスキップ。
// キャンセルは本人 or admin。 時刻は分単位に丸める (秒切り捨て、 §3.4)。
import { Hono } from 'hono';
import { bookingPrincipal } from '../booking-access/request.ts';
import { ensureBookingAccessSchema, readAudience, parseAudience, saveAudience, canReadBooking } from '../booking-access/policy.ts';
import { getIdentity, requireAuth } from '../auth.ts';
import { cancelReservation, createReservation, findConflicts, getFacilityCache, getReservation, getUserDisplay, listReservations, listReservationsForUser, updateReservation, upsertFacilityCache, type ReservationRow, } from '../db.ts';
import type { FacilitySource } from '../facility/source.ts';
const MINUTE_MS = 60000;
class ReservationConflict extends Error {}
class ReservationRangeError extends Error {}
/** ISO 8601 文字列 → epoch ms (分丸め)。 不正なら null。 */
function parseMinute(value: unknown): number | null {
    if (typeof value !== 'string')
        return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms))
        return null;
    return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}
interface ReservationView extends ReservationRow {
    facility_name: string | null;
    owner_display_name: string | null;
}
async function decorate(db: DatabaseInput, rows: ReservationRow[]): Promise<ReservationView[]> {
    return (await Promise.all(rows.map(async (row) => ({
        ...row,
        ...(await readAudience(db, 'reservation', row.id)),
        meeting_id: ((await prepare(db, 'SELECT meeting_id FROM meeting_facility_reservation WHERE reservation_id=?').get(row.id)) as {
            meeting_id: string;
        } | undefined)?.meeting_id ?? null,
        facility_name: (await getFacilityCache(db, row.facility_id))?.display_name ?? null,
        owner_display_name: (await getUserDisplay(db, row.owner_user_id)),
    }))));
}
/** 施設を source から取得し cache へ同期。 allow_overlap は cache の値を返す。 */
async function resolveFacility(db: DatabaseInput, source: FacilitySource, facilityId: string): Promise<{
    exists: boolean;
    allowOverlap: boolean;
}> {
    const facility = await source.getFacility(facilityId);
    if (!facility)
        return { exists: false, allowOverlap: false };
    (await upsertFacilityCache(db, {
        facilityId: facility.id,
        displayName: facility.name,
        source: source.sourceName,
        allowOverlap: facility.allowOverlap === true,
        rawJson: JSON.stringify(facility),
    }));
    const cached = (await getFacilityCache(db, facilityId));
    return { exists: true, allowOverlap: (cached?.allow_overlap ?? 0) === 1 };
}
export function makeReservationRouter(db: DatabaseInput, source: FacilitySource): Hono {
    ensureBookingAccessSchema(db);
    const r = new Hono();
    r.use('*', async (c, next) => { c.header('cache-control', 'private, no-store'); await next(); });
    r.onError((error, c) => {
        if (error instanceof ReservationConflict) return c.json({ error: 'reservation_conflict', code: 'RESERVATION_CONFLICT' }, 409);
        if (error instanceof ReservationRangeError) return c.json({ error: 'bad_request', code: 'startAt must precede endAt' }, 400);
        return c.json({ error: 'booking_access_unavailable' }, 503);
    });
    r.get('/capabilities', requireAuth, c => c.json({ groupContextVersion: 1 }));
    // Existing bookings without an explicit Public policy are not newly exposed anonymously.
    r.get('/public', async (c) => {
        const decorated = await transaction(db, async () => {
          const items = (await filterAsync((await listReservations(db, {})), async (row) => {
            const policy = (await prepare(db, 'SELECT visibility FROM booking_audience WHERE resource_type=? AND resource_id=?').get('reservation', row.id)) as {
                visibility?: string;
            } | undefined;
            return policy?.visibility === 'public';
          }));
          return decorate(db, items);
        })();
        return c.json({ items: decorated.map(({ owner_user_id: _owner, owner_display_name: _name, ...item }) => item) });
    });
    // 予約一覧 (期間 + 施設 filter)
    r.get('/', requireAuth, async (c) => {
        const facilityId = c.req.query('facility') || undefined;
        const from = parseMinute(c.req.query('from')) ?? undefined;
        const to = parseMinute(c.req.query('to')) ?? undefined;
        const principal = await bookingPrincipal(c);
        const items = await transaction(db, async () => {
          const rows = await listReservations(db, { facilityId, from, to });
          const visible = await filterAsync(rows, async row => canReadBooking(await readAudience(db, 'reservation', row.id), principal, row.owner_user_id === principal.userId));
          return decorate(db, visible);
        })();
        return c.json({ items });
    });
    // 自分の予約
    r.get('/mine', requireAuth, async (c) => {
        const id = getIdentity(c);
        const rows = (await listReservationsForUser(db, id.userId));
        return c.json({ items: (await decorate(db, rows)) });
    });
    // 新規予約 (重複検知 → confirmed)
    r.post('/', requireAuth, async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            facilityId?: string;
            startAt?: string;
            endAt?: string;
            purpose?: string;
            visibility?: unknown;
            group?: unknown;
        } | null;
        if (!body)
            return c.json({ error: 'bad_json' }, 400);
        const principal = await bookingPrincipal(c);
        let audience;
        try {
            audience = parseAudience(body, principal);
        }
        catch {
            return c.json({ error: 'invalid_booking_audience' }, 403);
        }
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
        if (!facility.exists)
            return c.json({ error: 'facility_not_found' }, 404);
        if (!facility.allowOverlap) {
            const conflicts = (await findConflicts(db, facilityId, startAt, endAt));
            if (conflicts.length > 0) {
                return c.json({ error: 'reservation_conflict', code: 'RESERVATION_CONFLICT' }, 409);
            }
        }
        const id = getIdentity(c);
        const reservation = (await transaction(db, async () => {
            // Recheck under the transaction's cross-process lock; the preflight above is only a fast rejection.
            const currentFacility = await getFacilityCache(db, facilityId);
            if (!currentFacility?.allow_overlap && (await findConflicts(db, facilityId, startAt, endAt)).length) throw new ReservationConflict();
            const created = (await createReservation(db, {
                facilityId,
                ownerUserId: id.userId,
                startAt,
                endAt,
                purpose: typeof body.purpose === 'string' ? body.purpose : '',
                state: 'confirmed',
            }));
            (await saveAudience(db, 'reservation', created.id, audience));
            return created;
        })());
        return c.json({ reservation: (await decorate(db, [reservation]))[0] }, 201);
    });
    // 時刻 / 目的の修正 (本人のみ)
    r.patch('/:id', requireAuth, async (c) => {
        const id = getIdentity(c);
        const reservationId = c.req.param('id');
        if ((await prepare(db, 'SELECT 1 FROM meeting_facility_reservation WHERE reservation_id=?').get(reservationId)))
            return c.json({ error: 'manage_reservation_from_meeting' }, 409);
        const current = (await getReservation(db, reservationId));
        if (!current || current.state === 'cancelled') {
            return c.json({ error: 'not_found' }, 404);
        }
        if (current.owner_user_id !== id.userId) {
            return c.json({ error: 'forbidden', code: 'owner only' }, 403);
        }
        const body = (await c.req.json().catch(() => null)) as {
            startAt?: string;
            endAt?: string;
            purpose?: string;
            visibility?: unknown;
            group?: unknown;
        } | null;
        if (!body)
            return c.json({ error: 'bad_json' }, 400);
        const principal = await bookingPrincipal(c);
        let audience;
        try {
            audience = parseAudience(body, principal, (await readAudience(db, 'reservation', reservationId)));
        }
        catch {
            return c.json({ error: 'invalid_booking_audience' }, 403);
        }
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
                const conflicts = (await findConflicts(db, current.facility_id, startAt, endAt, reservationId));
                if (conflicts.length > 0) {
                    return c.json({ error: 'reservation_conflict', code: 'RESERVATION_CONFLICT' }, 409);
                }
            }
        }
        const updated = (await transaction(db, async () => {
            const latest = await getReservation(db, reservationId);
            if (!latest || latest.state === 'cancelled') return null;
            const lockedStart = body.startAt === undefined ? latest.start_at : startAt;
            const lockedEnd = body.endAt === undefined ? latest.end_at : endAt;
            if (lockedStart >= lockedEnd) throw new ReservationRangeError();
            const currentFacility = await getFacilityCache(db, latest.facility_id);
            if (!currentFacility?.allow_overlap && (await findConflicts(db, latest.facility_id, lockedStart, lockedEnd, reservationId)).length) throw new ReservationConflict();
            const result = (await updateReservation(db, reservationId, {
                startAt: lockedStart,
                endAt: lockedEnd,
                purpose: body.purpose,
            }));
            if (result)
                (await saveAudience(db, 'reservation', reservationId, audience));
            return result;
        })());
        if (!updated)
            return c.json({ error: 'not_found' }, 404);
        return c.json({ reservation: (await decorate(db, [updated]))[0] });
    });
    // キャンセル (本人 or admin)
    r.delete('/:id', requireAuth, async (c) => {
      return transaction(db, async () => {
        const id = getIdentity(c);
        const reservationId = c.req.param('id');
        if ((await prepare(db, 'SELECT 1 FROM meeting_facility_reservation WHERE reservation_id=?').get(reservationId)))
            return c.json({ error: 'manage_reservation_from_meeting' }, 409);
        const current = (await getReservation(db, reservationId));
        if (!current || current.state === 'cancelled') {
            return c.json({ error: 'not_found' }, 404);
        }
        if (current.owner_user_id !== id.userId && !id.isAdmin) {
            return c.json({ error: 'forbidden', code: 'owner or admin only' }, 403);
        }
        const cancelled = (await cancelReservation(db, reservationId));
        if (!cancelled)
            return c.json({ error: 'not_found' }, 404);
        return c.json({ reservation: current.owner_user_id === id.userId ? (await decorate(db, [cancelled]))[0] : { id: cancelled.id, state: cancelled.state } });
      })();
    });
    return r;
}
