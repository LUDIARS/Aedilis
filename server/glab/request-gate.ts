import type { Context, MiddlewareHandler, Next } from 'hono';
import type { CompositeDelegations } from '../vendor/cernere-composite/delegation.js';
import type { ServiceOperationRisk } from '../vendor/cernere-composite/service-session.js';
import { captureOperationBody, DelegatedBodyError } from './operation-body.ts';

export interface GlabOperation {
  action: string;
  risk: ServiceOperationRisk;
  booking: boolean;
  requireBookingContext?: boolean;
  maximumBodyBytes?: number;
}
type Execution<T> = (c: Context, operation: T, next: Next, assertActive: () => void, body: Uint8Array) => Promise<void>;

/** One standard SDK verification path, shared by the finite target routers.
 * @implements SPEC-AE-GLAB-RESERVATION-DELEGATION-001
 * @implements SPEC-AE-GLAB-MEETING-DELEGATION-001
 */
export function glabRequestGate<T extends GlabOperation>(delegations: CompositeDelegations, adminIds: ReadonlySet<string>,
  classify: (method: string, path: string) => T | null,
  execute: Execution<T> = async (_c, _operation, next) => { await next(); }): { authenticate: MiddlewareHandler; assertActive: (c: Context) => void } {
  const deadlines = new WeakMap<Context, number>();
  const assertActive = (c: Context): void => {
    const until = deadlines.get(c);
    if (c.req.raw.signal.aborted || until === undefined || until <= Date.now()) throw new DelegatedBodyError(408);
  };
  const authenticate: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    const url = new URL(c.req.url);
    const operation = classify(c.req.method, url.pathname);
    if (!operation) return c.json({ error: 'unclassified_glab_operation' }, 403);
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Cernere-Delegation ') ? authorization.slice(19) : '';
    const requestId = c.req.header('x-cernere-request-id');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !requestId || requestId.length > 128 || requestId.includes(',') || c.req.header('cookie')
      || (operation.requireBookingContext && !c.req.header('x-glab-booking-context'))) return c.json({ error: 'scoped_delegation_required' }, 401);
    let executing = false;
    try {
      const body = await captureOperationBody(c, operation.maximumBodyBytes);
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
          await execute(c, operation, next, () => assertActive(c), body);
        },
      });
    } catch (error) {
      if (error instanceof DelegatedBodyError) {
        // Downstream may already have finalized a successful response. Hono
        // ignores a mere returned replacement at that point; replace c.res too.
        const response = c.json({ error: 'delegated_request_ended_or_invalid' }, error.status);
        c.res = response;
        return response;
      }
      if (executing) throw error;
      return c.json({ error: 'current_delegation_unconfirmed' }, 503);
    } finally { deadlines.delete(c); }
  };
  return { authenticate, assertActive };
}
