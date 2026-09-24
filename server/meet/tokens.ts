import type { CernereProjectClient } from '../lib/cernere-project-client.ts';
import { MeetingError } from '../meetings/types.ts';
import type { MeetConfig } from './config.ts';
import { googleJson } from './google-http.ts';

export interface GoogleToken {
  accessToken: string | null; refreshToken: string | null; expiresAt: string | null;
  tokenType: string | null; scope: string | null;
  metadata: { email?: string; subject?: string; emailVerified?: boolean; meetOrganizer?: boolean };
}
export interface TokenReply { access_token: string; refresh_token?: string; expires_in: number; scope?: string; token_type?: string }
export class MeetTokens {
  private readonly refreshes = new Map<string, Promise<string>>();
  constructor(private readonly client: Pick<CernereProjectClient, 'request'>, private readonly config: MeetConfig, private readonly send: typeof fetch = fetch) {}
  async get(userId: string): Promise<GoogleToken | null> {
    try { return await this.client.request('managed_project', 'get_oauth_token', { userId, provider: 'google' }) as GoogleToken | null; }
    catch { throw new MeetingError(503, 'CrのGoogle連携情報を取得できません'); }
  }
  async store(userId: string, token: GoogleToken): Promise<void> {
    try { await this.client.request('managed_project', 'store_oauth_token', { userId, provider: 'google', ...token }); }
    catch { throw new MeetingError(503, 'CrにGoogle認可を保存できません'); }
  }
  async email(userId: string): Promise<string> {
    const token = await this.get(userId);
    if (!token?.metadata?.emailVerified || !token.metadata.subject || !token.metadata.email) throw new MeetingError(409, 'Googleアカウントを確認してください');
    return token.metadata.email;
  }
  async access(userId: string): Promise<string> {
    const current = this.refreshes.get(userId);
    if (current) return current;
    const pending = this.refresh(userId);
    this.refreshes.set(userId, pending);
    try { return await pending; } finally { this.refreshes.delete(userId); }
  }
  private async refresh(userId: string): Promise<string> {
    const token = await this.get(userId);
    if (!token?.metadata?.meetOrganizer) throw new MeetingError(409, '管理アカウントのGoogle認可が必要です');
    if (token.accessToken && Date.parse(token.expiresAt || '') > Date.now() + 60000) return token.accessToken;
    if (!token.refreshToken) throw new MeetingError(409, '管理アカウントでGoogleを再認可してください');
    const reply = await googleJson<TokenReply>('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: this.config.clientId, client_secret: this.config.clientSecret }),
    }, this.send);
    if (!reply.access_token || !Number.isFinite(reply.expires_in) || reply.expires_in <= 0) throw new MeetingError(503, 'Google認可の更新に失敗しました');
    await this.store(userId, { ...token, accessToken: reply.access_token, refreshToken: reply.refresh_token || token.refreshToken, expiresAt: new Date(Date.now() + reply.expires_in * 1000).toISOString() });
    return reply.access_token;
  }
}
