import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { DatabaseInput } from '../persistence/database.ts';
import type { FacilitySource } from '../facility/source.ts';
import { CompositeDelegations } from '../vendor/cernere-composite/delegation.js';
import type { ServiceOperationRisk } from '../vendor/cernere-composite/service-session.js';
import { makeFacilityRouter } from '../routes/facilities.ts';
import { makeReservationRouter } from '../routes/reservations.ts';
import { captureOperationBody, DelegatedBodyError } from './operation-body.ts';

export const GLAB_RESERVATION_PREFIX = '/api/integrations/glab';
interface Operation { action: string; risk: ServiceOperationRisk; booking: boolean }
/** Only these existing operations are delegated; route parameters never select an action.
 * @implements SPEC-AE-GLAB-RESERVATION-DELEGATION-001
 */
export function reservationOperation(method: string, path: string): Operation | null {
  const relative = path.slice(GLAB_RESERVATION_PREFIX.length);
  if (!path.startsWith(GLAB_RESERVATION_PREFIX + '/')) return null;
  if (method === 'GET' && relative === '/facilities') return { action: 'facility.list', risk: 'read', booking: false };
  if (method === 'GET' && /^\/facilities\/[^/]+$/.test(relative)) return { action: 'facility.read', risk: 'read', booking: false };
  if (method === 'GET' && relative === '/reservations/capabilities') return { action: 'reservation.capabilities', risk: 'read', booking: false };
  if (method === 'GET' && relative === '/reservations') return { action: 'reservations.list', risk: 'sensitive_read', booking: true };
  if (method === 'GET' && relative === '/reservations/mine') return { action: 'reservations.own', risk: 'sensitive_read', booking: true };
  if (method === 'POST' && relative === '/reservations') return { action: 'reservations.create', risk: 'important', booking: true };
  if (!/^\/reservations\/[0-9a-f-]{36}$/i.test(relative)) return null;
  // The current shared router has no GET /:id handler. Do not manufacture one
  // from a stale caller declaration or turn it into a successful empty response.
  if (method === 'PATCH') return { action: 'reservations.update', risk: 'important', booking: true };
  if (method === 'DELETE') return { action: 'reservations.delete', risk: 'important', booking: true };
  return null;
}

/** The target DB handlers still own their resource/owner/audience decisions.
 * @implements SPEC-AE-GLAB-RESERVATION-DELEGATION-001
 */
export function makeGlabReservationTarget(db: DatabaseInput, source: FacilitySource,
  delegations: CompositeDelegations, adminIds: ReadonlySet<string>): Hono {
  const router = new Hono();
  // Per-request closure only. No reusable local credential is minted.
  const deadlines = new WeakMap<Context, number>();
  const assertActive = (c: Context): void => {
    const until = deadlines.get(c);
    if (c.req.raw.signal.aborted || until === undefined || until <= Date.now()) throw new DelegatedBodyError(408);
  };
  const inherited: MiddlewareHandler = async (c, next) => { assertActive(c); await next(); };
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    const url = new URL(c.req.url);
    const operation = reservationOperation(c.req.method, url.pathname);
    if (!operation) return c.json({ error: 'unclassified_glab_operation' }, 403);
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Cernere-Delegation ') ? authorization.slice(19) : '';
    const requestId = c.req.header('x-cernere-request-id');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !requestId || requestId.length > 128 || requestId.includes(',') || c.req.header('cookie')) {
      return c.json({ error: 'scoped_delegation_required' }, 401);
    }
    let executing = false;
    try {
      const body = await captureOperationBody(c);
      const path = url.pathname + url.search;
      await delegations.run(token, { action: operation.action, method: c.req.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path, resource: path, headers: new Headers(c.req.raw.headers), requestId, body,
        ...(operation.booking ? { additionalHeaders: ['x-glab-booking-context'] } : {}) }, {
        risk: operation.risk,
        authorizeResource: decision => !c.req.raw.signal.aborted && decision.sourceProject === 'glab'
          && decision.projectKey === 'aedilis' && decision.user.id.trim().length > 0,
        execute: async decision => {
          deadlines.set(c, Date.parse(decision.expiresAt));
          assertActive(c);
          c.set('auth', { userId: decision.user.id, role: decision.user.role, displayName: decision.user.displayName,
            projectKey: 'aedilis', isAdmin: adminIds.has(decision.user.id) });
          executing = true;
          await next();
        },
      });
    } catch (error) {
      if (error instanceof DelegatedBodyError) return c.json({ error: 'delegated_request_ended_or_invalid' }, error.status);
      if (executing) throw error; // Preserve DB/application errors; never retry a consumed operation.
      return c.json({ error: 'current_delegation_unconfirmed' }, 503);
    } finally { deadlines.delete(c); }
  });
  router.route('/facilities', makeFacilityRouter(db, source, inherited, assertActive));
  router.route('/reservations', makeReservationRouter(db, source, inherited, assertActive));
  router.all('*', c => c.json({ error: 'unclassified_glab_operation' }, 403));
  return router;
}
