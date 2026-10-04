// 位置の宣言 (CONTRACTS §6 G1) の decode / 検証。
//
// Ostiarius が gateway 鍵で署名した `base64url(JSON) + "." + base64url(Ed25519 署名)`。
// payload のキー: { lanId, facilityId, lat, lon, radiusM, issuedAt, purpose: "location" }。

import { peekSignedJson, verifySignedJson } from './attestation.ts';

export interface LocationStatement {
  lanId: string;
  facilityId: string;
  lat: number;
  lon: number;
  radiusM: number;
  /** epoch ms (ゲートウェイ時計)。 */
  issuedAt: number;
  purpose: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asStatement(o: unknown): LocationStatement | null {
  if (!o || typeof o !== 'object') return null;
  const p = o as Record<string, unknown>;
  const ok =
    typeof p.lanId === 'string' && p.lanId !== '' &&
    typeof p.facilityId === 'string' &&
    isFiniteNumber(p.lat) && Math.abs(p.lat) <= 90 &&
    isFiniteNumber(p.lon) && Math.abs(p.lon) <= 180 &&
    isFiniteNumber(p.radiusM) && p.radiusM >= 0 &&
    isFiniteNumber(p.issuedAt) &&
    typeof p.purpose === 'string';
  return ok ? (p as unknown as LocationStatement) : null;
}

/** 署名検証せず形だけ読む (lanId で公開鍵を引くため)。 形が不正なら null。 */
export function decodeLocationStatement(token: string): LocationStatement | null {
  return asStatement(peekSignedJson(token));
}

/** gateway 公開鍵で署名を検証し、 purpose が "location" の宣言だけを返す。 */
export function verifyLocationStatement(token: string, publicKeyPem: string): LocationStatement | null {
  const statement = asStatement(verifySignedJson(token, publicKeyPem));
  return statement && statement.purpose === 'location' ? statement : null;
}
