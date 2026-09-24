import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { MeetingConfig } from './config.ts';
import { MeetingError } from './types.ts';
import { text } from './validation.ts';

const NONCE_COOKIE = 'aedilis_login_nonce';
export function beginLogin(c: Context, secure: boolean): string {
  const nonce = randomBytes(32).toString('hex');
  setCookie(c, NONCE_COOKIE, nonce, { path: '/api/meetings/session', httpOnly: true, secure, sameSite: 'Strict', maxAge: 300 });
  return nonce;
}
export async function completeLogin(c: Context, config: MeetingConfig, input: Record<string, unknown>): Promise<void> {
  const nonce = text(input.nonce, 64, true), cookie = getCookie(c, NONCE_COOKIE);
  if (!cookie || nonce.length !== 64 || cookie.length !== 64 || !timingSafeEqual(Buffer.from(nonce), Buffer.from(cookie))) throw new MeetingError(403, 'ログインをやり直してください');
  deleteCookie(c, NONCE_COOKIE, { path: '/api/meetings/session' });
  const code = text(input.code, 2048, true);
  const exchange = await fetch(new URL('/api/auth/exchange', config.cernereUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(10000),
  });
  if (!exchange.ok) throw new MeetingError(401, 'ログインが失効しました。もう一度お試しください');
  const user = await exchange.json() as { accessToken?: string };
  if (!user.accessToken) throw new MeetingError(503, 'Cernereから認証情報を取得できません');
  const project = await fetch(new URL('/api/auth/project-token', config.cernereUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    body: JSON.stringify({ project_key: 'aedilis', hub_url: config.publicUrl }), signal: AbortSignal.timeout(10000),
  });
  if (!project.ok) throw new MeetingError(503, 'CernereのAedilis登録を確認してください');
  const token = await project.json() as { accessToken?: string; expiresIn?: number; tokenType?: string; projectKey?: string };
  if (!token.accessToken?.startsWith('v4.public.') || token.tokenType !== 'user_for_project' || token.projectKey !== 'aedilis') throw new MeetingError(503, 'Cernereの応答形式が不正です');
  setCookie(c, 'cernere_token', token.accessToken, {
    path: '/', secure: new URL(config.publicUrl).protocol === 'https:', httpOnly: true, sameSite: 'Lax', maxAge: Math.min(token.expiresIn || 900, 900),
  });
}
