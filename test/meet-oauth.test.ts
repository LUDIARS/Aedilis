import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { MeetOAuth } from '../server/meet/oauth.ts';
import { MeetTokens } from '../server/meet/tokens.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { migrateMeet } from '../server/meet/schema.ts';
import { ORGANIZER_SCOPES } from '../server/meet/config.ts';
import type { AuthIdentity } from '../server/auth.ts';

function fixture(admin = true) {
  const db = new Database(':memory:'); migrateMeetings(db); migrateMeet(db);
  const config = { clientId: 'client', clientSecret: 'client-secret', publicUrl: 'https://ae.example' };
  const request = vi.fn(async () => null);
  const send = vi.fn<typeof fetch>();
  const oauth = new MeetOAuth(db, config, new MeetTokens({ request }, config), send);
  const identity: AuthIdentity = { userId: 'cr-user', role: 'general', displayName: null, projectKey: 'aedilis', isAdmin: admin };
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, 400));
  app.get('/begin', c => c.json({ url: oauth.begin(c, identity, 'organizer', '//evil.example') }));
  app.get('/callback', async c => c.json({ path: await oauth.complete(c, identity) }));
  return { db, app, send, request, identity };
}

it('binds the code exchange to Cr user, browser state and PKCE; stores tokens only in Cr', async () => {
  const { db, app, send, request } = fixture();
  try {
    const begin = await app.request('/begin'), url = new URL((await begin.json() as { url: string }).url);
    const cookie = begin.headers.get('set-cookie')?.split(';')[0] || '';
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    send.mockResolvedValueOnce(Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: ORGANIZER_SCOPES.join(' ') })).mockResolvedValueOnce(Response.json({ sub: 'google-sub', email: 'host@example.com', email_verified: true, hd: 'example.com' }));
    const callback = `/callback?state=${url.searchParams.get('state')}&code=one-use`;
    expect((await app.request(callback)).status).toBe(400);
    const result = await app.request(callback, { headers: { cookie } });
    expect(await result.json()).toEqual({ path: '/meetings' });
    expect(request).toHaveBeenCalledWith('managed_project', 'store_oauth_token', expect.objectContaining({ userId: 'cr-user', provider: 'google', refreshToken: 'private-refresh', metadata: expect.objectContaining({ emailVerified: true, meetOrganizer: true }) }));
    expect((await app.request(callback, { headers: { cookie } })).status).toBe(400);
    expect(db.prepare('SELECT * FROM meet_oauth_state').all()).toHaveLength(0);
    expect(JSON.stringify(db.prepare('SELECT * FROM meet_organizer').all())).not.toContain('private-');
  } finally { db.close(); }
});

it('does not allow non-admin users to authorize the managed organizer', async () => {
  const { db, app, send } = fixture(false);
  try { expect((await app.request('/begin')).status).toBe(400); expect(send).not.toHaveBeenCalled(); }
  finally { db.close(); }
});

it('rejects a callback replayed under a different Cr user', async () => {
  const { db, app, identity, send } = fixture();
  try {
    const begin = await app.request('/begin'), url = new URL((await begin.json() as { url: string }).url);
    identity.userId = 'other';
    const response = await app.request(`/callback?state=${url.searchParams.get('state')}&code=x`, { headers: { cookie: begin.headers.get('set-cookie')?.split(';')[0] || '' } });
    expect(response.status).toBe(400); expect(send).not.toHaveBeenCalled();
  } finally { db.close(); }
});
