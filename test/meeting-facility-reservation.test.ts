import { describe, expect, it } from 'vitest';
import { openDb, upsertFacilityCache, createReservation, getReservation } from '../server/db.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { MeetingRepository } from '../server/meetings/repository.ts';
import { linkedReservation } from '../server/meetings/facility-reservation.ts';
import { saveAudience, readAudience } from '../server/booking-access/policy.ts';
import type { Actor, MeetingInput } from '../server/meetings/types.ts';
describe('finalized meeting facility booking', () => {
    it('reserves atomically, preserves privacy and releases on reopening', async () => {
        const db = openDb(':memory:');
        try {
            migrateMeetings(db);
            const repo = new MeetingRepository(db);
            (await db.prepare('INSERT INTO meeting_identity(id,user_id,created_at) VALUES(?,?,?)').run('host', 'user', 1));
            const identity = { id: 'host', user_id: 'user', notify: 0 };
            const actor: Actor = { userId: 'user', current: identity, identities: [identity] };
            (await upsertFacilityCache(db, { facilityId: 'room', displayName: 'Room', source: 'test', allowOverlap: false, rawJson: '{}' }));
            const input: MeetingInput = { title: 'Private meeting', description: '', organizerName: 'Host', onlineAllowed: false,
                venues: [{ name: 'Room', facilityId: 'room', busy: [] }],
                slots: [{ id: 'first', venue: 'Room', startAt: '2026-10-10T01:00:00Z', endAt: '2026-10-10T02:00:00Z' }] };
            const id = (await repo.create(input, actor));
            (await saveAudience(db, 'meeting', id, { visibility: 'private', group: null }));
            (await repo.finalize(id, 'first', 1, actor));
            const reservationId = (await linkedReservation(db, id));
            expect(reservationId).not.toBeNull();
            if (!reservationId)
                throw new Error('Missing linked reservation');
            expect((await getReservation(db, reservationId))?.state).toBe('confirmed');
            expect((await readAudience(db, 'reservation', reservationId)).visibility).toBe('private');
            (await expect((async () => (await repo.view(id, { userId: 'other', identities: [], current: null })))()).rejects.toThrow());
            (await repo.update(id, input, 2, actor));
            expect((await getReservation(db, reservationId))?.state).toBe('cancelled');
            (await createReservation(db, { facilityId: 'room', ownerUserId: 'other', startAt: Date.parse(input.slots[0]!.startAt),
                endAt: Date.parse(input.slots[0]!.endAt), purpose: 'Secret conflict', state: 'confirmed' }));
            (await expect((async () => (await repo.finalize(id, 'first', 3, actor)))()).rejects.toThrow('既に予約'));
            expect((await repo.get(id)).state).toBe('open');
            expect((await repo.get(id)).revision).toBe(3);
        }
        finally {
            db.close();
        }
    });
});
