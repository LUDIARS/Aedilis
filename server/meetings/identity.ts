import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { readIdentity } from '../auth.ts';
import { bookingPrincipal } from '../booking-access/request.ts';
import { MeetingError, type Actor, type IdentityRow } from './types.ts';
import { deviceIdentity, issueDeviceCookie } from './device-identity.ts';
import { discordRespondentActor } from './discord-respondent.ts';
export { deviceIdentity } from './device-identity.ts';

const COOKIE = 'aedilis_meeting_device';
const LIFETIME = 180 * 86400;
export async function actorFor(db: Database.Database, c: Context): Promise<Actor> {
  const discord = discordRespondentActor(db, c);
  if (discord) return discord;
  const auth = await readIdentity(c);
  const userId = auth?.projectKey === 'aedilis' ? auth.userId : null;
  const identities = userId ? db.prepare('SELECT id, user_id, notify FROM meeting_identity WHERE user_id = ? ORDER BY created_at').all(userId) as IdentityRow[] : [];
  const device = deviceIdentity(db, getCookie(c, COOKIE));
  if (device && !device.user_id && !identities.some(i => i.id === device.id)) identities.push(device);
  const principal = await bookingPrincipal(c);
  return { identities, current: identities[0] ?? null, userId, groups: principal.groups };
}
export function ensureActor(db: Database.Database, c: Context, actor: Actor, secure: boolean): Actor {
  if (actor.current) return actor;
  const id = randomUUID();
  db.prepare('INSERT INTO meeting_identity(id,user_id,created_at) VALUES(?,?,?)').run(id, actor.userId, Date.now());
  const identity: IdentityRow = { id, user_id: actor.userId, notify: 0 };
  if (!actor.userId) {
    issueDeviceCookie(db, c, id, { name: COOKIE, path: '/api/meetings', secure, lifetime: LIFETIME });
  }
  return { ...actor, current: identity, identities: [...actor.identities, identity] };
}
export function linkActor(db: Database.Database, c: Context, actor: Actor, secure: boolean): void {
  if (!actor.userId) throw new MeetingError(401, 'Cernereへのログインが必要です');
  const device = deviceIdentity(db, getCookie(c, COOKIE));
  if (device) db.transaction(() => {
    if (device.user_id && device.user_id !== actor.userId) throw new MeetingError(409, '別のアカウントに登録済みです');
    db.prepare('UPDATE meeting_identity SET user_id = ? WHERE id = ?').run(actor.userId, device.id);
    db.prepare('DELETE FROM meeting_device WHERE owner_id = ?').run(device.id);
  })();
  deleteCookie(c, COOKIE, { path: '/api/meetings', secure, httpOnly: true, sameSite: 'Lax' });
}
export function owns(actor: Actor, owner: string): boolean { return actor.identities.some(i => i.id === owner); }
