import type { Context } from 'hono';

export class DelegatedBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) { super('Delegated request body is invalid'); }
}

/** Bounded exact bytes, replayed once to the existing booking parser.
 * @implements SPEC-AE-GLAB-RESERVATION-DELEGATION-001
 */
export async function captureOperationBody(c: Context, maximumBytes?: number): Promise<Uint8Array> {
  const request = c.req.raw;
  const maximum = maximumBytes ?? (['POST', 'PATCH'].includes(request.method) ? 64 * 1024 : 0);
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 64 * 1024) throw new Error('Invalid route-owned body limit');
  const writesBody = maximum > 0;
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new DelegatedBodyError(413);
  if (request.signal.aborted) throw new DelegatedBodyError(408);
  if (!request.body) return new Uint8Array();
  if (request.bodyUsed || Object.keys(c.req.bodyCache).length) throw new DelegatedBodyError(400);
  const reader = request.body.getReader();
  let cancellation: Promise<void> | undefined;
  let ended = false;
  let cancelled = false;
  const cancel = (): Promise<void> => {
    cancelled = true;
    return cancellation ??= reader.cancel().catch(() => { /* the rejected input is being discarded */ });
  };
  const onAbort = (): void => { void cancel(); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, 15_000);
  timer.unref?.();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (request.signal.aborted) onAbort();
    while (true) {
      const part = await reader.read();
      if (cancelled) throw new DelegatedBodyError(408);
      if (part.done) { ended = true; break; }
      length += part.value.byteLength;
      if (length > maximum) throw new DelegatedBodyError(413);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (writesBody) c.req.raw = new Request(request, { body: bytes, duplex: 'half' } as RequestInit);
    return bytes;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    if (!ended || cancellation) await cancel();
    reader.releaseLock();
  }
}
