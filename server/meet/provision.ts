import type Database from 'better-sqlite3';
import { MeetingError } from '../meetings/types.ts';
import { MeetTokens } from './tokens.ts';
import { MeetApi } from './api.ts';

export interface MeetRow { meeting_id: string; organizer_id: string; creator_id: string; space_name: string | null; meeting_uri: string | null; status: string }
export class MeetProvisioner {
  private readonly active = new Set<string>();
  constructor(private readonly db: Database.Database, private readonly tokens: MeetTokens, private readonly api: MeetApi) {}
  get(id: string): { status: string; url?: string } {
    const row = this.row(id);
    return row?.status === 'ready' && row.meeting_uri ? { status: 'ready', url: row.meeting_uri } : { status: row?.status || 'none' };
  }
  private row(id: string): MeetRow | undefined { return this.db.prepare('SELECT * FROM meeting_meet WHERE meeting_id=?').get(id) as MeetRow | undefined; }
  async ensure(id: string, creatorId: string): Promise<{ status: string; url?: string }> {
    if (this.active.has(id)) throw new MeetingError(409, 'Meetを設定中です。少し待って再読込してください');
    this.active.add(id);
    try {
      let row = this.row(id);
      if (row && row.creator_id !== creatorId) throw new MeetingError(403, 'Meetを作成したCrアカウントで操作してください');
      if (row?.status === 'ready') return this.get(id);
      if (row && !row.space_name) throw new MeetingError(409, 'Meet作成結果が不明です。重複作成を防ぐため管理者の確認が必要です');
      const organizer = row ? { user_id: row.organizer_id } : this.db.prepare('SELECT user_id FROM meet_organizer WHERE singleton=1').get() as { user_id: string } | undefined;
      if (!organizer) throw new MeetingError(409, '管理者によるGoogle認可が必要です');
      const email = await this.tokens.email(creatorId);
      const token = await this.tokens.access(organizer.user_id);
      const organizerEmail = await this.tokens.email(organizer.user_id);
      if (!row) {
        this.db.prepare('INSERT INTO meeting_meet(meeting_id,organizer_id,creator_id,status,updated_at) VALUES(?,?,?,?,?)').run(id, organizer.user_id, creatorId, 'creating', Date.now());
        // Persist the intent before a non-idempotent request. A timeout must never create again.
        try {
          const space = await this.api.create(token);
          this.db.prepare("UPDATE meeting_meet SET space_name=?,meeting_uri=?,status='configuring',updated_at=? WHERE meeting_id=?").run(space.name, space.meetingUri, Date.now(), id);
        } catch (error) {
          this.db.prepare("UPDATE meeting_meet SET status='uncertain',updated_at=? WHERE meeting_id=?").run(Date.now(), id);
          throw error;
        }
        row = this.row(id);
      }
      if (!row?.space_name) throw new MeetingError(503, 'Meetの保存結果を確認できません');
      // Repeating configuration lists members first, recovering a lost create-member response.
      await this.api.configure(token, row.space_name, organizerEmail.toLowerCase() === email.toLowerCase() ? null : email);
      this.db.prepare("UPDATE meeting_meet SET status='ready',updated_at=? WHERE meeting_id=?").run(Date.now(), id);
      return this.get(id);
    } finally { this.active.delete(id); }
  }
}
