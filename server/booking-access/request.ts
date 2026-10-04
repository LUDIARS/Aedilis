import type { Context } from 'hono';
import { readIdentity } from '../auth.ts';
import { verifyBookingContext, type BookingPrincipal } from './context.ts';

/** Only trusted server configuration chooses the key; caller headers cannot select a key or issuer. */
export async function bookingPrincipal(c: Context): Promise<BookingPrincipal> {
  const identity = c.get('auth') ?? await readIdentity(c);
  const userId = identity?.userId ?? null;
  const url = new URL(c.req.url);
  const body = ['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text();
  const groups = verifyBookingContext(c.req.header('x-glab-booking-context'),
    process.env.GLAB_AEDILIS_CONTEXT_SECRET, userId, c.req.method, url.pathname + url.search, body);
  return { userId, groups };
}
