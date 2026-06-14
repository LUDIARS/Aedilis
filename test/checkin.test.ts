// 出席チェックインのユニットテスト (CONTRACTS §4)。
// in-memory SQLite で完結 (Cernere / ネットワーク不要)。 attestation は
// テスト内で Ed25519 鍵を生成して署名する (ゲートウェイ役)。

import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createReservation,
  getGateway,
  insertAttendance,
  listAttendance,
  listAttendanceForUser,
  listGateways,
  openDb,
  upsertGateway,
} from '../server/db.ts';
import { b64urlEncode, type AttestationPayload } from '../server/checkin/attestation.ts';
import { processCheckin } from '../server/checkin/service.ts';

let db: Database.Database;
let publicKeyPem: string;
let privateKey: KeyObject;

const LAN_ID = 'lan-1';
const FACILITY = 'room-101';
const USER = 'user-alice';

beforeEach(() => {
  db = openDb(':memory:');
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  upsertGateway(db, { lanId: LAN_ID, publicKeyPem, facilityId: FACILITY, label: 'Room 101' });
});

/** ゲートウェイ役: payload を署名して attestation トークンを作る。 */
function sign(payload: AttestationPayload, key: KeyObject = privateKey): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = cryptoSign(null, Buffer.from(body), key);
  return `${body}.${b64urlEncode(sig)}`;
}

function makePayload(over: Partial<AttestationPayload> = {}): AttestationPayload {
  return {
    sub: USER,
    placeId: FACILITY,
    lanId: LAN_ID,
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    issuedAt: Date.now(),
    ...over,
  };
}

describe('gateway registry', () => {
  it('upserts and reads a gateway', () => {
    expect(getGateway(db, LAN_ID)?.facility_id).toBe(FACILITY);
  });

  it('updates the key on re-upsert (PK = lan_id)', () => {
    upsertGateway(db, { lanId: LAN_ID, publicKeyPem: 'PEM2', facilityId: 'room-2' });
    expect(getGateway(db, LAN_ID)?.public_key_pem).toBe('PEM2');
    expect(getGateway(db, LAN_ID)?.facility_id).toBe('room-2');
    expect(listGateways(db)).toHaveLength(1);
  });

  it('returns null for an unknown gateway', () => {
    expect(getGateway(db, 'no-such-lan')).toBeNull();
  });
});

describe('attendance persistence', () => {
  it('inserts and lists attendance for a user', () => {
    const row = insertAttendance(db, {
      userId: USER, facilityId: FACILITY, lanId: LAN_ID,
      checkedInAt: 1000, reservationId: null, nonce: 'n1',
    });
    expect(row).not.toBe('duplicate');
    expect(listAttendanceForUser(db, USER)).toHaveLength(1);
  });

  it('detects replay via UNIQUE nonce', () => {
    insertAttendance(db, {
      userId: USER, facilityId: FACILITY, lanId: LAN_ID,
      checkedInAt: 1000, reservationId: null, nonce: 'dup',
    });
    const second = insertAttendance(db, {
      userId: 'user-bob', facilityId: FACILITY, lanId: LAN_ID,
      checkedInAt: 2000, reservationId: null, nonce: 'dup',
    });
    expect(second).toBe('duplicate');
  });

  it('filters admin listing by facility', () => {
    insertAttendance(db, {
      userId: USER, facilityId: 'room-a', lanId: LAN_ID,
      checkedInAt: 1, reservationId: null, nonce: 'a',
    });
    insertAttendance(db, {
      userId: USER, facilityId: 'room-b', lanId: LAN_ID,
      checkedInAt: 2, reservationId: null, nonce: 'b',
    });
    expect(listAttendance(db, { facilityId: 'room-a' })).toHaveLength(1);
  });
});

describe('processCheckin — full flow', () => {
  it('records a walk-in (no reservation) for a valid attestation', () => {
    const result = processCheckin(db, sign(makePayload()), USER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matchedReservation).toBeNull();
      expect(result.attendanceId).toBeTruthy();
    }
    expect(listAttendanceForUser(db, USER)).toHaveLength(1);
  });

  it('matches a covering confirmed reservation', () => {
    const at = Date.now();
    const reservation = createReservation(db, {
      facilityId: FACILITY, ownerUserId: USER,
      startAt: at - 60_000, endAt: at + 60_000, purpose: 'class', state: 'confirmed',
    });
    const result = processCheckin(db, sign(makePayload({ issuedAt: at })), USER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matchedReservation).toBe(reservation.id);
  });

  it('does not match a cancelled reservation', () => {
    const at = Date.now();
    createReservation(db, {
      facilityId: FACILITY, ownerUserId: USER,
      startAt: at - 60_000, endAt: at + 60_000, purpose: 'x', state: 'cancelled',
    });
    const result = processCheckin(db, sign(makePayload({ issuedAt: at })), USER);
    expect(result.ok && result.matchedReservation).toBeNull();
  });

  it('rejects when sub !== auth user (本人性)', () => {
    const result = processCheckin(db, sign(makePayload({ sub: 'someone-else' })), USER);
    expect(result).toMatchObject({ ok: false, status: 403, code: 'SUBJECT_MISMATCH' });
  });

  it('rejects a stale attestation (> 120s, 鮮度)', () => {
    const old = makePayload({ issuedAt: Date.now() - 121_000 });
    const result = processCheckin(db, sign(old), USER);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'ATTESTATION_STALE' });
  });

  it('rejects replay (same nonce twice → 409)', () => {
    const payload = makePayload();
    expect(processCheckin(db, sign(payload), USER).ok).toBe(true);
    const second = processCheckin(db, sign(payload), USER);
    expect(second).toMatchObject({ ok: false, status: 409, code: 'REPLAY_DETECTED' });
  });

  it('rejects an unknown gateway (400)', () => {
    const result = processCheckin(db, sign(makePayload({ lanId: 'ghost-lan' })), USER);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'UNKNOWN_GATEWAY' });
  });

  it('rejects a tampered signature (400)', () => {
    const other = generateKeyPairSync('ed25519');
    // 登録済とは別の鍵で署名 → 検証失敗
    const result = processCheckin(db, sign(makePayload(), other.privateKey), USER);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'ATTESTATION_INVALID' });
  });

  it('rejects a malformed token (400)', () => {
    const result = processCheckin(db, 'not-a-valid-token', USER);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'ATTESTATION_MALFORMED' });
  });
});
