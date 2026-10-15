import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import Database from 'better-sqlite3';
import { managedMeetRoutes } from '../server/meet/routes.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { migrateMeet } from '../server/meet/schema.ts';
import { parseExternalRedirectUris } from '../server/meet/config.ts';
import { ensureBookingAccessSchema, saveAudience } from '../server/booking-access/policy.ts';
import { MeetProvisioner } from '../server/meet/provision.ts';
import type { MeetTokens } from '../server/meet/tokens.ts';
import type { MeetApi } from '../server/meet/api.ts';
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
type Group = { kind: 'organization' | 'team'; id: string; name: string; representative?: true };
function assertion(userId: string, method: string, path: string, body: string, groups: Group[] = []): string {
    const payload = Buffer.from(JSON.stringify({ version: 1, source: 'glab', userId, groups, method, path,
        bodyHash: createHash('sha256').update(body).digest('hex'), expiresAt: Date.now() + 20000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}
function relayed(userId: string, method: string, path: string, body = '', admin = false, groups: Group[] = []): RequestInit {
    return { method, headers: { 'content-type': 'application/json', 'x-test-user': userId, ...(admin ? { 'x-test-admin': '1' } : {}),
        'x-glab-booking-context': assertion(userId, method, path, body, groups) }, ...(method === 'GET' ? {} : { body }) };
}
let db: Database.Database;
beforeEach(() => {
    process.env.GLAB_AEDILIS_CONTEXT_SECRET = key;
    db = new Database(':memory:');
    migrateMeetings(db);
    migrateMeet(db);
    ensureBookingAccessSchema(db);
});
afterEach(() => {
    delete process.env.GLAB_AEDILIS_CONTEXT_SECRET;
    db.close();
});
function app(request = vi.fn(async () => null)) {
    const client = { request } as unknown as CernereProjectClient;
    return new Hono().route('/api/meet', managedMeetRoutes(db, client, { clientId: 'id', clientSecret: 'secret', publicUrl: 'https://ae.example', externalRedirectUris: { glab: [redirectUri] } }));
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
it('issues a Meet for a GLab event only through the relay, hosted by the chosen organization when it has a representative', async () => {
    (await db.prepare("INSERT INTO meet_organizer VALUES(1,'ae-admin')").run());
    (await db.prepare("INSERT INTO meet_group_organizer VALUES('organization','org-1','owner',1)").run());
    const spaces: string[] = [];
    const send = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v2/spaces') && init?.method === 'POST') {
            spaces.push(url);
            return Response.json({ name: `spaces/s${spaces.length}`, meetingUri: `https://meet.google.com/abc-${'x'.repeat(spaces.length)}` });
        }
        if (url.includes('/members') && (!init?.method || init.method === 'GET')) return Response.json({ members: [] });
        return Response.json({});
    });
    vi.stubGlobal('fetch', send);
    const hosts = new Set(['owner', 'ae-admin']);
    const tokens = vi.fn(async (_module: string, _action: string, payload: Record<string, unknown>) => ({
        accessToken: `access-${String(payload.userId)}`, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600000).toISOString(), tokenType: 'Bearer', scope: '',
        metadata: { email: `${String(payload.userId)}@example.com`, subject: String(payload.userId), emailVerified: true, meetOrganizer: hosts.has(String(payload.userId)) },
    }));
    try {
        const meet = app(tokens as unknown as ReturnType<typeof vi.fn<() => Promise<null>>>);
        const member: Group = { kind: 'organization', id: 'org-1', name: 'GLab' };
        // Not relayed, or an organization the caller is not in: refused before anything is created.
        expect((await meet.request('/api/meet/external/glab-event/42', { method: 'POST', headers: { origin: 'https://ae.example', 'content-type': 'application/json', 'x-test-user': 'member' }, body: '{}' })).status).toBe(403);
        const other = JSON.stringify({ organizationId: 'org-2' });
        expect((await meet.request('/api/meet/external/glab-event/42', relayed('member', 'POST', '/api/meet/external/glab-event/42', other, false, [member]))).status).toBe(403);
        expect((await meet.request('/api/meet/external/other/42', relayed('member', 'POST', '/api/meet/external/other/42', '{}'))).status).toBe(404);
        const body = JSON.stringify({ organizationId: 'org-1' });
        const issued = await meet.request('/api/meet/external/glab-event/42', relayed('member', 'POST', '/api/meet/external/glab-event/42', body, false, [member]));
        expect(issued.status).toBe(200);
        expect(await issued.json()).toEqual({ status: 'ready', url: 'https://meet.google.com/abc-x' });
        // An event without an organization falls back to Ae's representative.
        expect((await meet.request('/api/meet/external/glab-event/43', relayed('member', 'POST', '/api/meet/external/glab-event/43', '{}'))).status).toBe(200);
        expect((await db.prepare('SELECT source, resource_id, organizer_id FROM meet_external_space ORDER BY resource_id').all())).toEqual([
            { source: 'glab-event', resource_id: '42', organizer_id: 'owner' },
            { source: 'glab-event', resource_id: '43', organizer_id: 'ae-admin' },
        ]);
        // Retrying a ready event never creates a second space, and reading needs the relay too.
        expect((await meet.request('/api/meet/external/glab-event/42', relayed('other', 'POST', '/api/meet/external/glab-event/42', '{}'))).status).toBe(200);
        expect(spaces).toHaveLength(2);
        expect(await (await meet.request('/api/meet/external/glab-event/42', relayed('member', 'GET', '/api/meet/external/glab-event/42'))).json())
            .toEqual({ status: 'ready', url: 'https://meet.google.com/abc-x' });
        expect((await meet.request('/api/meet/external/glab-event/42', { headers: { 'x-test-user': 'member' } })).status).toBe(403);
    }
    finally {
        vi.unstubAllGlobals();
    }
});
const representative: Group = { kind: 'organization', id: 'org-1', name: 'GLab', representative: true };
it('lets only the organization representative start an organization organizer authorization', async () => {
    const meet = app();
    const body = JSON.stringify({ mode: 'organizer', organizationId: 'org-1', redirectUri });
    // The representative flag must be signed for that organization; a plain member or another organization is refused.
    expect((await meet.request('/api/meet/oauth/start', relayed('member', 'POST', '/api/meet/oauth/start', body, false,
        [{ kind: 'organization', id: 'org-1', name: 'GLab' }]))).status).toBe(403);
    expect((await meet.request('/api/meet/oauth/start', relayed('owner', 'POST', '/api/meet/oauth/start', body, false,
        [{ ...representative, id: 'org-2' }]))).status).toBe(403);
    const started = await meet.request('/api/meet/oauth/start', relayed('owner', 'POST', '/api/meet/oauth/start', body, false, [representative]));
    expect(started.status).toBe(200);
    expect(new URL((await started.json() as { url: string }).url).searchParams.get('access_type')).toBe('offline');
    // A non-admin cannot become Ae's own representative this way, and Ae's page cannot pick an organization.
    expect((await meet.request('/api/meet/oauth/start', relayed('owner', 'POST', '/api/meet/oauth/start',
        JSON.stringify({ mode: 'organizer', redirectUri }), false, [representative]))).status).toBe(403);
    expect((await meet.request('/api/meet/oauth/start', { method: 'POST', headers: { origin: 'https://ae.example', 'content-type': 'application/json', 'x-test-user': 'owner' },
        body: JSON.stringify({ mode: 'organizer', organizationId: 'org-1' }) })).status).toBe(400);
    // A representative flag on a team is not a valid assertion.
    expect((await meet.request('/api/meet/oauth/start', relayed('owner', 'POST', '/api/meet/oauth/start', body, false,
        [{ kind: 'team', id: 'org-1', name: 'GLab', representative: true }]))).status).toBe(403);
});
it('reports only the organizations the caller represents', async () => {
    (await db.prepare("INSERT INTO meet_group_organizer VALUES('organization','org-1','owner',1)").run());
    const status = await app().request('/api/meet/status', relayed('owner', 'GET', '/api/meet/status', '', false,
        [representative, { kind: 'organization', id: 'org-2', name: 'Other' }]));
    expect((await status.json() as { organizations: unknown }).organizations)
        .toEqual([{ id: 'org-1', name: 'GLab', organizerConnected: true, isOrganizer: true }]);
});
it('keeps each embedding on its own callback', async () => {
    const meet = new Hono().route('/api/meet', managedMeetRoutes(db, { request: vi.fn() } as unknown as CernereProjectClient,
        { clientId: 'id', clientSecret: 'secret', publicUrl: 'https://ae.example', externalRedirectUris: {} }));
    // GLab may only use GLab's callbacks; with none configured even a relayed request is refused.
    expect((await meet.request('/api/meet/oauth/start', relayed('member', 'POST', '/api/meet/oauth/start',
        JSON.stringify({ mode: 'creator', redirectUri })))).status).toBe(403);
    // A relayed request without its own callback must not fall back to Ae's callback.
    expect((await meet.request('/api/meet/oauth/start', relayed('member', 'POST', '/api/meet/oauth/start',
        JSON.stringify({ mode: 'creator' })))).status).toBe(403);
});
it("hosts an organization booking with the organization representative and others with Ae's representative", async () => {
    (await db.prepare("INSERT INTO meet_organizer VALUES(1,'ae-admin')").run());
    (await db.prepare("INSERT INTO meet_group_organizer VALUES('organization','org-1','owner',1)").run());
    (await db.prepare("INSERT INTO meeting_identity(id,user_id,created_at) VALUES('owner','creator',1)").run());
    for (const id of ['org-poll', 'team-poll', 'plain-poll'])
        (await db.prepare("INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,slots_json,venues_json,created_at,updated_at,online_allowed) VALUES(?,'owner','Title','','Host','[]','[]',1,1,1)").run(id));
    await saveAudience(db, 'meeting', 'org-poll', { visibility: 'internal', group: { kind: 'organization', id: 'org-1', name: 'GLab' } });
    await saveAudience(db, 'meeting', 'team-poll', { visibility: 'internal', group: { kind: 'team', id: 'org-1', name: 'Team' } });
    const tokens = { access: vi.fn(async (userId: string) => `token-${userId}`), email: vi.fn(async (userId: string) => `${userId}@example.com`) } as unknown as MeetTokens;
    const api = { create: vi.fn(async () => ({ name: 'spaces/x', meetingUri: 'https://meet.google.com/x' })), configure: vi.fn(async () => undefined) } as unknown as MeetApi;
    const provision = new MeetProvisioner(db, tokens, api);
    await provision.ensure('org-poll', 'creator');
    await provision.ensure('team-poll', 'creator');
    await provision.ensure('plain-poll', 'creator');
    expect((await db.prepare('SELECT meeting_id, organizer_id FROM meeting_meet ORDER BY meeting_id').all())).toEqual([
        { meeting_id: 'org-poll', organizer_id: 'owner' },
        { meeting_id: 'plain-poll', organizer_id: 'ae-admin' },
        { meeting_id: 'team-poll', organizer_id: 'ae-admin' },
    ]);
});
