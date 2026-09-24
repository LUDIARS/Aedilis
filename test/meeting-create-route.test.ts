import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { makeMeetingRouter } from '../server/meetings/routes.ts';
import { request } from '../public/src/meetings/request.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }));
afterEach(() => vi.unstubAllGlobals());

it('creates through the mounted frontend API, reloads, and edits online availability separately from venues', async () => {
  const db = new Database(':memory:');
  try {
    migrateMeetings(db); migrateMeetings(db);
    const origin = 'https://ae.example.com';
    const client = { request: async () => { throw new Error('Unexpected Cernere request'); } } as unknown as CernereProjectClient;
    const app = new Hono().route('/api/meetings', makeMeetingRouter(db, {
      publicUrl: origin, cernereUrl: origin, cernerePublicUrl: '', googleClientId: '',
      discordToken: null, notificationIntervalMs: 1000, notificationMaxAttempts: 1,
    }, client));
    let cookie = '';
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers); headers.set('origin', origin); headers.set('cookie', cookie);
      const result = await app.request(origin + path, { ...init, headers });
      cookie = result.headers.get('set-cookie')?.split(';')[0] || cookie;
      return result;
    });
    await request('/session', 'POST', {});
    // Mounted Hono root is /api/meetings; the old UI's trailing slash produced 404.
    const legacy = await app.request(origin + '/api/meetings/', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    expect(legacy.status).toBe(404);
    const draft = { title: 'Route regression', description: '', organizerName: 'Host', onlineAllowed: true,
      slots: [{ id: 'slot', startAt: '2026-10-01T01:00:00Z', endAt: '2026-10-01T02:00:00Z', venue: 'Room' }], venues: [{ name: 'Room', busy: [] }] };
    const { id } = await request<{ id: string }>('/', 'POST', draft);
    const created = await request<{ onlineAllowed: boolean; canManage: boolean; revision: number }>('/' + id);
    expect(created.onlineAllowed).toBe(true); expect(created.canManage).toBe(true);
    await request('/' + id, 'PATCH', { ...draft, onlineAllowed: false, revision: created.revision });
    expect(await request('/' + id)).toMatchObject({ onlineAllowed: false, venues: draft.venues });
    await expect(request('', 'POST', { ...draft, onlineAllowed: 'yes' })).rejects.toThrow('オンライン');
  } finally { db.close(); }
});
