import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { meetingAuthority } from './fixtures/meeting-authority.ts';
import { CernereComposite } from '../server/vendor/cernere-composite/composite.js';
import { meetingOperation } from '../server/meetings/operation-policy.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps the reviewed source import byte-identical to the pinned integrity manifest', () => {
  const directory = new URL('../server/vendor/cernere-composite/', import.meta.url);
  const lock = JSON.parse(readFileSync(new URL('source-lock.json', directory), 'utf8')) as { commit: string; files: Record<string, string> };
  expect(lock.commit).toBe('b2bc69cf2130c719fa4db3db9cdcf44f4c5f5836');
  for (const [name, digest] of Object.entries(lock.files)) expect(createHash('sha256').update(readFileSync(new URL(name, directory))).digest('hex')).toBe(digest);
});
const verifier = 'v'.repeat(43);
describe('project-bound one-shot login and session ownership', () => {
  it('binds the opaque own session once, never exposes a global token, and rejects replay', async () => {
    const f = meetingAuthority(), nonce = f.sessions.beginLogin();
    const session = await f.sessions.completeLogin(nonce, 'code', verifier);
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.grant.sessionBinding).toBe(f.bindingFor(session.id));
    await expect(f.sessions.completeLogin(nonce, 'code', verifier)).rejects.toThrow();
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.exchange).toHaveBeenCalledWith('code', verifier);
  });
  it('claims before awaiting exchange and does not retry an ambiguous result', async () => {
    const f = meetingAuthority(), nonce = f.sessions.beginLogin();
    let reject!: (error: Error) => void;
    f.exchange.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = f.sessions.completeLogin(nonce, 'code', verifier);
    await expect(f.sessions.completeLogin(nonce, 'code', verifier)).rejects.toThrow();
    reject(new Error('outcome unknown'));
    await expect(first).rejects.toThrow('unknown');
    await expect(f.sessions.completeLogin(nonce, 'code', verifier)).rejects.toThrow();
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it('does not publish a bind after parallel logout, even when bind has already succeeded', async () => {
    const f = meetingAuthority(), nonce = f.sessions.beginLogin();
    const session = await f.sessions.completeLogin(nonce, 'code', verifier);
    await f.sessions.logout(undefined, nonce); // Logout has the old cookie, before Set-Cookie arrives.
    expect(f.sessions.current(session.id)).toBeUndefined();
    await expect(f.sessions.check(session.id)).rejects.toThrow();
    await expect(f.sessions.completeLogin(nonce, 'code', verifier)).rejects.toThrow();
  });
  it('cancels exchange in flight and never attempts a bind afterwards', async () => {
    const f = meetingAuthority(), nonce = f.sessions.beginLogin();
    let resolve!: (result: { projectToken: string; user: typeof f.user }) => void;
    f.exchange.mockImplementation(() => new Promise(done => { resolve = done; }));
    const login = f.sessions.completeLogin(nonce, 'code', verifier);
    await f.sessions.logout(undefined, nonce);
    resolve({ projectToken: 'token', user: f.user });
    await expect(login).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
  });
  it('revokes a bind that returns after the login owner has been cancelled', async () => {
    const f = meetingAuthority(), nonce = f.sessions.beginLogin();
    let release!: (result: ReturnType<typeof f.metadata>) => void;
    f.call.mockImplementationOnce(() => new Promise(done => { release = done; }));
    const login = f.sessions.completeLogin(nonce, 'code', verifier);
    await Promise.resolve();
    await f.sessions.logout(undefined, nonce);
    release(f.metadata());
    await expect(login).rejects.toThrow();
    expect(f.call.mock.calls.map(([action]) => action)).toEqual(['bind', 'revoke']);
  });
  it('rejects malformed verifier, expired nonce, wrong-project bind and excessive grant lifetime', async () => {
    const f = meetingAuthority();
    await expect(f.sessions.completeLogin(f.sessions.beginLogin(), 'code', 'short')).rejects.toThrow();
    expect(f.exchange).not.toHaveBeenCalled();
    f.call.mockResolvedValueOnce({ ...f.metadata(), projectKey: 'other' });
    await expect(f.login()).rejects.toThrow();
    const g = meetingAuthority();
    g.call.mockResolvedValueOnce({ ...g.metadata(), expiresAt: new Date(Date.now() + 901_000).toISOString() });
    await expect(g.login()).rejects.toThrow();
    vi.useFakeTimers();
    const h = meetingAuthority(), nonce = h.sessions.beginLogin();
    vi.advanceTimersByTime(300_001);
    await expect(h.sessions.completeLogin(nonce, 'code', verifier)).rejects.toThrow();
    expect(h.exchange).not.toHaveBeenCalled();
  });
  it('fails closed on live-check outage and cannot revive from a competing successful check', async () => {
    const f = meetingAuthority(), session = await f.login();
    let resolve!: (result: ReturnType<typeof f.metadata>) => void;
    f.call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = f.sessions.check(session.id);
    f.call.mockRejectedValueOnce(new Error('unavailable'));
    await expect(f.sessions.check(session.id)).rejects.toThrow('unavailable');
    resolve(f.metadata());
    await expect(first).rejects.toThrow();
    expect(f.sessions.current(session.id)).toBeUndefined();
  });
});

describe('one-operation online authority and local resource ACL', () => {
  it('binds exact action/resource/body/request ID, then checks ACL after consume and executes once', async () => {
    const f = meetingAuthority(), session = await f.login(), order: string[] = [];
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (action, body) => { order.push(action); return original(action, body); });
    const result = await f.sessions.run(session.id, { action: 'meetings.update', resource: '/api/meetings/one', body: '{"revision":1}', requestId: 'request-one' }, 'important',
      async () => { order.push('acl'); return true; }, async () => { order.push('execute'); return 7; });
    expect(result).toBe(7); expect(order).toEqual(['authorize', 'consume', 'acl', 'execute']);
    expect(f.call).toHaveBeenCalledWith('consume', expect.objectContaining({ action: 'meetings.update', resource: '/api/meetings/one',
      sessionBinding: f.bindingFor(session.id), requestId: 'request-one', contentDigest: createHash('sha256').update('{"revision":1}').digest('base64url') }));
  });
  it('rejects changed ACL, authority risk drift and missing action without executing', async () => {
    const f = meetingAuthority(), session = await f.login(), execute = vi.fn(async () => 1);
    await expect(f.sessions.run(session.id, { action: 'meetings.read', resource: '/one', body: '' }, 'sensitive_read', async () => false, execute)).rejects.toThrow();
    f.call.mockResolvedValueOnce({ permit: 'p'.repeat(43), expiresIn: 30, risk: 'read' });
    await expect(f.sessions.run(session.id, { action: 'meetings.read', resource: '/one', body: '' }, 'sensitive_read', async () => true, execute)).rejects.toThrow('risk');
    await expect(f.sessions.run(session.id, { action: '', resource: '/one', body: '' }, 'important', async () => true, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(() => meetingOperation('POST', '/unknown/new-action')).toThrow();
  });
  it('denies logout during permit consumption and never retries unknown execution', async () => {
    const f = meetingAuthority(), session = await f.login(), execute = vi.fn(async () => { throw new Error('DB outcome unknown'); });
    await expect(f.sessions.run(session.id, { action: 'meetings.update', resource: '/one', body: '{}' }, 'important', async () => true, execute)).rejects.toThrow('unknown');
    expect(execute).toHaveBeenCalledTimes(1);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (action, body) => { if (action === 'consume') await f.sessions.logout(session.id); return original(action, body); });
    await expect(f.sessions.run(session.id, { action: 'meetings.update', resource: '/one', body: '{}' }, 'important', async () => true, execute)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

it.each([401, 403, 409, 410, 503])('uses only the project credential/code+verifier exchange and never retries denial %s', async status => {
  const calls: Array<{ path: string; input: Record<string, unknown>; authorization: string | null }> = [];
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const input = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path: url.pathname, input, authorization: new Headers(init.headers).get('authorization') });
    if (url.pathname === '/api/auth/login') return Response.json({ tokenType: 'project', accessToken: 'credential', expiresIn: 300, project: { key: 'aedilis' } });
    return Response.json({ error: 'wrong project/verifier/purpose/expired/replay' }, { status });
  });
  const sdk = new CernereComposite({ cernereUrl: 'https://cr.example', projectKey: 'aedilis', clientId: 'ae-client', clientSecret: 'fixture-secret' });
  try {
    await expect(sdk.exchange('code', verifier)).rejects.toThrow();
    expect(calls.map(c => c.path)).toEqual(['/api/auth/login', '/api/auth/exchange']);
    expect(calls[1]).toMatchObject({ input: { code: 'code', code_verifier: verifier }, authorization: 'Bearer credential' });
  } finally { sdk.dispose(); }
});
