import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface BookingGroup { kind: 'organization' | 'team'; id: string; name: string }
export interface BookingPrincipal { userId: string | null; groups: BookingGroup[] }

/** v1 GLab assertion: bound to the independently authenticated caller and exact request bytes. */
export function verifyBookingContext(
  assertion: string | undefined, secret: string | undefined, userId: string | null,
  method: string, path: string, body: string, now = Date.now(),
): BookingGroup[] {
  if (!assertion) return [];
  if (!userId || !secret || Buffer.byteLength(secret) < 32 || assertion.length > 32768) {
    throw new Error('Invalid booking context');
  }
  const parts = assertion.split('.');
  if (parts.length !== 2) throw new Error('Invalid booking context');
  const [payload, signature] = parts;
  if (!payload || !signature) throw new Error('Invalid booking context');
  const expected = createHmac('sha256', secret).update(payload).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid booking context');
  const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (value.version !== 1 || value.source !== 'glab' || value.userId !== userId
    || value.method !== method || value.path !== path
    || value.bodyHash !== createHash('sha256').update(body).digest('hex')
    || typeof value.expiresAt !== 'number' || value.expiresAt <= now || value.expiresAt > now + 30000
    || !Array.isArray(value.groups) || value.groups.length > 200) throw new Error('Invalid booking context');
  const groups: BookingGroup[] = [];
  for (const item of value.groups) {
    if (!item || !['organization', 'team'].includes(item.kind)
      || typeof item.id !== 'string' || !item.id || item.id.length > 200
      || typeof item.name !== 'string' || !item.name || item.name.length > 300) throw new Error('Invalid booking context');
    groups.push({ kind: item.kind, id: item.id, name: item.name });
  }
  return groups;
}
