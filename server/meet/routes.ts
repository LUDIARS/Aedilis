import type { DatabaseInput } from '../persistence/database.ts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requireAuth, getIdentity } from '../auth.ts';
import type { CernereProjectClient } from '../lib/cernere-project-client.ts';
import { bookingPrincipal } from '../booking-access/request.ts';
import { actorFor } from '../meetings/identity.ts';
import { MeetingRepository } from '../meetings/repository.ts';
import { MeetingError } from '../meetings/types.ts';
import { object } from '../meetings/validation.ts';
import type { MeetConfig } from './config.ts';
import { MeetTokens } from './tokens.ts';
import { MeetOAuth } from './oauth.ts';
import { MeetApi } from './api.ts';
import { MeetProvisioner } from './provision.ts';
import { organizationOrganizer, singletonOrganizer } from './organizers.ts';
import { externalSpace } from './space-store.ts';
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
import type { MeetAuthorizationTarget, RelayCaller } from './oauth.ts';
/**
 * A GLab-signed booking context binds the authenticated Cr user to the exact method, path and body, so a relayed
 * request cannot be forged cross-site. Invalid assertions throw (403) instead of falling back to the origin check.
 */
async function relayedByGlab(c: Context): Promise<RelayCaller | null> {
    if (!c.req.header('x-glab-booking-context')) return null;
    try {
        const principal = await bookingPrincipal(c);
        return principal.userId && principal.source ? { source: principal.source, groups: principal.groups } : null;
    }
    catch {
        throw new MeetingError(403, 'GLabからの依頼を確認できません');
    }
}
function authorizationTarget(input: Record<string, unknown>, relay: RelayCaller | null): MeetAuthorizationTarget {
    if (input.mode !== 'creator' && input.mode !== 'organizer')
        throw new MeetingError(400, '認可の種類を選んでください');
    if (input.organizationId === undefined)
        return { mode: input.mode };
    // Organization representatives come only from a front end that signs organization memberships.
    if (!relay || input.mode !== 'organizer' || typeof input.organizationId !== 'string' || !input.organizationId || input.organizationId.length > 200)
        throw new MeetingError(400, '組織の指定が不正です');
    return { mode: 'organizer', organizationId: input.organizationId };
}
export function managedMeetRoutes(db: DatabaseInput, client: CernereProjectClient, config: MeetConfig): Hono<{ Variables: { glabRelay: RelayCaller | null } }> {
    const app = new Hono<{ Variables: { glabRelay: RelayCaller | null } }>(), tokens = new MeetTokens(client, config), oauth = new MeetOAuth(db, config, tokens);
    const repo = new MeetingRepository(db), provision = new MeetProvisioner(db, tokens, new MeetApi());
    app.use('*', bodyLimit({ maxSize: 8192 }));
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        c.header('Referrer-Policy', 'no-referrer');
        const relayed = await relayedByGlab(c);
        c.set('glabRelay', relayed);
        if (c.req.method !== 'GET' && ((!relayed && c.req.header('origin') !== new URL(config.publicUrl).origin) || !c.req.header('content-type')?.startsWith('application/json')))
            throw new MeetingError(403, '同じサイトから操作してください');
        await next();
    });
    app.use('*', requireAuth);
    app.use('*', async (c, next) => {
        if (getIdentity(c).projectKey !== 'aedilis')
            throw new MeetingError(403, 'Aeへログインしてください');
        await next();
    });
    app.onError((error, c) => c.json({ error: error instanceof MeetingError ? error.message : 'Meet連携に失敗しました。再読込してください' }, error instanceof MeetingError ? error.status : 503));
    app.get('/status', async (c) => {
        const identity = getIdentity(c), token = await tokens.get(identity.userId);
        const organizer = await singletonOrganizer(db);
        // Only organizations the caller represents: their own connection state, never other members' accounts.
        const organizations = await Promise.all((c.get('glabRelay')?.groups ?? [])
            .filter(group => group.kind === 'organization' && group.representative === true)
            .map(async (group) => {
                const representative = await organizationOrganizer(db, group.id);
                return { id: group.id, name: group.name, organizerConnected: !!representative, isOrganizer: representative === identity.userId };
            }));
        return c.json({ configured: !!config.clientId && !!config.clientSecret, isAdmin: identity.isAdmin, organizerConnected: !!organizer, isOrganizer: organizer === identity.userId, organizations, googleConnected: !!token?.metadata?.emailVerified, email: token?.metadata?.email || null });
    });
    app.post('/oauth/start', async (c) => {
        const input = object(await c.req.json()), relay = c.get('glabRelay');
        const target = authorizationTarget(input, relay);
        if (input.redirectUri !== undefined || relay) {
            // A relayed front end receives the Google redirect on its own callback; Ae's own page on Ae's.
            if (!relay || typeof input.redirectUri !== 'string')
                throw new MeetingError(403, 'この戻り先からのGoogle認可は許可されていません');
            return c.json({ url: await oauth.beginExternal(getIdentity(c), target, input.redirectUri, relay) });
        }
        return c.json({ url: (await oauth.begin(c, getIdentity(c), target.mode, typeof input.returnPath === 'string' ? input.returnPath : '')) });
    });
    app.post('/oauth/complete', async (c) => {
        const relay = c.get('glabRelay');
        if (!relay)
            throw new MeetingError(403, 'GLabからの依頼を確認できません');
        const input = object(await c.req.json());
        const target = await oauth.completeExternal(getIdentity(c), input.state, input.code, relay);
        return c.json({ mode: target.mode, ...(target.organizationId ? { organizationId: target.organizationId } : {}) });
    });
    app.get('/oauth/callback', async (c) => {
        return c.redirect(await oauth.complete(c, getIdentity(c)));
    });
    // Events owned by a trusted front end (GLab events). The front end decides who may see or issue them; Ae only
    // accepts its signed relay and keys the space by `<source>:<event id>` (SPEC-MANAGED-MEET-EXTERNAL-EVENT).
    const external = (c: Context): { relay: RelayCaller; store: ReturnType<typeof externalSpace> } => {
        const relay = c.get('glabRelay');
        if (!relay)
            throw new MeetingError(403, 'GLabからの依頼を確認できません');
        const kind = c.req.param('kind') ?? '', id = c.req.param('id') ?? '';
        if (kind !== 'glab-event' || !EXTERNAL_ID.test(id))
            throw new MeetingError(404, '予定が見つかりません');
        return { relay, store: externalSpace(db, `${relay.source}-event`, id) };
    };
    app.get('/external/:kind/:id', async (c) => {
        const { store } = external(c);
        return c.json(provision.view(await store.row()));
    });
    app.post('/external/:kind/:id', async (c) => {
        const { relay, store } = external(c);
        const input = object(await c.req.json());
        let organizationId: string | null = null;
        if (input.organizationId !== undefined) {
            // A member may host an event for an organization it belongs to; the host is that organization's representative.
            if (typeof input.organizationId !== 'string' || !relay.groups.some(group => group.kind === 'organization' && group.id === input.organizationId))
                throw new MeetingError(403, '所属する組織を選んでください');
            organizationId = input.organizationId;
        }
        return c.json(await provision.ensureSpace(store, getIdentity(c).userId, {
            creatorGoogle: 'optional',
            organizer: async () => (organizationId ? await organizationOrganizer(db, organizationId) : null) ?? singletonOrganizer(db),
        }));
    });
    app.get('/:id', async (c) => {
        (await repo.requireReadable(c.req.param('id'), await actorFor(db, c)));
        const row = (await repo.get(c.req.param('id')));
        if (row.state === 'cancelled')
            return c.json({ status: 'cancelled' });
        return c.json((await provision.get(row.id)));
    });
    app.post('/:id', async (c) => {
        const row = (await repo.get(c.req.param('id'))), identity = getIdentity(c);
        const actor = await actorFor(db, c);
        repo.requireOwner(row, actor);
        if (!row.online_allowed || row.state === 'cancelled')
            throw new MeetingError(409, 'オンライン参加を有効にした会議で作成できます');
        return c.json(await provision.ensure(row.id, identity.userId, { creatorGoogle: c.get('glabRelay') ? 'optional' : 'required' }));
    });
    return app;
}
