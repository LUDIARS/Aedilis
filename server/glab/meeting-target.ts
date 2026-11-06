import { Hono } from 'hono';
import { getIdentity } from '../auth.ts';
import { prepare, transaction, type DatabaseInput } from '../persistence/database.ts';
import { registeredActor, owns } from '../meetings/identity.ts';
import { MeetingRepository } from '../meetings/repository.ts';
import { MeetingError } from '../meetings/types.ts';
import { verifyBookingContext } from '../booking-access/context.ts';
import type { CompositeDelegations } from '../vendor/cernere-composite/delegation.js';
import { glabRequestGate, type GlabOperation } from './request-gate.ts';

export const GLAB_MEETING_PREFIX = '/api/integrations/glab/meetings';
interface Operation extends GlabOperation { meetingId?: string; owner: boolean; responseId?: string }
const uuid = (value: string | undefined): value is string => !!value && /^[0-9a-f-]{36}$/i.test(value);
/** Exact operations of the existing meeting router, excluding session/guest/Meet APIs.
 * @implements SPEC-AE-GLAB-MEETING-DELEGATION-001
 */
export function glabMeetingOperation(method: string, path: string): Operation | null {
  if (path !== GLAB_MEETING_PREFIX && !path.startsWith(GLAB_MEETING_PREFIX + '/')) return null;
  const relative = path.slice(GLAB_MEETING_PREFIX.length) || '/';
  let action: string | null = null;
  let owner = false;
  let meetingId: string | undefined, responseId: string | undefined;
  if (relative === '/' && method === 'GET') action = 'meetings.list.read';
  else if (relative === '/mine' && method === 'GET') action = 'meetings.mine.read';
  else if (relative === '/' && method === 'POST') action = 'meetings.create';
  else {
    const parts = relative.slice(1).split('/');
    if (!uuid(parts[0])) return null;
    meetingId = parts[0];
    if (parts.length === 1) {
      if (method === 'GET') action = 'meetings.read';
      if (method === 'PATCH') { action = 'meetings.update'; owner = true; }
      if (method === 'DELETE') { action = 'meetings.cancel'; owner = true; }
    } else if (parts.length === 2 && parts[1] === 'finalize' && method === 'POST') {
      action = 'meetings.finalize'; owner = true;
    } else if (parts.length === 2 && parts[1] === 'responses' && method === 'POST') action = 'meetings.response.create';
    else if (parts.length === 3 && parts[1] === 'responses' && uuid(parts[2]) && method === 'PATCH') {
      action = 'meetings.response.update'; responseId = parts[2];
    } else if (parts.length === 3 && parts[1] === 'glab-event' && ['finalize', 'cancel'].includes(parts[2] ?? '') && method === 'POST') {
      action = 'meetings.glab-event.' + parts[2]; owner = true;
    }
  }
  return action ? { action, risk: method === 'GET' ? 'sensitive_read' : 'important', booking: true, requireBookingContext: true,
    maximumBodyBytes: method === 'GET' ? 0 : 64 * 1024, owner, meetingId, responseId } : null;
}

class RejectedHandlerResponse extends Error {}

/** One DB transaction contains current resource ACL and the existing handler.
 * @implements SPEC-AE-GLAB-MEETING-DELEGATION-001
 */
export function makeGlabMeetingTarget(db: DatabaseInput, meetings: Hono, delegations: CompositeDelegations, adminIds: ReadonlySet<string>): Hono {
  const router = new Hono();
  const { authenticate } = glabRequestGate(delegations, adminIds, glabMeetingOperation, async (c, operation, next, assertActive, bytes) => {
    const identity = getIdentity(c), url = new URL(c.req.url);
    // Use the captured bytes, leaving the replay stream unread for body-limit and
    // the original parser. Invalid UTF-8 cannot acquire a different string hash.
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const groups = (): ReturnType<typeof verifyBookingContext> => verifyBookingContext(c.req.header('x-glab-booking-context'),
      process.env.GLAB_AEDILIS_CONTEXT_SECRET, identity.userId, c.req.method, url.pathname + url.search, body);
    try {
      await transaction(db, async () => {
        const actor = await registeredActor(db, identity.userId, groups());
        const repo = new MeetingRepository(db);
        if (operation.meetingId) {
          await repo.requireReadable(operation.meetingId, actor);
          const row = await repo.get(operation.meetingId);
          if (operation.owner) repo.requireOwner(row, actor);
          if (operation.responseId) {
            const response = await prepare(db, 'SELECT owner_id FROM meeting_response WHERE id=? AND meeting_id=?').get(operation.responseId, operation.meetingId) as { owner_id: string } | undefined;
            if (!response || !owns(actor, response.owner_id)) throw new MeetingError(403, '回答を編集する権限がありません');
          }
        }
        assertActive();
        await next();
        // A handled error must still roll back every write in this operation,
        // while preserving its already-built application response/status.
        if (c.error || !c.res.ok) throw new RejectedHandlerResponse();
        groups();
        assertActive();
      })();
    } catch (error) {
      if (!(error instanceof RejectedHandlerResponse)) throw error;
    }
  });
  router.onError((error, c) => c.json({ error: error instanceof MeetingError ? error.message : 'current_meeting_operation_unconfirmed' }, error instanceof MeetingError ? error.status : 503));
  router.use('*', authenticate);
  router.route('/', meetings);
  router.all('*', c => c.json({ error: 'unclassified_glab_operation' }, 403));
  return router;
}
