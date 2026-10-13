import { prepare, type DatabaseInput } from '../persistence/database.ts';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { IdentityRow } from './types.ts';
function digest(salt: string, secret: string): Buffer {
    return createHash('sha256').update(salt).update(':').update(secret).digest();
}
export async function deviceIdentity(db: DatabaseInput, cookie: string | undefined, meetingId?: string): Promise<IdentityRow | null> {
    if (!cookie || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(cookie))
        return null;
    const [id, secret] = cookie.split('.');
    if (!id || !secret)
        return null;
    const row = (await prepare(db, 'SELECT owner_id,salt,digest FROM meeting_device WHERE id=? AND expires_at>?').get(id, Date.now())) as {
        owner_id: string;
        salt: string;
        digest: string;
    } | undefined;
    if (!row)
        return null;
    const expected = Buffer.from(row.digest, 'hex');
    const actual = digest(row.salt, secret);
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected))
        return null;
    const scope = (await prepare(db, 'SELECT meeting_id FROM meeting_discord_respondent WHERE owner_id=?').get(row.owner_id)) as {
        meeting_id: string;
    } | undefined;
    if (scope ? scope.meeting_id !== meetingId : meetingId !== undefined)
        return null;
    return (await prepare(db, 'SELECT id,user_id,notify FROM meeting_identity WHERE id=?').get(row.owner_id)) as IdentityRow | undefined ?? null;
}
export async function issueDeviceCookie(db: DatabaseInput, c: Context, ownerId: string, options: {
    name: string;
    path: string;
    secure: boolean;
    lifetime: number;
}): Promise<void> {
    const id = randomUUID(), secret = randomBytes(32).toString('base64url'), salt = randomBytes(16).toString('hex');
    (await prepare(db, 'DELETE FROM meeting_device WHERE expires_at<=?').run(Date.now()));
    (await prepare(db, 'INSERT INTO meeting_device(id,owner_id,salt,digest,expires_at) VALUES(?,?,?,?,?)').run(id, ownerId, salt, digest(salt, secret).toString('hex'), Date.now() + options.lifetime * 1000));
    setCookie(c, options.name, id + '.' + secret, { path: options.path, secure: options.secure,
        httpOnly: true, sameSite: 'Lax', maxAge: options.lifetime });
}
