import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AuthIdentity } from '../auth.ts';
import { MeetingError } from '../meetings/types.ts';
import { ORGANIZER_SCOPES, type MeetConfig } from './config.ts';
import { googleJson } from './google-http.ts';
import { MeetTokens, type TokenReply } from './tokens.ts';

const COOKIE = 'aedilis_meet_oauth';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export class MeetOAuth {
  constructor(private readonly db: Database.Database, private readonly config: MeetConfig, private readonly tokens: MeetTokens, private readonly send: typeof fetch = fetch) {}
  private callback(): string { return new URL('/api/meet/oauth/callback', this.config.publicUrl).href; }
  begin(c: Context, identity: AuthIdentity, mode: 'creator' | 'organizer', returnPath: string): string {
    if (!this.config.clientId || !this.config.clientSecret) throw new MeetingError(503, '管理者によるGoogle API設定が必要です');
    if (mode === 'organizer' && !identity.isAdmin) throw new MeetingError(403, '管理者のみ設定できます');
    const organizer = this.db.prepare('SELECT user_id FROM meet_organizer WHERE singleton=1').get() as { user_id: string } | undefined;
    if (mode === 'creator' && organizer?.user_id === identity.userId) throw new MeetingError(409, '管理アカウントは管理用のGoogle再認可を利用してください');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM meet_oauth_state WHERE expires_at<? OR user_id=?').run(Date.now(), identity.userId);
    const destination = /^\/meeting\/[0-9a-f-]{36}$/i.test(returnPath) ? returnPath : '/meetings';
    this.db.prepare('INSERT INTO meet_oauth_state VALUES(?,?,?,?,?,?)').run(hash(state), identity.userId, mode, verifier, Date.now() + 600000, destination);
    setCookie(c, COOKIE, state, { path: '/api/meet/oauth', httpOnly: true, secure: this.config.publicUrl.startsWith('https:'), sameSite: 'Lax', maxAge: 600 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.callback(), response_type: 'code', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: (mode === 'organizer' ? ORGANIZER_SCOPES : ['openid', 'email']).join(' '), access_type: mode === 'organizer' ? 'offline' : 'online', prompt: mode === 'organizer' ? 'consent select_account' : 'select_account' }).toString();
    return url.href;
  }
  async complete(c: Context, identity: AuthIdentity): Promise<string> {
    const state = c.req.query('state') || '', cookie = getCookie(c, COOKIE) || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(cookie) || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) throw new MeetingError(403, 'Google認可をやり直してください');
    const row = this.db.prepare('DELETE FROM meet_oauth_state WHERE state_hash=? AND user_id=? AND expires_at>? RETURNING *').get(hash(state), identity.userId, Date.now()) as { mode: string; verifier: string; return_path: string } | undefined;
    deleteCookie(c, COOKIE, { path: '/api/meet/oauth', secure: this.config.publicUrl.startsWith('https:'), httpOnly: true, sameSite: 'Lax' });
    if (!row || (row.mode === 'organizer' && !identity.isAdmin)) throw new MeetingError(403, 'Google認可が失効しました');
    const organizer = this.db.prepare('SELECT user_id FROM meet_organizer WHERE singleton=1').get() as { user_id: string } | undefined;
    if (row.mode === 'creator' && organizer?.user_id === identity.userId) throw new MeetingError(409, '管理用のGoogle再認可を利用してください');
    const code = c.req.query('code');
    if (!code || code.length > 4096 || c.req.query('error')) throw new MeetingError(400, 'Google認可がキャンセルされました');
    const reply = await googleJson<TokenReply>('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: row.verifier, client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: this.callback() }) }, this.send);
    if (!reply.access_token || !Number.isFinite(reply.expires_in) || reply.expires_in <= 0) throw new MeetingError(503, 'Googleの認可応答が不正です');
    // This binds a Google account to an already authenticated Cr user, never logs into Cr.
    const user = await googleJson<{ sub?: string; email?: string; email_verified?: boolean; hd?: string }>('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${reply.access_token}` } }, this.send);
    if (!user.sub || !user.email || user.email_verified !== true) throw new MeetingError(403, '確認済みのGoogleメールアドレスが必要です');
    if (row.mode === 'organizer' && (!user.hd || ORGANIZER_SCOPES.filter(s => s.startsWith('https:')).some(s => !reply.scope?.split(' ').includes(s)))) throw new MeetingError(403, 'Workspace管理アカウントでMeetの作成・設定権限を許可してください');
    const old = await this.tokens.get(identity.userId);
    const refreshToken = reply.refresh_token || (old?.metadata?.subject === user.sub ? old.refreshToken : null);
    if (row.mode === 'organizer' && !refreshToken) throw new MeetingError(409, '管理アカウントでオフラインアクセスを再認可してください');
    // Never silently replace the Google identity after it has been assigned to a meeting.
    const linked = this.db.prepare('SELECT 1 FROM meeting_meet WHERE creator_id=? OR organizer_id=? LIMIT 1').get(identity.userId, identity.userId);
    if (linked && old?.metadata?.subject !== user.sub) throw new MeetingError(409, '作成済みMeetに紐づくGoogleアカウントは変更できません');
    await this.tokens.store(identity.userId, { accessToken: reply.access_token, refreshToken, expiresAt: new Date(Date.now() + reply.expires_in * 1000).toISOString(), tokenType: 'Bearer', scope: reply.scope || 'openid email', metadata: { subject: user.sub, email: user.email, emailVerified: true, meetOrganizer: row.mode === 'organizer' } });
    if (row.mode === 'organizer') this.db.prepare('INSERT INTO meet_organizer VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET user_id=excluded.user_id').run(identity.userId);
    return row.return_path;
  }
}
