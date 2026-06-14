// 出席チェックインの検証オーケストレーション (CONTRACTS §4 verify の 1〜6)。
//
// HTTP から切り離して純粋関数化 (route は薄く、 ここに業務ロジック)。
// 戻り値は判別可能 union — route が HTTP ステータスへ変換する。

import type Database from 'better-sqlite3';
import {
  findMatchingReservation,
  getGateway,
  insertAttendance,
} from '../db.ts';
import {
  decodeAttestationPayload,
  verifyAttestationWithPem,
} from './attestation.ts';
import { notifyAttendance } from './notify.ts';

/** 鮮度しきい値。 issuedAt がこれより古い attestation は拒否 (CONTRACTS §4-3)。 */
export const FRESHNESS_MS = 120_000;

export type CheckinResult =
  | { ok: true; attendanceId: string; matchedReservation: string | null }
  | { ok: false; status: 400 | 403 | 409; error: string; code: string };

/**
 * attestation を検証して出席を記録する。
 *   1. decode → lan_id で公開鍵を引いて署名検証 (引けない/不正 → 400)
 *   2. 本人性: payload.sub === authUserId (不一致 → 403)
 *   3. 鮮度: now - issuedAt <= 120s (古い → 400)
 *   4. replay: nonce UNIQUE 挿入 (重複 → 409)
 *   5. 予約照合: 同 user × facility の confirmed 予約 (無ければ walk-in)
 *   6. 記録 → Memoria webhook (fire-and-forget)
 */
export function processCheckin(
  db: Database.Database,
  attestation: string,
  authUserId: string,
  now: number = Date.now(),
): CheckinResult {
  // 1. decode (署名前) → ゲートウェイ公開鍵を引く
  const decoded = decodeAttestationPayload(attestation);
  if (!decoded) {
    return { ok: false, status: 400, error: 'attestation_malformed', code: 'ATTESTATION_MALFORMED' };
  }
  const gateway = getGateway(db, decoded.lanId);
  if (!gateway) {
    return { ok: false, status: 400, error: 'unknown_gateway', code: 'UNKNOWN_GATEWAY' };
  }

  // 1. 署名検証 (gateway 公開鍵で)
  const verified = verifyAttestationWithPem(attestation, gateway.public_key_pem);
  if (!verified.ok || !verified.payload) {
    return { ok: false, status: 400, error: 'attestation_invalid', code: 'ATTESTATION_INVALID' };
  }
  const payload = verified.payload;

  // 2. 本人性 — 他人の attestation を投げさせない
  if (payload.sub !== authUserId) {
    return { ok: false, status: 403, error: 'subject_mismatch', code: 'SUBJECT_MISMATCH' };
  }

  // 3. 鮮度
  if (now - payload.issuedAt > FRESHNESS_MS) {
    return { ok: false, status: 400, error: 'attestation_stale', code: 'ATTESTATION_STALE' };
  }

  // 5. 予約照合 (記録前に確定)
  const reservation = findMatchingReservation(
    db,
    authUserId,
    payload.placeId,
    payload.issuedAt,
  );

  // 4 + 6. 記録 (nonce UNIQUE = replay 検出)
  const inserted = insertAttendance(db, {
    userId: authUserId,
    facilityId: payload.placeId,
    lanId: payload.lanId,
    checkedInAt: payload.issuedAt,
    reservationId: reservation?.id ?? null,
    nonce: payload.nonce,
  });
  if (inserted === 'duplicate') {
    return { ok: false, status: 409, error: 'replay_detected', code: 'REPLAY_DETECTED' };
  }

  // 6. Memoria webhook (fire-and-forget — 失敗しても出席は成立)
  notifyAttendance({
    userId: authUserId,
    facilityId: payload.placeId,
    checkedInAt: payload.issuedAt,
    reservationId: reservation?.id ?? null,
  });

  return {
    ok: true,
    attendanceId: inserted.id,
    matchedReservation: reservation?.id ?? null,
  };
}
