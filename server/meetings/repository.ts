import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { owns } from './identity.ts';
import { MeetingError, type Actor, type Candidate, type MeetingInput, type MeetingRow, type ResponseInput, type ResponseRow, type Venue } from './types.ts';

export class MeetingRepository {
  constructor(readonly db: Database.Database) {}
  get(id: string): MeetingRow {
    const row = this.db.prepare('SELECT * FROM meeting_poll WHERE id = ?').get(id) as MeetingRow | undefined;
    if (!row) throw new MeetingError(404, '会議が見つかりません');
    return row;
  }
  responses(id: string): ResponseRow[] {
    return this.db.prepare('SELECT * FROM meeting_response WHERE meeting_id = ? ORDER BY rowid').all(id) as ResponseRow[];
  }
  requireOwner(row: MeetingRow | ResponseRow, actor: Actor): void {
    if (!owns(actor, row.owner_id)) throw new MeetingError(403, 'この端末・アカウントには編集権限がありません');
  }
  requireRevision(actual: number, expected: number): void {
    if (actual !== expected) throw new MeetingError(409, '別の端末で変更されました。再読込してください');
  }
  create(input: MeetingInput, actor: Actor): string {
    if (!actor.current) throw new MeetingError(401, 'ブラウザのCookieを有効にしてください');
    const id = randomUUID(), now = Date.now();
    this.db.prepare(`INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,slots_json,venues_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, actor.current.id, input.title, input.description, input.organizerName, JSON.stringify(input.slots), JSON.stringify(input.venues), now, now);
    return id;
  }
  update(id: string, input: MeetingInput, expected: number, actor: Actor): void {
    this.db.transaction(() => {
      const row = this.get(id);
      this.requireOwner(row, actor); this.requireRevision(row.revision, expected);
      if (row.state === 'cancelled') throw new MeetingError(409, '中止済みの会議です');
      const oldSlots = JSON.parse(row.slots_json) as Candidate[];
      const unchanged = new Set(input.slots.filter(s => oldSlots.some(o => o.id === s.id && o.startAt === s.startAt && o.endAt === s.endAt && o.venue === s.venue)).map(s => s.id));
      for (const answer of this.responses(id)) {
        const values = JSON.parse(answer.answers_json) as ResponseInput['answers'];
        const kept = Object.fromEntries(Object.entries(values).filter(([key]) => unchanged.has(key)));
        this.db.prepare('UPDATE meeting_response SET answers_json = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(kept), answer.id);
      }
      // Any organizer edit reopens scheduling so a stale final choice cannot survive changes.
      this.db.prepare(`UPDATE meeting_poll SET title=?,description=?,organizer_name=?,slots_json=?,venues_json=?,state='open',selected_slot=NULL,revision=revision+1,updated_at=? WHERE id=?`)
        .run(input.title, input.description, input.organizerName, JSON.stringify(input.slots), JSON.stringify(input.venues), Date.now(), id);
      this.enqueue(id, 'meeting_changed', this.responses(id).map(r => r.owner_id), actor);
    })();
  }
  finalize(id: string, slotId: string, expected: number, actor: Actor): void {
    this.db.transaction(() => {
      const row = this.get(id);
      this.requireOwner(row, actor); this.requireRevision(row.revision, expected);
      if (row.state === 'cancelled') throw new MeetingError(409, '中止済みの会議です');
      const slot = (JSON.parse(row.slots_json) as Candidate[]).find(s => s.id === slotId);
      if (!slot) throw new MeetingError(400, '候補を選択してください');
      const venue = (JSON.parse(row.venues_json) as Venue[]).find(v => v.name === slot.venue);
      if (venue?.busy.some(b => b.startAt < slot.endAt && b.endAt > slot.startAt)) throw new MeetingError(409, 'その会場は予定が重複しています');
      this.db.prepare("UPDATE meeting_poll SET state='finalized',selected_slot=?,revision=revision+1,updated_at=? WHERE id=?").run(slotId, Date.now(), id);
      this.enqueue(id, 'meeting_finalized', this.responses(id).map(r => r.owner_id), actor);
    })();
  }
  cancel(id: string, expected: number, actor: Actor): void {
    this.db.transaction(() => {
      const row = this.get(id);
      this.requireOwner(row, actor); this.requireRevision(row.revision, expected);
      if (row.state === 'cancelled') throw new MeetingError(409, '中止済みの会議です');
      this.db.prepare("UPDATE meeting_poll SET state='cancelled',selected_slot=NULL,revision=revision+1,updated_at=? WHERE id=?").run(Date.now(), id);
      this.enqueue(id, 'meeting_cancelled', this.responses(id).map(r => r.owner_id), actor);
    })();
  }
  saveResponse(id: string, input: ResponseInput, responseId: string | null, expected: number | null, meetingRevision: number, actor: Actor): void {
    this.db.transaction(() => {
      const meeting = this.get(id);
      this.requireRevision(meeting.revision, meetingRevision);
      if (meeting.state !== 'open') throw new MeetingError(409, 'この会議の回答受付は終了しています');
      if (!actor.current) throw new MeetingError(401, 'Cookieを有効にしてください');
      if (responseId) {
        const row = this.response(id, responseId);
        this.requireOwner(row, actor); this.requireRevision(row.revision, expected ?? 0);
        this.db.prepare('UPDATE meeting_response SET name=?,comment=?,topic=?,answers_json=?,revision=revision+1 WHERE id=?')
          .run(input.name, input.comment, input.topic, JSON.stringify(input.answers), row.id);
      } else {
        if (this.responses(id).some(r => owns(actor, r.owner_id))) throw new MeetingError(409, '回答済みです。自分の回答を編集してください');
        if (this.responses(id).length >= 500) throw new MeetingError(409, '参加者の上限に達しました');
        this.db.prepare('INSERT INTO meeting_response(id,meeting_id,owner_id,name,comment,topic,answers_json) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), id, actor.current.id, input.name, input.comment, input.topic, JSON.stringify(input.answers));
      }
      this.enqueue(id, responseId ? 'response_changed' : 'response_added', [meeting.owner_id], actor);
    })();
  }
  response(meetingId: string, id: string): ResponseRow {
    const row = this.db.prepare('SELECT * FROM meeting_response WHERE id=? AND meeting_id=?').get(id, meetingId) as ResponseRow | undefined;
    if (!row) throw new MeetingError(404, '回答が見つかりません');
    return row;
  }
  deleteResponse(meetingId: string, id: string, expected: number, actor: Actor): void {
    this.db.transaction(() => {
      const row = this.response(meetingId, id);
      this.requireOwner(row, actor); this.requireRevision(row.revision, expected);
      this.db.prepare('DELETE FROM meeting_response WHERE id=?').run(id);
      this.enqueue(meetingId, 'response_deleted', [this.get(meetingId).owner_id], actor);
    })();
  }
  enqueue(meetingId: string, event: string, owners: string[], actor: Actor): void {
    const seenUsers = new Set<string>();
    for (const owner of new Set(owners)) {
      if (owns(actor, owner)) continue;
      const recipient = this.db.prepare('SELECT user_id FROM meeting_identity WHERE id=? AND notify=1').get(owner) as { user_id: string | null } | undefined;
      if (!recipient?.user_id || seenUsers.has(recipient.user_id)) continue;
      seenUsers.add(recipient.user_id);
      const now = Date.now();
      this.db.prepare('INSERT INTO meeting_outbox(id,meeting_id,recipient_id,event,due_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), meetingId, owner, event, now, now);
    }
  }
  view(id: string, actor: Actor): unknown {
    const row = this.get(id), mine = owns(actor, row.owner_id);
    return {
      id: row.id, title: row.title, description: row.description, organizerName: row.organizer_name,
      slots: JSON.parse(row.slots_json), venues: JSON.parse(row.venues_json), state: row.state,
      selectedSlot: row.selected_slot, revision: row.revision, canManage: mine,
      responses: this.responses(id).map(r => ({ id: r.id, name: r.name, comment: r.comment, topic: r.topic, answers: JSON.parse(r.answers_json), revision: r.revision, canEdit: owns(actor, r.owner_id) })),
    };
  }
}
