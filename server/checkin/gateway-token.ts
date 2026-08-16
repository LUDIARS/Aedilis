import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Generates the one-time plaintext credential returned when an admin registers a gateway. */
export function issueGatewayToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this SHA-256 digest is persisted, so the token cannot be recovered from the database. */
export function hashGatewayToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function gatewayTokenFromAuthorization(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(header);
  return match?.[1] ?? null;
}

export function tokenHashesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
