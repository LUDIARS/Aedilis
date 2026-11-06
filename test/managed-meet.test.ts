import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { migrateMeet } from '../server/meet/schema.ts';
import { MeetApi } from '../server/meet/api.ts';
import { MeetTokens } from '../server/meet/tokens.ts';
import { MeetProvisioner } from '../server/meet/provision.ts';
import { MeetingError } from '../server/meetings/types.ts';
import type { MeetOperation } from '../server/meet/operation.ts';
async function fixture(send: typeof fetch) {
    const db = new Database(':memory:');
    migrateMeetings(db);
    migrateMeet(db);
    migrateMeet(db);
    (await db.prepare('INSERT INTO meeting_identity(id,created_at) VALUES(?,?)').run('owner', 1));
    (await db.prepare("INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,slots_json,venues_json,created_at,updated_at) VALUES('poll','owner','Title','','Host','[]','[]',1,1)").run());
    (await db.prepare("INSERT INTO meet_organizer VALUES(1,'organizer')").run());
    const request = vi.fn(async (_module: string, _action: string, payload: Record<string, unknown>) => ({
        accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: new Date(Date.now() + 3600000).toISOString(), tokenType: 'Bearer', scope: '',
        metadata: { email: payload.userId === 'organizer' ? 'host@example.com' : 'creator@gmail.com', subject: String(payload.userId), emailVerified: true, meetOrganizer: payload.userId === 'organizer' },
    }));
    const tokens = new MeetTokens({ request }, { clientId: 'id', clientSecret: 'secret', publicUrl: 'https://ae.example' });
    const api = new MeetApi(send);
    return { db, provision: new MeetProvisioner(db, tokens, api), tokens, api };
}
const created = () => Response.json({ name: 'spaces/abc', meetingUri: 'https://meet.google.com/abc-defg-hij' });
it('creates one managed space, turns on transcription and assigns the verified creator as cohost', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(created()).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({ members: [] })).mockResolvedValueOnce(Response.json({ name: 'spaces/abc/members/one' }));
    const { db, provision } = (await fixture(send));
    try {
        expect(await provision.ensure('poll', 'creator')).toEqual({ status: 'ready', url: 'https://meet.google.com/abc-defg-hij' });
        expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toMatchObject({ config: { moderation: 'ON', artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } } });
        expect(JSON.parse(String(send.mock.calls[3]?.[1]?.body))).toEqual({ email: 'creator@gmail.com', role: 'COHOST' });
        await provision.ensure('poll', 'creator');
        expect(send).toHaveBeenCalledTimes(4);
        const saved = JSON.stringify((await db.prepare('SELECT * FROM meeting_meet').all()));
        expect(saved).not.toContain('secret-');
        expect(saved).not.toContain('creator@gmail.com');
        await expect(provision.ensure('poll', 'other')).rejects.toThrow('Cr');
    }
    finally {
        db.close();
    }
});
it('hides a partially configured link and resumes the same space after restart without duplicating its member', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(created()).mockRejectedValueOnce(new Error('network'));
    const { db, provision, tokens, api } = (await fixture(send));
    try {
        await expect(provision.ensure('poll', 'creator')).rejects.toThrow('Google');
        expect((await provision.get('poll'))).toEqual({ status: 'configuring' });
        send.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({ members: [{ name: 'spaces/abc/members/one', email: 'creator@gmail.com', role: 'COHOST' }] }));
        const restarted = new MeetProvisioner(db, tokens, api);
        expect((await restarted.ensure('poll', 'creator')).status).toBe('ready');
        expect(send.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    }
    finally {
        db.close();
    }
});
it('never retries an uncertain create even after restart', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    const { db, provision, tokens, api } = (await fixture(send));
    try {
        await expect(provision.ensure('poll', 'creator')).rejects.toThrow('Google');
        expect((await provision.get('poll'))).toEqual({ status: 'uncertain' });
        await expect(new MeetProvisioner(db, tokens, api).ensure('poll', 'creator')).rejects.toThrow('重複');
        expect(send).toHaveBeenCalledTimes(1);
    }
    finally {
        db.close();
    }
});
it('serializes simultaneous requests for one meeting', async () => {
    let finish: ((value: Response) => void) | undefined;
    // Each HTTP response has a single-use body, including mocked responses.
    const send = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockImplementation(async () => Response.json({ members: [] }));
    const { db, provision } = (await fixture(send));
    try {
        const pending = provision.ensure('poll', 'creator');
        await expect(provision.ensure('poll', 'creator')).rejects.toThrow('設定中');
        await vi.waitFor(() => expect(finish).toBeDefined());
        finish?.(created());
        expect(await pending).toEqual({ status: 'ready', url: 'https://meet.google.com/abc-defg-hij' });
        expect(send.mock.calls.filter(call => String(call[0]).endsWith('/spaces'))).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(4);
        expect(await provision.ensure('poll', 'creator')).toEqual({ status: 'ready', url: 'https://meet.google.com/abc-defg-hij' });
        expect(send).toHaveBeenCalledTimes(4);
    }
    finally {
        db.close();
    }
});
it('lets the representative account host alone when a GLab-relayed creator has no linked Google account', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(created()).mockResolvedValueOnce(Response.json({}));
    const { db, provision, tokens } = (await fixture(send));
    try {
        const get = tokens.get.bind(tokens);
        vi.spyOn(tokens, 'get').mockImplementation(async (userId: string) => userId === 'creator' ? null : get(userId));
        await expect(provision.ensure('poll', 'creator')).rejects.toThrow('Google');
        (await db.prepare('DELETE FROM meeting_meet').run());
        expect(await provision.ensure('poll', 'creator', { creatorGoogle: 'optional' })).toEqual({ status: 'ready', url: 'https://meet.google.com/abc-defg-hij' });
        // Create + settings only: no member listing / COHOST call for the unlinked creator.
        expect(send).toHaveBeenCalledTimes(2);
    }
    finally {
        db.close();
    }
});
it('retains a dispatched creation result on revocation, makes no further Google call and later resumes that same space', async () => {
    let current = true;
    const operation: MeetOperation = { signal: new AbortController().signal,
        assertCurrent: async () => { if (!current) throw new MeetingError(403, 'Resource revoked'); } };
    const send = vi.fn<typeof fetch>().mockImplementationOnce(async () => { current = false; return created(); })
        .mockImplementation(async () => Response.json({ members: [] }));
    const { db, provision } = await fixture(send);
    try {
        await expect(provision.ensure('poll', 'creator', { operation })).rejects.toThrow('revoked');
        expect(send).toHaveBeenCalledTimes(1);
        const row = db.prepare('SELECT space_name,status FROM meeting_meet WHERE meeting_id=?').get('poll');
        expect(row).toEqual({ space_name: 'spaces/abc', status: 'configuring' });
        expect(await provision.get('poll')).toEqual({ status: 'configuring' });
        current = true;
        expect((await provision.ensure('poll', 'creator', { operation })).status).toBe('ready');
        expect(send.mock.calls.filter(call => String(call[0]).endsWith('/spaces'))).toHaveLength(1);
    } finally { db.close(); }
});
it('rechecks resource rights after account lookup before persisting intent or dispatching creation', async () => {
    let current = true;
    const operation: MeetOperation = { signal: new AbortController().signal,
        assertCurrent: async () => { if (!current) throw new MeetingError(403, 'Resource revoked'); } };
    const send = vi.fn<typeof fetch>();
    const { db, provision, tokens } = await fixture(send);
    const email = tokens.email.bind(tokens);
    vi.spyOn(tokens, 'email').mockImplementation(async userId => { const value = await email(userId); current = false; return value; });
    try {
        await expect(provision.ensure('poll', 'creator', { operation })).rejects.toThrow('revoked');
        expect(send).not.toHaveBeenCalled(); expect(db.prepare('SELECT * FROM meeting_meet').all()).toEqual([]);
    } finally { db.close(); }
});
it('passes request cancellation to Google without extending the existing transport timeout', async () => {
    const controller = new AbortController();
    const operation: MeetOperation = { signal: controller.signal, assertCurrent: async () => {} };
    const send = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        expect(init?.redirect).toBe('error'); expect(init?.signal?.aborted).toBe(false);
        controller.abort(); expect(init?.signal?.aborted).toBe(true);
        throw new Error('aborted');
    });
    const { db, provision } = await fixture(send);
    try {
        await expect(provision.ensure('poll', 'creator', { operation })).rejects.toThrow('Google');
        expect(await provision.get('poll')).toEqual({ status: 'uncertain' });
        expect(send).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
});
