import { isPostgres, prepare, transaction, type DatabaseInput } from '../persistence/database.ts';
import { randomUUID } from 'node:crypto';
import { releaseMeetingFacility, reserveMeetingFacility } from './facility-reservation.ts';
import { owns } from './identity.ts';
import { requireResponder } from './participation-policy.ts';
import { ensureBookingAccessSchema, readAudience, canReadBooking } from '../booking-access/policy.ts';
import { MeetingError, type Actor, type Candidate, type MeetingInput, type MeetingRow, type ResponseInput, type ResponseRow, type Venue } from './types.ts';
export class MeetingRepository {
    constructor(readonly db: DatabaseInput) { ensureBookingAccessSchema(db); }
    async get(id: string): Promise<MeetingRow> {
        const row = (await prepare(this.db, 'SELECT * FROM meeting_poll WHERE id = ?').get(id)) as MeetingRow | undefined;
        if (!row)
            throw new MeetingError(404, '会議が見つかりません');
        return row;
    }
    /** @implements SPEC-PG-MEETING-RESPONSE-ORDERING */
    async responses(id: string): Promise<ResponseRow[]> {
        // SQLite's implicit insertion key is unavailable in PostgreSQL. UUID is a stable PG tie-breaker.
        const order = isPostgres(this.db) ? 'id' : 'rowid';
        return (await prepare(this.db, `SELECT * FROM meeting_response WHERE meeting_id = ? ORDER BY ${order}`).all(id)) as ResponseRow[];
    }
    requireOwner(row: MeetingRow | ResponseRow, actor: Actor): void {
        if (!owns(actor, row.owner_id))
            throw new MeetingError(403, 'この端末・アカウントには編集権限がありません');
    }
    requireRevision(actual: number, expected: number): void {
        if (actual !== expected)
            throw new MeetingError(409, '別の端末で変更されました。再読込してください');
    }
    async create(input: MeetingInput, actor: Actor): Promise<string> {
        if (!actor.current)
            throw new MeetingError(401, 'ブラウザのCookieを有効にしてください');
        const id = randomUUID(), now = Date.now();
        (await prepare(this.db, `INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,online_allowed,guest_responses,slots_json,venues_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, actor.current.id, input.title, input.description, input.organizerName, Number(input.onlineAllowed), Number(input.guestResponses ?? false), JSON.stringify(input.slots), JSON.stringify(input.venues), now, now));
        return id;
    }
    async update(id: string, input: MeetingInput, expected: number, actor: Actor): Promise<void> {
        (await transaction(this.db, async () => {
            const row = (await this.get(id));
            this.requireOwner(row, actor);
            this.requireRevision(row.revision, expected);
            if (row.state === 'cancelled')
                throw new MeetingError(409, '中止済みの会議です');
            const oldSlots = JSON.parse(row.slots_json) as Candidate[];
            const unchanged = new Set(input.slots.filter(s => oldSlots.some(o => o.id === s.id && o.startAt === s.startAt && o.endAt === s.endAt && o.venue === s.venue)).map(s => s.id));
            for (const answer of (await this.responses(id))) {
                const values = JSON.parse(answer.answers_json) as ResponseInput['answers'];
                const kept = Object.fromEntries(Object.entries(values).filter(([key]) => unchanged.has(key)));
                const online = JSON.parse(answer.online_json) as Record<string, boolean>;
                const keptOnline = Object.fromEntries(Object.entries(online).filter(([key]) => unchanged.has(key)));
                (await prepare(this.db, 'UPDATE meeting_response SET answers_json = ?, online_json = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(kept), JSON.stringify(keptOnline), answer.id));
            }
            (await releaseMeetingFacility(this.db, id));
            // Any organizer edit reopens scheduling so a stale final choice cannot survive changes.
            (await prepare(this.db, `UPDATE meeting_poll SET title=?,description=?,organizer_name=?,online_allowed=?,guest_responses=?,slots_json=?,venues_json=?,state='open',selected_slot=NULL,revision=revision+1,updated_at=? WHERE id=?`).run(input.title, input.description, input.organizerName, Number(input.onlineAllowed), Number(input.guestResponses ?? row.guest_responses === 1), JSON.stringify(input.slots), JSON.stringify(input.venues), Date.now(), id));
            (await this.enqueue(id, 'meeting_changed', (await this.responses(id)).map(r => r.owner_id), actor));
        })());
    }
    async finalize(id: string, slotId: string, expected: number, actor: Actor): Promise<void> {
        (await transaction(this.db, async () => {
            const row = (await this.get(id));
            this.requireOwner(row, actor);
            this.requireRevision(row.revision, expected);
            if (row.state === 'cancelled')
                throw new MeetingError(409, '中止済みの会議です');
            const slot = (JSON.parse(row.slots_json) as Candidate[]).find(s => s.id === slotId);
            if (!slot)
                throw new MeetingError(400, '候補を選択してください');
            const venue = (JSON.parse(row.venues_json) as Venue[]).find(v => v.name === slot.venue);
            if (venue?.busy.some(b => b.startAt < slot.endAt && b.endAt > slot.startAt))
                throw new MeetingError(409, 'その会場は予定が重複しています');
            (await reserveMeetingFacility(this.db, row, slot, actor));
            (await prepare(this.db, "UPDATE meeting_poll SET state='finalized',selected_slot=?,revision=revision+1,updated_at=? WHERE id=?").run(slotId, Date.now(), id));
            (await this.enqueue(id, 'meeting_finalized', (await this.responses(id)).map(r => r.owner_id), actor));
        })());
    }
    async cancel(id: string, expected: number, actor: Actor): Promise<void> {
        (await transaction(this.db, async () => {
            const row = (await this.get(id));
            this.requireOwner(row, actor);
            this.requireRevision(row.revision, expected);
            if (row.state === 'cancelled')
                throw new MeetingError(409, '中止済みの会議です');
            (await releaseMeetingFacility(this.db, id));
            (await prepare(this.db, "UPDATE meeting_poll SET state='cancelled',selected_slot=NULL,revision=revision+1,updated_at=? WHERE id=?").run(Date.now(), id));
            (await this.enqueue(id, 'meeting_cancelled', (await this.responses(id)).map(r => r.owner_id), actor));
        })());
    }
    async saveResponse(id: string, input: ResponseInput, responseId: string | null, expected: number | null, meetingRevision: number, actor: Actor): Promise<void> {
        (await transaction(this.db, async () => {
            const meeting = (await this.get(id));
            this.requireRevision(meeting.revision, meetingRevision);
            if (meeting.state !== 'open')
                throw new MeetingError(409, 'この会議の回答受付は終了しています');
            requireResponder(meeting.guest_responses === 1, actor);
            if (!actor.current)
                throw new MeetingError(401, 'Cookieを有効にしてください');
            if (responseId) {
                const row = (await this.response(id, responseId));
                this.requireOwner(row, actor);
                this.requireRevision(row.revision, expected ?? 0);
                (await prepare(this.db, 'UPDATE meeting_response SET name=?,comment=?,topic=?,answers_json=?,default_online=?,online_json=?,revision=revision+1 WHERE id=?').run(input.name, input.comment, input.topic, JSON.stringify(input.answers), Number(input.defaultOnline ?? false), JSON.stringify(input.online ?? {}), row.id));
            }
            else {
                if ((await this.responses(id)).some(r => owns(actor, r.owner_id)))
                    throw new MeetingError(409, '回答済みです。自分の回答を編集してください');
                if ((await this.responses(id)).length >= 500)
                    throw new MeetingError(409, '参加者の上限に達しました');
                (await prepare(this.db, 'INSERT INTO meeting_response(id,meeting_id,owner_id,name,comment,topic,answers_json,default_online,online_json) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, actor.current.id, input.name, input.comment, input.topic, JSON.stringify(input.answers), Number(input.defaultOnline ?? false), JSON.stringify(input.online ?? {})));
            }
            (await this.enqueue(id, responseId ? 'response_changed' : 'response_added', [meeting.owner_id], actor));
        })());
    }
    async response(meetingId: string, id: string): Promise<ResponseRow> {
        const row = (await prepare(this.db, 'SELECT * FROM meeting_response WHERE id=? AND meeting_id=?').get(id, meetingId)) as ResponseRow | undefined;
        if (!row)
            throw new MeetingError(404, '回答が見つかりません');
        return row;
    }
    async deleteResponse(meetingId: string, id: string, expected: number, actor: Actor): Promise<void> {
        (await transaction(this.db, async () => {
            const row = (await this.response(meetingId, id));
            this.requireOwner(row, actor);
            this.requireRevision(row.revision, expected);
            (await prepare(this.db, 'DELETE FROM meeting_response WHERE id=?').run(id));
            (await this.enqueue(meetingId, 'response_deleted', [(await this.get(meetingId)).owner_id], actor));
        })());
    }
    async enqueue(meetingId: string, event: string, owners: string[], actor: Actor): Promise<void> {
        const seenUsers = new Set<string>();
        for (const owner of new Set(owners)) {
            if (owns(actor, owner))
                continue;
            const recipient = (await prepare(this.db, 'SELECT user_id FROM meeting_identity WHERE id=? AND notify=1').get(owner)) as {
                user_id: string | null;
            } | undefined;
            if (!recipient?.user_id || seenUsers.has(recipient.user_id))
                continue;
            seenUsers.add(recipient.user_id);
            const now = Date.now();
            (await prepare(this.db, 'INSERT INTO meeting_outbox(id,meeting_id,recipient_id,event,due_at,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), meetingId, owner, event, now, now));
        }
    }
    async requireReadable(id: string, actor: Actor): Promise<void> {
        const row = (await this.get(id));
        if (!canReadBooking((await readAudience(this.db, 'meeting', id)), { userId: actor.userId, groups: actor.groups ?? [] }, owns(actor, row.owner_id))) {
            throw new MeetingError(404, '会議が見つかりません');
        }
    }
    async view(id: string, actor: Actor): Promise<unknown> {
      return transaction(this.db, async () => {
        (await this.requireReadable(id, actor));
        const row = (await this.get(id)), mine = owns(actor, row.owner_id);
        return {
            ...(await readAudience(this.db, 'meeting', id)),
            id: row.id, title: row.title, description: row.description, organizerName: row.organizer_name, onlineAllowed: row.online_allowed === 1, guestResponses: row.guest_responses === 1,
            slots: JSON.parse(row.slots_json), venues: JSON.parse(row.venues_json), state: row.state,
            selectedSlot: row.selected_slot, revision: row.revision, canManage: mine,
            discordRespondent: actor.discord ?? null,
            responses: (await this.responses(id)).map(r => ({ id: r.id, name: r.name, comment: r.comment, topic: r.topic, answers: JSON.parse(r.answers_json), defaultOnline: r.default_online === 1, online: JSON.parse(r.online_json), revision: r.revision, canEdit: owns(actor, r.owner_id) })),
        };
      })();
    }
}
