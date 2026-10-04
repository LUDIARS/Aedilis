import type Database from 'better-sqlite3';
import type { BookingGroup, BookingPrincipal } from './context.ts';

export type Visibility = 'public' | 'internal' | 'private';
export interface BookingAudience { visibility: Visibility; group: BookingGroup | null }
type Resource = 'reservation' | 'meeting';
interface AudienceRow { visibility: Visibility; group_kind: 'organization' | 'team' | null; group_id: string | null; group_name: string | null }

export function ensureBookingAccessSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS booking_audience (
    resource_type TEXT NOT NULL CHECK(resource_type IN ('reservation','meeting')),
    resource_id TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public','internal','private')),
    group_kind TEXT CHECK(group_kind IN ('organization','team')),
    group_id TEXT, group_name TEXT,
    PRIMARY KEY(resource_type,resource_id),
    CHECK(visibility != 'internal' OR (group_kind IS NOT NULL AND group_id IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS meeting_facility_reservation (
    meeting_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE
  )`);
}

/** Missing records are pre-existing public bookings; never rewrite their historic policy silently. */
export function readAudience(db: Database.Database, type: Resource, id: string): BookingAudience {
  const row = db.prepare('SELECT * FROM booking_audience WHERE resource_type=? AND resource_id=?').get(type, id) as AudienceRow | undefined;
  if (!row) return { visibility: 'public', group: null };
  return { visibility: row.visibility, group: row.group_kind && row.group_id
    ? { kind: row.group_kind, id: row.group_id, name: row.group_name ?? row.group_id } : null };
}

export function parseAudience(input: Record<string, unknown>, principal: BookingPrincipal, current?: BookingAudience): BookingAudience {
  const visibility = input.visibility ?? current?.visibility ?? 'public';
  if (visibility !== 'public' && visibility !== 'internal' && visibility !== 'private') throw new Error('invalid_visibility');
  const requested = input.group === undefined ? current?.group ?? null : input.group;
  let group: BookingGroup | null = null;
  if (requested !== null) {
    if (!principal.userId || typeof requested !== 'object' || !('kind' in requested) || !('id' in requested)) throw new Error('invalid_group');
    group = principal.groups.find(item => item.kind === requested.kind && item.id === requested.id) ?? null;
    if (!group) throw new Error('group_membership_required');
  }
  if (visibility !== 'public' && !principal.userId) throw new Error('login_required');
  if (visibility === 'internal' && !group) throw new Error('internal_group_required');
  return { visibility, group };
}

export function saveAudience(db: Database.Database, type: Resource, id: string, audience: BookingAudience): void {
  db.prepare(`INSERT INTO booking_audience(resource_type,resource_id,visibility,group_kind,group_id,group_name)
    VALUES(?,?,?,?,?,?) ON CONFLICT(resource_type,resource_id) DO UPDATE SET
    visibility=excluded.visibility,group_kind=excluded.group_kind,group_id=excluded.group_id,group_name=excluded.group_name`)
    .run(type, id, audience.visibility, audience.group?.kind ?? null, audience.group?.id ?? null, audience.group?.name ?? null);
}

export function canReadBooking(audience: BookingAudience, principal: BookingPrincipal, isOwner: boolean): boolean {
  if (isOwner || audience.visibility === 'public') return true;
  if (!principal.userId || audience.visibility === 'private' || !audience.group) return false;
  return principal.groups.some(group => group.kind === audience.group?.kind && group.id === audience.group?.id);
}
