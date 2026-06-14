// Aedilis 出席チェックイン PWA (CONTRACTS §4 PWA 節)。
//
// フロー:
//   1. POST {gateway}/checkin/begin          → WebAuthn options (challenge=nonce)
//   2. startAuthentication(options)           → passkey で署名 (生体ゲート)
//   3. POST {gateway}/checkin/finish {response} → ゲートウェイが attestation 署名
//   4. POST /api/checkin/verify {attestation} → Aedilis (Cernere cookie/Bearer)
//   5. 結果表示 + 自分の出席履歴を更新
//
// ゲートウェイ URL は会場 LAN アドレス。 /api/health の defaultGatewayUrl を
// pre-fill し、 localStorage に上書き保存できる (画面入力)。 vanilla TS + esbuild。

import { startAuthentication } from '@simplewebauthn/browser';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

const GATEWAY_KEY = 'aedilis.gatewayUrl';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    const m: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return m[ch] ?? ch;
  });
}

function setStatus(msg: string, kind: 'ok' | 'err' | ''): void {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

function fmt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── API helpers ──────────────────────────────────────────────────────────────

interface Me {
  userId: string;
  displayName: string | null;
  isAdmin: boolean;
}
interface Attendance {
  id: string;
  facility_id: string;
  lan_id: string;
  checked_in_at: number;
  reservation_id: string | null;
}

/** Aedilis 自身への呼び出し (Cernere cookie 同送)。 */
async function aedilis<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new Error(body.code ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** 会場ゲートウェイ (別 origin、 LAN) への呼び出し。 */
async function gatewayPost<T>(gatewayUrl: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${gatewayUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gateway ${path} -> ${res.status}`);
  return data as T;
}

// ── ゲートウェイ URL 設定 ─────────────────────────────────────────────────────

function gatewayUrl(): string {
  return ($('gateway-url') as HTMLInputElement).value.trim();
}

function saveGateway(): void {
  const url = gatewayUrl();
  if (url) localStorage.setItem(GATEWAY_KEY, url);
  setStatus(url ? 'ゲートウェイ URL を保存しました' : 'URL を入力してください', url ? 'ok' : 'err');
}

// ── チェックイン ──────────────────────────────────────────────────────────────

async function doCheckin(): Promise<void> {
  const gw = gatewayUrl();
  if (!gw) {
    setStatus('ゲートウェイ URL を入力してください', 'err');
    return;
  }
  const btn = $('checkin-btn') as HTMLButtonElement;
  btn.disabled = true;
  try {
    setStatus('(1) ゲートウェイが nonce を発行中…', '');
    const options = await gatewayPost<Record<string, unknown>>(gw, '/checkin/begin');

    setStatus('(2) passkey で署名中 (生体認証)…', '');
    const assertion = await startAuthentication({ optionsJSON: options as never });

    setStatus('(3) ゲートウェイがオフライン検証 → attestation 署名中…', '');
    const finish = await gatewayPost<{ ok?: boolean; attestation?: string }>(
      gw,
      '/checkin/finish',
      { response: assertion },
    );
    if (!finish.attestation) throw new Error('ゲートウェイが attestation を返しませんでした');

    setStatus('(4) Aedilis へリレー → 検証 → 出席記録中…', '');
    const result = await aedilis<{ ok: boolean; attendanceId: string; matchedReservation: string | null }>(
      '/api/checkin/verify',
      { method: 'POST', body: JSON.stringify({ attestation: finish.attestation }) },
    );
    setStatus(
      result.matchedReservation
        ? '✅ 出席を記録しました (予約と照合)'
        : '✅ 出席を記録しました (予約なし / walk-in)',
      'ok',
    );
    await refreshHistory();
  } catch (e) {
    setStatus(`❌ ${e instanceof Error ? e.message : String(e)}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 履歴 ─────────────────────────────────────────────────────────────────────

async function refreshHistory(): Promise<void> {
  try {
    const { items } = await aedilis<{ items: Attendance[] }>('/api/checkin/mine');
    const root = $('history');
    if (items.length === 0) {
      root.innerHTML = '<p class="empty">まだ出席記録はありません</p>';
      return;
    }
    root.innerHTML = items
      .map(
        (a) => `
        <div class="card">
          <div class="card-title">${escapeHtml(a.facility_id)}</div>
          <div class="card-time">${fmt(a.checked_in_at)}</div>
          <div class="card-owner">${a.reservation_id ? '予約照合あり' : 'walk-in'}</div>
        </div>`,
      )
      .join('');
  } catch (e) {
    setStatus(`履歴取得失敗: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
}

// ── 起動 ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let me: Me;
  try {
    me = await aedilis<Me>('/api/me');
  } catch {
    $('app').innerHTML =
      '<p class="empty">ログインが必要です。 Cernere でログインしてからアクセスしてください。</p>';
    return;
  }
  $('user').textContent = me.displayName ?? me.userId;

  // ゲートウェイ URL: localStorage > /api/health の既定値
  const input = $('gateway-url') as HTMLInputElement;
  const saved = localStorage.getItem(GATEWAY_KEY);
  if (saved) {
    input.value = saved;
  } else {
    try {
      const health = await aedilis<{ defaultGatewayUrl: string | null }>('/api/health');
      if (health.defaultGatewayUrl) input.value = health.defaultGatewayUrl;
    } catch {
      /* health は任意 */
    }
  }

  $('save-gateway').addEventListener('click', saveGateway);
  $('checkin-btn').addEventListener('click', () => void doCheckin());
  await refreshHistory();
}

void main();
