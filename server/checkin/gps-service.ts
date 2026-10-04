// GPS + 写真チェックインの判定と記録 (CONTRACTS §6 G3 の検証 2〜7)。
//
// 検証 1 (入力形式) は gps-input.ts、 レート制限は route。 ここは HTTP から
// 切り離した純粋なオーケストレーションで、 結果は固定語彙のエラーコードで返す。
// 写真はメモリ上で検証して捨てる。 保存するのは SHA-256・Exif 撮影時刻・判定結果・
// 距離だけ (Exif の位置は保存しない)。

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  findMatchingReservation,
  getGateway,
  insertAttendance,
  insertGpsCheckinPhoto,
  isGpsPhotoReused,
} from '../db.ts';
import { exifTakenAtMs, readPhotoExif } from './exif/index.ts';
import { haversineMeters } from './geo.ts';
import type { GpsCheckinInput } from './gps-input.ts';
import { decodeLocationStatement, verifyLocationStatement } from './location-statement.ts';
import { notifyAttendance } from './notify.ts';

/** 位置の宣言の鮮度 (G3-3)。 */
export const STATEMENT_FRESHNESS_MS = 15 * 60_000;
/** 端末の測位精度の上限 (G3-4)。 */
export const MAX_ACCURACY_M = 100;
/** 端末の測位時刻の許容ずれ (G3-4)。 */
export const POSITION_WINDOW_MS = 5 * 60_000;
/** Exif 撮影時刻の許容ずれ (G3-5)。 */
export const EXIF_TIME_WINDOW_MS = 10 * 60_000;
/** OffsetTimeOriginal が無い写真は施設のタイムゾーン (Asia/Tokyo) とみなす。 */
export const FACILITY_UTC_OFFSET = '+09:00';

export type GpsCheckinErrorCode =
  | 'invalid_input'
  | 'statement_invalid'
  | 'unknown_gateway'
  | 'facility_mismatch'
  | 'statement_stale'
  | 'accuracy_too_low'
  | 'out_of_range'
  | 'photo_invalid'
  | 'exif_missing'
  | 'exif_time_out_of_window'
  | 'exif_location_out_of_range'
  | 'photo_reused'
  | 'rate_limited';

export const GPS_ERROR_STATUS: Record<GpsCheckinErrorCode, 400 | 403 | 409 | 413 | 429> = {
  invalid_input: 400,
  statement_invalid: 400,
  unknown_gateway: 400,
  facility_mismatch: 403,
  statement_stale: 400,
  accuracy_too_low: 400,
  out_of_range: 403,
  photo_invalid: 400,
  exif_missing: 400,
  exif_time_out_of_window: 400,
  exif_location_out_of_range: 403,
  photo_reused: 409,
  rate_limited: 429,
};

export type GpsCheckinResult =
  | { ok: true; attendanceId: string; matchedReservation: string | null; distanceM: number }
  | { ok: false; error: GpsCheckinErrorCode };

function fail(error: GpsCheckinErrorCode): GpsCheckinResult {
  return { ok: false, error };
}

/**
 * 位置の宣言と写真を検証して GPS 出席を記録する (G3 の 2〜7 をこの順で)。
 *   2. 宣言の署名 (gateway 公開鍵)・purpose == "location"・facilityId
 *   3. 宣言の鮮度 (15 分)
 *   4. 測位精度 <= 100m、 haversine 距離 <= radiusM + accuracyM、 positionAt ±5 分
 *   5. Exif DateTimeOriginal (±10 分)、 Exif GPS があればその範囲判定
 *   6. 使い回し (SHA-256 / 同一利用者 × 同一撮影時刻)
 *   7. attendance に method="gps"・assurance="low" で記録 → Memoria webhook
 */
export function processGpsCheckin(
  db: Database.Database,
  input: GpsCheckinInput,
  userId: string,
  now: number = Date.now(),
): GpsCheckinResult {
  // 2. 宣言の署名と施設
  const decoded = decodeLocationStatement(input.locationStatement);
  if (!decoded) return fail('statement_invalid');
  const gateway = getGateway(db, decoded.lanId);
  if (!gateway) return fail('unknown_gateway');
  const statement = verifyLocationStatement(input.locationStatement, gateway.public_key_pem);
  if (!statement) return fail('statement_invalid');
  if (statement.facilityId !== gateway.facility_id) return fail('facility_mismatch');

  // 3. 鮮度
  if (Math.abs(now - statement.issuedAt) > STATEMENT_FRESHNESS_MS) return fail('statement_stale');

  // 4. 端末の位置
  if (input.accuracyM > MAX_ACCURACY_M) return fail('accuracy_too_low');
  const allowedM = statement.radiusM + input.accuracyM;
  const distanceM = haversineMeters(statement.lat, statement.lon, input.lat, input.lon);
  if (distanceM > allowedM) return fail('out_of_range');
  if (Math.abs(now - input.positionAt) > POSITION_WINDOW_MS) return fail('invalid_input');

  // 5. 写真の Exif
  const exif = readPhotoExif(input.photo.bytes, input.photo.mime);
  const takenAt = exifTakenAtMs(exif, FACILITY_UTC_OFFSET);
  if (takenAt === null) return fail('exif_missing');
  if (Math.abs(now - takenAt) > EXIF_TIME_WINDOW_MS) return fail('exif_time_out_of_window');
  if (exif.gpsLat !== undefined && exif.gpsLon !== undefined) {
    const exifDistanceM = haversineMeters(statement.lat, statement.lon, exif.gpsLat, exif.gpsLon);
    if (exifDistanceM > allowedM) return fail('exif_location_out_of_range');
  }

  // 6. 使い回し
  const photoSha256 = createHash('sha256').update(input.photo.bytes).digest('hex');
  if (isGpsPhotoReused(db, { photoSha256, userId, exifTakenAt: takenAt })) return fail('photo_reused');

  // 7. 記録 (写真の判定記録と attendance を 1 トランザクションで)
  const reservation = findMatchingReservation(db, userId, statement.facilityId, now);
  const roundedDistanceM = Math.round(distanceM * 10) / 10;
  const record = db.transaction(() => {
    const attendance = insertAttendance(db, {
      userId,
      facilityId: statement.facilityId,
      lanId: statement.lanId,
      checkedInAt: now,
      reservationId: reservation?.id ?? null,
      nonce: `gps:${photoSha256}`,
      method: 'gps',
      assurance: 'low',
    });
    if (attendance === 'duplicate') return null;
    const photo = insertGpsCheckinPhoto(db, {
      photoSha256,
      userId,
      exifTakenAt: takenAt,
      result: 'accepted',
      distanceM: roundedDistanceM,
      attendanceId: attendance.id,
    });
    if (photo === 'duplicate') throw new PhotoReusedRace();
    return attendance;
  });

  let attendance;
  try {
    attendance = record();
  } catch (e) {
    if (e instanceof PhotoReusedRace) return fail('photo_reused');
    throw e;
  }
  if (!attendance) return fail('photo_reused');

  notifyAttendance({
    userId,
    facilityId: statement.facilityId,
    checkedInAt: now,
    reservationId: reservation?.id ?? null,
  });

  return {
    ok: true,
    attendanceId: attendance.id,
    matchedReservation: reservation?.id ?? null,
    distanceM: roundedDistanceM,
  };
}

/** 事前検査と挿入の間に同じ写真が記録された場合に transaction を巻き戻すための印。 */
class PhotoReusedRace extends Error {}
