import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { MeetingRepository } from '../server/meetings/repository.ts';
import { establishDiscordRespondent, discordRespondentActor } from '../server/meetings/discord-respondent.ts';
import { deviceIdentity } from '../server/meetings/device-identity.ts';
import type { Actor, MeetingInput } from '../server/meetings/types.ts';

it('restores only the same meeting respondent and cannot promote the cookie to a global identity', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON'); migrateMeetings(db); migrateMeetings(db);
    db.prepare('INSERT INTO meeting_identity VALUES(?,?,?,?)').run('host', 'cernere-host', 0, 0);
    const hostIdentity = { id: 'host', user_id: 'cernere-host', notify: 0 };
    const host: Actor = { userId: 'cernere-host', current: hostIdentity, identities: [hostIdentity] };
    const draft: MeetingInput = { title: 'Meeting', description: '', organizerName: 'Host', guestResponses: true, onlineAllowed: false,
      slots: [{ id: 'slot', startAt: '2026-10-01T01:00:00Z', endAt: '2026-10-01T02:00:00Z', venue: 'Room' }], venues: [{ name: 'Room', busy: [] }] };
    const repo = new MeetingRepository(db); const id = repo.create(draft, host); const other = repo.create(draft, host);
    const proof = { guildId: '1136199339417534606', discordUserId: '123456789012345678', displayName: '回答者' };
    const app = new Hono();
    app.post('/:id', c => { establishDiscordRespondent(db, c, c.req.param('id'), proof, true); return c.json({ ok: true }); });
    app.get('/:id', c => c.json(discordRespondentActor(db, c)));
    const created = await app.request('/' + id, { method: 'POST' });
    const header = created.headers.get('set-cookie')!;
    expect(header).toContain('HttpOnly'); expect(header).toContain('Secure');
    expect(header).toContain('Path=/api/meetings/' + id); expect(header).toContain('Max-Age=43200');
    const cookie = header.split(';')[0]!;
    const actor = await (await app.request('/' + id, { headers: { cookie } })).json() as Actor;
    expect(actor.userId).toBeNull(); expect(actor.identities).toHaveLength(1);
    expect(deviceIdentity(db, cookie.slice(cookie.indexOf('=') + 1))).toBeNull();
    expect(await (await app.request('/' + other, { headers: { cookie } })).json()).toBeNull();
    repo.saveResponse(id, { name: proof.displayName, comment: '', topic: '', answers: { slot: 'yes' } }, null, null, 1, actor);
    const fresh = await app.request('/' + id, { method: 'POST' });
    const nextCookie = fresh.headers.get('set-cookie')!.split(';')[0]!;
    const returned = await (await app.request('/' + id, { headers: { cookie: nextCookie } })).json() as Actor;
    expect(returned.current?.id).toBe(actor.current?.id);
    expect(repo.view(id, returned)).toMatchObject({ canManage: false, responses: [{ canEdit: true }] });
    expect(JSON.stringify(repo.view(id, host))).not.toContain(proof.discordUserId);
    expect(() => repo.cancel(id, 1, returned)).toThrow();
  } finally { db.close(); }
});
