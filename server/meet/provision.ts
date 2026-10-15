import { prepare, type DatabaseInput } from '../persistence/database.ts';
import { MeetingError } from '../meetings/types.ts';
import { MeetTokens } from './tokens.ts';
import { MeetApi } from './api.ts';
export interface MeetRow {
    meeting_id: string;
    organizer_id: string;
    creator_id: string;
    space_name: string | null;
    meeting_uri: string | null;
    status: string;
}
export class MeetProvisioner {
    private readonly active = new Set<string>();
    constructor(private readonly db: DatabaseInput, private readonly tokens: MeetTokens, private readonly api: MeetApi) { }
    async get(id: string): Promise<{
        status: string;
        url?: string;
    }> {
        const row = (await this.row(id));
        return row?.status === 'ready' && row.meeting_uri ? { status: 'ready', url: row.meeting_uri } : { status: row?.status || 'none' };
    }
    private async row(id: string): Promise<MeetRow | undefined> { return (await prepare(this.db, 'SELECT * FROM meeting_meet WHERE meeting_id=?').get(id)) as MeetRow | undefined; }
    /**
     * `creatorGoogle: 'optional'` is used for requests relayed by a trusted front end (GLab): the representative
     * Google account hosts the space alone when the creator has not linked Google. Ae's own page keeps 'required'.
     */
    async ensure(id: string, creatorId: string, options: { creatorGoogle?: 'required' | 'optional' } = {}): Promise<{
        status: string;
        url?: string;
    }> {
        if (this.active.has(id))
            throw new MeetingError(409, 'Meetを設定中です。少し待って再読込してください');
        this.active.add(id);
        try {
            let row = (await this.row(id));
            if (row && row.creator_id !== creatorId)
                throw new MeetingError(403, 'Meetを作成したCrアカウントで操作してください');
            if (row?.status === 'ready')
                return (await this.get(id));
            if (row && !row.space_name)
                throw new MeetingError(409, 'Meet作成結果が不明です。重複作成を防ぐため管理者の確認が必要です');
            const organizer = row ? { user_id: row.organizer_id } : (await prepare(this.db, 'SELECT user_id FROM meet_organizer WHERE singleton=1').get()) as {
                user_id: string;
            } | undefined;
            if (!organizer)
                throw new MeetingError(409, '管理者によるGoogle認可が必要です');
            const email = options.creatorGoogle === 'optional'
                ? await this.tokens.email(creatorId).catch((error: unknown) => {
                    if (error instanceof MeetingError && error.status === 409) return null;
                    throw error;
                })
                : await this.tokens.email(creatorId);
            const token = await this.tokens.access(organizer.user_id);
            const organizerEmail = await this.tokens.email(organizer.user_id);
            if (!row) {
                (await prepare(this.db, 'INSERT INTO meeting_meet(meeting_id,organizer_id,creator_id,status,updated_at) VALUES(?,?,?,?,?)').run(id, organizer.user_id, creatorId, 'creating', Date.now()));
                // Persist the intent before a non-idempotent request. A timeout must never create again.
                try {
                    const space = await this.api.create(token);
                    (await prepare(this.db, "UPDATE meeting_meet SET space_name=?,meeting_uri=?,status='configuring',updated_at=? WHERE meeting_id=?").run(space.name, space.meetingUri, Date.now(), id));
                }
                catch (error) {
                    (await prepare(this.db, "UPDATE meeting_meet SET status='uncertain',updated_at=? WHERE meeting_id=?").run(Date.now(), id));
                    throw error;
                }
                row = (await this.row(id));
            }
            if (!row?.space_name)
                throw new MeetingError(503, 'Meetの保存結果を確認できません');
            // Repeating configuration lists members first, recovering a lost create-member response.
            await this.api.configure(token, row.space_name, !email || organizerEmail.toLowerCase() === email.toLowerCase() ? null : email);
            (await prepare(this.db, "UPDATE meeting_meet SET status='ready',updated_at=? WHERE meeting_id=?").run(Date.now(), id));
            return (await this.get(id));
        }
        finally {
            this.active.delete(id);
        }
    }
}
