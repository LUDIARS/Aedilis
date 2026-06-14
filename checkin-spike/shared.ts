// 会場ゲートウェイ (LAN) とクラウド (Aedilis stub) で共有する
// attestation の型 + 署名/検証ヘルパ。
//
// attestation = base64url(JSON payload) + "." + base64url(Ed25519 署名)
// LANゲートウェイの秘密鍵で署名し、 クラウドはゲートウェイ公開鍵で検証する。

import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface AttestationPayload {
  sub: string; // 本番では Cernere sub
  placeId: string; // 出席対象の施設/部屋
  lanId: string; // どのゲートウェイが発行したか
  nonce: string; // 検証に使った challenge (replay 検出)
  issuedAt: number; // epoch ms — 出席時刻の正本 (LAN 時計)
}

export function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signAttestation(payload: AttestationPayload, privateKey: KeyObject): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = cryptoSign(null, Buffer.from(body), privateKey);
  return `${body}.${b64urlEncode(sig)}`;
}

export function verifyAttestation(
  token: string,
  publicKey: KeyObject,
): { ok: boolean; payload?: AttestationPayload } {
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false };
  const ok = cryptoVerify(null, Buffer.from(body), publicKey, b64urlDecode(sig));
  if (!ok) return { ok: false };
  return { ok: true, payload: JSON.parse(b64urlDecode(body).toString('utf8')) as AttestationPayload };
}
