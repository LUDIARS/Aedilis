import type { DatabaseInput } from '../persistence/database.ts';
import { MeetingError } from '../meetings/types.ts';
import { MeetTokens } from './tokens.ts';
import { MeetApi } from './api.ts';
import { organizerForMeeting } from './organizers.ts';
import { ensureBookingAccessSchema } from '../booking-access/policy.ts';
import { meetingSpace, type MeetRow, type MeetSpaceStore } from './space-store.ts';
export type { MeetRow } from './space-store.ts';
export interface EnsureOptions {
    /**
     * `'optional'` is used for requests relayed by a trusted front end (GLab): the representative Google account hosts
     * the space alone when the creator has not linked Google. Ae's own page keeps `'required'`.
     */
    creatorGoogle?: 'required' | 'optional';
    /** Chooses the host for a new record (an Ae meeting picks it from its booking audience). */
    organizer?: () => Promise<string | null>;
    /** Only the Cr user who created the space may retry it. Front end events leave this to the front end. */
    creatorOnly?: boolean;
}
export class MeetProvisioner {
    private readonly active = new Set<string>();
    // The host choice reads the booking audience (organization bookings), so its table must exist like in MeetingRepository.
    constructor(private readonly db: DatabaseInput, private readonly tokens: MeetTokens, private readonly api: MeetApi) { ensureBookingAccessSchema(db); }
    async get(id: string): Promise<{ status: string; url?: string }> {
        return this.view(await meetingSpace(this.db, id).row());
    }
    view(row: MeetRow | undefined): { status: string; url?: string } {
        return row?.status === 'ready' && row.meeting_uri ? { status: 'ready', url: row.meeting_uri } : { status: row?.status || 'none' };
    }
    async ensure(id: string, creatorId: string, options: EnsureOptions = {}): Promise<{ status: string; url?: string }> {
        return this.ensureSpace(meetingSpace(this.db, id), creatorId, {
            creatorOnly: true, organizer: () => organizerForMeeting(this.db, id), ...options,
        });
    }
    async ensureSpace(store: MeetSpaceStore, creatorId: string, options: EnsureOptions = {}): Promise<{ status: string; url?: string }> {
        if (this.active.has(store.key))
            throw new MeetingError(409, 'Meetを設定中です。少し待って再読込してください');
        this.active.add(store.key);
        try {
            let row = await store.row();
            if (row && options.creatorOnly && row.creator_id !== creatorId)
                throw new MeetingError(403, 'Meetを作成したCrアカウントで操作してください');
            if (row?.status === 'ready')
                return this.view(row);
            if (row && !row.space_name)
                throw new MeetingError(409, 'Meet作成結果が不明です。重複作成を防ぐため管理者の確認が必要です');
            // The host is fixed at the first attempt; later retries keep it even if the representative changes.
            const organizerId = row ? row.organizer_id : await (options.organizer?.() ?? Promise.resolve(null));
            if (!organizerId)
                throw new MeetingError(409, '組織の代表者または管理者によるGoogle認可が必要です');
            const email = options.creatorGoogle === 'optional'
                ? await this.tokens.email(creatorId).catch((error: unknown) => {
                    if (error instanceof MeetingError && error.status === 409) return null;
                    throw error;
                })
                : await this.tokens.email(creatorId);
            const token = await this.tokens.access(organizerId);
            const organizerEmail = await this.tokens.email(organizerId);
            if (!row) {
                await store.insert(organizerId, creatorId);
                // Persist the intent before a non-idempotent request. A timeout must never create again.
                try {
                    const space = await this.api.create(token);
                    await store.created(space.name, space.meetingUri);
                }
                catch (error) {
                    await store.status('uncertain');
                    throw error;
                }
                row = await store.row();
            }
            if (!row?.space_name)
                throw new MeetingError(503, 'Meetの保存結果を確認できません');
            // Repeating configuration lists members first, recovering a lost create-member response.
            await this.api.configure(token, row.space_name, !email || organizerEmail.toLowerCase() === email.toLowerCase() ? null : email);
            await store.status('ready');
            return this.view(await store.row());
        }
        finally {
            this.active.delete(store.key);
        }
    }
}
