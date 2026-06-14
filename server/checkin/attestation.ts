// Attestation 検証ヘルパ (CONTRACTS §1)。
//
// attestation = base64url(JSON payload) + "." + base64url(Ed25519 署名)。
// 会場ゲートウェイ (Ostiarius) の秘密鍵で署名され、 Aedilis は lan_id で引いた
// 公開鍵 (SPKI PEM) で検証する。 checkin-spike/shared.ts の検証側を移植したもの
// (Aedilis は cloud = 検証専用なので sign は持たない)。

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface AttestationPayload {
  /** Cernere user id (assertion で確定した本人)。 */
  sub: string;
  /** = facilityId。 出席対象の施設/部屋。 */
  placeId: string;
  /** 発行ゲートウェイ ID (gateway_registry を引くキー)。 */
  lanId: string;
  /** 検証に使った challenge (base64url)。 replay 検出用。 */
  nonce: string;
  /** epoch ms。 出席時刻の正本 (ゲートウェイ時計)。 */
  issuedAt: number;
}

export function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** payload の各フィールドが期待する型かを検査する (untrusted JSON ガード)。 */
function isPayload(o: unknown): o is AttestationPayload {
  if (!o || typeof o !== 'object') return false;
  const p = o as Record<string, unknown>;
  return (
    typeof p.sub === 'string' &&
    typeof p.placeId === 'string' &&
    typeof p.lanId === 'string' &&
    typeof p.nonce === 'string' &&
    typeof p.issuedAt === 'number'
  );
}

/**
 * 署名検証せず payload だけ取り出す。 検証前に lan_id で公開鍵を引くために使う。
 * 不正な形式 / 型なら null。
 */
export function decodeAttestationPayload(token: string): AttestationPayload | null {
  const body = token.split('.')[0];
  if (!body) return null;
  try {
    const obj = JSON.parse(b64urlDecode(body).toString('utf8'));
    return isPayload(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** KeyObject (Ed25519 公開鍵) で attestation を検証する。 */
export function verifyAttestation(
  token: string,
  publicKey: KeyObject,
): { ok: boolean; payload?: AttestationPayload } {
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false };
  try {
    const ok = cryptoVerify(null, Buffer.from(body), publicKey, b64urlDecode(sig));
    if (!ok) return { ok: false };
    const obj = JSON.parse(b64urlDecode(body).toString('utf8'));
    return isPayload(obj) ? { ok: true, payload: obj } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** SPKI PEM 文字列から KeyObject を作って検証する (gateway_registry の保存形式)。 */
export function verifyAttestationWithPem(
  token: string,
  publicKeyPem: string,
): { ok: boolean; payload?: AttestationPayload } {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: publicKeyPem, format: 'pem' });
  } catch {
    return { ok: false };
  }
  return verifyAttestation(token, key);
}

/** PEM が Ed25519 公開鍵として読めるか (gateway 登録時の検証用)。 */
export function isValidPublicKeyPem(pem: string): boolean {
  try {
    createPublicKey({ key: pem, format: 'pem' });
    return true;
  } catch {
    return false;
  }
}
