// 出席チェックインの検証オーケストレーション (CONTRACTS §4 verify の 1〜6)。
//
// HTTP から切り離して純粋関数化 (route は薄く、 ここに業務ロジック)。
// 戻り値は判別可能 union — route が HTTP ステータスへ変換する。

import type Database from 'better-sqlite3';
import {
  type CheckinAssurance,
  type CheckinMethod,
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

const ASSURANCE_RANK: Record<CheckinAssurance, number> = { low: 0, medium: 1, high: 2, manual: 3 };

function configuredMinimumAssurance(): CheckinAssurance {
  const value = process.env.CHECKIN_MIN_ASSURANCE?.trim() ?? 'medium';
  return value === 'low' || value === 'medium' || value === 'high' || value === 'manual' ? value : 'medium';
}

function configuredPasskeyStreakWarning(): number {
  const value = Number(process.env.CHECKIN_PASSKEY_STREAK_WARN ?? '5');
  return Number.isInteger(value) && value > 0 ? value : 5;
}

export function getCheckinPolicy(): { minAssurance: CheckinAssurance; passkeyStreakWarning: number } {
  return { minAssurance: configuredMinimumAssurance(), passkeyStreakWarning: configuredPasskeyStreakWarning() };
}

export type CheckinResult =
  | { ok: true; attendanceId: string; matchedReservation: string | null }
  | { ok: false; status: 400 | 403 | 409; error: string; code: string };

/**
 * attestation を検証して出席を記録する。
 *   1. decode → lan_id で公開鍵を引いて署名検証 (引けない/不正 → 400)
 *   2. gateway は登録済み施設の attestation だけを発行できる (不一致 → 403)
 *   3. 本人性: browser 経路では payload.sub === authUserId (不一致 → 403)
 *   4. 鮮度: now - issuedAt <= 120s (古い → 400)
 *   5. replay: nonce UNIQUE 挿入 (重複 → 409)
 *   6. 予約照合: 同 user × facility の confirmed 予約 (無ければ walk-in)
 *   7. 記録 → Memoria webhook (fire-and-forget)
 */
export function processCheckin(
  db: Database.Database,
  attestation: string,
  authorization: { subjectUserId?: string; gatewayLanId?: string } = {},
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

  // A registered signing key is scoped to one facility; it must not create
  // attendance (or reservation matches) for another facility.
  if (payload.placeId !== gateway.facility_id) {
    return { ok: false, status: 403, error: 'gateway_facility_mismatch', code: 'GATEWAY_FACILITY_MISMATCH' };
  }

  if (authorization.gatewayLanId && payload.lanId !== authorization.gatewayLanId) {
    return { ok: false, status: 403, error: 'gateway_mismatch', code: 'GATEWAY_MISMATCH' };
  }

  // 2. 本人性 — browser 経路では他人の attestation を投げさせない。
  if (authorization.subjectUserId && payload.sub !== authorization.subjectUserId) {
    return { ok: false, status: 403, error: 'subject_mismatch', code: 'SUBJECT_MISMATCH' };
  }

  const method: CheckinMethod = payload.method ?? 'passkey';
  const assurance: CheckinAssurance = payload.assurance ?? 'medium';
  const minimumAssurance = configuredMinimumAssurance();
  if (method !== 'staff_override' && ASSURANCE_RANK[assurance] < ASSURANCE_RANK[minimumAssurance]) {
    return { ok: false, status: 403, error: 'assurance_too_low', code: 'ASSURANCE_TOO_LOW' };
  }

  // 3. 鮮度
  if (now - payload.issuedAt > FRESHNESS_MS) {
    return { ok: false, status: 400, error: 'attestation_stale', code: 'ATTESTATION_STALE' };
  }

  // 5. 予約照合 (記録前に確定)
  const reservation = findMatchingReservation(
    db,
    payload.sub,
    payload.placeId,
    payload.issuedAt,
  );

  // 4 + 6. 記録 (nonce UNIQUE = replay 検出)
  const inserted = insertAttendance(db, {
    userId: payload.sub,
    facilityId: payload.placeId,
    lanId: payload.lanId,
    checkedInAt: payload.issuedAt,
    reservationId: reservation?.id ?? null,
    nonce: payload.nonce,
    method,
    assurance,
  });
  if (inserted === 'duplicate') {
    return { ok: false, status: 409, error: 'replay_detected', code: 'REPLAY_DETECTED' };
  }

  // 6. Memoria webhook (fire-and-forget — 失敗しても出席は成立)
  notifyAttendance({
    userId: payload.sub,
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
