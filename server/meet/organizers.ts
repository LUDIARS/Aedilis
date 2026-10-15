import { prepare, type DatabaseInput } from '../persistence/database.ts';
import { readAudience } from '../booking-access/policy.ts';

/**
 * Who hosts Meet spaces (the "representative" Google account).
 *
 * - Ae itself: one representative chosen by an Ae administrator (`meet_organizer`, singleton).
 * - A GLab organization: that organization's representative (Cr organization `owner`) authorizes from GLab
 *   (neco 2026-10-15「GLAB の組織で予約した場合 GLAB の代表で登録したい。組織の代表者アカウントとしたい」).
 *
 * A meeting booked for an organization uses the organization's representative when one has authorized,
 * otherwise Ae's representative.
 */
export interface OrganizationRef { kind: 'organization'; id: string }

export async function singletonOrganizer(db: DatabaseInput): Promise<string | null> {
    const row = (await prepare(db, 'SELECT user_id FROM meet_organizer WHERE singleton=1').get()) as { user_id: string } | undefined;
    return row?.user_id ?? null;
}

export async function organizationOrganizer(db: DatabaseInput, organizationId: string): Promise<string | null> {
    const row = (await prepare(db, "SELECT user_id FROM meet_group_organizer WHERE group_kind='organization' AND group_id=?").get(organizationId)) as { user_id: string } | undefined;
    return row?.user_id ?? null;
}

/** A representative's stored Google token carries organizer scopes; a creator re-link must never replace it. */
export async function isAnyOrganizer(db: DatabaseInput, userId: string): Promise<boolean> {
    if ((await singletonOrganizer(db)) === userId) return true;
    return !!(await prepare(db, 'SELECT 1 FROM meet_group_organizer WHERE user_id=? LIMIT 1').get(userId));
}

export async function saveOrganizationOrganizer(db: DatabaseInput, organizationId: string, userId: string): Promise<void> {
    (await prepare(db, `INSERT INTO meet_group_organizer(group_kind,group_id,user_id,updated_at) VALUES('organization',?,?,?)
    ON CONFLICT(group_kind,group_id) DO UPDATE SET user_id=excluded.user_id,updated_at=excluded.updated_at`).run(organizationId, userId, Date.now()));
}

export async function saveSingletonOrganizer(db: DatabaseInput, userId: string): Promise<void> {
    (await prepare(db, 'INSERT INTO meet_organizer VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET user_id=excluded.user_id').run(userId));
}

/** Organization representative for an organization booking, else Ae's representative. */
export async function organizerForMeeting(db: DatabaseInput, meetingId: string): Promise<string | null> {
    const { group } = await readAudience(db, 'meeting', meetingId);
    if (group?.kind === 'organization') {
        const representative = await organizationOrganizer(db, group.id);
        if (representative) return representative;
    }
    return singletonOrganizer(db);
}
