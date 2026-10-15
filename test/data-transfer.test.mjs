import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TABLES, checksFromSql, predicate, rowDigest, validateBundle } from '../scripts/site/transfer-format.mjs';
import { captureSqlite } from '../scripts/site/sqlite-transfer.mjs';
import { postgresProgram, sqlLiteral } from '../scripts/site/postgres-transfer.mjs';

function fixture() {
  const db = new Database(':memory:');
  try {
    for (const table of TABLES) {
      if (table === 'meeting_identity') db.exec('CREATE TABLE meeting_identity (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
      else if (table === 'meeting_poll') db.exec("CREATE TABLE meeting_poll (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES meeting_identity(id), title TEXT NOT NULL, online_allowed INTEGER NOT NULL DEFAULT 0 CHECK (online_allowed IN (0,1)))");
      else if (table === 'meeting_response') db.exec('CREATE TABLE meeting_response (id TEXT PRIMARY KEY, meeting_id TEXT REFERENCES meeting_poll(id) ON DELETE CASCADE, owner_id TEXT REFERENCES meeting_identity(id), UNIQUE(meeting_id,owner_id))');
      else db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
    }
    db.prepare('INSERT INTO meeting_identity VALUES (?,?)').run('owner', 9223372036854775806n);
    db.prepare('INSERT INTO meeting_poll VALUES (?,?,?,?)').run('poll', 'owner', "日本語 ' newline\n", 0);
    db.prepare('INSERT INTO meeting_response VALUES (?,?,?)').run('response', 'poll', 'owner');
    return captureSqlite(db, '2026-10-13T00:00:00.000Z');
  } finally { db.close(); }
}

describe('Ae SQLite to PostgreSQL transfer', () => {
  it('preserves Unicode, 64-bit integers, CHECKs, unique indexes and cascaded relationships', () => {
    const bundle = fixture();
    const identity = bundle.tables.find(t => t.name === 'meeting_identity');
    expect(identity.rows[0][1]).toBe('9223372036854775806');
    const response = bundle.tables.find(t => t.name === 'meeting_response');
    expect(response.foreignKeys.find(k => k.table === 'meeting_poll').onDelete).toBe('CASCADE');
    expect(response.indexes.some(i => i.unique && i.columns.join(',') === 'meeting_id,owner_id')).toBe(true);
    expect(bundle.tables.find(t => t.name === 'meeting_poll').checks).toEqual(['online_allowed IN (0,1)']);
    expect(validateBundle(bundle)).toBe(bundle);
  });

  it('rejects changed values even when table counts still match', () => {
    const bundle = fixture();
    bundle.tables.find(t => t.name === 'meeting_poll').rows[0][2] = 'changed';
    expect(() => validateBundle(bundle)).toThrow('row_digest_mismatch');
  });

  it('rejects SQL predicates outside the reviewed dialect mapping', () => {
    expect(checksFromSql('CREATE TABLE t (value TEXT CHECK(json_valid(online_json)))')).toEqual(['json_valid(online_json)']);
    expect(predicate('json_valid(online_json)')).toBe('(online_json::jsonb IS NOT NULL)');
    expect(() => checksFromSql('CREATE TABLE t (n INTEGER CHECK(random() > 0))')).toThrow('unsupported_predicate');
    expect(() => predicate("state != 'cancelled'; DROP TABLE reservation")).toThrow('unsupported_predicate');
  });

  it('rejects site OAuth credentials instead of replicating them silently', () => {
    const bundle = fixture();
    const oauth = bundle.tables.find(t => t.name === 'meet_oauth_state');
    oauth.rows.push(['sensitive-state']); oauth.digest = rowDigest(oauth, oauth.rows);
    expect(() => validateBundle(bundle)).toThrow('site_credentials_require_separate_migration');
  });

  it('rejects content that could escape a SQL literal or a procedural dollar delimiter', () => {
    expect(sqlLiteral("' ; DROP TABLE reservation; --\\")).toBe("''' ; DROP TABLE reservation; --\\'");
    const bundle = fixture(), table = bundle.tables.find(t => t.name === 'meeting_poll');
    table.rows[0][2] = "$aedilis_guard_0$; ' 日本語";
    table.digest = rowDigest(table, table.rows);
    const program = postgresProgram(bundle, 'a'.repeat(64), '2026-10-13T00:00:00Z');
    expect(program).toContain('DO $aedilis_guard_1$');
    expect(program).toContain('SET LOCAL standard_conforming_strings = on;');
    expect(() => sqlLiteral('invalid\0text')).toThrow('invalid_literal');
  });

  it('rejects forged schema identifiers and source ownership before producing SQL', () => {
    const bundle = fixture();
    bundle.tables[0].columns[0].name = 'id); DROP TABLE t; --';
    expect(() => postgresProgram(bundle, 'a'.repeat(64), '2026-10-13T00:00:00Z')).toThrow('invalid_identifier');
    expect(() => validateBundle({ ...fixture(), service: 'cernere' })).toThrow('invalid_bundle');
  });

  it('places target guards and exact multiset checks inside the transaction before COMMIT', () => {
    const sql = postgresProgram(fixture(), 'a'.repeat(64), '2026-10-13T00:00:00Z');
    expect(sql.startsWith('BEGIN;')).toBe(true);
    expect(sql.indexOf('target_not_empty')).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql.indexOf("current_database() <> 'aedilis'")).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql.match(/EXCEPT ALL/g)).toHaveLength(TABLES.length * 2);
    expect(sql.indexOf('SET CONSTRAINTS ALL IMMEDIATE')).toBeLessThan(sql.indexOf('INSERT INTO public.aedilis_transfer_receipt'));
    expect(sql.indexOf('INSERT INTO public.aedilis_transfer_receipt')).toBeLessThan(sql.indexOf('COMMIT;'));
    expect(sql.indexOf('COMMIT;')).toBeLessThan(sql.indexOf('SELECT json_build_object'));
  });
});
