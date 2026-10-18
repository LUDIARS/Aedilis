import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { openDb, upsertFacilityCache } from '../server/db.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { MeetingRepository } from '../server/meetings/repository.ts';
import { finalizeForGlab } from '../server/meetings/glab-handoff.ts';
import { saveAudience } from '../server/booking-access/policy.ts';
import type { Actor, MeetingInput } from '../server/meetings/types.ts';
import { makeMeetingRouter } from '../server/meetings/routes.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }));
vi.mock('../server/auth.ts', () => ({ readIdentity: async () => null }));

describe('GLAB handoff invariants', () => {
  it('does not expose the export or cancellation mutation to anonymous share-page users', async () => {
    const db = openDb(':memory:');
    try {
      migrateMeetings(db);
      db.prepare('INSERT INTO meeting_identity(id,user_id,created_at) VALUES(?,?,?)').run('host', 'user', 1);
      const identity = { id: 'host', user_id: 'user', notify: 0 };
      const actor: Actor = { userId: 'user', current: identity, identities: [identity] };
      const id = await new MeetingRepository(db).create({ title: 'Public poll', description: '', organizerName: 'Host',
        onlineAllowed: false, guestResponses: true, venues: [],
        slots: [{ id: 'slot', venue: '', startAt: '2026-10-20T01:00:00Z', endAt: '2026-10-20T02:00:00Z' }] }, actor);
      await saveAudience(db, 'meeting', id, { visibility: 'public', group: null });
      const app = new Hono().route('/api/meetings', makeMeetingRouter(db, {
        publicUrl: 'https://ae.test', cernereUrl: 'https://cr.test', cernerePublicUrl: '', googleClientId: '',
        discordToken: null, notificationIntervalMs: 1000, notificationMaxAttempts: 1,
      }, {} as CernereProjectClient));
      for (const operation of ['finalize', 'cancel']) {
        const response = await app.request(`/api/meetings/${id}/glab-event/${operation}`, { method: 'POST',
          headers: { origin: 'https://ae.test', 'content-type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(403);
      }
    } finally { db.close(); }
  });
  it('reuses a single reservation across retries, freezes edits, and refuses a cancelled handoff', async () => {
    const db = openDb(':memory:');
    try {
      migrateMeetings(db);
      const repo = new MeetingRepository(db);
      db.prepare('INSERT INTO meeting_identity(id,user_id,created_at) VALUES(?,?,?)').run('host', 'user', 1);
      const identity = { id: 'host', user_id: 'user', notify: 0 };
      const actor: Actor = { userId: 'user', current: identity, identities: [identity] };
      await upsertFacilityCache(db, { facilityId: 'room', displayName: 'Room', source: 'test', allowOverlap: false, rawJson: '{}' });
      const input: MeetingInput = { title: 'Class', description: '', organizerName: 'Host', onlineAllowed: false,
        guestResponses: true, venues: [{ name: 'Room', facilityId: 'room', busy: [] }],
        slots: [{ id: 'first', venue: 'Room', startAt: '2026-10-20T01:00:00Z', endAt: '2026-10-20T02:00:00Z' }] };
      const id = await repo.create(input, actor);
      await saveAudience(db, 'meeting', id, { visibility: 'private', group: null });
      await expect(finalizeForGlab(db, id, 'first', 1, actor)).rejects.toThrow('Public');
      expect((await repo.get(id)).state).toBe('open');
      await saveAudience(db, 'meeting', id, { visibility: 'public', group: null });
      const results = await Promise.all([finalizeForGlab(db, id, 'first', 1, actor), finalizeForGlab(db, id, 'first', 1, actor)]);
      expect(results[0]).toEqual(results[1]);
      expect(db.prepare('SELECT count(*) AS n FROM reservation').get()).toEqual({ n: 1 });
      await expect(repo.update(id, input, 2, actor)).rejects.toThrow('GLAB');
      await expect(repo.cancel(id, 2, actor)).rejects.toThrow('GLAB');
      await expect(finalizeForGlab(db, id, 'other', 2, actor)).rejects.toThrow('別の日程');
      await expect(finalizeForGlab(db, id, 'first', 2, { userId: 'other', identities: [], current: null })).rejects.toThrow('権限');
      await repo.cancel(id, 2, actor, true);
      await expect(finalizeForGlab(db, id, 'first', 2, actor)).rejects.toThrow('中止');
      expect(db.prepare('SELECT state FROM reservation').get()).toEqual({ state: 'cancelled' });
    } finally { db.close(); }
  });
});
