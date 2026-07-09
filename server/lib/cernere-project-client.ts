// Cernere プロジェクト WS クライアント — 接続ライフサイクルのみ (SRP)。
//
// Aedilis は Cernere 上に自分専用の最小プロジェクト ("aedilis") として登録され、
// `user_data.columns` を自前で持たない (= 何も書き込まない)。 唯一の用途は
// vantan_user プロジェクトが持つ学生プロフィール (department_name / grade / name /
// desired_job) を `managed_project.get_user_data` の `targetProjectKey` 経由で
// 読み取ること。
//
// 接続手順 (Cernere/server/src/http/auth-handler.ts 実装を突き合わせ済み):
//   1. POST {CERNERE_BASE_URL}/api/auth/login
//        body: { grant_type: "project_credentials", client_id, client_secret }
//        → 200 { tokenType: "project", accessToken, expiresIn, project: {...} }
//      (`/api/auth?action=project-token` ではない — その action はログイン中ユーザーの
//       accessToken を hub_url 宛の PASETO に交換する別機構 (`projectUserToken`)。
//       Aedilis はユーザーではなく project 本人として繋ぐので `login` +
//       `grant_type: "project_credentials"` → `projectLogin` → HS256 project JWT
//       (`generateProjectToken`) が正しい経路。 Aedilis 自身の `server/auth.ts` が
//       検証している "user_for_project" PASETO token とは別物なので混同しないこと)。
//   2. wss://{host}/ws/project へ接続。 認証は Sec-WebSocket-Protocol ヘッダ
//        `bearer, <project JWT>` (Cernere/server/src/app.ts の parseWsAuthProtocol
//        が `bearer` スキームを認識する。 ?token= query は deprecated 扱いなので使わない)。
//   3. プロトコルは module_request/module_response
//        (Cernere/server/src/ws/project-handler.ts, project-dispatch.ts):
//        送信: { type: "module_request", request_id, module, action, payload }
//        成功: { type: "module_response", request_id, module, action, payload }
//        失敗: { type: "error", request_id, code, message }
//
// NOTE (要人間確認): targetProjectKey を managed_project.get_user_data の
//   payload に含めるクロスプロジェクト読み取りは、 本タスクと並行して Cernere 側に
//   実装される予定の新機能で、 マージ済みの実コードをこちらから確認できていない。
//   本ファイルは指示された契約 —
//     payload: { userId, targetProjectKey: "vantan_user", columns: [...] }
//     response payload: { [column]: value or null, ... } (対象行が無い/権限が無い場合は
//       全カラム null — 既存の同一プロジェクト向け getUserColumns の "no row" 挙動を
//       踏襲する前提)
//   を仮定して実装した。 Cernere 側 PR がマージされたら実際のレスポンス形状
//   (特に: 権限不足時に null 埋めで返すのかエラーを投げるのか) を突き合わせて
//   本ファイルの translateVantanProfile / getVantanUserProfile を確認すること。
//
// 再接続: 固定 interval retry (exponential backoff は過剰と判断 — Ostiarius の
// cernere-sync.ts (interval 再試行 + warn ログのみで継続) に倣うシンプルな方式)。

const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface CernereProjectClientConfig {
  /** 末尾スラッシュ有無どちらでも可 (内部で正規化する)。 */
  cernereBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** テスト注入用。 未指定ならグローバル fetch を使う。 */
  fetchImpl?: typeof fetch;
  /** テスト注入用。 未指定ならグローバル WebSocket (Node 22+ undici 実装) を使う。 */
  createWebSocket?: (url: string, protocols: string[]) => WsLike;
  /** 切断時の固定再接続間隔 (ms)。 default 5000。 */
  reconnectDelayMs?: number;
  /** module_request 応答待ちタイムアウト (ms)。 default 10000。 */
  requestTimeoutMs?: number;
}

/**
 * ブラウザ/undici WebSocket の使用箇所のみを切り出した最小インターフェース。
 * 実体 (new WebSocket(url, protocols)) はこの形を満たすので追加アダプタ不要。
 * テストではこのインターフェースを満たすフェイクを注入する。
 */
export interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

interface ModuleRequestMessage {
  type: 'module_request';
  request_id: string;
  module: string;
  action: string;
  payload: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface VantanUserProfile {
  departmentName: string;
  grade: number;
  name: string;
  desiredJob: string | null;
}

const VANTAN_COLUMNS = ['department_name', 'grade', 'name', 'desired_job'] as const;

function defaultCreateWebSocket(url: string, protocols: string[]): WsLike {
  // Node 22+ はグローバル WebSocket (undici 実装) を持つ。 追加パッケージ不要。
  return new WebSocket(url, protocols) as unknown as WsLike;
}

/** cernereBaseUrl (http/https) を /ws/project の ws/wss URL に変換する。 */
function toProjectWsUrl(cernereBaseUrl: string): string {
  const base = cernereBaseUrl.replace(/\/+$/, '');
  return base.replace(/^http/i, 'ws') + '/ws/project';
}

/**
 * Cernere に project として常時接続し、 managed_project.get_user_data を叩くクライアント。
 *
 * ライフサイクル管理のみを扱う (呼び出し側の業務ロジックは持たない)。
 */
export class CernereProjectClient {
  private readonly cernereBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createWs: (url: string, protocols: string[]) => WsLike;
  private readonly reconnectDelayMs: number;
  private readonly requestTimeoutMs: number;

  private ws: WsLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;
  private reqSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(config: CernereProjectClientConfig) {
    if (!config.cernereBaseUrl || !config.cernereBaseUrl.trim()) throw new Error('CernereProjectClient: cernereBaseUrl is required');
    if (!config.clientId || !config.clientId.trim()) throw new Error('CernereProjectClient: clientId is required');
    if (!config.clientSecret || !config.clientSecret.trim()) throw new Error('CernereProjectClient: clientSecret is required');
    this.cernereBaseUrl = config.cernereBaseUrl.replace(/\/+$/, '');
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.createWs = config.createWebSocket ?? defaultCreateWebSocket;
    this.reconnectDelayMs = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * 起動時に 1 回呼ぶ。 初回接続を試み、 以後は切断のたびに固定間隔で自動再接続する。
   * 接続失敗は throw せず warn ログのみ (Cernere 側の Infisical 値がまだ未投入でも
   * Aedilis 自体の起動は止めない — Ostiarius の startCernereSync と同じ思想)。
   */
  start(): void {
    this.closedByCaller = false;
    this.connect().catch((err) => {
      const delay = this.reconnectDelayMs;
      console.warn(`[aedilis] cernere project connect 失敗 (起動時): ${(err as Error).message} — ${delay}ms 後に再試行`);
      this.scheduleReconnect();
    });
  }

  /** 明示的に閉じる (再接続ループも止める)。 テスト/シャットダウン用。 */
  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CernereProjectClient closed'));
    }
    this.pending.clear();
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  /** 単発の接続試行。 失敗時は throw する (呼び出し側が retry を仕切る)。 */
  async connect(): Promise<void> {
    const token = await this.fetchProjectToken();
    const url = toProjectWsUrl(this.cernereBaseUrl);
    await new Promise<void>((resolve, reject) => {
      const ws = this.createWs(url, ['bearer', token]);
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        console.log('[aedilis] cernere project WS connected');
        resolve();
      };
      ws.onerror = (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error('cernere project WS error: ' + describeWsError(ev)));
        }
      };
      ws.onclose = (ev) => {
        this.ws = null;
        const code = ev && typeof ev.code === 'number' ? ev.code : 0;
        if (!settled) {
          settled = true;
          reject(new Error('cernere project WS closed before open (code=' + code + ')'));
          return;
        }
        // 開通後の切断 — 保留中リクエストは全て失敗させ、 再接続をスケジュールする。
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('cernere project WS disconnected'));
        }
        this.pending.clear();
        console.warn(`[aedilis] cernere project WS 切断 (code=${code}) — ${this.reconnectDelayMs}ms 後に再接続`);
        this.scheduleReconnect();
      };
      ws.onmessage = (ev) => this.handleMessage(ev.data);
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        console.warn(`[aedilis] cernere project 再接続失敗: ${(err as Error).message} — ${this.reconnectDelayMs}ms 後に再試行`);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  private async fetchProjectToken(): Promise<string> {
    const res = await this.fetchImpl(`${this.cernereBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'project_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`cernere project login failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { accessToken?: unknown };
    if (typeof body.accessToken !== 'string' || !body.accessToken) {
      throw new Error('cernere project login response missing accessToken');
    }
    return body.accessToken;
  }

  private handleMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      if (this.ws) this.ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      return;
    }
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : undefined;
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (msg.type === 'module_response') {
      pending.resolve(msg.payload ?? {});
    } else if (msg.type === 'error') {
      pending.reject(new Error(typeof msg.message === 'string' ? msg.message : 'cernere module_request failed'));
    } else {
      pending.reject(new Error('unexpected cernere WS response type: ' + String(msg.type)));
    }
  }

  /** module_request を送って module_response.payload を待つ。 未接続なら即 throw。 */
  private request(moduleName: string, action: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error('cernere project WS is not connected'));
    }
    const requestId = `aedilis-${Date.now()}-${this.reqSeq++}`;
    const msg: ModuleRequestMessage = { type: 'module_request', request_id: requestId, module: moduleName, action, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`cernere module_request timed out: ${moduleName}.${action}`));
      }, this.requestTimeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        if (this.ws) this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * vantan_user プロジェクトが持つ学生プロフィールを読む。
   *
   * - 接続断/認証失敗/タイムアウトなど「本当に失敗」した場合は throw する。
   * - 対象ユーザーの行が無い、 または全カラムが null (データ未入力) の場合は
   *   throw せず null を返す (呼び出し側は「まだプロフィール未登録」として扱える)。
   */
  async getVantanUserProfile(userId: string): Promise<VantanUserProfile | null> {
    if (!userId || !userId.trim()) throw new Error('getVantanUserProfile: userId is required');
    const raw = await this.request('managed_project', 'get_user_data', {
      userId,
      targetProjectKey: 'vantan_user',
      columns: [...VANTAN_COLUMNS],
    });
    return translateVantanProfile(raw);
  }
}

function describeWsError(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev && typeof (ev as { message: unknown }).message === 'string') {
    return (ev as { message: string }).message;
  }
  return 'unknown error';
}

/**
 * snake_case の Cernere カラム名を camelCase の VantanUserProfile へ変換する。
 * 全カラムが null/undefined (行が無い、 または未入力) なら null。
 */
export function translateVantanProfile(raw: unknown): VantanUserProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const allEmpty = VANTAN_COLUMNS.every((c) => r[c] === null || r[c] === undefined);
  if (allEmpty) return null;

  const departmentName = typeof r.department_name === 'string' ? r.department_name : '';
  const name = typeof r.name === 'string' ? r.name : '';
  const desiredJob = typeof r.desired_job === 'string' ? r.desired_job : null;
  const gradeRaw = r.grade;
  let grade = 0;
  if (typeof gradeRaw === 'number') {
    grade = gradeRaw;
  } else if (typeof gradeRaw === 'string' && gradeRaw.trim() !== '' && Number.isFinite(Number(gradeRaw))) {
    grade = Number(gradeRaw);
  }

  return { departmentName, grade, name, desiredJob };
}

/** index.ts から呼ぶファクトリ。 env 解決済みの config を渡す (このファイルは env を知らない)。 */
export function createCernereProjectClient(config: CernereProjectClientConfig): CernereProjectClient {
  return new CernereProjectClient(config);
}
