// db.ts のユニットテスト — 予約台帳の永続層ロジック。
// in-memory SQLite で完結する (Cernere / ネットワーク不要)。

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  cancelReservation,
  createReservation,
  findConflicts,
  getFacilityCache,
  getReservation,
  getUserDisplay,
  listReservations,
  listReservationsForUser,
  openDb,
  setFacilityOverlap,
  updateReservation,
  upsertFacilityCache,
  upsertUserDisplay,
} from '../server/db.ts';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

/** 分 → epoch ms。 テストの可読性用 (予約時刻は分丸めされる)。 */
const t = (min: number): number => min * 60_000;

function makeReservation(
  facilityId: string,
  startMin: number,
  endMin: number,
  owner = 'user-1',
) {
  return createReservation(db, {
    facilityId,
    ownerUserId: owner,
    startAt: t(startMin),
    endAt: t(endMin),
    purpose: 'test',
    state: 'confirmed',
  });
}

describe('schema', () => {
  it('creates the expected tables', () => {
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain('facility_cache');
    expect(tables).toContain('reservation');
    expect(tables).toContain('user_display_cache');
  });
});

describe('facility cache', () => {
  function upsert(id: string, allowOverlap: boolean) {
    upsertFacilityCache(db, {
      facilityId: id,
      displayName: `Facility ${id}`,
      source: 'local',
      allowOverlap,
      rawJson: '{}',
    });
  }

  it('upserts and reads a facility', () => {
    upsert('room-a', false);
    expect(getFacilityCache(db, 'room-a')?.display_name).toBe('Facility room-a');
  });

  it('keeps allow_overlap authority on re-upsert', () => {
    // 起動同期 (upsert) は allow_overlap を上書きしない — admin トグルが権威。
    upsert('room-a', true);
    expect(getFacilityCache(db, 'room-a')?.allow_overlap).toBe(1);
    upsert('room-a', false);
    expect(getFacilityCache(db, 'room-a')?.allow_overlap).toBe(1);
  });

  it('toggles the overlap flag via setFacilityOverlap', () => {
    upsert('room-a', false);
    expect(setFacilityOverlap(db, 'room-a', true)).toBe(true);
    expect(getFacilityCache(db, 'room-a')?.allow_overlap).toBe(1);
    setFacilityOverlap(db, 'room-a', false);
    expect(getFacilityCache(db, 'room-a')?.allow_overlap).toBe(0);
  });

  it('returns false when toggling an unknown facility', () => {
    expect(setFacilityOverlap(db, 'no-such-room', true)).toBe(false);
  });

  it('returns null for an uncached facility', () => {
    expect(getFacilityCache(db, 'never-seen')).toBeNull();
  });
});

describe('reservation CRUD', () => {
  it('creates and reads a reservation', () => {
    const r = makeReservation('room-a', 10, 11);
    const fetched = getReservation(db, r.id);
    expect(fetched?.id).toBe(r.id);
    expect(fetched?.state).toBe('confirmed');
    expect(fetched?.facility_id).toBe('room-a');
  });

  it('updates start/end times', () => {
    const r = makeReservation('room-a', 10, 11);
    const updated = updateReservation(db, r.id, {
      startAt: t(20),
      endAt: t(21),
    });
    expect(updated?.start_at).toBe(t(20));
    expect(updated?.end_at).toBe(t(21));
  });

  it('returns null when updating a missing reservation', () => {
    expect(updateReservation(db, 'no-such-id', { purpose: 'x' })).toBeNull();
  });

  it('returns null when updating a cancelled reservation', () => {
    const r = makeReservation('room-a', 10, 11);
    cancelReservation(db, r.id);
    expect(updateReservation(db, r.id, { purpose: 'x' })).toBeNull();
  });

  it('cancels a reservation', () => {
    const r = makeReservation('room-a', 10, 11);
    expect(cancelReservation(db, r.id)?.state).toBe('cancelled');
  });

  it('returns null when cancelling an already-cancelled reservation', () => {
    const r = makeReservation('room-a', 10, 11);
    cancelReservation(db, r.id);
    expect(cancelReservation(db, r.id)).toBeNull();
  });
});

describe('findConflicts — overlap detection', () => {
  it('detects an overlapping reservation', () => {
    makeReservation('room-a', 10, 12);
    expect(findConflicts(db, 'room-a', t(11), t(13))).toHaveLength(1);
  });

  it('treats adjacent intervals as non-conflicting', () => {
    // [10,12) と [12,14) は端が接するだけ — 重ならない。
    makeReservation('room-a', 10, 12);
    expect(findConflicts(db, 'room-a', t(12), t(14))).toHaveLength(0);
  });

  it('ignores reservations on a different facility', () => {
    makeReservation('room-a', 10, 12);
    expect(findConflicts(db, 'room-b', t(10), t(12))).toHaveLength(0);
  });

  it('ignores cancelled reservations', () => {
    const r = makeReservation('room-a', 10, 12);
    cancelReservation(db, r.id);
    expect(findConflicts(db, 'room-a', t(11), t(13))).toHaveLength(0);
  });

  it('excludes the reservation named by excludeId', () => {
    // 自分自身の時刻変更で「自分と衝突」と誤検知しないこと。
    const r = makeReservation('room-a', 10, 12);
    expect(findConflicts(db, 'room-a', t(10), t(12), r.id)).toHaveLength(0);
  });
});

describe('listReservations', () => {
  it('filters by facility', () => {
    makeReservation('room-a', 10, 12);
    makeReservation('room-b', 10, 12);
    const rows = listReservations(db, { facilityId: 'room-a' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.facility_id).toBe('room-a');
  });

  it('filters by time window', () => {
    makeReservation('room-a', 10, 12);
    const later = makeReservation('room-a', 100, 102);
    const rows = listReservations(db, { from: t(50), to: t(200) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(later.id);
  });

  it('excludes cancelled reservations', () => {
    const r = makeReservation('room-a', 10, 12);
    cancelReservation(db, r.id);
    expect(listReservations(db, {})).toHaveLength(0);
  });
});

describe('listReservationsForUser', () => {
  it('returns only the given user reservations', () => {
    makeReservation('room-a', 10, 12, 'alice');
    makeReservation('room-a', 20, 22, 'bob');
    const rows = listReservationsForUser(db, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner_user_id).toBe('alice');
  });

  it('excludes cancelled reservations', () => {
    const r = makeReservation('room-a', 10, 12, 'alice');
    cancelReservation(db, r.id);
    expect(listReservationsForUser(db, 'alice')).toHaveLength(0);
  });
});

describe('user display cache', () => {
  it('upserts and reads a display name', () => {
    upsertUserDisplay(db, 'alice', 'Alice');
    expect(getUserDisplay(db, 'alice')).toBe('Alice');
  });

  it('updates the name on re-upsert', () => {
    upsertUserDisplay(db, 'alice', 'Alice');
    upsertUserDisplay(db, 'alice', 'Alice Cooper');
    expect(getUserDisplay(db, 'alice')).toBe('Alice Cooper');
  });

  it('returns null for an unknown user', () => {
    expect(getUserDisplay(db, 'nobody')).toBeNull();
  });
});
