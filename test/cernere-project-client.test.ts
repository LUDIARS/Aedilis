// CernereProjectClient のユニットテスト。
//
// 実 WS / 実 Cernere には繋がず、 WsLike を満たすフェイクソケット + fetch モックを
// 注入して module_request/module_response のやり取りと snake_case→camelCase 変換、
// エラー/未接続/再接続の各パスを検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CernereProjectClient,
  translateVantanProfile,
  type WsLike,
} from '../server/lib/cernere-project-client.ts';

/** WsLike を満たす手動制御可能なフェイクソケット。 */
class FakeWebSocket implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];

  constructor(public readonly url: string, public readonly protocols: string[]) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  /** テストからサーバの open 応答を模擬する。 */
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  /** テストからサーバ発のメッセージを模擬する。 */
  simulateMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  /** テストからサーバ都合の切断 (client 側 close() を経由しない) を模擬する。 */
  simulateServerClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: 'server closed' });
  }
}

function makeFetchOk(accessToken = 'proj-token-abc'): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tokenType: 'project', accessToken, expiresIn: 3600 }),
  })) as unknown as typeof fetch;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('translateVantanProfile', () => {
  it('translates a full snake_case row to camelCase', () => {
    const result = translateVantanProfile({
      department_name: 'ゲーム学部',
      grade: 2,
      name: '山田太郎',
      desired_job: 'ゲームプログラマー',
    });
    expect(result).toEqual({
      departmentName: 'ゲーム学部',
      grade: 2,
      name: '山田太郎',
      desiredJob: 'ゲームプログラマー',
    });
  });

  it('returns null when every requested column is null', () => {
    const result = translateVantanProfile({
      department_name: null,
      grade: null,
      name: null,
      desired_job: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when every requested column is missing entirely', () => {
    expect(translateVantanProfile({})).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(translateVantanProfile(null)).toBeNull();
    expect(translateVantanProfile('nope')).toBeNull();
    expect(translateVantanProfile(undefined)).toBeNull();
  });

  it('coerces a numeric-string grade and defaults desiredJob to null when absent', () => {
    const result = translateVantanProfile({
      department_name: 'CG学部',
      grade: '3',
      name: '鈴木花子',
    });
    expect(result).toEqual({
      departmentName: 'CG学部',
      grade: 3,
      name: '鈴木花子',
      desiredJob: null,
    });
  });
});

describe('CernereProjectClient — construction', () => {
  it('throws fail-fast when cernereBaseUrl is missing', () => {
    expect(() => new CernereProjectClient({ cernereBaseUrl: '', clientId: 'a', clientSecret: 'b' }))
      .toThrow(/cernereBaseUrl/);
  });

  it('throws fail-fast when clientId is missing', () => {
    expect(() => new CernereProjectClient({ cernereBaseUrl: 'https://x', clientId: '', clientSecret: 'b' }))
      .toThrow(/clientId/);
  });

  it('throws fail-fast when clientSecret is missing', () => {
    expect(() => new CernereProjectClient({ cernereBaseUrl: 'https://x', clientId: 'a', clientSecret: '' }))
      .toThrow(/clientSecret/);
  });
});

describe('CernereProjectClient — connect()', () => {
  let sockets: FakeWebSocket[];
  let createWebSocket: (url: string, protocols: string[]) => WsLike;

  beforeEach(() => {
    sockets = [];
    createWebSocket = (url, protocols) => {
      const ws = new FakeWebSocket(url, protocols);
      sockets.push(ws);
      return ws;
    };
  });

  it('exchanges client credentials for a project token via POST /api/auth/login', async () => {
    const fetchImpl = makeFetchOk('tok-xyz');
    const client = new CernereProjectClient({
      cernereBaseUrl: 'https://cernere.example.com/',
      clientId: 'aedilis',
      clientSecret: 's3cret',
      fetchImpl,
      createWebSocket,
    });

    const connectPromise = client.connect();
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0]!.simulateOpen();
    await connectPromise;

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cernere.example.com/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'project_credentials',
          client_id: 'aedilis',
          client_secret: 's3cret',
        }),
      }),
    );
    // WS URL は http(s) → ws(s) 変換 + /ws/project、 認証は Sec-WebSocket-Protocol の
    // bearer スキーム (query の ?token= は使わない)。
    expect(sockets[0]!.url).toBe('wss://cernere.example.com/ws/project');
    expect(sockets[0]!.protocols).toEqual(['bearer', 'tok-xyz']);
  });

  it('rejects when the login HTTP call fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const client = new CernereProjectClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'aedilis',
      clientSecret: 'bad',
      fetchImpl,
      createWebSocket,
    });
    await expect(client.connect()).rejects.toThrow(/HTTP 401/);
    expect(sockets).toHaveLength(0);
  });

  it('rejects when the WS closes before opening', async () => {
    const fetchImpl = makeFetchOk();
    const client = new CernereProjectClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'aedilis',
      clientSecret: 's3cret',
      fetchImpl,
      createWebSocket,
    });
    const connectPromise = client.connect();
    await flush();
    sockets[0]!.simulateServerClose(401);
    await expect(connectPromise).rejects.toThrow(/closed before open/);
  });
});

describe('CernereProjectClient — getVantanUserProfile()', () => {
  let sockets: FakeWebSocket[];
  let client: CernereProjectClient;
  let ws: FakeWebSocket;

  async function buildConnectedClient(): Promise<void> {
    sockets = [];
    const createWebSocket = (url: string, protocols: string[]) => {
      const s = new FakeWebSocket(url, protocols);
      sockets.push(s);
      return s;
    };
    client = new CernereProjectClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'aedilis',
      clientSecret: 's3cret',
      fetchImpl: makeFetchOk(),
      createWebSocket,
      requestTimeoutMs: 200,
    });
    const connectPromise = client.connect();
    await flush();
    ws = sockets[0]!;
    ws.simulateOpen();
    await connectPromise;
  }

  beforeEach(async () => {
    await buildConnectedClient();
  });

  afterEach(() => {
    client.close();
  });

  it('sends userId + targetProjectKey + requested columns, and translates the response', async () => {
    const promise = client.getVantanUserProfile('user-42');
    await flush();
    expect(ws.sent).toHaveLength(1);
    const sentMsg = JSON.parse(ws.sent[0]!);
    expect(sentMsg).toMatchObject({
      type: 'module_request',
      module: 'managed_project',
      action: 'get_user_data',
      payload: {
        userId: 'user-42',
        targetProjectKey: 'vantan_user',
        columns: ['department_name', 'grade', 'name', 'desired_job'],
      },
    });
    expect(typeof sentMsg.request_id).toBe('string');

    ws.simulateMessage({
      type: 'module_response',
      request_id: sentMsg.request_id,
      module: 'managed_project',
      action: 'get_user_data',
      payload: {
        department_name: 'ゲーム学部',
        grade: 3,
        name: '山田太郎',
        desired_job: 'ゲームプランナー',
      },
    });

    await expect(promise).resolves.toEqual({
      departmentName: 'ゲーム学部',
      grade: 3,
      name: '山田太郎',
      desiredJob: 'ゲームプランナー',
    });
  });

  it('resolves null (does not throw) when the user has no row / all columns are null', async () => {
    const promise = client.getVantanUserProfile('user-no-data');
    await flush();
    const sentMsg = JSON.parse(ws.sent[0]!);
    ws.simulateMessage({
      type: 'module_response',
      request_id: sentMsg.request_id,
      payload: { department_name: null, grade: null, name: null, desired_job: null },
    });
    await expect(promise).resolves.toBeNull();
  });

  it('throws when Cernere returns a module error', async () => {
    const promise = client.getVantanUserProfile('user-42');
    await flush();
    const sentMsg = JSON.parse(ws.sent[0]!);
    ws.simulateMessage({
      type: 'error',
      request_id: sentMsg.request_id,
      code: 'command_error',
      message: 'project not authorized for cross-project read',
    });
    await expect(promise).rejects.toThrow(/not authorized/);
  });

  it('throws on request timeout when no response ever arrives', async () => {
    const promise = client.getVantanUserProfile('user-slow');
    await expect(promise).rejects.toThrow(/timed out/);
  }, 2000);

  it('throws immediately when userId is blank', async () => {
    await expect(client.getVantanUserProfile('')).rejects.toThrow(/userId is required/);
  });

  it('replies to server pings with pong (keeps the always-connected session alive)', async () => {
    ws.simulateMessage({ type: 'ping', ts: 123456 });
    await flush();
    const pong = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'pong');
    expect(pong).toEqual({ type: 'pong', ts: 123456 });
  });
});

describe('CernereProjectClient — not connected', () => {
  it('throws (does not hang) when getVantanUserProfile is called before any connection', async () => {
    const client = new CernereProjectClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'aedilis',
      clientSecret: 's3cret',
      fetchImpl: makeFetchOk(),
      createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols),
    });
    await expect(client.getVantanUserProfile('user-1')).rejects.toThrow(/not connected/);
  });
});

describe('CernereProjectClient — reconnect', () => {
  it('automatically reconnects after an unexpected disconnect', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const createWebSocket = (url: string, protocols: string[]) => {
        const s = new FakeWebSocket(url, protocols);
        sockets.push(s);
        return s;
      };
      const client = new CernereProjectClient({
        cernereBaseUrl: 'https://cernere.example.com',
        clientId: 'aedilis',
        clientSecret: 's3cret',
        fetchImpl: makeFetchOk(),
        createWebSocket,
        reconnectDelayMs: 1000,
      });

      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      sockets[0]!.simulateOpen();
      await vi.advanceTimersByTimeAsync(0);

      // サーバ都合で切断 → 固定 interval 後に自動で繋ぎ直す。
      sockets[0]!.simulateServerClose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
