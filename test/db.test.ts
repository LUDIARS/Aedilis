// db.ts のユニットテスト — 予約台帳の永続層ロジック。
// in-memory SQLite で完結する (Cernere / ネットワーク不要)。
import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { cancelReservation, createReservation, findConflicts, getFacilityCache, getReservation, getUserDisplay, listReservations, listReservationsForUser, openDb, setFacilityOverlap, updateReservation, upsertFacilityCache, upsertUserDisplay, } from '../server/db.ts';
let db: Database.Database;
beforeEach(() => {
    db = openDb(':memory:');
});
/** 分 → epoch ms。 テストの可読性用 (予約時刻は分丸めされる)。 */
const t = (min: number): number => min * 60000;
async function makeReservation(facilityId: string, startMin: number, endMin: number, owner = 'user-1') {
    return (await createReservation(db, {
        facilityId,
        ownerUserId: owner,
        startAt: t(startMin),
        endAt: t(endMin),
        purpose: 'test',
        state: 'confirmed',
    }));
}
describe('schema', () => {
    it('creates the expected tables', async () => {
        const tables = (await db
            .prepare<[
        ], {
            name: string;
        }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all()).map((r) => r.name);
        expect(tables).toContain('facility_cache');
        expect(tables).toContain('reservation');
        expect(tables).toContain('user_display_cache');
    });
});
describe('facility cache', () => {
    async function upsert(id: string, allowOverlap: boolean) {
        (await upsertFacilityCache(db, {
            facilityId: id,
            displayName: `Facility ${id}`,
            source: 'local',
            allowOverlap,
            rawJson: '{}',
        }));
    }
    it('upserts and reads a facility', async () => {
        (await upsert('room-a', false));
        expect((await getFacilityCache(db, 'room-a'))?.display_name).toBe('Facility room-a');
    });
    it('keeps allow_overlap authority on re-upsert', async () => {
        // 起動同期 (upsert) は allow_overlap を上書きしない — admin トグルが権威。
        (await upsert('room-a', true));
        expect((await getFacilityCache(db, 'room-a'))?.allow_overlap).toBe(1);
        (await upsert('room-a', false));
        expect((await getFacilityCache(db, 'room-a'))?.allow_overlap).toBe(1);
    });
    it('toggles the overlap flag via setFacilityOverlap', async () => {
        (await upsert('room-a', false));
        expect((await setFacilityOverlap(db, 'room-a', true))).toBe(true);
        expect((await getFacilityCache(db, 'room-a'))?.allow_overlap).toBe(1);
        (await setFacilityOverlap(db, 'room-a', false));
        expect((await getFacilityCache(db, 'room-a'))?.allow_overlap).toBe(0);
    });
    it('returns false when toggling an unknown facility', async () => {
        expect((await setFacilityOverlap(db, 'no-such-room', true))).toBe(false);
    });
    it('returns null for an uncached facility', async () => {
        expect((await getFacilityCache(db, 'never-seen'))).toBeNull();
    });
});
describe('reservation CRUD', () => {
    it('creates and reads a reservation', async () => {
        const r = (await makeReservation('room-a', 10, 11));
        const fetched = (await getReservation(db, r.id));
        expect(fetched?.id).toBe(r.id);
        expect(fetched?.state).toBe('confirmed');
        expect(fetched?.facility_id).toBe('room-a');
    });
    it('updates start/end times', async () => {
        const r = (await makeReservation('room-a', 10, 11));
        const updated = (await updateReservation(db, r.id, {
            startAt: t(20),
            endAt: t(21),
        }));
        expect(updated?.start_at).toBe(t(20));
        expect(updated?.end_at).toBe(t(21));
    });
    it('returns null when updating a missing reservation', async () => {
        expect((await updateReservation(db, 'no-such-id', { purpose: 'x' }))).toBeNull();
    });
    it('returns null when updating a cancelled reservation', async () => {
        const r = (await makeReservation('room-a', 10, 11));
        (await cancelReservation(db, r.id));
        expect((await updateReservation(db, r.id, { purpose: 'x' }))).toBeNull();
    });
    it('cancels a reservation', async () => {
        const r = (await makeReservation('room-a', 10, 11));
        expect((await cancelReservation(db, r.id))?.state).toBe('cancelled');
    });
    it('returns null when cancelling an already-cancelled reservation', async () => {
        const r = (await makeReservation('room-a', 10, 11));
        (await cancelReservation(db, r.id));
        expect((await cancelReservation(db, r.id))).toBeNull();
    });
});
describe('findConflicts — overlap detection', () => {
    it('detects an overlapping reservation', async () => {
        (await makeReservation('room-a', 10, 12));
        expect((await findConflicts(db, 'room-a', t(11), t(13)))).toHaveLength(1);
    });
    it('treats adjacent intervals as non-conflicting', async () => {
        // [10,12) と [12,14) は端が接するだけ — 重ならない。
        (await makeReservation('room-a', 10, 12));
        expect((await findConflicts(db, 'room-a', t(12), t(14)))).toHaveLength(0);
    });
    it('ignores reservations on a different facility', async () => {
        (await makeReservation('room-a', 10, 12));
        expect((await findConflicts(db, 'room-b', t(10), t(12)))).toHaveLength(0);
    });
    it('ignores cancelled reservations', async () => {
        const r = (await makeReservation('room-a', 10, 12));
        (await cancelReservation(db, r.id));
        expect((await findConflicts(db, 'room-a', t(11), t(13)))).toHaveLength(0);
    });
    it('excludes the reservation named by excludeId', async () => {
        // 自分自身の時刻変更で「自分と衝突」と誤検知しないこと。
        const r = (await makeReservation('room-a', 10, 12));
        expect((await findConflicts(db, 'room-a', t(10), t(12), r.id))).toHaveLength(0);
    });
});
describe('listReservations', () => {
    it('filters by facility', async () => {
        (await makeReservation('room-a', 10, 12));
        (await makeReservation('room-b', 10, 12));
        const rows = (await listReservations(db, { facilityId: 'room-a' }));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.facility_id).toBe('room-a');
    });
    it('filters by time window', async () => {
        (await makeReservation('room-a', 10, 12));
        const later = (await makeReservation('room-a', 100, 102));
        const rows = (await listReservations(db, { from: t(50), to: t(200) }));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(later.id);
    });
    it('excludes cancelled reservations', async () => {
        const r = (await makeReservation('room-a', 10, 12));
        (await cancelReservation(db, r.id));
        expect((await listReservations(db, {}))).toHaveLength(0);
    });
});
describe('listReservationsForUser', () => {
    it('returns only the given user reservations', async () => {
        (await makeReservation('room-a', 10, 12, 'alice'));
        (await makeReservation('room-a', 20, 22, 'bob'));
        const rows = (await listReservationsForUser(db, 'alice'));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.owner_user_id).toBe('alice');
    });
    it('excludes cancelled reservations', async () => {
        const r = (await makeReservation('room-a', 10, 12, 'alice'));
        (await cancelReservation(db, r.id));
        expect((await listReservationsForUser(db, 'alice'))).toHaveLength(0);
    });
});
describe('user display cache', () => {
    it('upserts and reads a display name', async () => {
        (await upsertUserDisplay(db, 'alice', 'Alice'));
        expect((await getUserDisplay(db, 'alice'))).toBe('Alice');
    });
    it('updates the name on re-upsert', async () => {
        (await upsertUserDisplay(db, 'alice', 'Alice'));
        (await upsertUserDisplay(db, 'alice', 'Alice Cooper'));
        expect((await getUserDisplay(db, 'alice'))).toBe('Alice Cooper');
    });
    it('returns null for an unknown user', async () => {
        expect((await getUserDisplay(db, 'nobody'))).toBeNull();
    });
});
