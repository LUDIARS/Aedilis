import { peekSignedJson } from '../server/checkin/attestation.ts';

type CheckinResult =
  | { ok: true; attendanceId: string; matchedReservation: string | null }
  | { ok: false; status: 400 | 403 | 409; error: string; code: string };

export default {
  // C-4: a location statement (purpose "location") never records attendance via processCheckin.
  post: (result: CheckinResult, _db: unknown, attestation: string): boolean => {
    const payload = peekSignedJson(attestation) as { purpose?: unknown } | null;
    if (!payload || payload.purpose !== 'location') return true;
    return result.ok === false;
  },
};
