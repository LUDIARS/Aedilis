// Aedilis 永続層 — better-sqlite3。
//
// 持つのは **予約台帳** と **施設キャッシュ** のみ。
// 施設の「中身」は外部 FacilitySource が権威。 facility_cache は照会高速化用の
// スナップショット。 個人データは Cernere 単一情報源 — owner_user_id (Cernere sub)
// と display name キャッシュのみ保持する。
//
// migration は CREATE IF NOT EXISTS のみ。 カラム追加時は ALTER ADD COLUMN を
// 後付けし、 新カラム用 INDEX は ALTER の直後に冪等発行する (既存 DB の boot 失敗防止)。

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ReservationState = 'pending' | 'confirmed' | 'cancelled';

export interface FacilityCacheRow {
  facility_id: string;
  display_name: string;
  source: string;
  allow_overlap: number;
  raw_json: string;
  fetched_at: number;
}

export interface ReservationRow {
  id: string;
  facility_id: string;
  owner_user_id: string;
  start_at: number;
  end_at: number;
  purpose: string;
  state: ReservationState;
  created_at: number;
  updated_at: number;
}

export interface UserDisplayRow {
  user_id: string;
  name: string;
  updated_at: number;
}

export interface GatewayRegistryRow {
  lan_id: string;
  public_key_pem: string;
  facility_id: string;
  label: string;
  created_at: number;
}

export interface AttendanceRow {
  id: string;
  user_id: string;
  facility_id: string;
  lan_id: string;
  checked_in_at: number;
  reservation_id: string | null;
  nonce: string;
  created_at: number;
}

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS facility_cache (
      facility_id   TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      source        TEXT NOT NULL,
      allow_overlap INTEGER NOT NULL DEFAULT 0,
      raw_json      TEXT NOT NULL,
      fetched_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservation (
      id            TEXT PRIMARY KEY,
      facility_id   TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      start_at      INTEGER NOT NULL,
      end_at        INTEGER NOT NULL,
      purpose       TEXT NOT NULL DEFAULT '',
      state         TEXT NOT NULL DEFAULT 'confirmed',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reservation_facility_time
      ON reservation(facility_id, start_at, end_at)
      WHERE state != 'cancelled';
    CREATE INDEX IF NOT EXISTS reservation_owner
      ON reservation(owner_user_id);

    CREATE TABLE IF NOT EXISTS user_display_cache (
      user_id    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 出席チェックイン (CONTRACTS §4)。 会場ゲートウェイ (Ostiarius) の公開鍵を
    -- lan_id で引いて attestation を検証する。 attendance は Cernere sub アンカーのみ。
    CREATE TABLE IF NOT EXISTS gateway_registry (
      lan_id         TEXT PRIMARY KEY,
      public_key_pem TEXT NOT NULL,
      facility_id    TEXT NOT NULL,
      label          TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      facility_id    TEXT NOT NULL,
      lan_id         TEXT NOT NULL,
      checked_in_at  INTEGER NOT NULL,
      reservation_id TEXT,
      nonce          TEXT NOT NULL,
      created_at     INTEGER NOT NULL
    );
    -- 新規テーブルなので INDEX を同 exec に置いてよい (既存 DB の no such column は起きない)。
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_nonce ON attendance(nonce);
    CREATE INDEX IF NOT EXISTS attendance_user ON attendance(user_id, checked_in_at);
  `);
  return db;
}

// ── Facility cache ─────────────────────────────────────────────────────────

/**
 * 施設をキャッシュへ upsert。 allow_overlap は **初回 insert 時のみ** source の値を
 * 使い、 既存行では更新しない (admin のトグル [[setFacilityOverlap]] が権威のため、
 * 起動同期で上書きしない)。
 */
export function upsertFacilityCache(
  db: Database.Database,
  args: {
    facilityId: string;
    displayName: string;
    source: string;
    allowOverlap: boolean;
    rawJson: string;
  },
): void {
  db.prepare(
    `INSERT INTO facility_cache
       (facility_id, display_name, source, allow_overlap, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(facility_id) DO UPDATE SET
       display_name  = excluded.display_name,
       source        = excluded.source,
       raw_json      = excluded.raw_json,
       fetched_at    = excluded.fetched_at`,
  ).run(
    args.facilityId,
    args.displayName,
    args.source,
    args.allowOverlap ? 1 : 0,
    args.rawJson,
    Date.now(),
  );
}

export function getFacilityCache(
  db: Database.Database,
  facilityId: string,
): FacilityCacheRow | null {
  return (
    db
      .prepare<[string], FacilityCacheRow>(
        `SELECT * FROM facility_cache WHERE facility_id = ?`,
      )
      .get(facilityId) ?? null
  );
}

export function setFacilityOverlap(
  db: Database.Database,
  facilityId: string,
  allowOverlap: boolean,
): boolean {
  const info = db
    .prepare(`UPDATE facility_cache SET allow_overlap = ? WHERE facility_id = ?`)
    .run(allowOverlap ? 1 : 0, facilityId);
  return info.changes > 0;
}

// ── Reservation operations ─────────────────────────────────────────────────

/** [s1,e1) と [s2,e2) は s1 < e2 かつ s2 < e1 のとき重なる。 */
export function findConflicts(
  db: Database.Database,
  facilityId: string,
  startAt: number,
  endAt: number,
  excludeId?: string,
): ReservationRow[] {
  return db
    .prepare<[string, number, number, string], ReservationRow>(
      `SELECT * FROM reservation
       WHERE facility_id = ?
         AND state != 'cancelled'
         AND start_at < ?
         AND end_at > ?
         AND id != ?
       ORDER BY start_at`,
    )
    .all(facilityId, endAt, startAt, excludeId ?? '');
}

export function createReservation(
  db: Database.Database,
  args: {
    facilityId: string;
    ownerUserId: string;
    startAt: number;
    endAt: number;
    purpose: string;
    state: ReservationState;
  },
): ReservationRow {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reservation
       (id, facility_id, owner_user_id, start_at, end_at, purpose, state,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.facilityId,
    args.ownerUserId,
    args.startAt,
    args.endAt,
    args.purpose,
    args.state,
    now,
    now,
  );
  return getReservation(db, id) as ReservationRow;
}

export function getReservation(
  db: Database.Database,
  id: string,
): ReservationRow | null {
  return (
    db
      .prepare<[string], ReservationRow>(`SELECT * FROM reservation WHERE id = ?`)
      .get(id) ?? null
  );
}

export function listReservations(
  db: Database.Database,
  filter: { facilityId?: string; from?: number; to?: number },
): ReservationRow[] {
  const where: string[] = [`state != 'cancelled'`];
  const params: Array<string | number> = [];
  if (filter.facilityId) {
    where.push('facility_id = ?');
    params.push(filter.facilityId);
  }
  if (typeof filter.from === 'number') {
    where.push('end_at > ?');
    params.push(filter.from);
  }
  if (typeof filter.to === 'number') {
    where.push('start_at < ?');
    params.push(filter.to);
  }
  return db
    .prepare<Array<string | number>, ReservationRow>(
      `SELECT * FROM reservation WHERE ${where.join(' AND ')}
       ORDER BY start_at LIMIT 500`,
    )
    .all(...params);
}

export function listReservationsForUser(
  db: Database.Database,
  userId: string,
): ReservationRow[] {
  return db
    .prepare<[string], ReservationRow>(
      `SELECT * FROM reservation
       WHERE owner_user_id = ? AND state != 'cancelled'
       ORDER BY start_at DESC LIMIT 200`,
    )
    .all(userId);
}

export function updateReservation(
  db: Database.Database,
  id: string,
  patch: { startAt?: number; endAt?: number; purpose?: string },
): ReservationRow | null {
  const current = getReservation(db, id);
  if (!current || current.state === 'cancelled') return null;
  const startAt = patch.startAt ?? current.start_at;
  const endAt = patch.endAt ?? current.end_at;
  const purpose = patch.purpose ?? current.purpose;
  db.prepare(
    `UPDATE reservation
       SET start_at = ?, end_at = ?, purpose = ?, updated_at = ?
       WHERE id = ?`,
  ).run(startAt, endAt, purpose, Date.now(), id);
  return getReservation(db, id);
}

export function cancelReservation(
  db: Database.Database,
  id: string,
): ReservationRow | null {
  const current = getReservation(db, id);
  if (!current || current.state === 'cancelled') return null;
  db.prepare(
    `UPDATE reservation SET state = 'cancelled', updated_at = ? WHERE id = ?`,
  ).run(Date.now(), id);
  return getReservation(db, id);
}

// ── User display name cache ────────────────────────────────────────────────

export function upsertUserDisplay(
  db: Database.Database,
  userId: string,
  name: string,
): void {
  db.prepare(
    `INSERT INTO user_display_cache(user_id, name, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       name = excluded.name,
       updated_at = excluded.updated_at`,
  ).run(userId, name, Date.now());
}

export function getUserDisplay(
  db: Database.Database,
  userId: string,
): string | null {
  const row = db
    .prepare<[string], UserDisplayRow>(
      `SELECT * FROM user_display_cache WHERE user_id = ?`,
    )
    .get(userId);
  return row?.name ?? null;
}

// ── Gateway registry (出席ゲートウェイ公開鍵) ────────────────────────────────

/** 会場ゲートウェイの公開鍵を upsert (lan_id が PK)。 created_at は初回のみ。 */
export function upsertGateway(
  db: Database.Database,
  args: { lanId: string; publicKeyPem: string; facilityId: string; label?: string },
): GatewayRegistryRow {
  db.prepare(
    `INSERT INTO gateway_registry (lan_id, public_key_pem, facility_id, label, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(lan_id) DO UPDATE SET
       public_key_pem = excluded.public_key_pem,
       facility_id    = excluded.facility_id,
       label          = excluded.label`,
  ).run(args.lanId, args.publicKeyPem, args.facilityId, args.label ?? '', Date.now());
  return getGateway(db, args.lanId) as GatewayRegistryRow;
}

export function getGateway(
  db: Database.Database,
  lanId: string,
): GatewayRegistryRow | null {
  return (
    db
      .prepare<[string], GatewayRegistryRow>(
        `SELECT * FROM gateway_registry WHERE lan_id = ?`,
      )
      .get(lanId) ?? null
  );
}

export function listGateways(db: Database.Database): GatewayRegistryRow[] {
  return db
    .prepare<[], GatewayRegistryRow>(
      `SELECT * FROM gateway_registry ORDER BY created_at`,
    )
    .all();
}

// ── Attendance (出席記録) ────────────────────────────────────────────────────

/**
 * 出席を記録する。 nonce は UNIQUE — 既に同じ nonce が記録済なら 'duplicate'
 * を返す (replay 検出)。 race condition でも UNIQUE 制約で原子的に弾く。
 */
export function insertAttendance(
  db: Database.Database,
  args: {
    userId: string;
    facilityId: string;
    lanId: string;
    checkedInAt: number;
    reservationId: string | null;
    nonce: string;
  },
): AttendanceRow | 'duplicate' {
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO attendance
         (id, user_id, facility_id, lan_id, checked_in_at, reservation_id, nonce, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      args.userId,
      args.facilityId,
      args.lanId,
      args.checkedInAt,
      args.reservationId,
      args.nonce,
      Date.now(),
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return 'duplicate';
    }
    throw e;
  }
  return db
    .prepare<[string], AttendanceRow>(`SELECT * FROM attendance WHERE id = ?`)
    .get(id) as AttendanceRow;
}

export function listAttendanceForUser(
  db: Database.Database,
  userId: string,
): AttendanceRow[] {
  return db
    .prepare<[string], AttendanceRow>(
      `SELECT * FROM attendance WHERE user_id = ? ORDER BY checked_in_at DESC LIMIT 200`,
    )
    .all(userId);
}

export function listAttendance(
  db: Database.Database,
  filter: { facilityId?: string; from?: number; to?: number },
): AttendanceRow[] {
  const where: string[] = ['1 = 1'];
  const params: Array<string | number> = [];
  if (filter.facilityId) {
    where.push('facility_id = ?');
    params.push(filter.facilityId);
  }
  if (typeof filter.from === 'number') {
    where.push('checked_in_at >= ?');
    params.push(filter.from);
  }
  if (typeof filter.to === 'number') {
    where.push('checked_in_at < ?');
    params.push(filter.to);
  }
  return db
    .prepare<Array<string | number>, AttendanceRow>(
      `SELECT * FROM attendance WHERE ${where.join(' AND ')}
       ORDER BY checked_in_at DESC LIMIT 500`,
    )
    .all(...params);
}

/**
 * checkedInAt 時点で有効な confirmed 予約を 1 件探す (同 user × facility)。
 * [start_at, end_at) に checkedInAt が含まれるものが対象。 無ければ null (= walk-in)。
 */
export function findMatchingReservation(
  db: Database.Database,
  userId: string,
  facilityId: string,
  checkedInAt: number,
): ReservationRow | null {
  return (
    db
      .prepare<[string, string, number, number], ReservationRow>(
        `SELECT * FROM reservation
         WHERE owner_user_id = ?
           AND facility_id = ?
           AND state = 'confirmed'
           AND start_at <= ?
           AND end_at > ?
         ORDER BY start_at DESC
         LIMIT 1`,
      )
      .get(userId, facilityId, checkedInAt, checkedInAt) ?? null
  );
}
