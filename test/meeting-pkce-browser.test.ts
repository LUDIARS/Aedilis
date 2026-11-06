/// <reference lib="dom" />
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkce, matchesAuthMessage, receiveAuth } from '../public/src/meetings/pkce-login.ts';
import { setupAccount } from '../public/src/meetings/account.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('creates independent random S256 verifier/state and accepts only exact origin/source/state messages', async () => {
  const first = await createPkce(), second = await createPkce();
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.challenge).toBe(createHash('sha256').update(first.verifier).digest('base64url'));
  expect(first.verifier).not.toBe(second.verifier); expect(first.state).not.toBe(second.state);
  const popup = {} as Window;
  const event = { origin: 'https://cr.example', source: popup, data: { type: 'cernere:auth', authCode: 'code', state: first.state } } as unknown as MessageEvent;
  expect(matchesAuthMessage(event, popup, event.origin, first.state)).toBe(true);
  for (const changed of [{ origin: 'https://evil.example' }, { source: {} }, { data: { ...event.data, state: second.state } }, { data: { ...event.data, authCode: '' } }]) {
    expect(matchesAuthMessage({ ...event, ...changed } as MessageEvent, popup, event.origin, first.state)).toBe(false);
  }
});
it('releases listener/timer on abort and popup close without accepting a later message', async () => {
  vi.useFakeTimers();
  const window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', window);
  const popup = { closed: false } as Window, controller = new AbortController();
  const auth = receiveAuth(popup, 'https://cr.example', 'state', controller.signal);
  const rejection = expect(auth).rejects.toThrow('中断');
  controller.abort(); await rejection;
  expect(window.removeEventListener).toHaveBeenCalledWith('message', window.addEventListener.mock.calls[0]?.[1]);
  expect(vi.getTimerCount()).toBe(0);
  const closed = receiveAuth({ closed: true } as Window, 'https://cr.example', 'state', new AbortController().signal);
  const closedRejection = expect(closed).rejects.toThrow('中断');
  await vi.advanceTimersByTimeAsync(1100); await closedRejection;
  expect(vi.getTimerCount()).toBe(0);
});
it('reports an owned login timeout instead of silently completing', async () => {
  vi.useFakeTimers();
  const nodes = new Map<string, { onclick?: (() => void) | null; textContent?: string; disabled?: boolean; classList: { toggle: ReturnType<typeof vi.fn> } }>();
  vi.stubGlobal('document', { getElementById: (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { classList: { toggle: vi.fn() } });
    return nodes.get(id);
  } });
  vi.stubGlobal('crypto', { randomUUID: () => 'popup-id', getRandomValues: (bytes: Uint8Array) => bytes.fill(1),
    subtle: { digest: async () => new ArrayBuffer(32) } });
  const popup = { closed: false, close: vi.fn() };
  vi.stubGlobal('window', { open: () => popup, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  })));
  const dispose = setupAccount({ cernereUrl: 'https://cr.example', cernereClientId: 'ae', googleClientId: '', discordEnabled: false }, async () => {});
  nodes.get('login')!.onclick!();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(nodes.get('status')?.textContent).toBe('ログインがタイムアウトしました');
  expect(nodes.get('status')?.classList.toggle).toHaveBeenCalledWith('error', true);
  dispose();
});
it('ignores repeated login clicks and releases all owned handlers on disposal before network setup', async () => {
  const nodes = new Map<string, { onclick?: (() => void) | null; onchange?: (() => void) | null; disabled?: boolean; textContent?: string; classList: { toggle: () => void } }>();
  vi.stubGlobal('document', { getElementById: (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { classList: { toggle: () => {} } });
    return nodes.get(id);
  } });
  let finishDigest!: (buffer: ArrayBuffer) => void;
  const crypto = { randomUUID: () => 'popup-id', getRandomValues: (bytes: Uint8Array) => bytes.fill(1),
    subtle: { digest: () => new Promise<ArrayBuffer>(done => { finishDigest = done; }) } };
  vi.stubGlobal('crypto', crypto);
  const popup = { closed: false, close: vi.fn() };
  const window = { open: vi.fn(() => popup), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', window);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const dispose = setupAccount({ cernereUrl: 'https://cr.example', cernereClientId: 'ae', googleClientId: '', discordEnabled: false }, async () => {});
  const click = nodes.get('login')!.onclick!;
  click(); click(); expect(window.open).toHaveBeenCalledTimes(1);
  dispose(); finishDigest(new ArrayBuffer(32));
  await vi.waitFor(() => expect(popup.close).toHaveBeenCalledTimes(2));
  expect(popup.close).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  for (const id of ['login', 'link', 'logout', 'delivery-refresh', 'delivery-retry']) expect(nodes.get(id)?.onclick).toBeNull();
  expect(nodes.get('notifications')?.onchange).toBeNull();
});
