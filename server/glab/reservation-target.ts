import { Hono, type MiddlewareHandler } from 'hono';
import type { DatabaseInput } from '../persistence/database.ts';
import type { FacilitySource } from '../facility/source.ts';
import { CompositeDelegations } from '../vendor/cernere-composite/delegation.js';
import type { ServiceOperationRisk } from '../vendor/cernere-composite/service-session.js';
import { makeFacilityRouter } from '../routes/facilities.ts';
import { makeReservationRouter } from '../routes/reservations.ts';
import { glabRequestGate } from './request-gate.ts';

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
  const { authenticate, assertActive } = glabRequestGate(delegations, adminIds, reservationOperation);
  const inherited: MiddlewareHandler = async (c, next) => { assertActive(c); await next(); };
  router.use('*', authenticate);
  router.route('/facilities', makeFacilityRouter(db, source, inherited, assertActive));
  router.route('/reservations', makeReservationRouter(db, source, inherited, assertActive));
  router.all('*', c => c.json({ error: 'unclassified_glab_operation' }, 403));
  return router;
}
