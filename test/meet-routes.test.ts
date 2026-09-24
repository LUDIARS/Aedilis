import { expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import Database from 'better-sqlite3';
import { managedMeetRoutes } from '../server/meet/routes.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { migrateMeet } from '../server/meet/schema.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';
import type { AuthIdentity } from '../server/auth.ts';

vi.mock('../server/auth.ts', () => {
  const identity = (c: Context): AuthIdentity | null => c.req.header('x-test-user') ? {
    userId: c.req.header('x-test-user') || '', isAdmin: false, role: 'general', displayName: null, projectKey: c.req.header('x-test-project') || 'aedilis',
  } : null;
  return { readIdentity: async (c: Context) => identity(c), getIdentity: (c: Context) => c.get('auth'), requireAuth: async (c: Context, next: Next) => {
    const user = identity(c); if (!user) return c.json({ error: 'unauthorized' }, 401); c.set('auth', user); await next();
  } };
});

it('keeps managed Meet creation behind Cr, same-origin checks and meeting ownership', async () => {
  const db = new Database(':memory:');
  try {
    migrateMeetings(db); migrateMeet(db);
    db.prepare("INSERT INTO meeting_identity(id,user_id,created_at) VALUES('owner','creator',1)").run();
    db.prepare("INSERT INTO meeting_poll(id,owner_id,title,description,organizer_name,slots_json,venues_json,created_at,updated_at,online_allowed) VALUES('poll','owner','Title','','Host','[]','[]',1,1,1)").run();
    const request = vi.fn(async () => null);
    const client = { request } as unknown as CernereProjectClient;
    const app = new Hono().route('/api/meet', managedMeetRoutes(db, client, { clientId: 'id', clientSecret: 'secret', publicUrl: 'https://ae.example' }));
    const headers = { origin: 'https://ae.example', 'content-type': 'application/json', 'x-test-user': 'creator' };
    expect((await app.request('/api/meet/poll', { method: 'POST', headers: { origin: headers.origin, 'content-type': headers['content-type'] }, body: '{}' })).status).toBe(401);
    expect((await app.request('/api/meet/poll', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await app.request('/api/meet/poll', { method: 'POST', headers: { ...headers, 'x-test-user': 'outsider' }, body: '{}' })).status).toBe(403);
    expect((await app.request('/api/meet/poll', { headers: { ...headers, 'x-test-project': 'another' } })).status).toBe(403);
    expect((await app.request('/api/meet/oauth/start', { method: 'POST', headers, body: JSON.stringify({ mode: 'organizer' }) })).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
    db.prepare("UPDATE meeting_poll SET state='cancelled'").run();
    expect(await (await app.request('/api/meet/poll', { headers })).json()).toEqual({ status: 'cancelled' });
    expect((await app.request('/api/meet/poll', { method: 'POST', headers, body: '{}' })).status).toBe(409);
  } finally { db.close(); }
});
