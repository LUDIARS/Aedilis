import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { verifyBookingContext } from '../server/booking-access/context.ts';
import { canReadBooking, ensureBookingAccessSchema, parseAudience, readAudience, saveAudience } from '../server/booking-access/policy.ts';

const key = 'test-key-with-at-least-thirty-two-bytes';
const team = { kind: 'team' as const, id: 'project-a', name: '制作A' };
const member = { userId: 'member', groups: [team] };
const stranger = { userId: 'other', groups: [] };
const anonymous = { userId: null, groups: [] };
function assertion(overrides: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, source: 'glab', userId: 'member', groups: [team],
    method: 'POST', path: '/api/reservations', bodyHash: createHash('sha256').update('{}').digest('hex'), expiresAt: 31000,
    ...overrides })).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

describe('request-bound membership assertions', () => {
  it('accepts only a signature bound to the user, request and current time', () => {
    expect(verifyBookingContext(assertion(), key, 'member', 'POST', '/api/reservations', '{}', 1000)).toEqual([team]);
    for (const override of [{ userId: 'other' }, { path: '/api/meetings' }, { method: 'GET' }, { expiresAt: 999 }, { expiresAt: 90000 }, { source: 'other' }]) {
      expect(() => verifyBookingContext(assertion(override), key, 'member', 'POST', '/api/reservations', '{}', 1000)).toThrow();
    }
    expect(() => verifyBookingContext(assertion(), key, 'member', 'POST', '/api/reservations', '{"visibility":"public"}', 1000)).toThrow();
    expect(() => verifyBookingContext(assertion(), `${key}wrong`, 'member', 'POST', '/api/reservations', '{}', 1000)).toThrow();
    expect(() => verifyBookingContext(assertion(), key, null, 'POST', '/api/reservations', '{}', 1000)).toThrow();
  });
});

describe('booking audience', () => {
  it('uses verified membership labels and rejects arbitrary or absent membership', () => {
    expect(parseAudience({ visibility: 'internal', group: { ...team, name: 'spoofed' } }, member).group?.name).toBe(team.name);
    expect(() => parseAudience({ visibility: 'internal', group: team }, stranger)).toThrow();
    expect(() => parseAudience({ visibility: 'internal' }, member)).toThrow();
    expect(() => parseAudience({ visibility: 'private' }, anonymous)).toThrow();
  });
  it('re-evaluates current membership and never makes Private group-visible', () => {
    const internal = { visibility: 'internal' as const, group: team };
    expect(canReadBooking(internal, member, false)).toBe(true);
    expect(canReadBooking(internal, { ...member, groups: [] }, false)).toBe(false);
    expect(canReadBooking(internal, anonymous, false)).toBe(false);
    expect(canReadBooking({ ...internal, visibility: 'private' }, member, false)).toBe(false);
    expect(canReadBooking({ ...internal, visibility: 'private' }, stranger, true)).toBe(true);
    expect(canReadBooking({ ...internal, visibility: 'public' }, anonymous, false)).toBe(true);
  });
  it('stores independent reservation/meeting policies with an idempotent schema', () => {
    const db = new Database(':memory:');
    try {
      ensureBookingAccessSchema(db); ensureBookingAccessSchema(db);
      saveAudience(db, 'reservation', 'same-id', { visibility: 'internal', group: team });
      saveAudience(db, 'meeting', 'same-id', { visibility: 'private', group: null });
      expect(readAudience(db, 'reservation', 'same-id').group).toEqual(team);
      expect(readAudience(db, 'meeting', 'same-id').visibility).toBe('private');
      saveAudience(db, 'reservation', 'same-id', { visibility: 'private', group: null });
      expect(readAudience(db, 'reservation', 'same-id')).toEqual({ visibility: 'private', group: null });
    } finally { db.close(); }
  });
});
