/** @implements SPEC-MEETING-SCOPED-OPERATION */
import { afterEach, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import Database from 'better-sqlite3';
import { actorFor } from '../server/meetings/identity.ts';
import { bookingPrincipal } from '../server/booking-access/request.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { readIdentity, type AuthIdentity } from '../server/auth.ts';

// A generic reader returning a valid identity must still not authenticate a direct meeting.
vi.mock('../server/auth.ts', () => ({ readIdentity: vi.fn(async () => ({
  userId: 'generic', projectKey: 'aedilis', role: 'general', isAdmin: false, displayName: 'Generic',
})) }));
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.clearAllMocks(); });
const generic: AuthIdentity = { userId: 'generic', projectKey: 'aedilis', role: 'general', isAdmin: false, displayName: 'Generic' };
function app(identity: (c: Context) => void): Hono {
  const db = new Database(':memory:'); databases.push(db); migrateMeetings(db);
  db.prepare("INSERT INTO meeting_identity(id,user_id,created_at) VALUES('generic-owner','generic',1),('scoped-owner','scoped',1)").run();
  const router = new Hono();
  router.use('*', async (c, next) => { identity(c); await next(); });
  router.get('*', async c => c.json({ principal: await bookingPrincipal(c), actor: await actorFor(db, c) }));
  return router;
}
it('ignores generic context and generic identity readers on direct meetings', async () => {
  const router = app(c => { c.set('auth', generic); c.set('meetingAuth', null); });
  const response = await router.request('https://ae.example/api/meetings/private');
  expect(await response.json()).toMatchObject({ principal: { userId: null }, actor: { userId: null, current: null } });
  expect(readIdentity).not.toHaveBeenCalled();
});
it('uses the direct scoped identity even when a different generic identity is present', async () => {
  const router = app(c => { c.set('auth', generic); c.set('meetingAuth', { ...generic, userId: 'scoped' }); });
  expect(await (await router.request('https://ae.example/api/meetings/private')).json())
    .toMatchObject({ principal: { userId: 'scoped' }, actor: { userId: 'scoped', current: { id: 'scoped-owner' } } });
  expect(readIdentity).not.toHaveBeenCalled();
});
it('preserves the distinct authenticated managed Meet principal', async () => {
  const router = app(c => { c.set('auth', generic); });
  expect(await (await router.request('https://ae.example/api/meet/poll')).json())
    .toMatchObject({ principal: { userId: 'generic' }, actor: { userId: 'generic', current: { id: 'generic-owner' } } });
});
