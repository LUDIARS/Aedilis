import { prepare, type DatabaseInput } from '../persistence/database.ts';
import { cancelReservation, createReservation, findConflicts, getFacilityCache, getReservation } from '../db.ts';
import { readAudience, saveAudience } from '../booking-access/policy.ts';
import { MeetingError, type Actor, type Candidate, type MeetingRow, type Venue } from './types.ts';
export async function linkedReservation(db: DatabaseInput, meetingId: string): Promise<string | null> {
    const row = (await prepare(db, 'SELECT reservation_id FROM meeting_facility_reservation WHERE meeting_id=?').get(meetingId)) as {
        reservation_id: string;
    } | undefined;
    return row?.reservation_id ?? null;
}
/** Caller owns the surrounding meeting transaction, so cancellation and reopening commit together. */
export async function releaseMeetingFacility(db: DatabaseInput, meetingId: string): Promise<void> {
    const id = (await linkedReservation(db, meetingId));
    if (id && (await getReservation(db, id))?.state !== 'cancelled')
        (await cancelReservation(db, id));
}
/** Reserve only the finalized candidate, using the facility cache's administrator-owned overlap policy. */
export async function reserveMeetingFacility(db: DatabaseInput, meeting: MeetingRow, slot: Candidate, actor: Actor): Promise<void> {
    const venue = (JSON.parse(meeting.venues_json) as Venue[]).find(item => item.name === slot.venue);
    if (!venue?.facilityId) {
        (await releaseMeetingFacility(db, meeting.id));
        return;
    }
    if (!actor.userId)
        throw new MeetingError(401, '施設の予約にはログインしてください');
    const facility = (await getFacilityCache(db, venue.facilityId));
    if (!facility)
        throw new MeetingError(409, '施設一覧を更新して会場を選び直してください');
    const startAt = Math.floor(Date.parse(slot.startAt) / 60000) * 60000;
    const endAt = Math.floor(Date.parse(slot.endAt) / 60000) * 60000;
    if (startAt >= endAt)
        throw new MeetingError(400, '予約は1分以上にしてください');
    const previous = (await linkedReservation(db, meeting.id));
    if (!facility.allow_overlap && (await findConflicts(db, venue.facilityId, startAt, endAt, previous ?? undefined)).length) {
        throw new MeetingError(409, 'その施設は既に予約されています');
    }
    (await releaseMeetingFacility(db, meeting.id));
    const reservation = (await createReservation(db, { facilityId: venue.facilityId, ownerUserId: actor.userId,
        startAt, endAt, purpose: meeting.title, state: 'confirmed' }));
    (await saveAudience(db, 'reservation', reservation.id, (await readAudience(db, 'meeting', meeting.id))));
    (await prepare(db, `INSERT INTO meeting_facility_reservation(meeting_id,reservation_id) VALUES(?,?)
    ON CONFLICT(meeting_id) DO UPDATE SET reservation_id=excluded.reservation_id`).run(meeting.id, reservation.id));
}
