import { prepare, type DatabaseInput } from '../persistence/database.ts';
import type { Hono } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { deviceIdentity } from './device-identity.ts';
import type { MeetingConfig } from './config.ts';
import { readAudience } from '../booking-access/policy.ts';
import { MeetingRepository } from './repository.ts';
import { MeetingError } from './types.ts';
import { DISCORD_RESPONDENT_COOKIE, discordCookiePath, establishDiscordRespondent } from './discord-respondent.ts';
import { object } from './validation.ts';
async function requireGuestMeeting(repo: MeetingRepository, meetingId: string): Promise<void> {
    const meeting = (await repo.get(meetingId));
    if (meeting.state !== 'open' || meeting.guest_responses !== 1 || (await readAudience(repo.db, 'meeting', meetingId)).visibility !== 'public') {
        throw new MeetingError(403, 'この予定ではDiscordからの回答を受け付けていません');
    }
}
export function registerDiscordHandoff(app: Hono, db: DatabaseInput, config: MeetingConfig): void {
    const repo = new MeetingRepository(db), secure = new URL(config.publicUrl).protocol === 'https:';
    app.post('/:id/discord-handoff', async (c) => {
        const meetingId = c.req.param('id');
        (await requireGuestMeeting(repo, meetingId));
        const body = object(await c.req.json());
        if (typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code))
            throw new MeetingError(400, 'Discordの回答ボタンから新しいリンクを取得してください');
        if (!config.discordHandoffUrl || !config.discordHandoffGuildId)
            throw new MeetingError(503, 'Discord本人確認は設定待ちです');
        let response: Response;
        try {
            response = await fetch(new URL('/v1/discord/meeting-handoffs/consume', config.discordHandoffUrl), {
                method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: body.code, meetingId, audience: new URL(config.publicUrl).origin }), signal: AbortSignal.timeout(8000),
            });
        }
        catch {
            // A consumed proof must not be retried automatically after an ambiguous transport failure.
            throw new MeetingError(503, '本人確認を完了できませんでした。Discordで新しいリンクを取得してください');
        }
        if (!response.ok)
            throw new MeetingError(403, 'リンクが期限切れ・使用済み、または組織への所属を確認できません。Discordで取得し直してください');
        const proof = object(await response.json());
        if (proof.meetingId !== meetingId || proof.audience !== new URL(config.publicUrl).origin || proof.guildId !== config.discordHandoffGuildId
            || typeof proof.discordUserId !== 'string' || !/^\d{17,20}$/.test(proof.discordUserId)
            || typeof proof.displayName !== 'string' || !proof.displayName.trim() || proof.displayName.length > 80) {
            throw new MeetingError(403, 'Discordの本人確認結果を検証できませんでした');
        }
        // Recheck policy after network I/O; a concurrently closed/private meeting cannot acquire a guest session.
        (await requireGuestMeeting(repo, meetingId));
        (await establishDiscordRespondent(db, c, meetingId, { discordUserId: proof.discordUserId, guildId: proof.guildId, displayName: proof.displayName }, secure));
        return c.json({ linked: true, displayName: proof.displayName });
    });
    app.delete('/:id/discord-session', async (c) => {
        const cookie = getCookie(c, DISCORD_RESPONDENT_COOKIE);
        if ((await deviceIdentity(db, cookie, c.req.param('id'))))
            (await prepare(db, 'DELETE FROM meeting_device WHERE id=?').run(cookie!.split('.')[0]));
        deleteCookie(c, DISCORD_RESPONDENT_COOKIE, { path: discordCookiePath(c.req.param('id')), secure, httpOnly: true, sameSite: 'Lax' });
        return c.json({ ok: true });
    });
}
