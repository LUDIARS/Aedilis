import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { makeMeetingRouter } from '../server/meetings/routes.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { SESSION_COOKIE } from '../server/meetings/cernere-login.ts';
import { meetingAuthority } from './fixtures/meeting-authority.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';
import { prepare } from '../server/persistence/database.ts';

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }));
const origin = 'https://ae.example', config = { publicUrl: origin, cernereUrl: 'https://cr.example', cernerePublicUrl: 'https://cr.example',
  cernereClientId: 'ae-client', googleClientId: '', discordToken: null, notificationIntervalMs: 1000, notificationMaxAttempts: 1 };
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); migrateMeetings(db); });
afterEach(() => db.close());
const client = {} as CernereProjectClient;
const headers = (cookie = '', from = origin) => ({ origin: from, 'content-type': 'application/json', cookie });

it('requires exact origin and nonce, returns host-only secure opaque cookie, and locally logs out before revoke', async () => {
  const f = meetingAuthority(), router = makeMeetingRouter(db, config, client, undefined, f.sessions);
  const app = new Hono().route('/api/meetings', router);
  try {
    const request = (path: string, cookie = '', body = {}, from = origin) => app.request(origin + '/api/meetings' + path,
      { method: 'POST', headers: headers(cookie, from), body: JSON.stringify(body) });
    expect((await request('/session/login/start', '', {}, 'https://evil.example')).status).toBe(403);
    const start = await request('/session/login/start');
    const { nonce } = await start.json() as { nonce: string };
    const nonceCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    expect((await request('/session/login/complete', nonceCookie, { nonce: 'wrong', code: 'code', verifier: 'v'.repeat(43) })).status).toBe(403);
    expect(f.exchange).not.toHaveBeenCalled();
    const complete = await request('/session/login/complete', nonceCookie, { nonce, code: 'code', verifier: 'v'.repeat(43) });
    expect(complete.status).toBe(200);
    const cookies = complete.headers.getSetCookie();
    const sessionCookie = cookies.find(c => c.startsWith(SESSION_COOKIE + '='))!;
    expect(sessionCookie).toContain('Secure'); expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict'); expect(sessionCookie).toContain('Path=/');
    expect(sessionCookie).not.toContain('Domain='); expect(sessionCookie).not.toContain('project-token');
    const cookie = sessionCookie.split(';')[0]!;
    expect(await (await request('/session', cookie)).json()).toMatchObject({ linked: true });
    expect(f.call).toHaveBeenCalledWith('authorize', expect.objectContaining({ action: 'meetings.session.ensure' }));
    f.call.mockRejectedValueOnce(new Error('revoke unavailable'));
    expect((await request('/session/logout', cookie)).status).toBe(503);
    expect((await request('/session', cookie)).status).toBe(401);
    expect((await request('/session/login/complete', nonceCookie, { nonce, code: 'code', verifier: 'v'.repeat(43) })).status).not.toBe(200);
  } finally { router.dispose(); }
});

it('does not hold the database transaction while remote authorization is pending', async () => {
  const f = meetingAuthority(), session = await f.login(), router = makeMeetingRouter(db, config, client, undefined, f.sessions);
  const app = new Hono().route('/api/meetings', router), cookie = `${SESSION_COOKIE}=${session.id}`;
  const original = f.call.getMockImplementation()!;
  let authorizeStarted!: () => void, releaseAuthorize!: () => void;
  const started = new Promise<void>(resolve => { authorizeStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseAuthorize = resolve; });
  f.call.mockImplementation(async (action, body) => {
    if (action === 'authorize') { authorizeStarted(); await release; }
    return original(action, body);
  });
  try {
    const pending = app.request(origin + '/api/meetings/mine', { headers: headers(cookie) });
    await started;
    const write = prepare(db, 'INSERT INTO meeting_identity (id, user_id, notify, created_at) VALUES (?, ?, 0, ?)')
      .run('parallel-device', null, Date.now());
    expect(await Promise.race([write.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 50))])).toBe(true);
    releaseAuthorize();
    expect((await pending).status).toBe(200);
  } finally { releaseAuthorize(); router.dispose(); }
});

it('rejects legacy credentials explicitly and preserves credential-free guest device identity', async () => {
  const f = meetingAuthority(), router = makeMeetingRouter(db, config, client, undefined, f.sessions);
  const app = new Hono().route('/api/meetings', router);
  try {
    for (const obsolete of [{ cookie: 'cernere_token=v4.public.legacy' }, { authorization: 'Bearer v4.public.legacy' }] as Record<string, string>[]) {
      for (const path of ['/session', '/mine', '']) {
        const result = await app.request(origin + '/api/meetings' + path, { method: path === '/mine' ? 'GET' : 'POST',
          headers: { ...headers(), ...obsolete }, ...(path === '/mine' ? {} : { body: '{}' }) });
        expect(result.status).toBe(401); expect(result.headers.get('set-cookie')).toBeNull();
      }
    }
    const result = await app.request(origin + '/api/meetings/session', { method: 'POST', headers: headers(), body: '{}' });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ linked: false });
    expect(result.headers.get('set-cookie')).toContain('aedilis_meeting_device=');
    expect(f.call).not.toHaveBeenCalled();
  } finally { router.dispose(); }
});

it('rechecks the owner ACL after remote consume and rejects a sensitive GET when authority is unavailable', async () => {
  const f = meetingAuthority(), session = await f.login(), router = makeMeetingRouter(db, config, client, undefined, f.sessions);
  const app = new Hono().route('/api/meetings', router), cookie = `${SESSION_COOKIE}=${session.id}`;
  try {
    const draft = { title: 'Owner', description: '', organizerName: 'Host', slots: [{ id: 'slot', startAt: '2026-11-10T01:00:00Z', endAt: '2026-11-10T02:00:00Z', venue: 'Room' }], venues: [{ name: 'Room', busy: [] }] };
    const create = await app.request(origin + '/api/meetings', { method: 'POST', headers: headers(cookie), body: JSON.stringify(draft) });
    expect(create.status).toBe(201);
    const { id } = await create.json() as { id: string };
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (action, body) => {
      if (action === 'consume' && (body as { action: string }).action === 'meetings.update') {
        db.prepare('UPDATE meeting_identity SET user_id=? WHERE user_id=?').run('new-owner', f.user.id);
      }
      return original(action, body);
    });
    const edit = await app.request(origin + '/api/meetings/' + id, { method: 'PATCH', headers: headers(cookie), body: JSON.stringify({ ...draft, title: 'Stolen', revision: 1 }) });
    expect(edit.status).not.toBe(200);
    expect(db.prepare('SELECT title FROM meeting_poll WHERE id=?').get(id)).toEqual({ title: 'Owner' });
    f.call.mockRejectedValueOnce(new Error('authority unavailable'));
    expect((await app.request(origin + '/api/meetings/mine', { headers: headers(cookie) })).status).toBe(503);
  } finally { router.dispose(); }
});
