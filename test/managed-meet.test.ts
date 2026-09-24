import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { migrateMeet } from '../server/meet/schema.ts';
import { MeetApi } from '../server/meet/api.ts';
import { MeetTokens } from '../server/meet/tokens.ts';
import { MeetProvisioner } from '../server/meet/provision.ts';

function fixture(send: typeof fetch) {
  const db = new Database(':memory:');
  migrateMeetings(db); migrateMeet(db); migrateMeet(db);
  db.prepare('INSERT INTO meeting_identity(id,created_at) VALUES(?,?)').run('owner', 1);
  db.prepare("INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,slots_json,venues_json,created_at,updated_at) VALUES('poll','owner','Title','','Host','[]','[]',1,1)").run();
  db.prepare("INSERT INTO meet_organizer VALUES(1,'organizer')").run();
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
  const { db, provision } = fixture(send);
  try {
    expect(await provision.ensure('poll', 'creator')).toEqual({ status: 'ready', url: 'https://meet.google.com/abc-defg-hij' });
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toMatchObject({ config: { moderation: 'ON', artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } } });
    expect(JSON.parse(String(send.mock.calls[3]?.[1]?.body))).toEqual({ email: 'creator@gmail.com', role: 'COHOST' });
    await provision.ensure('poll', 'creator');
    expect(send).toHaveBeenCalledTimes(4);
    const saved = JSON.stringify(db.prepare('SELECT * FROM meeting_meet').all());
    expect(saved).not.toContain('secret-'); expect(saved).not.toContain('creator@gmail.com');
    await expect(provision.ensure('poll', 'other')).rejects.toThrow('Cr');
  } finally { db.close(); }
});

it('hides a partially configured link and resumes the same space after restart without duplicating its member', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(created()).mockRejectedValueOnce(new Error('network'));
  const { db, provision, tokens, api } = fixture(send);
  try {
    await expect(provision.ensure('poll', 'creator')).rejects.toThrow('Google');
    expect(provision.get('poll')).toEqual({ status: 'configuring' });
    send.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({ members: [{ name: 'spaces/abc/members/one', email: 'creator@gmail.com', role: 'COHOST' }] }));
    const restarted = new MeetProvisioner(db, tokens, api);
    expect((await restarted.ensure('poll', 'creator')).status).toBe('ready');
    expect(send.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  } finally { db.close(); }
});

it('never retries an uncertain create even after restart', async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
  const { db, provision, tokens, api } = fixture(send);
  try {
    await expect(provision.ensure('poll', 'creator')).rejects.toThrow('Google');
    expect(provision.get('poll')).toEqual({ status: 'uncertain' });
    await expect(new MeetProvisioner(db, tokens, api).ensure('poll', 'creator')).rejects.toThrow('重複');
    expect(send).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});

it('serializes simultaneous requests for one meeting', async () => {
  let finish: ((value: Response) => void) | undefined;
  // Each HTTP response has a single-use body, including mocked responses.
  const send = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockImplementation(async () => Response.json({ members: [] }));
  const { db, provision } = fixture(send);
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
  } finally { db.close(); }
});
