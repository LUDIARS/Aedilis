/** Request-owned scope installed only inside the real Composite target execution.
 * It is neither a browser credential nor a replacement for the data ACL.
 * @implements SPEC-AE-GLAB-MANAGED-MEET-DELEGATION-001
 */
import type { Context } from 'hono';
import { DelegatedBodyError } from '../glab/operation-body.ts';

export interface MeetOperation {
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
const operations = new WeakMap<Context, MeetOperation>();
export function currentMeetOperation(c: Context): MeetOperation | undefined { return operations.get(c); }

export async function withMeetOperation(c: Context, expiresAt: number, authorize: () => Promise<void>,
  execute: () => Promise<void>): Promise<void> {
  if (operations.has(c) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new DelegatedBodyError(408);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, Math.max(1, expiresAt - Date.now()));
  c.req.raw.signal.addEventListener('abort', abort, { once: true });
  if (c.req.raw.signal.aborted) abort();
  const assertOpen = (): void => { if (controller.signal.aborted || expiresAt <= Date.now()) throw new DelegatedBodyError(408); };
  const operation: MeetOperation = { signal: controller.signal, assertCurrent: async () => {
    assertOpen(); await authorize(); assertOpen();
  } };
  operations.set(c, operation);
  try { await operation.assertCurrent(); await execute(); await operation.assertCurrent(); }
  finally { operations.delete(c); clearTimeout(timer); c.req.raw.signal.removeEventListener('abort', abort); controller.abort(); }
}
