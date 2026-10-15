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
    const db = new Database(':memory:');
    migrateMeetings(db);
    migrateMeet(db);
    const config = { clientId: 'client', clientSecret: 'client-secret', publicUrl: 'https://ae.example' };
    const request = vi.fn(async () => null);
    const send = vi.fn<typeof fetch>();
    const oauth = new MeetOAuth(db, config, new MeetTokens({ request }, config), send);
    const identity: AuthIdentity = { userId: 'cr-user', role: 'general', displayName: null, projectKey: 'aedilis', isAdmin: admin };
    const app = new Hono();
    app.onError((error, c) => c.json({ error: error.message }, 400));
    app.get('/begin', async (c) => c.json({ url: (await oauth.begin(c, identity, 'organizer', '//evil.example')) }));
    app.get('/callback', async (c) => c.json({ path: await oauth.complete(c, identity) }));
    return { db, app, send, request, identity };
}
it('binds the code exchange to Cr user, browser state and PKCE; stores tokens only in Cr', async () => {
    const { db, app, send, request } = fixture();
    try {
        const begin = await app.request('/begin'), url = new URL((await begin.json() as {
            url: string;
        }).url);
        const cookie = begin.headers.get('set-cookie')?.split(';')[0] || '';
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        send.mockResolvedValueOnce(Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: ORGANIZER_SCOPES.join(' ') })).mockResolvedValueOnce(Response.json({ sub: 'google-sub', email: 'host@example.com', email_verified: true, hd: 'example.com' }));
        const callback = `/callback?state=${url.searchParams.get('state')}&code=one-use`;
        expect((await app.request(callback)).status).toBe(400);
        const result = await app.request(callback, { headers: { cookie } });
        expect(await result.json()).toEqual({ path: '/meetings' });
        expect(request).toHaveBeenCalledWith('managed_project', 'store_oauth_token', expect.objectContaining({ userId: 'cr-user', provider: 'google', refreshToken: 'private-refresh', metadata: expect.objectContaining({ emailVerified: true, meetOrganizer: true }) }));
        expect((await app.request(callback, { headers: { cookie } })).status).toBe(400);
        expect((await db.prepare('SELECT * FROM meet_oauth_state').all())).toHaveLength(0);
        expect(JSON.stringify((await db.prepare('SELECT * FROM meet_organizer').all()))).not.toContain('private-');
    }
    finally {
        db.close();
    }
});
it('does not allow non-admin users to authorize the managed organizer', async () => {
    const { db, app, send } = fixture(false);
    try {
        expect((await app.request('/begin')).status).toBe(400);
        expect(send).not.toHaveBeenCalled();
    }
    finally {
        db.close();
    }
});
it('binds an organization representative only through the same front end while still representing it', async () => {
    const db = new Database(':memory:');
    migrateMeetings(db);
    migrateMeet(db);
    const redirect = 'https://glab.example/api/x/facility/meet/oauth/callback';
    const config = { clientId: 'client', clientSecret: 'client-secret', publicUrl: 'https://ae.example', externalRedirectUris: { glab: [redirect] } };
    const send = vi.fn<typeof fetch>();
    const oauth = new MeetOAuth(db, config, new MeetTokens({ request: vi.fn(async () => null) }, config), send);
    const identity: AuthIdentity = { userId: 'owner', role: 'general', displayName: null, projectKey: 'aedilis', isAdmin: false };
    const caller = { source: 'glab' as const, groups: [{ kind: 'organization' as const, id: 'org-1', name: 'GLab', representative: true as const }] };
    const start = async () => new URL(await oauth.beginExternal(identity, { mode: 'organizer', organizationId: 'org-1' }, redirect, caller)).searchParams.get('state');
    try {
        // Lost representation between start and completion stops the flow before any token exchange.
        await expect(oauth.completeExternal(identity, await start(), 'code', { source: 'glab', groups: [] })).rejects.toThrow('Google認可が失効しました');
        expect(send).not.toHaveBeenCalled();
        send.mockResolvedValueOnce(Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: ORGANIZER_SCOPES.join(' ') }))
            .mockResolvedValueOnce(Response.json({ sub: 'google-sub', email: 'rep@glab.example', email_verified: true, hd: 'glab.example' }));
        expect(await oauth.completeExternal(identity, await start(), 'code', caller)).toEqual({ mode: 'organizer', organizationId: 'org-1' });
        expect((await db.prepare('SELECT group_kind, group_id, user_id FROM meet_group_organizer').all()))
            .toEqual([{ group_kind: 'organization', group_id: 'org-1', user_id: 'owner' }]);
        expect((await db.prepare('SELECT * FROM meet_organizer').all())).toHaveLength(0);
        // The representative cannot downgrade its organizer token through a creator link.
        await expect(oauth.beginExternal(identity, { mode: 'creator' }, redirect, caller)).rejects.toThrow('代表用');
    }
    finally {
        db.close();
    }
});
it('rejects a callback replayed under a different Cr user', async () => {
    const { db, app, identity, send } = fixture();
    try {
        const begin = await app.request('/begin'), url = new URL((await begin.json() as {
            url: string;
        }).url);
        identity.userId = 'other';
        const response = await app.request(`/callback?state=${url.searchParams.get('state')}&code=x`, { headers: { cookie: begin.headers.get('set-cookie')?.split(';')[0] || '' } });
        expect(response.status).toBe(400);
        expect(send).not.toHaveBeenCalled();
    }
    finally {
        db.close();
    }
});
