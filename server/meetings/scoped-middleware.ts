import type { MiddlewareHandler } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import type { DatabaseInput } from '../persistence/database.ts';
import { prepare, transaction } from '../persistence/database.ts';
import { actorFor, owns } from './identity.ts';
import { SESSION_COOKIE } from './cernere-login.ts';
import { meetingOperation } from './operation-policy.ts';
import { MeetingRepository } from './repository.ts';
import type { MeetingSessions } from './scoped-sessions.ts';
import { MeetingError } from './types.ts';

export function scopedMeetings(db: DatabaseInput, sessions?: MeetingSessions): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname.replace(/^\/api\/meetings/, '') || '/';
    c.set('meetingAuth', null);
    if (['/config', '/session/login/start', '/session/login/complete', '/session/logout'].includes(path)) { await next(); return; }
    const id = getCookie(c, SESSION_COOKIE);
    if (!id) { await next(); return; } // Guest/Discord/signed GLAB retain their separate ACLs.
    if (c.req.header('x-glab-booking-context')) throw new MeetingError(403, '認証経路を混在させないでください');
    if (!sessions) throw new MeetingError(503, 'ログイン設定を確認してください');
    let session;
    try { session = await sessions.check(id); }
    catch (error) {
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Strict' });
      throw error; // This request must not silently continue as a guest.
    }
    const user = session.grant.user;
    c.set('meetingAuth', { userId: user.id, displayName: user.displayName, role: user.role, projectKey: 'aedilis', isAdmin: false });
    const operation = meetingOperation(c.req.method, path), repo = new MeetingRepository(db);
    const body = ['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text();
    // Consume the remote permit before acquiring the database transaction. The
    // callback then pins current ACL reads and handler execution to one transaction.
    const authorize = async (): Promise<boolean> => {
      const actor = await actorFor(db, c);
      if (actor.userId !== user.id) return false;
      if (operation.meetingId) {
        await repo.requireReadable(operation.meetingId, actor);
        const row = await repo.get(operation.meetingId);
        if (operation.owner && !owns(actor, row.owner_id)) return false;
        if (operation.responseId) {
          const response = await prepare(db, 'SELECT owner_id FROM meeting_response WHERE id=? AND meeting_id=?').get(operation.responseId, operation.meetingId) as { owner_id: string } | undefined;
          if (!response || !owns(actor, response.owner_id)) return false;
        }
      }
      return true; // Collection/session endpoints enforce per-row/self ACL in their handlers.
    };
    await sessions.run(id, { action: operation.action,
      resource: new URL(c.req.url).pathname + new URL(c.req.url).search, body, requestId: randomUUID() }, operation.risk,
    authorize, async authorizeCurrent => transaction(db, async () => {
      if (!await authorizeCurrent()) throw new MeetingError(403, '対象を操作する権限がありません');
      await next(); if (c.error) throw c.error;
    })());
  };
}
