// GPS + 写真チェックイン (CONTRACTS §6 G3) の判定と記録のユニットテスト。
// in-memory SQLite で完結。 位置の宣言はテスト内の Ed25519 鍵で署名する (Ostiarius 役)。

import { createHash, type KeyObject } from 'node:crypto';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createReservation, listAttendanceForUser, openDb, upsertGateway } from '../server/db.ts';
import type { GpsCheckinInput } from '../server/checkin/gps-input.ts';
import { processGpsCheckin } from '../server/checkin/gps-service.ts';
import { processCheckin } from '../server/checkin/service.ts';
import {
  buildHeic,
  buildJpeg,
  type ExifSpec,
  exifDateTime,
  latOffset,
  makeGatewayKeys,
  signStatement,
} from './fixtures/photo-exif.ts';

const NOW = Date.parse('2026-10-05T01:00:00Z');
const LAN_ID = 'lan-gps';
const FACILITY = 'room-101';
const USER = 'user-alice';
const VENUE = { lat: 35.681236, lon: 139.767125, radiusM: 50 };

let db: Database.Database;
let privateKey: KeyObject;

beforeEach(() => {
  db = openDb(':memory:');
  const keys = makeGatewayKeys();
  privateKey = keys.privateKey;
  upsertGateway(db, { lanId: LAN_ID, publicKeyPem: keys.publicKeyPem, facilityId: FACILITY, tokenHash: 'gps-test-hash' });
});

function statement(over: Record<string, unknown> = {}, key: KeyObject = privateKey): string {
  return signStatement(
    { lanId: LAN_ID, facilityId: FACILITY, ...VENUE, issuedAt: NOW, purpose: 'location', ...over },
    key,
  );
}

function photoSpec(over: Partial<ExifSpec> = {}): ExifSpec {
  return { dateTimeOriginal: exifDateTime(NOW), ...over };
}

function input(over: Partial<GpsCheckinInput> = {}): GpsCheckinInput {
  return {
    locationStatement: statement(),
    lat: VENUE.lat,
    lon: VENUE.lon,
    accuracyM: 10,
    positionAt: NOW,
    photo: { bytes: buildJpeg(photoSpec()), mime: 'image/jpeg' },
    ...over,
  };
}

function check(over: Partial<GpsCheckinInput> = {}, user = USER, now = NOW) {
  return processGpsCheckin(db, input(over), user, now);
}

describe('processGpsCheckin — accepted', () => {
  it('records attendance as method "gps" / assurance "low"', () => {
    const result = check();
    expect(result).toMatchObject({ ok: true });
    const [row] = listAttendanceForUser(db, USER);
    expect(row).toMatchObject({ facility_id: FACILITY, lan_id: LAN_ID, method: 'gps', assurance: 'low', checked_in_at: NOW });
    expect(result.ok && result.attendanceId).toBe(row?.id);
  });

  it('stores only the hash, Exif capture time, result and distance — never the photo or Exif location', () => {
    const bytes = buildJpeg(photoSpec({ gps: { lat: VENUE.lat, lon: VENUE.lon } }));
    const result = check({ photo: { bytes, mime: 'image/jpeg' }, lat: latOffset(VENUE.lat, 20) });
    expect(result.ok).toBe(true);
    const rows = db.prepare('SELECT * FROM gps_checkin_photo').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ['attendance_id', 'created_at', 'distance_m', 'exif_taken_at', 'photo_sha256', 'result', 'user_id'],
    );
    expect(rows[0]).toMatchObject({
      photo_sha256: createHash('sha256').update(bytes).digest('hex'),
      exif_taken_at: NOW,
      result: 'accepted',
    });
    expect(rows[0]?.distance_m as number).toBeCloseTo(20, 0);
    expect(Object.values(rows[0] ?? {}).some((v) => Buffer.isBuffer(v))).toBe(false);
  });

  it('accepts a HEIC photo', () => {
    expect(check({ photo: { bytes: buildHeic(photoSpec()), mime: 'image/heic' } }).ok).toBe(true);
  });

  it('matches a confirmed reservation like the attestation flow', () => {
    const reservation = createReservation(db, {
      facilityId: FACILITY, ownerUserId: USER, startAt: NOW - 60_000, endAt: NOW + 3_600_000, purpose: '', state: 'confirmed',
    });
    const result = check();
    expect(result).toMatchObject({ ok: true, matchedReservation: reservation.id });
  });
});

describe('processGpsCheckin — location statement (G3-2, G3-3)', () => {
  it('rejects a malformed statement', () => {
    expect(check({ locationStatement: 'garbage' })).toEqual({ ok: false, error: 'statement_invalid' });
  });

  it('rejects a statement signed by another key', () => {
    const other = makeGatewayKeys();
    expect(check({ locationStatement: statement({}, other.privateKey) })).toEqual({ ok: false, error: 'statement_invalid' });
  });

  it('rejects a statement whose purpose is not "location"', () => {
    expect(check({ locationStatement: statement({ purpose: 'attendance' }) })).toEqual({ ok: false, error: 'statement_invalid' });
  });

  it('rejects an unregistered gateway', () => {
    expect(check({ locationStatement: statement({ lanId: 'unknown-lan' }) })).toEqual({ ok: false, error: 'unknown_gateway' });
  });

  it('rejects a facility the gateway is not registered for', () => {
    expect(check({ locationStatement: statement({ facilityId: 'room-999' }) })).toEqual({ ok: false, error: 'facility_mismatch' });
  });

  it('accepts a statement exactly 15 minutes old and rejects an older one', () => {
    expect(check({ locationStatement: statement({ issuedAt: NOW - 15 * 60_000 }) }).ok).toBe(true);
    expect(check({ locationStatement: statement({ issuedAt: NOW - 15 * 60_000 - 1 }) })).toEqual({ ok: false, error: 'statement_stale' });
  });
});

describe('processGpsCheckin — device position (G3-4)', () => {
  it('accepts accuracy 100m and rejects anything coarser', () => {
    expect(check({ accuracyM: 100 }).ok).toBe(true);
    expect(check({ accuracyM: 100.5 })).toEqual({ ok: false, error: 'accuracy_too_low' });
  });

  it('uses radiusM + accuracyM as the distance boundary', () => {
    // radius 50 + accuracy 10 = 60m
    expect(check({ lat: latOffset(VENUE.lat, 59.9) }).ok).toBe(true);
    expect(check({ lat: latOffset(VENUE.lat, 60.1) })).toEqual({ ok: false, error: 'out_of_range' });
  });

  it('rejects a position timestamp more than 5 minutes from server time', () => {
    expect(check({ positionAt: NOW - 5 * 60_000 }).ok).toBe(true);
    expect(check({ positionAt: NOW + 5 * 60_000 + 1 })).toEqual({ ok: false, error: 'invalid_input' });
  });
});

describe('processGpsCheckin — photo Exif (G3-5)', () => {
  it('rejects a photo without DateTimeOriginal', () => {
    expect(check({ photo: { bytes: buildJpeg(null), mime: 'image/jpeg' } })).toEqual({ ok: false, error: 'exif_missing' });
    expect(check({ photo: { bytes: buildJpeg({ gps: VENUE }), mime: 'image/jpeg' } })).toEqual({ ok: false, error: 'exif_missing' });
  });

  it('rejects a capture time more than 10 minutes from server time', () => {
    const at = (ms: number) => ({ bytes: buildJpeg(photoSpec({ dateTimeOriginal: exifDateTime(ms) })), mime: 'image/jpeg' as const });
    expect(check({ photo: at(NOW - 10 * 60_000) }).ok).toBe(true);
    expect(check({ photo: at(NOW - 11 * 60_000) })).toEqual({ ok: false, error: 'exif_time_out_of_window' });
  });

  it('applies OffsetTimeOriginal instead of the facility time zone', () => {
    const utc = { dateTimeOriginal: exifDateTime(NOW, 0), offsetTimeOriginal: '+00:00' };
    expect(check({ photo: { bytes: buildJpeg(utc), mime: 'image/jpeg' } }).ok).toBe(true);
    // 同じ壁時計を Asia/Tokyo とみなすと 9 時間ずれる
    const noOffset = { dateTimeOriginal: exifDateTime(NOW, 0) };
    expect(check({ photo: { bytes: buildJpeg(noOffset), mime: 'image/jpeg' } }))
      .toEqual({ ok: false, error: 'exif_time_out_of_window' });
  });

  it('rejects an Exif GPS position outside the venue range', () => {
    const far = buildJpeg(photoSpec({ gps: { lat: latOffset(VENUE.lat, 500), lon: VENUE.lon } }));
    expect(check({ photo: { bytes: far, mime: 'image/jpeg' } })).toEqual({ ok: false, error: 'exif_location_out_of_range' });
  });
});

describe('processGpsCheckin — reuse (G3-6)', () => {
  it('rejects the same photo bytes twice, even for another user', () => {
    const bytes = buildJpeg(photoSpec());
    expect(check({ photo: { bytes, mime: 'image/jpeg' } }).ok).toBe(true);
    expect(check({ photo: { bytes, mime: 'image/jpeg' } }, 'user-bob')).toEqual({ ok: false, error: 'photo_reused' });
  });

  it('rejects another photo from the same user with the same DateTimeOriginal', () => {
    expect(check().ok).toBe(true);
    expect(check()).toEqual({ ok: false, error: 'photo_reused' });
  });

  it('allows the same capture time for a different user', () => {
    expect(check().ok).toBe(true);
    expect(check({}, 'user-bob').ok).toBe(true);
  });
});

describe('processCheckin — location statement is not an attestation', () => {
  it('rejects a signed location statement with purpose_mismatch', () => {
    const result = processCheckin(db, statement(), { subjectUserId: USER }, NOW);
    expect(result).toMatchObject({ ok: false, status: 403, error: 'purpose_mismatch' });
    expect(listAttendanceForUser(db, USER)).toHaveLength(0);
  });
});
