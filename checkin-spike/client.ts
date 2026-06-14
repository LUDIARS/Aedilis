// Aedilis check-in spike — client (PWA 役).
// @simplewebauthn/browser で navigator.credentials の base64url 直列化を任せる。

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

// クラウド (Aedilis stub) は別環境 = 別 origin。 PWA がここへ attestation をリレーする。
const CLOUD_URL = 'http://localhost:17591';

const logEl = document.getElementById('log') as HTMLPreElement;
function log(...args: unknown[]): void {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2)))
    .join(' ');
  logEl.textContent += line + '\n';
  // eslint-disable-next-line no-console
  console.log(...args);
}

async function postJson(url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// 初回登録 (本番では Cernere passkey 登録)
async function register(): Promise<void> {
  log('— 登録開始 (initial registration) —');
  const options = await postJson('/reg/begin');
  const attResp = await startRegistration({ optionsJSON: options });
  const result = await postJson('/reg/finish', { response: attResp });
  log('登録完了:', result);
}

// 到着時チェックイン (毎日の唯一の操作 = 1タップ + 生体)
async function checkin(): Promise<void> {
  log('— チェックイン開始 (1) LANが nonce 発行 —');
  const options = await postJson('/checkin/begin');
  log('   nonce:', options.challenge);
  log('— (2) passkey で nonce 署名 (生体ゲート) —');
  const asseResp = await startAuthentication({ optionsJSON: options });
  log('— (3) LANがオフライン検証 → (4) attestation 署名 —');
  const { attestation } = await postJson('/checkin/finish', { response: asseResp });
  log('   attestation:', attestation);
  log(`— (5) PWA が別環境のクラウド(${CLOUD_URL})へリレー → 検証 → 出席記録 —`);
  const recorded = await postJson(`${CLOUD_URL}/attestation/verify`, { attestation });
  log('✅ 出席確定:', recorded);
}

document.getElementById('btn-register')!.addEventListener('click', () => {
  register().catch((e) => log('❌ 登録エラー:', String(e)));
});
document.getElementById('btn-checkin')!.addEventListener('click', () => {
  checkin().catch((e) => log('❌ チェックインエラー:', String(e)));
});
