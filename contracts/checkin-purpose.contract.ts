import { decodeAttestationPayload } from '../server/checkin/attestation.ts';

type CheckinResult =
  | { ok: true; attendanceId: string; matchedReservation: string | null }
  | { ok: false; status: 400 | 403 | 409; error: string; code: string };

export default {
  post: (result: CheckinResult, _db: unknown, attestation: string): boolean => {
    const payload = decodeAttestationPayload(attestation);
    if (!payload) return true; // malformed attestation — purpose check out of scope here
    const purpose = payload.purpose ?? 'attendance';
    if (purpose === 'attendance') {
      // Accepting attendance-purpose attestations is governed by other checks
      // (signature/freshness/replay); this contract only asserts the purpose gate.
      return true;
    }
    return result.ok === false && result.status === 403 && result.code === 'PURPOSE_MISMATCH';
  },
};
