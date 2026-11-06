/** @implements SPEC-AE-GLAB-RESERVATION-DELEGATION-001 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { openDb, createReservation, upsertFacilityCache, getReservation, listReservations } from '../server/db.ts';
import type { FacilitySource } from '../server/facility/source.ts';
import { saveAudience } from '../server/booking-access/policy.ts';
import { CompositeDelegations, type DelegatedHttpOperation } from '../server/vendor/cernere-composite/delegation.js';
import type { BoundServiceSession } from '../server/vendor/cernere-composite/service-session.js';
import { GLAB_RESERVATION_PREFIX as prefix, makeGlabReservationTarget, reservationOperation } from '../server/glab/reservation-target.ts';

const user = { id: 'subject', role: 'general', displayName: 'Subject', email: null };
const group = { kind: 'team' as const, id: 'one-team', name: 'One team' };
function fixture() {
  const db = openDb(':memory:');
  // Per-fixture memory only; never embed or fetch a deployment credential.
  const secret = randomBytes(32).toString('base64url');
  const priorSecret = process.env.GLAB_AEDILIS_CONTEXT_SECRET;
  process.env.GLAB_AEDILIS_CONTEXT_SECRET = secret;
  const state = { consumes: 0, unavailable: false, sourceProject: 'glab', onFacility: () => {} };
  const source: FacilitySource = {
    sourceName: 'fixture',
    async listFacilities() { state.onFacility(); return [{ id: 'room', name: 'Room' }]; },
    async getFacility(id) { state.onFacility(); return id === 'room' ? { id, name: 'Room' } : null; },
  };
  const pending = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const issuer = new CompositeDelegations(async (_action, payload) => {
    const body = payload as Record<string, unknown>;
    const token = 't'.repeat(40) + String(++sequence).padStart(3, '0');
    pending.set(token, body);
    return { delegationToken: token, requestId: body.requestId, expiresAt: new Date(Date.now() + 20_000).toISOString() };
  }, 'glab');
  const consumer = new CompositeDelegations(async (action, payload) => {
    state.consumes++;
    expect(action).toBe('consume-delegation');
    if (state.unavailable) throw new Error('private authority detail');
    const body = payload as Record<string, unknown>;
    const issued = pending.get(body.delegationToken as string);
    pending.delete(body.delegationToken as string);
    expect(issued).toBeDefined();
    for (const key of ['action', 'method', 'path', 'resource', 'requestId', 'headersDigest', 'contentDigest']) expect(body[key]).toEqual(issued?.[key]);
    const operation = reservationOperation(body.method as string, new URL(body.path as string, 'https://fixture.invalid').pathname);
    if (!operation) throw new Error('Unclassified fixture operation');
    return { allowed: true, requestId: body.requestId, sourceProject: state.sourceProject, projectKey: 'aedilis', user,
      risk: operation.risk, expiresAt: new Date(Date.now() + 20_000).toISOString() };
  }, 'aedilis');
  const admins = new Set<string>();
  const app = new Hono();
  app.route(prefix, makeGlabReservationTarget(db, source, consumer, admins));
  const session: BoundServiceSession = { user, projectKey: 'glab', sessionBinding: 'source-binding', projectToken: 'source-only', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  async function prepare(path: string, action: string, method: DelegatedHttpOperation['method'] = 'GET', body = '', groups?: unknown[]): Promise<RequestInit> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (groups) {
      const payload = Buffer.from(JSON.stringify({ version: 1, source: 'glab', userId: user.id, groups, method, path,
        bodyHash: createHash('sha256').update(body).digest('hex'), expiresAt: Date.now() + 20_000 })).toString('base64url');
      headers.set('x-glab-booking-context', payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url'));
    }
    const operation = reservationOperation(method, new URL(path, 'https://fixture.invalid').pathname);
    const credential = await issuer.issue(session, { projectKey: 'aedilis', audience: 'https://aedilis.fixture.invalid' },
      { action, method, path, resource: path, body, headers, ...(operation?.booking ? { additionalHeaders: ['x-glab-booking-context'] } : {}) });
    headers.set('authorization', 'Cernere-Delegation ' + credential.delegationToken);
    headers.set('x-cernere-request-id', credential.requestId);
    return { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body }) };
  }
  async function seed(owner: string, visibility: 'private' | 'internal' | 'public', start = 1000) {
    await upsertFacilityCache(db, { facilityId: 'room', displayName: 'Room', source: 'fixture', allowOverlap: false, rawJson: '{}' });
    const row = await createReservation(db, { facilityId: 'room', ownerUserId: owner, startAt: start, endAt: start + 100,
      purpose: visibility + '-purpose', state: 'confirmed' });
    await saveAudience(db, 'reservation', row.id, { visibility, group: visibility === 'internal' ? group : null });
    return row;
  }
  return { db, app, state, admins, prepare, seed, close() {
    db.close();
    if (priorSecret === undefined) delete process.env.GLAB_AEDILIS_CONTEXT_SECRET;
    else process.env.GLAB_AEDILIS_CONTEXT_SECRET = priorSecret;
  } };
}

describe('scoped GLAB reservation target', () => {
  it('admits only eight existing route shapes and rejects legacy credentials before consuming', async () => {
    const f = fixture();
    try {
      for (const path of ['/reservations/public', '/meetings', '/facilities/room/overlap', '/reservations/00000000-0000-0000-0000-000000000000']) {
        expect((await f.app.request(prefix + path)).status).toBe(403);
      }
      const legacy: RequestInit[] = [{ headers: { authorization: 'Bearer old-global' } }, { headers: { cookie: 'cernere_token=old' } }, { method: 'HEAD' }];
      for (const init of legacy) {
        expect([401, 403]).toContain((await f.app.request(prefix + '/facilities', init)).status);
      }
      expect(f.state.consumes).toBe(0);
      const response = await f.app.request(prefix + '/facilities', await f.prepare(prefix + '/facilities', 'facility.list'));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(f.state.consumes).toBe(1);
      expect((await f.app.request(prefix + '/facilities/room', await f.prepare(prefix + '/facilities/room', 'facility.read'))).status).toBe(200);
      const capabilities = await f.app.request(prefix + '/reservations/capabilities', await f.prepare(prefix + '/reservations/capabilities', 'reservation.capabilities'));
      expect(await capabilities.json()).toEqual({ groupContextVersion: 1 });
      expect(f.state.consumes).toBe(3);
    } finally { f.close(); }
  });
  it('checks current audience and signed groups without making private bookings group-readable', async () => {
    const f = fixture();
    try {
      const own = await f.seed(user.id, 'private');
      const other = await f.seed('other', 'private', 2000);
      const internal = await f.seed('other', 'internal', 3000);
      const path = prefix + '/reservations';
      const response = await f.app.request(path, await f.prepare(path, 'reservations.list', 'GET', '', [group]));
      expect(response.status).toBe(200);
      const ids = (await response.json() as { items: { id: string }[] }).items.map(row => row.id);
      expect(ids).toContain(own.id); expect(ids).toContain(internal.id); expect(ids).not.toContain(other.id);
      await saveAudience(f.db, 'reservation', internal.id, { visibility: 'private', group: null });
      const changed = await f.app.request(path, await f.prepare(path, 'reservations.list', 'GET', '', [group]));
      expect((await changed.json() as { items: { id: string }[] }).items.map(row => row.id)).not.toContain(internal.id);
    } finally { f.close(); }
  });
  it('keeps mutation ownership and local admin decisions, and consumes each proof once', async () => {
    const f = fixture();
    try {
      const row = await f.seed('other', 'private');
      const path = prefix + '/reservations/' + row.id;
      const init = await f.prepare(path, 'reservations.delete', 'DELETE');
      expect((await f.app.request(path, init)).status).toBe(403);
      expect((await getReservation(f.db, row.id))?.state).toBe('confirmed');
      expect((await f.app.request(path, init)).status).toBe(503);
      f.admins.add(user.id);
      const deleted = await f.app.request(path, await f.prepare(path, 'reservations.delete', 'DELETE'));
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ reservation: { id: row.id, state: 'cancelled' } });
    } finally { f.close(); }
  });
  it('creates and updates only the verified owner while preserving booking policies and conflict protection', async () => {
    const f = fixture();
    try {
      const path = prefix + '/reservations';
      const body = JSON.stringify({ facilityId: 'room', startAt: '2028-01-01T10:00:00Z', endAt: '2028-01-01T11:00:00Z',
        ownerUserId: 'spoofed', isAdmin: true, visibility: 'internal', group });
      const response = await f.app.request(path, await f.prepare(path, 'reservations.create', 'POST', body, [group]));
      expect(response.status).toBe(201);
      const created = (await response.json() as { reservation: { id: string; owner_user_id: string; visibility: string } }).reservation;
      expect(created.owner_user_id).toBe(user.id); expect(created.visibility).toBe('internal');
      const changedPath = path + '/' + created.id;
      const patch = JSON.stringify({ purpose: 'Revised', visibility: 'private', group: null });
      const updated = await f.app.request(changedPath, await f.prepare(changedPath, 'reservations.update', 'PATCH', patch, [group]));
      expect(updated.status).toBe(200);
      expect((await getReservation(f.db, created.id))?.purpose).toBe('Revised');
      const duplicate = await f.app.request(path, await f.prepare(path, 'reservations.create', 'POST', body, [group]));
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ error: 'reservation_conflict', code: 'RESERVATION_CONFLICT' });
      const mine = await f.app.request(path + '/mine?userId=another', await f.prepare(path + '/mine?userId=another', 'reservations.own'));
      expect((await mine.json() as { items: { id: string }[] }).items.map(row => row.id)).toEqual([created.id]);
    } finally { f.close(); }
  });
  it('binds semantic headers and exact body, and rejects an unavailable or different source authority', async () => {
    const f = fixture();
    try {
      const path = prefix + '/reservations';
      const body = JSON.stringify({ facilityId: 'room', startAt: '2028-01-01T10:00:00Z', endAt: '2028-01-01T11:00:00Z' });
      const init = await f.prepare(path, 'reservations.create', 'POST', body, [group]);
      const headers = new Headers(init.headers); headers.delete('x-glab-booking-context');
      expect((await f.app.request(path, { ...init, headers })).status).toBe(503);
      const changedBody = await f.prepare(path, 'reservations.create', 'POST', body);
      expect((await f.app.request(path, { ...changedBody, body: body + ' ' })).status).toBe(503);
      f.state.unavailable = true;
      const unavailable = await f.app.request(prefix + '/facilities', await f.prepare(prefix + '/facilities', 'facility.list'));
      expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain('private authority detail');
      f.state.unavailable = false; f.state.sourceProject = 'another-service';
      expect((await f.app.request(path, await f.prepare(path, 'reservations.create', 'POST', body))).status).toBe(503);
      expect(await listReservations(f.db, {})).toEqual([]);
    } finally { f.close(); }
  });
  it('cannot write after facility lookup disconnects and bounds input before authority consumption', async () => {
    const f = fixture();
    try {
      const path = prefix + '/reservations';
      const controller = new AbortController();
      f.state.onFacility = () => controller.abort();
      const body = JSON.stringify({ facilityId: 'room', startAt: '2028-01-01T10:00:00Z', endAt: '2028-01-01T11:00:00Z' });
      const response = await f.app.request(path, { ...await f.prepare(path, 'reservations.create', 'POST', body), signal: controller.signal });
      expect([408, 503]).toContain(response.status);
      expect(await listReservations(f.db, {})).toEqual([]);
      const consumes = f.state.consumes;
      const excessive = 'x'.repeat(64 * 1024 + 1);
      expect((await f.app.request(path, await f.prepare(path, 'reservations.create', 'POST', excessive))).status).toBe(413);
      expect(f.state.consumes).toBe(consumes);
    } finally { f.close(); }
  });
  it('a delegated envelope cannot replace the independently verified booking group signature', async () => {
    const f = fixture();
    try {
      await f.seed('other', 'internal');
      process.env.GLAB_AEDILIS_CONTEXT_SECRET = randomBytes(32).toString('base64url');
      const path = prefix + '/reservations';
      const response = await f.app.request(path, await f.prepare(path, 'reservations.list', 'GET', '', [group]));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('internal-purpose');
      expect(f.state.consumes).toBe(1);
    } finally { f.close(); }
  });
});
