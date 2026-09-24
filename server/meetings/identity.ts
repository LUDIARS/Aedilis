import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readIdentity } from '../auth.ts';
import { MeetingError, type Actor, type IdentityRow } from './types.ts';

const COOKIE = 'aedilis_meeting_device';
const LIFETIME = 180 * 86400;
function digest(salt: string, secret: string): Buffer {
  // The secret has 256 bits of entropy; a salted digest is sufficient for this capability.
  return createHash('sha256').update(salt).update(':').update(secret).digest();
}
export function deviceIdentity(db: Database.Database, cookie: string | undefined): IdentityRow | null {
  if (!cookie || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
  const [id, secret] = cookie.split('.');
  if (!id || !secret) return null;
  const row = db.prepare('SELECT * FROM meeting_device WHERE id = ? AND expires_at > ?').get(id, Date.now()) as
    { owner_id: string; salt: string; digest: string } | undefined;
  if (!row || !timingSafeEqual(digest(row.salt, secret), Buffer.from(row.digest, 'hex'))) return null;
  return db.prepare('SELECT id, user_id, notify FROM meeting_identity WHERE id = ?').get(row.owner_id) as IdentityRow;
}
export async function actorFor(db: Database.Database, c: Context): Promise<Actor> {
  const auth = await readIdentity(c);
  const userId = auth?.projectKey === 'aedilis' ? auth.userId : null;
  const identities = userId ? db.prepare('SELECT id, user_id, notify FROM meeting_identity WHERE user_id = ? ORDER BY created_at').all(userId) as IdentityRow[] : [];
  const device = deviceIdentity(db, getCookie(c, COOKIE));
  if (device && !device.user_id && !identities.some(i => i.id === device.id)) identities.push(device);
  return { identities, current: identities[0] ?? null, userId };
}
export function ensureActor(db: Database.Database, c: Context, actor: Actor, secure: boolean): Actor {
  if (actor.current) return actor;
  const id = randomUUID();
  db.prepare('INSERT INTO meeting_identity(id,user_id,created_at) VALUES(?,?,?)').run(id, actor.userId, Date.now());
  const identity: IdentityRow = { id, user_id: actor.userId, notify: 0 };
  if (!actor.userId) {
    const deviceId = randomUUID(), secret = randomBytes(32).toString('base64url'), salt = randomBytes(16).toString('hex');
    db.prepare('DELETE FROM meeting_device WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO meeting_device VALUES(?,?,?,?,?)').run(deviceId, id, salt, digest(salt, secret).toString('hex'), Date.now() + LIFETIME * 1000);
    setCookie(c, COOKIE, `${deviceId}.${secret}`, { httpOnly: true, secure, sameSite: 'Lax', path: '/api/meetings', maxAge: LIFETIME });
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
