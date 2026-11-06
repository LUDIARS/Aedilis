import { createHash } from 'node:crypto';
import type { OwnSession } from '../meetings/scoped-sessions.ts';
export default {
  post: (result: OwnSession, _nonce: string, _code: string, verifier: string): boolean =>
    /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && /^[A-Za-z0-9_-]{43}$/.test(result.id)
    && result.grant.projectKey === 'aedilis' && !!result.grant.user.id
    && result.grant.sessionBinding === createHash('sha256').update(result.id).digest('base64url')
    && Date.parse(result.grant.expiresAt) >= result.expiresAt
    && Number.isFinite(result.expiresAt) && result.expiresAt > Date.now() && result.expiresAt <= Date.now() + 900_000,
};
