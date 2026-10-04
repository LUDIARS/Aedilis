import type Database from 'better-sqlite3';

const VOCABULARY = new Set([
  'invalid_input', 'statement_invalid', 'unknown_gateway', 'facility_mismatch', 'statement_stale',
  'accuracy_too_low', 'out_of_range', 'photo_invalid', 'exif_missing', 'exif_time_out_of_window',
  'exif_location_out_of_range', 'photo_reused', 'rate_limited',
]);

type GpsCheckinResult =
  | { ok: true; attendanceId: string; matchedReservation: string | null; distanceM: number }
  | { ok: false; error: string };

export default {
  // C-3: rejections use only the fixed vocabulary; an accepted check-in is recorded as
  // method "gps" / assurance "low" with a photo row that holds no image or Exif location.
  post: (result: GpsCheckinResult, db: Database.Database): boolean => {
    if (!result.ok) return VOCABULARY.has(result.error);
    const attendance = db
      .prepare('SELECT method, assurance FROM attendance WHERE id = ?')
      .get(result.attendanceId) as { method: string; assurance: string } | undefined;
    const photo = db
      .prepare('SELECT * FROM gps_checkin_photo WHERE attendance_id = ?')
      .get(result.attendanceId) as Record<string, unknown> | undefined;
    const allowedColumns = ['photo_sha256', 'user_id', 'exif_taken_at', 'result', 'distance_m', 'attendance_id', 'created_at'];
    return attendance?.method === 'gps' && attendance.assurance === 'low' &&
      photo !== undefined && Object.keys(photo).every((key) => allowedColumns.includes(key)) &&
      typeof photo.photo_sha256 === 'string' && /^[0-9a-f]{64}$/.test(photo.photo_sha256);
  },
};
