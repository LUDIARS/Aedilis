import type { Visibility } from '../booking-access/policy.ts';
import { MeetingError, type Actor } from './types.ts';

/** Meetings are created only by registered Cernere users; device-only identities may not organize. */
export function requireRegisteredOrganizer(actor: Actor): void {
  if (!actor.userId) throw new MeetingError(401, '会議の作成にはCernereへの登録・ログインが必要です');
}

/**
 * Guest (login-free) responses need a URL-readable meeting. An omitted request keeps the
 * current setting while the meeting stays public, so older clients never widen access.
 */
export function resolveGuestResponses(requested: boolean | undefined, visibility: Visibility, current?: boolean): boolean {
  if (requested === true && visibility !== 'public') {
    throw new MeetingError(400, 'ログインなしの回答は、公開範囲が「URLを知っている人」の会議だけ受け付けられます');
  }
  if (visibility !== 'public') return false;
  return requested ?? current ?? false;
}

export function requireResponder(guestResponses: boolean, actor: Actor): void {
  if (!guestResponses && !actor.userId) throw new MeetingError(401, 'この会議に回答するにはCernereへのログインが必要です');
}
