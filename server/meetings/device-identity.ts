import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { IdentityRow } from './types.ts';

function digest(salt: string, secret: string): Buffer {
  return createHash('sha256').update(salt).update(':').update(secret).digest();
}
export function deviceIdentity(db: Database.Database, cookie: string | undefined, meetingId?: string): IdentityRow | null {
  if (!cookie || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
  const [id, secret] = cookie.split('.');
  if (!id || !secret) return null;
  const row = db.prepare('SELECT owner_id,salt,digest FROM meeting_device WHERE id=? AND expires_at>?').get(id, Date.now()) as
    { owner_id: string; salt: string; digest: string } | undefined;
  if (!row) return null;
  const expected = Buffer.from(row.digest, 'hex');
  const actual = digest(row.salt, secret);
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return null;
  const scope = db.prepare('SELECT meeting_id FROM meeting_discord_respondent WHERE owner_id=?').get(row.owner_id) as { meeting_id: string } | undefined;
  if (scope ? scope.meeting_id !== meetingId : meetingId !== undefined) return null;
  return db.prepare('SELECT id,user_id,notify FROM meeting_identity WHERE id=?').get(row.owner_id) as IdentityRow | undefined ?? null;
}
export function issueDeviceCookie(db: Database.Database, c: Context, ownerId: string,
  options: { name: string; path: string; secure: boolean; lifetime: number }): void {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url'), salt = randomBytes(16).toString('hex');
  db.prepare('DELETE FROM meeting_device WHERE expires_at<=?').run(Date.now());
  db.prepare('INSERT INTO meeting_device(id,owner_id,salt,digest,expires_at) VALUES(?,?,?,?,?)')
    .run(id, ownerId, salt, digest(salt, secret).toString('hex'), Date.now() + options.lifetime * 1000);
  setCookie(c, options.name, id + '.' + secret, { path: options.path, secure: options.secure,
    httpOnly: true, sameSite: 'Lax', maxAge: options.lifetime });
}
