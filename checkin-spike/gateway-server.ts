// 会場LANゲートウェイ (仮称 Ostiarius) — スパイク版。
//
// 役割 (会場のラズパイ/PC に置く、 別環境でも独立して動く):
//   - nonce (challenge) を発行する
//   - passkey assertion を「登録済み公開鍵」だけでオフライン検証する
//     (= Cernere に問い合わせない。 家からは LAN に到達できないので成立しない)
//   - 検証OKなら presence-attestation を自鍵 (Ed25519) で署名して返す
//   - PWA (静的ファイル) も配る
//
// このスパイクでは passkey 登録 (/reg/*) も同居させているが、 本番では
// 登録は Cernere (passkey レジストリ) が持ち、 ゲートウェイは公開鍵を
// 初回セットアップ時に provision されるだけ。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { signAttestation } from './shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.GATEWAY_PORT ?? 17590);
const ORIGIN = `http://localhost:${PORT}`;
const RP_ID = 'localhost'; // localhost は secure context 扱い → WebAuthn が動く
const RP_NAME = 'Aedilis Check-in (Ostiarius spike)';

const SPIKE_USER_ID = 'spike-user-001'; // 本番では Cernere sub
const SPIKE_PLACE_ID = 'room-101';
const LAN_ID = 'lan-gw-spike';

// ── 登録 credential (in-memory + ファイル write-through) ─────────────────
interface StoredCredential {
  id: string;
  publicKey: string; // base64 COSE
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}
const STATE_PATH = join(__dirname, '.spike-state.json');
let credential: StoredCredential | null = existsSync(STATE_PATH)
  ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as StoredCredential)
  : null;
function saveCredential(c: StoredCredential): void {
  credential = c;
  writeFileSync(STATE_PATH, JSON.stringify(c, null, 2));
}

let pendingRegChallenge: string | null = null;
let pendingAuthChallenge: string | null = null;

// ゲートウェイの attestation 署名鍵。 スパイクは起動毎生成 (= 揮発)。
// 本番は永続 + 公開鍵を Aedilis に初回 provision。
const gwKeyPair = generateKeyPairSync('ed25519');
const gwPrivateKey: KeyObject = gwKeyPair.privateKey;
const gwPublicKeyPem = gwKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// ── HTTP ヘルパ ─────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
function sendFile(res: ServerResponse, path: string, type: string): void {
  try {
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(join(__dirname, path)));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', ORIGIN).pathname;
  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return sendFile(res, 'index.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && path === '/client.js') {
      return sendFile(res, 'client.js', 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && path === '/client.js.map') {
      return sendFile(res, 'client.js.map', 'application/json');
    }

    // 初回登録 (本番では Cernere passkey 登録に置換)
    if (req.method === 'POST' && path === '/reg/begin') {
      const opts = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: SPIKE_USER_ID,
        userID: new TextEncoder().encode(SPIKE_USER_ID),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      pendingRegChallenge = opts.challenge;
      return sendJson(res, 200, opts);
    }
    if (req.method === 'POST' && path === '/reg/finish') {
      const body = (await readBody(req)) as { response?: unknown };
      if (!pendingRegChallenge) return sendJson(res, 400, { error: 'no_challenge' });
      const verification = await verifyRegistrationResponse({
        // @ts-expect-error RegistrationResponseJSON をそのまま渡す
        response: body.response,
        expectedChallenge: pendingRegChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
      pendingRegChallenge = null;
      if (!verification.verified || !verification.registrationInfo) {
        return sendJson(res, 400, { error: 'reg_verify_failed' });
      }
      const cred = verification.registrationInfo.credential;
      saveCredential({
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey).toString('base64'),
        counter: cred.counter,
        transports: (body.response as { response?: { transports?: AuthenticatorTransportFuture[] } })
          ?.response?.transports,
      });
      console.log(`[gateway] passkey registered: ${cred.id.slice(0, 16)}…`);
      return sendJson(res, 201, { ok: true, credentialId: cred.id });
    }

    // 会場ゲートウェイ本体: nonce 発行 → assertion オフライン検証 → attestation
    if (req.method === 'POST' && path === '/checkin/begin') {
      if (!credential) return sendJson(res, 409, { error: 'not_registered' });
      const opts = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: 'required',
        allowCredentials: [{ id: credential.id, transports: credential.transports }],
      });
      pendingAuthChallenge = opts.challenge;
      return sendJson(res, 200, opts);
    }
    if (req.method === 'POST' && path === '/checkin/finish') {
      const body = (await readBody(req)) as { response?: unknown };
      if (!credential) return sendJson(res, 409, { error: 'not_registered' });
      if (!pendingAuthChallenge) return sendJson(res, 400, { error: 'no_challenge' });
      const nonce = pendingAuthChallenge;
      const verification = await verifyAuthenticationResponse({
        // @ts-expect-error AuthenticationResponseJSON をそのまま渡す
        response: body.response,
        expectedChallenge: nonce,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')),
          counter: credential.counter,
          transports: credential.transports,
        },
      });
      pendingAuthChallenge = null;
      if (!verification.verified) return sendJson(res, 401, { error: 'assertion_failed' });
      saveCredential({ ...credential, counter: verification.authenticationInfo.newCounter });

      const attestation = signAttestation(
        { sub: SPIKE_USER_ID, placeId: SPIKE_PLACE_ID, lanId: LAN_ID, nonce, issuedAt: Date.now() },
        gwPrivateKey,
      );
      console.log(`[gateway] check-in verified → attestation issued`);
      return sendJson(res, 200, { ok: true, attestation });
    }

    // 初回セットアップ時にクラウド (Aedilis) が取りに来る公開鍵 (一度きりの provision)
    if (req.method === 'GET' && path === '/gateway-public-key') {
      return sendJson(res, 200, { lanId: LAN_ID, publicKeyPem: gwPublicKeyPem });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[gateway] error:', msg);
    sendJson(res, 500, { error: 'internal', message: msg });
  }
});

server.listen(PORT, () => {
  console.log(`[gateway] (Ostiarius spike) listening on ${ORIGIN}`);
  console.log(`[gateway] registered credential: ${credential ? 'yes' : 'no — まず登録してください'}`);
});
