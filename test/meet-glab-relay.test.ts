import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import Database from 'better-sqlite3';
import { managedMeetRoutes } from '../server/meet/routes.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { migrateMeet } from '../server/meet/schema.ts';
import { parseExternalRedirectUris } from '../server/meet/config.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';
import type { AuthIdentity } from '../server/auth.ts';
vi.mock('../server/auth.ts', () => {
    const identity = (c: Context): AuthIdentity | null => c.req.header('x-test-user') ? {
        userId: c.req.header('x-test-user') || '', isAdmin: c.req.header('x-test-admin') === '1', role: 'general', displayName: null, projectKey: 'aedilis',
    } : null;
    return { readIdentity: async (c: Context) => identity(c), getIdentity: (c: Context) => c.get('auth'), requireAuth: async (c: Context, next: Next) => {
            const user = identity(c);
            if (!user)
                return c.json({ error: 'unauthorized' }, 401);
            c.set('auth', user);
            await next();
        } };
});
const key = 'test-key-with-at-least-thirty-two-bytes';
const redirectUri = 'https://glab.example/api/x/facility/meet/oauth/callback';
/** Same v1 assertion GLab's facility proxy signs (plugins/facility/context-signature.ts). */
function assertion(userId: string, method: string, path: string, body: string): string {
    const payload = Buffer.from(JSON.stringify({ version: 1, source: 'glab', userId, groups: [], method, path,
        bodyHash: createHash('sha256').update(body).digest('hex'), expiresAt: Date.now() + 20000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}
function relayed(userId: string, method: string, path: string, body = '', admin = false): RequestInit {
    return { method, headers: { 'content-type': 'application/json', 'x-test-user': userId, ...(admin ? { 'x-test-admin': '1' } : {}),
        'x-glab-booking-context': assertion(userId, method, path, body) }, ...(method === 'GET' ? {} : { body }) };
}
let db: Database.Database;
beforeEach(() => {
    process.env.GLAB_AEDILIS_CONTEXT_SECRET = key;
    db = new Database(':memory:');
    migrateMeetings(db);
    migrateMeet(db);
});
afterEach(() => {
    delete process.env.GLAB_AEDILIS_CONTEXT_SECRET;
    db.close();
});
function app(request = vi.fn(async () => null)) {
    const client = { request } as unknown as CernereProjectClient;
    return new Hono().route('/api/meet', managedMeetRoutes(db, client, { clientId: 'id', clientSecret: 'secret', publicUrl: 'https://ae.example', externalRedirectUris: [redirectUri] }));
}
it('lets a GLab-signed request skip the Ae origin check but rejects a forged assertion', async () => {
    (await db.prepare("INSERT INTO meeting_identity(id,user_id,created_at) VALUES('owner','creator',1)").run());
    (await db.prepare("INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,slots_json,venues_json,created_at,updated_at,online_allowed) VALUES('poll','owner','Title','','Host','[]','[]',1,1,1)").run());
    const meet = app();
    // No organizer yet: the relayed request reaches provisioning (409) instead of the same-origin refusal (403).
    expect((await meet.request('/api/meet/poll', relayed('creator', 'POST', '/api/meet/poll', '{}'))).status).toBe(409);
    const forged = relayed('creator', 'POST', '/api/meet/poll', '{}');
    (forged.headers as Record<string, string>)['x-glab-booking-context'] = assertion('creator', 'POST', '/api/meet/other', '{}');
    expect((await meet.request('/api/meet/poll', forged)).status).toBe(403);
    expect((await meet.request('/api/meet/poll', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'creator' }, body: '{}' })).status).toBe(403);
});
it('starts an external Google authorization only for a relayed request to an allowlisted redirect', async () => {
    const meet = app();
    const body = JSON.stringify({ mode: 'organizer', redirectUri });
    const started = await meet.request('/api/meet/oauth/start', relayed('admin', 'POST', '/api/meet/oauth/start', body, true));
    expect(started.status).toBe(200);
    expect(started.headers.get('set-cookie')).toBeNull();
    const url = new URL((await started.json() as { url: string }).url);
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const other = JSON.stringify({ mode: 'organizer', redirectUri: 'https://evil.example/callback' });
    expect((await meet.request('/api/meet/oauth/start', relayed('admin', 'POST', '/api/meet/oauth/start', other, true))).status).toBe(403);
    const direct = { method: 'POST', headers: { origin: 'https://ae.example', 'content-type': 'application/json', 'x-test-user': 'admin', 'x-test-admin': '1' }, body };
    expect((await meet.request('/api/meet/oauth/start', direct)).status).toBe(403);
    // Organizer authorization stays limited to Ae administrators even through GLab.
    expect((await meet.request('/api/meet/oauth/start', relayed('member', 'POST', '/api/meet/oauth/start', body))).status).toBe(403);
});
it('completes an external authorization only for the same Cr user and never through the Ae callback', async () => {
    const meet = app();
    const body = JSON.stringify({ mode: 'creator', redirectUri });
    const started = await meet.request('/api/meet/oauth/start', relayed('member', 'POST', '/api/meet/oauth/start', body));
    const state = new URL((await started.json() as { url: string }).url).searchParams.get('state') || '';
    // The Ae page callback refuses an external state (no cookie and the row is marked external).
    expect((await meet.request(`/api/meet/oauth/callback?state=${state}&code=x`, { headers: { 'x-test-user': 'member', cookie: `aedilis_meet_oauth=${state}` } })).status).toBe(403);
    const replay = JSON.stringify({ state, code: 'x' });
    // The row was consumed by the refused callback attempt above, so the relay cannot finish it either.
    expect((await meet.request('/api/meet/oauth/complete', relayed('member', 'POST', '/api/meet/oauth/complete', replay))).status).toBe(403);
    const again = await meet.request('/api/meet/oauth/start', relayed('member', 'POST', '/api/meet/oauth/start', body));
    const fresh = new URL((await again.json() as { url: string }).url).searchParams.get('state') || '';
    const stolen = JSON.stringify({ state: fresh, code: 'x' });
    expect((await meet.request('/api/meet/oauth/complete', relayed('attacker', 'POST', '/api/meet/oauth/complete', stolen))).status).toBe(403);
    expect((await meet.request('/api/meet/oauth/complete', { method: 'POST', headers: { origin: 'https://ae.example', 'content-type': 'application/json', 'x-test-user': 'member' }, body: stolen })).status).toBe(403);
});
it('keeps only exact HTTPS or loopback redirect URIs from the allowlist env', () => {
    expect(parseExternalRedirectUris(` ${redirectUri}, http://127.0.0.1:5187/cb ,http://glab.example/cb,https://a.example/cb?x=1,nope, ${redirectUri}`))
        .toEqual([redirectUri, 'http://127.0.0.1:5187/cb']);
    expect(parseExternalRedirectUris(undefined)).toEqual([]);
});
