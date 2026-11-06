/** Finite existing Google Meet operations; no legacy credentials in this namespace.
 * @implements SPEC-AE-GLAB-MANAGED-MEET-DELEGATION-001
 */
import { Hono } from 'hono';
import { getIdentity } from '../auth.ts';
import { verifyBookingContext } from '../booking-access/context.ts';
import type { DatabaseInput } from '../persistence/database.ts';
import { registeredActor } from '../meetings/identity.ts';
import { MeetingRepository } from '../meetings/repository.ts';
import { MeetingError } from '../meetings/types.ts';
import { withMeetOperation } from '../meet/operation.ts';
import type { RelayCaller } from '../meet/oauth.ts';
import type { CompositeDelegations } from '../vendor/cernere-composite/delegation.js';
import { glabRequestGate, type GlabOperation } from './request-gate.ts';

export const GLAB_MANAGED_MEET_PREFIX = '/api/integrations/glab/meet';
interface Operation extends GlabOperation { meetingId?: string; owner?: boolean }
export function glabManagedMeetOperation(method: string, path: string): Operation | null {
  if (!path.startsWith(GLAB_MANAGED_MEET_PREFIX + '/')) return null;
  const parts = path.slice(GLAB_MANAGED_MEET_PREFIX.length + 1).split('/');
  let action: string | undefined, meetingId: string | undefined;
  if (parts.length === 1 && parts[0] === 'status' && method === 'GET') action = 'meet.status.read';
  else if (parts.length === 2 && parts[0] === 'oauth' && method === 'POST' && ['start', 'complete'].includes(parts[1] ?? '')) action = 'meet.oauth.' + parts[1];
  else if (parts.length === 1 && /^[0-9a-f-]{36}$/i.test(parts[0] ?? '') && ['GET', 'POST'].includes(method)) {
    meetingId = parts[0]; action = method === 'GET' ? 'meet.read' : 'meet.create';
  } else if (parts.length === 3 && parts[0] === 'external' && parts[1] === 'glab-event'
    && /^[1-9][0-9]{0,15}$/.test(parts[2] ?? '') && method === 'POST') action = 'meet.external.create';
  return action ? { action, meetingId, owner: method === 'POST', risk: method === 'GET' ? 'sensitive_read' : 'important',
    booking: true, requireBookingContext: true, maximumBodyBytes: method === 'GET' ? 0 : 8192 } : null;
}

export function makeGlabManagedMeetTarget(db: DatabaseInput, managedMeet: Hono<{ Variables: { glabRelay: RelayCaller | null } }>, delegations: CompositeDelegations,
  adminIds: ReadonlySet<string>): Hono {
  const router = new Hono();
  const { authenticate } = glabRequestGate(delegations, adminIds, glabManagedMeetOperation,
    async (c, operation, next, assertActive, bytes, expiresAt) => {
      const identity = getIdentity(c), url = new URL(c.req.url);
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await withMeetOperation(c, expiresAt, async () => {
        assertActive();
        if (getIdentity(c).userId !== identity.userId) throw new MeetingError(403, '本人確認が変更されました');
        const groups = verifyBookingContext(c.req.header('x-glab-booking-context'), process.env.GLAB_AEDILIS_CONTEXT_SECRET,
          identity.userId, c.req.method, url.pathname + url.search, body);
        const actor = await registeredActor(db, identity.userId, groups);
        if (operation.meetingId) {
          const repo = new MeetingRepository(db);
          await repo.requireReadable(operation.meetingId, actor);
          if (operation.owner) {
            const row = await repo.get(operation.meetingId);
            repo.requireOwner(row, actor);
            if (!row.online_allowed || row.state === 'cancelled') throw new MeetingError(409, 'オンライン参加を有効にした会議で作成できます');
          }
        }
        assertActive();
      }, next);
    });
  router.use('*', authenticate);
  router.route('/', managedMeet);
  router.all('*', c => c.json({ error: 'unclassified_glab_operation' }, 403));
  router.onError((error, c) => c.json({ error: error instanceof MeetingError ? error.message : 'current_meet_operation_unconfirmed' }, error instanceof MeetingError ? error.status : 503));
  return router;
}
