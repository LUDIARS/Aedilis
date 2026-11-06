import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { MeetingError } from './types.ts';
import type { MeetingSessions } from './scoped-sessions.ts';

export const SESSION_COOKIE = '__Host-aedilis_meeting_session';
const NONCE_COOKIE = '__Host-aedilis_login_nonce';
const options = { path: '/', httpOnly: true, secure: true, sameSite: 'Strict' as const };

export function beginLogin(c: Context, sessions: MeetingSessions): string {
  const nonce = sessions.beginLogin(getCookie(c, NONCE_COOKIE));
  setCookie(c, NONCE_COOKIE, nonce, { ...options, maxAge: 300 });
  return nonce;
}
export async function completeLogin(c: Context, sessions: MeetingSessions, input: Record<string, unknown>): Promise<void> {
  const nonce = getCookie(c, NONCE_COOKIE);
  if (!nonce || input.nonce !== nonce || typeof input.code !== 'string' || typeof input.verifier !== 'string') {
    throw new MeetingError(403, 'ログインをやり直してください');
  }
  // Retain nonce until the response: parallel logout can cancel the claimed attempt.
  await sessions.logout(getCookie(c, SESSION_COOKIE));
  const session = await sessions.completeLogin(nonce, input.code, input.verifier);
  deleteCookie(c, NONCE_COOKIE, options);
  setCookie(c, SESSION_COOKIE, session.id, { ...options, maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) });
}
export async function logout(c: Context, sessions: MeetingSessions): Promise<void> {
  deleteCookie(c, SESSION_COOKIE, options);
  deleteCookie(c, NONCE_COOKIE, options);
  await sessions.logout(getCookie(c, SESSION_COOKIE), getCookie(c, NONCE_COOKIE));
}
