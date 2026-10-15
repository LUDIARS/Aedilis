import { prepare, type DatabaseInput } from '../persistence/database.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AuthIdentity } from '../auth.ts';
import type { BookingGroup } from '../booking-access/context.ts';
import { MeetingError } from '../meetings/types.ts';
import { ORGANIZER_SCOPES, type MeetConfig, type RelaySource } from './config.ts';
import { googleJson } from './google-http.ts';
import { MeetTokens, type TokenReply } from './tokens.ts';
import { isAnyOrganizer, saveOrganizationOrganizer, saveSingletonOrganizer } from './organizers.ts';
const COOKIE = 'aedilis_meet_oauth';
/**
 * A front end such as GLab receives the Google redirect on its own origin and relays code+state with the same
 * authenticated Cr user. Its source and redirect URI are kept in `return_path` as `external:<source>:<uri>` (no
 * schema change), so the Ae callback can never complete an external flow, the external completion can never complete
 * an Ae flow, and one front end can never complete a flow started through another.
 */
const EXTERNAL_PREFIX = 'external:';
type Mode = 'creator' | 'organizer';
/** `organizationId` makes the organizer the representative of that organization instead of Ae's representative. */
export interface MeetAuthorizationTarget { mode: Mode; organizationId?: string }
/** The verified front end that relayed the request, with the groups it signed for the caller. */
export interface RelayCaller { source: RelaySource; groups: readonly BookingGroup[] }
interface StateRow { mode: string; verifier: string; return_path: string }
const ORGANIZATION_MODE = 'organizer:organization:';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const validState = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);
function encodeMode(target: MeetAuthorizationTarget): string {
    return target.mode === 'organizer' && target.organizationId ? ORGANIZATION_MODE + target.organizationId : target.mode;
}
function decodeMode(value: string): MeetAuthorizationTarget {
    if (value.startsWith(ORGANIZATION_MODE)) return { mode: 'organizer', organizationId: value.slice(ORGANIZATION_MODE.length) };
    return { mode: value === 'organizer' ? 'organizer' : 'creator' };
}
export class MeetOAuth {
    constructor(private readonly db: DatabaseInput, private readonly config: MeetConfig, private readonly tokens: MeetTokens, private readonly send: typeof fetch = fetch) { }
    private callback(): string { return new URL('/api/meet/oauth/callback', this.config.publicUrl).href; }
    private allowedExternal(source: RelaySource, redirectUri: string): string {
        let normalized: string;
        try { normalized = new URL(redirectUri).href; }
        catch { throw new MeetingError(400, '戻り先が不正です'); }
        if (!(this.config.externalRedirectUris?.[source] ?? []).includes(normalized))
            throw new MeetingError(403, 'この戻り先からのGoogle認可は許可されていません');
        return normalized;
    }
    /**
     * Organizer rights are checked when the flow starts and again when it completes (membership may change).
     * `refusal` replaces the 403 text at completion so a stale flow does not reveal why it stopped.
     */
    private async requireAllowed(identity: AuthIdentity, target: MeetAuthorizationTarget, groups: readonly BookingGroup[], refusal?: string): Promise<void> {
        if (target.mode === 'organizer' && target.organizationId) {
            if (!groups.some(group => group.kind === 'organization' && group.id === target.organizationId && group.representative === true))
                throw new MeetingError(403, refusal ?? '組織の代表者のみ設定できます');
        }
        else if (target.mode === 'organizer' && !identity.isAdmin)
            throw new MeetingError(403, refusal ?? '管理者のみ設定できます');
        if (target.mode === 'creator' && await isAnyOrganizer(this.db, identity.userId))
            throw new MeetingError(409, '代表アカウントは代表用のGoogle再認可を利用してください');
    }
    /** Shared by the Ae page flow and a trusted front end flow: checks, one-use state row and the Google URL. */
    private async authorizationUrl(identity: AuthIdentity, target: MeetAuthorizationTarget, storedPath: string, redirectUri: string, groups: readonly BookingGroup[]): Promise<{ url: string; state: string }> {
        if (!this.config.clientId || !this.config.clientSecret)
            throw new MeetingError(503, '管理者によるGoogle API設定が必要です');
        await this.requireAllowed(identity, target, groups);
        const organizer = target.mode === 'organizer';
        const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
        (await prepare(this.db, 'DELETE FROM meet_oauth_state WHERE expires_at<? OR user_id=?').run(Date.now(), identity.userId));
        (await prepare(this.db, 'INSERT INTO meet_oauth_state VALUES(?,?,?,?,?,?)').run(hash(state), identity.userId, encodeMode(target), verifier, Date.now() + 600000, storedPath));
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: (organizer ? ORGANIZER_SCOPES : ['openid', 'email']).join(' '), access_type: organizer ? 'offline' : 'online', prompt: organizer ? 'consent select_account' : 'select_account' }).toString();
        return { url: url.href, state };
    }
    async begin(c: Context, identity: AuthIdentity, mode: Mode, returnPath: string): Promise<string> {
        const destination = /^\/meeting\/[0-9a-f-]{36}$/i.test(returnPath) ? returnPath : '/meetings';
        const { url, state } = await this.authorizationUrl(identity, { mode }, destination, this.callback(), []);
        setCookie(c, COOKIE, state, { path: '/api/meet/oauth', httpOnly: true, secure: this.config.publicUrl.startsWith('https:'), sameSite: 'Lax', maxAge: 600 });
        return url;
    }
    /**
     * Front end flow. No Ae cookie exists in the browser, so the binding is: state row ↔ the Cr user who started it
     * through that front end, and completion only through `completeExternal` by that same user and front end. A victim
     * who authorizes an attacker's URL cannot complete it (state belongs to the attacker) and the attacker never sees
     * the code.
     */
    async beginExternal(identity: AuthIdentity, target: MeetAuthorizationTarget, redirectUri: string, caller: RelayCaller): Promise<string> {
        const allowed = this.allowedExternal(caller.source, redirectUri);
        return (await this.authorizationUrl(identity, target, `${EXTERNAL_PREFIX}${caller.source}:${allowed}`, allowed, caller.groups)).url;
    }
    async complete(c: Context, identity: AuthIdentity): Promise<string> {
        const state = c.req.query('state') || '', cookie = getCookie(c, COOKIE) || '';
        if (!validState(state) || !validState(cookie) || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie)))
            throw new MeetingError(403, 'Google認可をやり直してください');
        const row = await this.takeState(state, identity);
        deleteCookie(c, COOKIE, { path: '/api/meet/oauth', secure: this.config.publicUrl.startsWith('https:'), httpOnly: true, sameSite: 'Lax' });
        if (!row || row.return_path.startsWith(EXTERNAL_PREFIX))
            throw new MeetingError(403, 'Google認可が失効しました');
        if (c.req.query('error'))
            throw new MeetingError(400, 'Google認可がキャンセルされました');
        await this.bind(row, identity, c.req.query('code'), this.callback(), []);
        return row.return_path;
    }
    async completeExternal(identity: AuthIdentity, state: unknown, code: unknown, caller: RelayCaller): Promise<MeetAuthorizationTarget> {
        if (typeof state !== 'string' || !validState(state))
            throw new MeetingError(403, 'Google認可をやり直してください');
        const row = await this.takeState(state, identity);
        const sourcePrefix = `${EXTERNAL_PREFIX}${caller.source}:`;
        if (!row || !row.return_path.startsWith(sourcePrefix))
            throw new MeetingError(403, 'Google認可が失効しました');
        const redirectUri = this.allowedExternal(caller.source, row.return_path.slice(sourcePrefix.length));
        await this.bind(row, identity, typeof code === 'string' ? code : undefined, redirectUri, caller.groups);
        return decodeMode(row.mode);
    }
    private async takeState(state: string, identity: AuthIdentity): Promise<StateRow | undefined> {
        return (await prepare(this.db, 'DELETE FROM meet_oauth_state WHERE state_hash=? AND user_id=? AND expires_at>? RETURNING *').get(hash(state), identity.userId, Date.now())) as StateRow | undefined;
    }
    private async bind(row: StateRow, identity: AuthIdentity, code: string | undefined, redirectUri: string, groups: readonly BookingGroup[]): Promise<void> {
        const target = decodeMode(row.mode), organizer = target.mode === 'organizer';
        await this.requireAllowed(identity, target, groups, 'Google認可が失効しました');
        if (!code || code.length > 4096)
            throw new MeetingError(400, 'Google認可がキャンセルされました');
        const reply = await googleJson<TokenReply>('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: row.verifier, client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: redirectUri }) }, this.send);
        if (!reply.access_token || !Number.isFinite(reply.expires_in) || reply.expires_in <= 0)
            throw new MeetingError(503, 'Googleの認可応答が不正です');
        // This binds a Google account to an already authenticated Cr user, never logs into Cr.
        const user = await googleJson<{
            sub?: string;
            email?: string;
            email_verified?: boolean;
            hd?: string;
        }>('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${reply.access_token}` } }, this.send);
        if (!user.sub || !user.email || user.email_verified !== true)
            throw new MeetingError(403, '確認済みのGoogleメールアドレスが必要です');
        if (organizer && (!user.hd || ORGANIZER_SCOPES.filter(s => s.startsWith('https:')).some(s => !reply.scope?.split(' ').includes(s))))
            throw new MeetingError(403, 'Workspace管理アカウントでMeetの作成・設定権限を許可してください');
        const old = await this.tokens.get(identity.userId);
        const refreshToken = reply.refresh_token || (old?.metadata?.subject === user.sub ? old.refreshToken : null);
        if (organizer && !refreshToken)
            throw new MeetingError(409, '管理アカウントでオフラインアクセスを再認可してください');
        // Never silently replace the Google identity after it has been assigned to a meeting.
        const linked = (await prepare(this.db, 'SELECT 1 FROM meeting_meet WHERE creator_id=? OR organizer_id=? LIMIT 1').get(identity.userId, identity.userId));
        if (linked && old?.metadata?.subject !== user.sub)
            throw new MeetingError(409, '作成済みMeetに紐づくGoogleアカウントは変更できません');
        await this.tokens.store(identity.userId, { accessToken: reply.access_token, refreshToken, expiresAt: new Date(Date.now() + reply.expires_in * 1000).toISOString(), tokenType: 'Bearer', scope: reply.scope || 'openid email', metadata: { subject: user.sub, email: user.email, emailVerified: true, meetOrganizer: organizer } });
        if (target.organizationId)
            await saveOrganizationOrganizer(this.db, target.organizationId, identity.userId);
        else if (organizer)
            await saveSingletonOrganizer(this.db, identity.userId);
    }
}
