import { prepare, type DatabaseInput } from '../persistence/database.ts';

/** One Meet space record, whatever it belongs to (an Ae meeting or a front end's own event). */
export interface MeetRow {
    organizer_id: string;
    creator_id: string;
    space_name: string | null;
    meeting_uri: string | null;
    status: string;
}

/**
 * Where a space record lives. Creation intent is saved before the non-idempotent Google call, so every store keeps
 * the same `creating → configuring → ready` / `uncertain` states.
 */
export interface MeetSpaceStore {
    /** Lock key for concurrent requests on the same record. */
    readonly key: string;
    row(): Promise<MeetRow | undefined>;
    insert(organizerId: string, creatorId: string): Promise<void>;
    created(spaceName: string, meetingUri: string): Promise<void>;
    status(status: 'ready' | 'uncertain'): Promise<void>;
}

/** Spaces for Ae meetings (`meeting_meet`, keyed by the meeting poll). */
export function meetingSpace(db: DatabaseInput, meetingId: string): MeetSpaceStore {
    return {
        key: `meeting:${meetingId}`,
        row: async () => (await prepare(db, 'SELECT * FROM meeting_meet WHERE meeting_id=?').get(meetingId)) as MeetRow | undefined,
        insert: async (organizerId, creatorId) => { (await prepare(db, 'INSERT INTO meeting_meet(meeting_id,organizer_id,creator_id,status,updated_at) VALUES(?,?,?,?,?)').run(meetingId, organizerId, creatorId, 'creating', Date.now())); },
        created: async (spaceName, meetingUri) => { (await prepare(db, "UPDATE meeting_meet SET space_name=?,meeting_uri=?,status='configuring',updated_at=? WHERE meeting_id=?").run(spaceName, meetingUri, Date.now(), meetingId)); },
        status: async (status) => { (await prepare(db, 'UPDATE meeting_meet SET status=?,updated_at=? WHERE meeting_id=?').run(status, Date.now(), meetingId)); },
    };
}

/** Spaces for a trusted front end's own events (GLab events), keyed by the front end and its event id. */
export function externalSpace(db: DatabaseInput, source: string, resourceId: string): MeetSpaceStore {
    return {
        key: `external:${source}:${resourceId}`,
        row: async () => (await prepare(db, 'SELECT * FROM meet_external_space WHERE source=? AND resource_id=?').get(source, resourceId)) as MeetRow | undefined,
        insert: async (organizerId, creatorId) => { (await prepare(db, 'INSERT INTO meet_external_space(source,resource_id,organizer_id,creator_id,status,updated_at) VALUES(?,?,?,?,?,?)').run(source, resourceId, organizerId, creatorId, 'creating', Date.now())); },
        created: async (spaceName, meetingUri) => { (await prepare(db, "UPDATE meet_external_space SET space_name=?,meeting_uri=?,status='configuring',updated_at=? WHERE source=? AND resource_id=?").run(spaceName, meetingUri, Date.now(), source, resourceId)); },
        status: async (status) => { (await prepare(db, 'UPDATE meet_external_space SET status=?,updated_at=? WHERE source=? AND resource_id=?').run(status, Date.now(), source, resourceId)); },
    };
}
