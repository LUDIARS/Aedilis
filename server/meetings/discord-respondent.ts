import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { deviceIdentity, issueDeviceCookie } from './device-identity.ts';
import type { Actor } from './types.ts';

export const DISCORD_RESPONDENT_COOKIE = 'aedilis_discord_respondent';
export function discordCookiePath(meetingId: string): string { return '/api/meetings/' + meetingId; }

export function migrateDiscordRespondents(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meeting_discord_respondent (
    meeting_id TEXT NOT NULL REFERENCES meeting_poll(id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL, guild_id TEXT NOT NULL, display_name TEXT NOT NULL,
    owner_id TEXT NOT NULL UNIQUE REFERENCES meeting_identity(id),
    PRIMARY KEY(meeting_id,guild_id,discord_user_id)
  )`);
}
/** A Discord capability is valid for one meeting, never for the organizer or a Cernere account. */
export function discordRespondentActor(db: Database.Database, c: Context): Actor | null {
  const meetingId = c.req.param('id');
  if (!meetingId || !/^[0-9a-f-]{36}$/i.test(meetingId)) return null;
  const identity = deviceIdentity(db, getCookie(c, DISCORD_RESPONDENT_COOKIE), meetingId);
  if (!identity || identity.user_id) return null;
  const row = db.prepare('SELECT display_name FROM meeting_discord_respondent WHERE meeting_id=? AND owner_id=?')
    .get(meetingId, identity.id) as { display_name: string } | undefined;
  if (!row) return null;
  return { current: identity, identities: [identity], userId: null, groups: [], discord: { displayName: row.display_name } };
}
export function establishDiscordRespondent(db: Database.Database, c: Context, meetingId: string,
  proof: { discordUserId: string; guildId: string; displayName: string }, secure: boolean): void {
  db.transaction(() => {
    const existing = db.prepare('SELECT owner_id FROM meeting_discord_respondent WHERE meeting_id=? AND guild_id=? AND discord_user_id=?')
      .get(meetingId, proof.guildId, proof.discordUserId) as { owner_id: string } | undefined;
    const ownerId = existing?.owner_id ?? randomUUID();
    if (!existing) {
      db.prepare('INSERT INTO meeting_identity(id,user_id,notify,created_at) VALUES(?,NULL,0,?)').run(ownerId, Date.now());
      db.prepare('INSERT INTO meeting_discord_respondent(meeting_id,discord_user_id,guild_id,display_name,owner_id) VALUES(?,?,?,?,?)')
        .run(meetingId, proof.discordUserId, proof.guildId, proof.displayName, ownerId);
    } else {
      db.prepare('UPDATE meeting_discord_respondent SET display_name=? WHERE owner_id=?').run(proof.displayName, ownerId);
    }
    issueDeviceCookie(db, c, ownerId, { name: DISCORD_RESPONDENT_COOKIE, path: discordCookiePath(meetingId), secure, lifetime: 12 * 3600 });
  })();
}
