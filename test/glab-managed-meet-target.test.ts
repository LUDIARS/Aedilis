/** @implements SPEC-AE-GLAB-MANAGED-MEET-DELEGATION-001 */
import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { openDb } from '../server/db.ts';
import { migrateMeetings } from '../server/meetings/schema.ts';
import { migrateMeet } from '../server/meet/schema.ts';
import { MeetingRepository } from '../server/meetings/repository.ts';
import { saveAudience } from '../server/booking-access/policy.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';
import type { BoundServiceSession } from '../server/vendor/cernere-composite/service-session.js';
import { CompositeDelegations, type DelegatedHttpOperation } from '../server/vendor/cernere-composite/delegation.js';
import { managedMeetRoutes } from '../server/meet/routes.ts';
import { GLAB_MANAGED_MEET_PREFIX as prefix, glabManagedMeetOperation, makeGlabManagedMeetTarget } from '../server/glab/managed-meet-target.ts';

const redirectUri = 'https://glab.fixture.invalid/api/x/facility/meet/oauth/callback';
function fixture() {
  const db = openDb(':memory:'), secret = randomBytes(48).toString('base64url');
  const prior = process.env.GLAB_AEDILIS_CONTEXT_SECRET;
  const state = { subject: 'owner', consumes: 0, source: 'glab', unavailable: false };
  const pending = new Map<string, Record<string, unknown>>();
  const stored = vi.fn();
  const close = (): void => { db.close(); if (prior === undefined) delete process.env.GLAB_AEDILIS_CONTEXT_SECRET; else process.env.GLAB_AEDILIS_CONTEXT_SECRET = prior; };
  try {
    migrateMeetings(db); migrateMeet(db);
    process.env.GLAB_AEDILIS_CONTEXT_SECRET = secret;
    const issuer = new CompositeDelegations(async (_action, value) => {
      const payload = value as Record<string, unknown>, token = randomBytes(32).toString('base64url');
      pending.set(token, { ...payload, subject: state.subject });
      return { delegationToken: token, requestId: payload.requestId, expiresAt: new Date(Date.now() + 25_000).toISOString() };
    }, 'glab');
    const consumer = new CompositeDelegations(async (_action, value) => {
      state.consumes++;
      if (state.unavailable) throw new Error('private authority diagnostic');
      const payload = value as Record<string, unknown>, issued = pending.get(payload.delegationToken as string);
      pending.delete(payload.delegationToken as string);
      if (!issued) throw new Error('Used or missing proof');
      for (const name of ['action', 'method', 'path', 'resource', 'headersDigest', 'contentDigest', 'requestId']) {
        if (payload[name] !== issued[name]) throw new Error('Envelope mismatch');
      }
      return { allowed: true, sourceProject: state.source, projectKey: 'aedilis', requestId: payload.requestId,
        user: { id: issued.subject, role: 'general', displayName: 'Subject', email: null },
        risk: payload.method === 'GET' ? 'sensitive_read' : 'important', expiresAt: new Date(Date.now() + 25_000).toISOString() };
    }, 'aedilis');
    const request = vi.fn(async (_module: string, action: string, input: Record<string, unknown>) => {
      if (action === 'store_oauth_token') { stored(input); return {}; }
      if (action !== 'get_oauth_token') throw new Error('Unexpected Cr action');
      return { accessToken: randomBytes(32).toString('base64url'), refreshToken: null,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), metadata: { subject: input.userId,
          email: input.userId + '@fixture.invalid', emailVerified: true, meetOrganizer: input.userId === 'organizer' } };
    });
    const managed = managedMeetRoutes(db, { request } as unknown as CernereProjectClient,
      { clientId: randomBytes(16).toString('hex'), clientSecret: randomBytes(32).toString('base64url'),
        publicUrl: 'https://ae.fixture.invalid', externalRedirectUris: { glab: [redirectUri] } });
    // Both surfaces borrow the same owner. The test does not start auth or services.
    const app = new Hono().route('/api/meet', managed).route(prefix, makeGlabManagedMeetTarget(db, managed, consumer, new Set()));
    async function prepare(path: string, method: DelegatedHttpOperation['method'] = 'GET', body = ''): Promise<RequestInit> {
      const operation = glabManagedMeetOperation(method, new URL(path, 'https://fixture.invalid').pathname);
      if (!operation) throw new Error('Unclassified fixture route');
      const payload = Buffer.from(JSON.stringify({ version: 1, source: 'glab', userId: state.subject, groups: [], method, path,
        bodyHash: createHash('sha256').update(body).digest('hex'), expiresAt: Date.now() + 25_000 })).toString('base64url');
      const headers = new Headers({ 'content-type': 'application/json', 'x-glab-booking-context': payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url') });
      const session: BoundServiceSession = { user: { id: state.subject, role: 'general', displayName: 'Subject', email: null }, projectKey: 'glab',
        projectToken: randomBytes(32).toString('base64url'), sessionBinding: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const proof = await issuer.issue(session, { projectKey: 'aedilis', audience: 'https://ae.fixture.invalid' }, {
        action: operation.action, path, resource: path, method, body, headers, additionalHeaders: ['x-glab-booking-context'],
      });
      headers.set('authorization', 'Cernere-Delegation ' + proof.delegationToken); headers.set('x-cernere-request-id', proof.requestId);
      return { method, headers, ...(method === 'GET' ? {} : { body }) };
    }
    async function seed(subject = 'owner', visibility: 'private' | 'public' = 'private'): Promise<string> {
      const current = { id: 'identity-' + subject, user_id: subject, notify: 0 };
      db.prepare('INSERT OR IGNORE INTO meeting_identity(id,user_id,created_at) VALUES(?,?,?)').run(current.id, subject, 1);
      const id = await new MeetingRepository(db).create({ title: 'Meeting', description: '', organizerName: 'Owner', onlineAllowed: true,
        slots: [], venues: [] }, { userId: subject, current, identities: [current], groups: [] });
      await saveAudience(db, 'meeting', id, { visibility, group: null }); return id;
    }
    return { db, app, state, stored, request, prepare, seed, close };
  } catch (error) { close(); throw error; }
}

describe('six scoped managed Meet target shapes', () => {
  it('refuses unknown methods/routes, old credentials and missing signed context before consumption', async () => {
    const f = fixture();
    try {
      for (const path of ['/oauth/callback', '/external/glab-event/1', '/unknown']) {
        expect((await f.app.request(prefix + path)).status).toBe(403);
      }
      expect(glabManagedMeetOperation('HEAD', prefix + '/status')).toBeNull();
      expect((await f.app.request(prefix + '/status', { headers: { authorization: 'Bearer old', cookie: 'cernere_token=old' } })).status).toBe(401);
      const init = await f.prepare(prefix + '/status'), headers = new Headers(init.headers); headers.delete('x-glab-booking-context');
      expect((await f.app.request(prefix + '/status', { ...init, headers })).status).toBe(401);
      expect(f.state.consumes).toBe(0); expect(f.request).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it('uses one consumed proof for status and never turns scoped identity into a direct reusable login', async () => {
    const f = fixture();
    try {
      const init = await f.prepare(prefix + '/status');
      const response = await f.app.request(prefix + '/status', init);
      expect(response.status).toBe(200); expect((await response.json() as { email: string }).email).toBe('owner@fixture.invalid');
      expect(f.state.consumes).toBe(1);
      expect((await f.app.request(prefix + '/status', init)).status).toBe(503);
      const legacyHeaders = new Headers(init.headers); legacyHeaders.delete('x-glab-booking-context');
      expect((await f.app.request('/api/meet/status', { ...init, headers: legacyHeaders })).status).toBe(401);
    } finally { f.close(); }
  });
  it('requires current meeting audience and owner independently of a readable public row', async () => {
    const f = fixture();
    try {
      const own = await f.seed(), privateId = await f.seed('other'), publicId = await f.seed('public-owner', 'public');
      expect((await f.app.request(prefix + '/' + own, await f.prepare(prefix + '/' + own))).status).toBe(200);
      expect((await f.app.request(prefix + '/' + privateId, await f.prepare(prefix + '/' + privateId))).status).toBe(404);
      expect((await f.app.request(prefix + '/' + publicId, await f.prepare(prefix + '/' + publicId, 'POST', '{}'))).status).toBe(403);
      expect(f.request).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it('keeps external OAuth state bound to the same user and exact allowlisted source without exposing direct callbacks', async () => {
    const f = fixture();
    try {
      const path = prefix + '/oauth/start', body = JSON.stringify({ mode: 'creator', redirectUri });
      const response = await f.app.request(path, await f.prepare(path, 'POST', body));
      expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull();
      const url = new URL((await response.json() as { url: string }).url), state = url.searchParams.get('state');
      expect(url.searchParams.get('redirect_uri')).toBe(redirectUri); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      f.state.subject = 'other';
      const complete = prefix + '/oauth/complete', payload = JSON.stringify({ state, code: randomBytes(16).toString('hex') });
      expect((await f.app.request(complete, await f.prepare(complete, 'POST', payload))).status).toBe(403);
      expect(f.stored).not.toHaveBeenCalled();
      f.state.subject = 'owner';
      const denied = JSON.stringify({ mode: 'organizer', redirectUri });
      expect((await f.app.request(path, await f.prepare(path, 'POST', denied))).status).toBe(403);
    } finally { f.close(); }
  });
  it('fails closed on authority errors, wrong source or changed body before any Google/account access', async () => {
    const f = fixture();
    try {
      f.state.unavailable = true;
      expect((await f.app.request(prefix + '/status', await f.prepare(prefix + '/status'))).status).toBe(503);
      f.state.unavailable = false; f.state.source = 'other';
      expect((await f.app.request(prefix + '/status', await f.prepare(prefix + '/status'))).status).toBe(503);
      f.state.source = 'glab';
      const path = prefix + '/oauth/start', init = await f.prepare(path, 'POST', '{}');
      expect((await f.app.request(path, { ...init, body: '{"mode":"creator"}' })).status).toBe(503);
      expect(f.request).not.toHaveBeenCalled(); expect(f.stored).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it('completes a same-user external state once using the existing Google exchange and never returns credentials', async () => {
    let f: ReturnType<typeof fixture> | undefined;
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(init?.redirect).toBe('error');
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: randomBytes(32).toString('base64url'), expires_in: 3600, scope: 'openid email' });
      }
      if (String(input) === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ sub: 'owner', email: 'owner@fixture.invalid', email_verified: true });
      }
      throw new Error('Unexpected Google destination');
    });
    try {
      f = fixture();
      const start = prefix + '/oauth/start', body = JSON.stringify({ mode: 'creator', redirectUri });
      const started = await f.app.request(start, await f.prepare(start, 'POST', body));
      expect(started.status).toBe(200);
      const state = new URL((await started.json() as { url: string }).url).searchParams.get('state');
      const complete = prefix + '/oauth/complete', payload = JSON.stringify({ state, code: randomBytes(16).toString('hex') });
      const response = await f.app.request(complete, await f.prepare(complete, 'POST', payload));
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ mode: 'creator' });
      expect(f.stored).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
      expect((await f.app.request(complete, await f.prepare(complete, 'POST', payload))).status).toBe(403);
      expect(f.stored).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
    } finally { send.mockRestore(); f?.close(); }
  });
});
