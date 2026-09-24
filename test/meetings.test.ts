import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { MeetingRepository } from '../server/meetings/repository.ts';
import { deviceIdentity } from '../server/meetings/identity.ts';
import { meetingInput, responseInput } from '../server/meetings/validation.ts';
import type { Actor, MeetingInput, ResponseInput } from '../server/meetings/types.ts';

let db: Database.Database;
let repo: MeetingRepository;
let host: Actor, participant: Actor, stranger: Actor;
const draft: MeetingInput = {
  title: 'Meeting', description: '', organizerName: 'Host', onlineAllowed: false,
  slots: [{ id: 'slot-a', startAt: '2026-10-01T01:00:00.000Z', endAt: '2026-10-01T02:00:00.000Z', venue: 'Room' }],
  venues: [{ name: 'Room', busy: [] }],
};
const answer: ResponseInput = { name: 'Alex', comment: 'Hello', topic: 'Agenda', answers: { 'slot-a': 'yes' } };
function actor(id: string, userId: string | null = null, notify = 0): Actor {
  db.prepare('INSERT INTO meeting_identity VALUES(?,?,?,?)').run(id, userId, notify, Date.now());
  const identity = { id, user_id: userId, notify };
  return { identities: [identity], current: identity, userId };
}
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateMeetings(db);
  repo = new MeetingRepository(db);
  host = actor('host', 'cernere-host', 1); participant = actor('participant'); stranger = actor('stranger');
});
afterEach(() => db.close());

describe('meeting ownership and revisions', () => {
  it('rejects another browser changing or deleting an answer, even with the same name', () => {
    const id = repo.create(draft, host);
    repo.saveResponse(id, answer, null, null, 1, participant);
    const row = repo.responses(id)[0]; if (!row) throw new Error('missing answer');
    expect(() => repo.saveResponse(id, answer, row.id, 1, 1, stranger)).toThrow('編集権限');
    expect(() => repo.deleteResponse(id, row.id, 1, stranger)).toThrow('編集権限');
    expect(() => repo.cancel(id, 1, participant)).toThrow('編集権限');
    expect(repo.responses(id)).toHaveLength(1);
  });
  it('rejects stale edits and atomically invalidates answers to changed slots', () => {
    const id = repo.create(draft, host);
    repo.saveResponse(id, answer, null, null, 1, participant);
    const changed = { ...draft, slots: draft.slots.map(s => ({ ...s, endAt: '2026-10-01T03:00:00.000Z' })) };
    repo.update(id, changed, 1, host);
    expect(JSON.parse(repo.responses(id)[0]?.answers_json || 'null')).toEqual({});
    expect(() => repo.update(id, draft, 1, host)).toThrow('別の端末');
    expect(() => repo.saveResponse(id, answer, null, null, 1, stranger)).toThrow('別の端末');
  });
  it('allows another authenticated device with the linked identity to edit', () => {
    const id = repo.create(draft, host);
    repo.saveResponse(id, answer, null, null, 1, participant);
    db.prepare('UPDATE meeting_identity SET user_id=? WHERE id=?').run('linked-user', 'participant');
    const otherDevice: Actor = { userId: 'linked-user', current: null, identities: [{ id: 'participant', user_id: 'linked-user', notify: 0 }] };
    const row = repo.responses(id)[0]; if (!row) throw new Error('missing answer');
    repo.deleteResponse(id, row.id, 1, otherDevice);
    expect(repo.responses(id)).toHaveLength(0);
  });
  it('refuses a final venue collision and preserves meeting state', () => {
    const input = { ...draft, venues: [{ name: 'Room', busy: [{ startAt: '2026-10-01T01:30:00.000Z', endAt: '2026-10-01T02:30:00.000Z' }] }] };
    const id = repo.create(input, host);
    expect(() => repo.finalize(id, 'slot-a', 1, host)).toThrow('重複');
    expect(repo.get(id).state).toBe('open');
  });
  it('does not expose ownership or Cernere identifiers in the public response', () => {
    const id = repo.create(draft, host);
    repo.saveResponse(id, answer, null, null, 1, participant);
    const view = JSON.stringify(repo.view(id, stranger));
    expect(view).not.toContain('owner_id'); expect(view).not.toContain('cernere-host');
    expect(view).toContain('"canManage":false'); expect(view).toContain('"canEdit":false');
  });
  it('commits a notification with an answer and does not enqueue for rejected edits', () => {
    const id = repo.create(draft, host);
    repo.saveResponse(id, answer, null, null, 1, participant);
    expect(db.prepare('SELECT * FROM meeting_outbox').all()).toHaveLength(1);
    const row = repo.responses(id)[0]; if (!row) throw new Error('missing answer');
    expect(() => repo.saveResponse(id, answer, row.id, 10, 1, participant)).toThrow();
    expect(db.prepare('SELECT * FROM meeting_outbox').all()).toHaveLength(1);
  });
});
describe('capability and input boundaries', () => {
  it('requires the secret and expiry rather than a device ID alone', () => {
    const id = '12345678-1234-1234-1234-123456789012', secret = 'a'.repeat(43), salt = 'salt';
    const hash = createHash('sha256').update(`${salt}:${secret}`).digest('hex');
    db.prepare('INSERT INTO meeting_device VALUES(?,?,?,?,?)').run(id, 'participant', salt, hash, Date.now() + 10000);
    expect(deviceIdentity(db, `${id}.${secret}`)?.id).toBe('participant');
    expect(deviceIdentity(db, `${id}.${'b'.repeat(43)}`)).toBeNull();
    db.prepare('UPDATE meeting_device SET expires_at=0').run();
    expect(deviceIdentity(db, `${id}.${secret}`)).toBeNull();
  });
  it('rejects timezone-less periods and missing candidate answers', () => {
    expect(() => meetingInput({ ...draft, slots: [{ ...draft.slots[0], startAt: '2026-10-01T01:00' }] })).toThrow();
    expect(() => responseInput({ ...answer, answers: {} }, draft.slots)).toThrow();
    expect(() => responseInput({ ...answer, answers: { 'slot-a': 'yes', fake: 'no' } }, draft.slots)).toThrow();
  });
});
