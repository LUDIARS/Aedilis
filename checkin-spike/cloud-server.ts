// クラウド側 = Aedilis 本体の stub (別環境)。
//
// 役割:
//   - PWA がリレーしてきた attestation を「ゲートウェイ公開鍵」で検証する
//   - 検証OKなら出席記録 (本番では Placement に記録 + 予約照合)
//
// ゲートウェイ公開鍵は「初回セットアップで provision される」想定。 スパイクでは
// 初回 verify 時に GATEWAY_URL/gateway-public-key を一度だけ取得してキャッシュする
// (= ランタイムの常時結合ではなく、 一度きりの鍵交換のスタンドイン)。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { verifyAttestation, type AttestationPayload } from './shared.ts';

const PORT = Number(process.env.CLOUD_PORT ?? 17591);
const ORIGIN = `http://localhost:${PORT}`;
// PWA は gateway(17590) から配信されるので、 そこからの cross-origin を許可する。
const PWA_ORIGIN = process.env.PWA_ORIGIN ?? 'http://localhost:17590';
const GATEWAY_URL = (process.env.GATEWAY_URL ?? 'http://localhost:17590').replace(/\/+$/, '');

let gatewayPublicKey: KeyObject | null = null;
const attendance: AttestationPayload[] = [];

async function ensureGatewayKey(): Promise<KeyObject> {
  if (gatewayPublicKey) return gatewayPublicKey;
  const res = await fetch(`${GATEWAY_URL}/gateway-public-key`);
  if (!res.ok) throw new Error(`gateway-public-key fetch failed: ${res.status}`);
  const body = (await res.json()) as { publicKeyPem?: string };
  if (!body.publicKeyPem) throw new Error('gateway returned no publicKeyPem');
  gatewayPublicKey = createPublicKey({ key: body.publicKeyPem, format: 'pem' });
  console.log('[cloud] gateway public key provisioned');
  return gatewayPublicKey;
}

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
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': PWA_ORIGIN,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', ORIGIN).pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': PWA_ORIGIN,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }
  try {
    if (req.method === 'POST' && path === '/attestation/verify') {
      const body = (await readBody(req)) as { attestation?: string };
      if (!body.attestation) return sendJson(res, 400, { error: 'no_attestation' });
      const key = await ensureGatewayKey();
      const result = verifyAttestation(body.attestation, key);
      if (!result.ok || !result.payload) return sendJson(res, 401, { error: 'attestation_invalid' });
      attendance.push(result.payload);
      console.log('[cloud] attestation OK → 出席記録:', result.payload);
      return sendJson(res, 200, { ok: true, recorded: result.payload });
    }
    if (req.method === 'GET' && path === '/attendance') {
      return sendJson(res, 200, { count: attendance.length, records: attendance });
    }
    sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[cloud] error:', msg);
    sendJson(res, 500, { error: 'internal', message: msg });
  }
});

server.listen(PORT, () => {
  console.log(`[cloud] (Aedilis stub) listening on ${ORIGIN}`);
  console.log(`[cloud] gateway: ${GATEWAY_URL} / pwa origin: ${PWA_ORIGIN}`);
});
