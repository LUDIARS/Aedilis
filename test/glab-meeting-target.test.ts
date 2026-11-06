/** @implements SPEC-AE-GLAB-MEETING-DELEGATION-001 */
import { describe, expect, it, vi } from 'vitest';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { openDb } from '../server/db.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { makeMeetingRouter } from '../server/meetings/routes.ts';
import { MeetingRepository } from '../server/meetings/repository.ts';
import { saveAudience } from '../server/booking-access/policy.ts';
import type { Actor } from '../server/meetings/types.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';
import { CompositeDelegations, type DelegatedHttpOperation } from '../server/vendor/cernere-composite/delegation.js';
import type { BoundServiceSession } from '../server/vendor/cernere-composite/service-session.js';
import { GLAB_MEETING_PREFIX as prefix, glabMeetingOperation, makeGlabMeetingTarget } from '../server/glab/meeting-target.ts';

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }));
const draft = { title: 'Poll', description: '', organizerName: 'Owner', onlineAllowed: false, guestResponses: false,
  slots: [{ id: 'slot', startAt: '2028-01-01T10:00:00Z', endAt: '2028-01-01T11:00:00Z', venue: '' }], venues: [] };
function fixture() {
  const db = openDb(':memory:');
  const prior = process.env.GLAB_AEDILIS_CONTEXT_SECRET;
  const secret = randomBytes(48).toString('base64url');
  let dispose = (): void => {};
  const close = (): void => { dispose(); db.close(); if (prior === undefined) delete process.env.GLAB_AEDILIS_CONTEXT_SECRET; else process.env.GLAB_AEDILIS_CONTEXT_SECRET = prior; };
  try {
    migrateMeetings(db);
    process.env.GLAB_AEDILIS_CONTEXT_SECRET = secret;
    const state = { subject: 'owner', consumes: 0, unavailable: false, onConsume: () => {}, afterHandler: (_c: Context) => {} };
    const pending = new Map<string, Record<string, unknown>>();
    const issuer = new CompositeDelegations(async (_action, value) => {
      const payload = value as Record<string, unknown>, token = randomBytes(32).toString('base64url');
      pending.set(token, { ...payload, subject: state.subject });
      return { delegationToken: token, requestId: payload.requestId, expiresAt: new Date(Date.now() + 25_000).toISOString() };
    }, 'glab');
    const consumer = new CompositeDelegations(async (action, value) => {
      state.consumes++; expect(action).toBe('consume-delegation');
      if (state.unavailable) throw new Error('private authority diagnostic');
      const payload = value as Record<string, unknown>, issued = pending.get(payload.delegationToken as string);
      pending.delete(payload.delegationToken as string); expect(issued).toBeDefined();
      for (const field of ['action', 'method', 'path', 'resource', 'headersDigest', 'contentDigest', 'requestId']) expect(payload[field]).toEqual(issued?.[field]);
      state.onConsume();
      return { allowed: true, sourceProject: 'glab', projectKey: 'aedilis', requestId: payload.requestId,
        user: { id: issued?.subject, role: 'general', displayName: 'Subject', email: null },
        risk: payload.method === 'GET' ? 'sensitive_read' : 'important', expiresAt: new Date(Date.now() + 25_000).toISOString() };
    }, 'aedilis');
    const meetings = makeMeetingRouter(db, { publicUrl: 'https://ae.fixture.invalid', cernereUrl: 'https://cr.fixture.invalid',
      cernerePublicUrl: '', googleClientId: '', discordToken: null, notificationIntervalMs: 1000, notificationMaxAttempts: 1 },
    { request: async () => { throw new Error('Unexpected remote client request'); } } as unknown as CernereProjectClient);
    dispose = () => meetings.dispose();
    const wrapped = new Hono(); wrapped.use('*', async (c, next) => { await next(); state.afterHandler(c); }); wrapped.route('/', meetings);
    const app = new Hono().route(prefix, makeGlabMeetingTarget(db, wrapped, consumer, new Set()));
    async function prepare(path: string, method: DelegatedHttpOperation['method'] = 'GET', body = ''): Promise<RequestInit> {
      const operation = glabMeetingOperation(method, new URL(path, 'https://fixture.invalid').pathname);
      if (!operation) throw new Error('Unclassified fixture route');
      const payload = Buffer.from(JSON.stringify({ version: 1, source: 'glab', userId: state.subject, groups: [], method, path,
        bodyHash: createHash('sha256').update(body).digest('hex'), expiresAt: Date.now() + 25_000 })).toString('base64url');
      const headers = new Headers({ 'content-type': 'application/json', 'x-glab-booking-context': payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url') });
      const session: BoundServiceSession = { user: { id: state.subject, role: 'general', displayName: 'Subject', email: null }, projectKey: 'glab',
        projectToken: 'source-only', sessionBinding: 'binding', expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const credential = await issuer.issue(session, { projectKey: 'aedilis', audience: 'https://ae.fixture.invalid' }, {
        action: operation.action, method, path, resource: path, headers, body, additionalHeaders: ['x-glab-booking-context'],
      });
      headers.set('authorization', 'Cernere-Delegation ' + credential.delegationToken); headers.set('x-cernere-request-id', credential.requestId);
      return { method, headers, ...(method === 'GET' ? {} : { body }) };
    }
    async function seed(subject: string, visibility: 'private' | 'public') {
      const identity = { id: 'identity-' + subject, user_id: subject, notify: 0 };
      db.prepare('INSERT OR IGNORE INTO meeting_identity(id,user_id,created_at) VALUES(?,?,?)').run(identity.id, subject, 1);
      const actor: Actor = { userId: subject, current: identity, identities: [identity], groups: [] };
      const id = await new MeetingRepository(db).create({ ...draft, title: visibility + ' poll' }, actor);
      await saveAudience(db, 'meeting', id, { visibility, group: null }); return id;
    }
    return { db, app, state, prepare, seed, close };
  } catch (error) { close(); throw error; }
}

describe('scoped meeting target', () => {
  it('rejects old/session/guest/unknown routes and missing group context without consuming', async () => {
    const f = fixture();
    try {
      for (const [method, suffix] of [['POST', '/session'], ['POST', '/session/login/complete'], ['GET', '/config'],
        ['GET', '/facilities'], ['HEAD', ''], ['POST', '/not-an-id/finalize']]) {
        expect((await f.app.request(prefix + suffix, { method })).status).toBe(403);
      }
      const init = await f.prepare(prefix), headers = new Headers(init.headers); headers.delete('x-glab-booking-context');
      expect((await f.app.request(prefix, { ...init, headers })).status).toBe(401);
      expect((await f.app.request(prefix, { headers: { authorization: 'Bearer old', cookie: 'cernere_token=old' } })).status).toBe(401);
      expect(f.state.consumes).toBe(0);
    } finally { f.close(); }
  });
  it('reads only the current audience and keeps owner-only mutation independent of a readable public row', async () => {
    const f = fixture();
    try {
      const own = await f.seed('owner', 'private'), other = await f.seed('other', 'private'), publicId = await f.seed('other', 'public');
      const response = await f.app.request(prefix, await f.prepare(prefix));
      expect(response.status).toBe(200);
      const ids = (await response.json() as { items: { id: string }[] }).items.map(row => row.id);
      expect(ids).toContain(own); expect(ids).toContain(publicId); expect(ids).not.toContain(other);
      expect((await f.app.request(prefix + '/' + other, await f.prepare(prefix + '/' + other))).status).toBe(404);
      const body = JSON.stringify({ ...draft, revision: 1 });
      const denied = await f.app.request(prefix + '/' + publicId, await f.prepare(prefix + '/' + publicId, 'PATCH', body));
      expect(denied.status).toBe(403); expect((await new MeetingRepository(f.db).get(publicId)).revision).toBe(1);
      await saveAudience(f.db, 'meeting', publicId, { visibility: 'private', group: null });
      expect((await f.app.request(prefix + '/' + publicId, await f.prepare(prefix + '/' + publicId))).status).toBe(404);
    } finally { f.close(); }
  });
  it('creates only the verified actor and accepts the revision body on DELETE with one-use consumption', async () => {
    const f = fixture();
    try {
      const create = await f.app.request(prefix, await f.prepare(prefix, 'POST', JSON.stringify({ ...draft, ownerUserId: 'another' }, null, 2)));
      expect(create.status).toBe(201); const id = (await create.json() as { id: string }).id;
      const row = await new MeetingRepository(f.db).get(id);
      expect(f.db.prepare('SELECT user_id FROM meeting_identity WHERE id=?').get(row.owner_id)).toEqual({ user_id: 'owner' });
      const path = prefix + '/' + id;
      expect((await f.app.request(path, await f.prepare(path, 'PATCH', JSON.stringify({ ...draft, title: 'Revised', revision: row.revision })))).status).toBe(200);
      const current = await new MeetingRepository(f.db).get(id);
      expect(current.title).toBe('Revised');
      const init = await f.prepare(path, 'DELETE', JSON.stringify({ revision: current.revision }));
      expect((await f.app.request(path, init)).status).toBe(200);
      expect((await new MeetingRepository(f.db).get(id)).state).toBe('cancelled');
      expect((await f.app.request(path, init)).status).toBe(503);
    } finally { f.close(); }
  });
  it('keeps GLAB handoff idempotency and requires the current owner for export/cancel', async () => {
    const f = fixture();
    try {
      const id = await f.seed('owner', 'public'), path = prefix + '/' + id + '/glab-event/finalize';
      const finalize = prefix + '/' + id + '/finalize';
      expect((await f.app.request(finalize, await f.prepare(finalize, 'POST', JSON.stringify({ slotId: 'slot', revision: 1 })))).status).toBe(200);
      const body = JSON.stringify({ slotId: 'slot', revision: (await new MeetingRepository(f.db).get(id)).revision });
      const first = await f.app.request(path, await f.prepare(path, 'POST', body)); expect(first.status).toBe(200);
      const snapshot = await first.json();
      const again = await f.app.request(path, await f.prepare(path, 'POST', body)); expect(await again.json()).toEqual(snapshot);
      f.state.subject = 'other';
      expect((await f.app.request(path, await f.prepare(path, 'POST', body))).status).toBe(403);
      f.state.subject = 'owner';
      const cancel = prefix + '/' + id + '/glab-event/cancel';
      expect((await f.app.request(cancel, await f.prepare(cancel, 'POST', '{}'))).status).toBe(200);
      expect((await new MeetingRepository(f.db).get(id)).state).toBe('cancelled');
    } finally { f.close(); }
  });
  it('edits only the currently verified respondent while preserving meeting revisions', async () => {
    const f = fixture();
    try {
      const id = await f.seed('owner', 'public'), path = prefix + '/' + id + '/responses';
      f.state.subject = 'respondent';
      const body = { name: 'Respondent', comment: '', topic: '', answers: { slot: 'yes' }, meetingRevision: 1 };
      expect((await f.app.request(path, await f.prepare(path, 'POST', JSON.stringify(body)))).status).toBe(201);
      const response = f.db.prepare('SELECT id,revision FROM meeting_response WHERE meeting_id=?').get(id) as { id: string; revision: number };
      const edit = path + '/' + response.id, updated = JSON.stringify({ ...body, name: 'Revised respondent', revision: response.revision });
      f.state.subject = 'intruder';
      expect((await f.app.request(edit, await f.prepare(edit, 'PATCH', updated))).status).toBe(403);
      f.state.subject = 'respondent';
      expect((await f.app.request(edit, await f.prepare(edit, 'PATCH', updated))).status).toBe(200);
      expect((f.db.prepare('SELECT name FROM meeting_response WHERE id=?').get(response.id) as { name: string }).name).toBe('Revised respondent');
    } finally { f.close(); }
  });
  it('rolls back handler writes when the request ends before commit and never runs with unknown authority', async () => {
    const f = fixture();
    try {
      const controller = new AbortController(); f.state.afterHandler = () => controller.abort();
      const response = await f.app.request(prefix, { ...await f.prepare(prefix, 'POST', JSON.stringify(draft)), signal: controller.signal });
      expect(response.status).toBe(408);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM meeting_poll').get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM meeting_identity').get()).toEqual({ n: 0 });
      f.state.afterHandler = () => {}; f.state.unavailable = true;
      const unavailable = await f.app.request(prefix, await f.prepare(prefix, 'POST', JSON.stringify(draft)));
      expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain('private authority');
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM meeting_poll').get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });
  it('bounds DELETE input before authority and binds the exact revision bytes', async () => {
    const f = fixture();
    try {
      const id = await f.seed('owner', 'public'), path = prefix + '/' + id;
      const original = JSON.stringify({ revision: 1 }), init = await f.prepare(path, 'DELETE', original);
      expect((await f.app.request(path, { ...init, body: original + ' ' })).status).toBe(503);
      const consumes = f.state.consumes;
      expect((await f.app.request(path, await f.prepare(path, 'DELETE', 'x'.repeat(65537)))).status).toBe(413);
      expect(f.state.consumes).toBe(consumes);
      expect((await new MeetingRepository(f.db).get(id)).state).toBe('open');
    } finally { f.close(); }
  });
  it('preserves handled validation errors and rolls back their request transaction', async () => {
    const f = fixture();
    try {
      const malformed = await f.app.request(prefix, await f.prepare(prefix, 'POST', '{'));
      expect(malformed.status).toBe(400);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM meeting_identity').get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM meeting_poll').get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });
});
