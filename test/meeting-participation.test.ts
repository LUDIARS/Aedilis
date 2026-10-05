import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { makeMeetingRouter } from '../server/meetings/routes.ts';
import { requireRegisteredOrganizer, requireResponder, resolveGuestResponses } from '../server/meetings/participation-policy.ts';
import type { AuthIdentity } from '../server/auth.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }));
vi.mock('../server/auth.ts', () => ({
  readIdentity: async (c: Context): Promise<AuthIdentity | null> => c.req.header('x-test-user') ? {
    userId: c.req.header('x-test-user') || '', isAdmin: false, role: 'general', displayName: null, projectKey: 'aedilis',
  } : null,
}));

const origin = 'https://ae.example.com';
const draft = { title: 'Guest policy', description: '', organizerName: 'Host', onlineAllowed: false,
  slots: [{ id: 'slot', startAt: '2026-10-01T01:00:00Z', endAt: '2026-10-01T02:00:00Z', venue: '' }], venues: [] };
const answer = { name: 'Guest', comment: '', topic: '', answers: { slot: 'yes' } };

function setup(): { db: Database.Database; call: (method: string, path: string, body?: unknown, user?: string, cookie?: string) => Promise<Response> } {
  const db = new Database(':memory:'); migrateMeetings(db);
  const client = { request: async () => { throw new Error('Unexpected Cernere request'); } } as unknown as CernereProjectClient;
  const app = new Hono().route('/api/meetings', makeMeetingRouter(db, {
    publicUrl: origin, cernereUrl: origin, cernerePublicUrl: '', googleClientId: '',
    discordToken: null, notificationIntervalMs: 1000, notificationMaxAttempts: 1,
  }, client));
  const call = (method: string, path: string, body?: unknown, user?: string, cookie?: string): Promise<Response> => {
    const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    if (cookie) headers.cookie = cookie;
    return Promise.resolve(app.request(origin + '/api/meetings' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  };
  return { db, call };
}
async function guestCookie(call: ReturnType<typeof setup>['call']): Promise<string> {
  const session = await call('POST', '/session', {});
  return session.headers.get('set-cookie')?.split(';')[0] ?? '';
}

describe('meeting participation policy', () => {
  it('requires a Cernere user to organize and a login unless guests are allowed', () => {
    const guest = { identities: [], current: null, userId: null };
    expect(() => requireRegisteredOrganizer(guest)).toThrow('Cernere');
    expect(() => requireRegisteredOrganizer({ ...guest, userId: 'cr-user' })).not.toThrow();
    expect(() => requireResponder(false, guest)).toThrow('ログイン');
    expect(() => requireResponder(true, guest)).not.toThrow();
    expect(() => requireResponder(false, { ...guest, userId: 'cr-user' })).not.toThrow();
  });
  it('allows guest responses only for URL-readable meetings and keeps the setting when omitted', () => {
    expect(() => resolveGuestResponses(true, 'private')).toThrow('URL');
    expect(resolveGuestResponses(undefined, 'public')).toBe(false);
    expect(resolveGuestResponses(undefined, 'public', true)).toBe(true);
    expect(resolveGuestResponses(undefined, 'internal', true)).toBe(false);
    expect(resolveGuestResponses(false, 'public', true)).toBe(false);
  });
});

describe('meeting participation routes', () => {
  it('publishes the canonical share origin for proxies', async () => {
    const { db, call } = setup();
    try { expect(await (await call('GET', '/config')).json()).toMatchObject({ publicUrl: origin }); }
    finally { db.close(); }
  });
  it('rejects meeting creation without Cernere login, even with a device cookie', async () => {
    const { db, call } = setup();
    try {
      const cookie = await guestCookie(call);
      const response = await call('POST', '', draft, undefined, cookie);
      expect(response.status).toBe(401);
      expect((db.prepare('SELECT COUNT(*) AS n FROM meeting_poll').get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });
  it('accepts login-free answers only when the organizer enabled them', async () => {
    const { db, call } = setup();
    try {
      const open = await (await call('POST', '', { ...draft, guestResponses: true }, 'cr-host')).json() as { id: string };
      const closed = await (await call('POST', '', draft, 'cr-host')).json() as { id: string };
      const cookie = await guestCookie(call);
      expect(await (await call('GET', '/' + open.id, undefined, undefined, cookie)).json()).toMatchObject({ guestResponses: true });
      expect((await call('POST', `/${open.id}/responses`, { ...answer, meetingRevision: 1 }, undefined, cookie)).status).toBe(201);
      expect((await call('POST', `/${closed.id}/responses`, { ...answer, meetingRevision: 1 }, undefined, cookie)).status).toBe(401);
      expect((await call('POST', `/${closed.id}/responses`, { ...answer, meetingRevision: 1 }, 'cr-member')).status).toBe(201);
    } finally { db.close(); }
  });
  it('refuses guests on non-public meetings and keeps the setting when an older client omits it', async () => {
    const { db, call } = setup();
    try {
      expect((await call('POST', '', { ...draft, guestResponses: true, visibility: 'private' }, 'cr-host')).status).toBe(400);
      const { id } = await (await call('POST', '', { ...draft, guestResponses: true }, 'cr-host')).json() as { id: string };
      expect((await call('PATCH', '/' + id, { ...draft, title: 'Renamed', revision: 1 }, 'cr-host')).status).toBe(200);
      expect(await (await call('GET', '/' + id, undefined, 'cr-host')).json()).toMatchObject({ title: 'Renamed', guestResponses: true });
      expect((await call('PATCH', '/' + id, { ...draft, guestResponses: false, revision: 2 }, 'cr-host')).status).toBe(200);
      expect(await (await call('GET', '/' + id, undefined, 'cr-host')).json()).toMatchObject({ guestResponses: false });
    } finally { db.close(); }
  });
  it('keeps login-free answers for meetings created before the setting existed', () => {
    const db = new Database(':memory:');
    try {
      migrateMeetings(db);
      db.exec('ALTER TABLE meeting_poll DROP COLUMN guest_responses');
      db.prepare("INSERT INTO meeting_identity(id,user_id,created_at) VALUES('owner',NULL,1)").run();
      db.prepare("INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,slots_json,venues_json,created_at,updated_at) VALUES('legacy','owner','T','','H','[]','[]',1,1)").run();
      migrateMeetings(db); migrateMeetings(db);
      expect(db.prepare("SELECT guest_responses FROM meeting_poll WHERE id='legacy'").get()).toEqual({ guest_responses: 1 });
    } finally { db.close(); }
  });
});
