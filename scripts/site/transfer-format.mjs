import { createHash } from 'node:crypto';

export const TABLES = Object.freeze([
  'facility_cache', 'reservation', 'user_display_cache', 'gateway_registry',
  'attendance', 'checkin_event_summary', 'gps_checkin_photo', 'meeting_identity',
  'meeting_device', 'meeting_poll', 'meeting_response', 'meeting_outbox',
  'meet_organizer', 'meet_group_organizer', 'meet_external_space', 'meet_oauth_state', 'meeting_meet', 'booking_audience',
  'meeting_facility_reservation', 'meeting_discord_respondent',
]);
export const MAX_BYTES = 64 * 1024 * 1024;
export const PG_TYPES = Object.freeze({ INTEGER: 'BIGINT', REAL: 'DOUBLE PRECISION', TEXT: 'TEXT' });

// Only current Ae predicates can cross the SQL dialect boundary. Unknown schema fails closed.
const predicates = new Map([
  ['online_allowed IN (0,1)', 'online_allowed IN (0,1)'],
  ['guest_responses IN (0,1)', 'guest_responses IN (0,1)'],
  ['default_online IN (0,1)', 'default_online IN (0,1)'],
  ['json_valid(online_json)', '(online_json::jsonb IS NOT NULL)'],
  ['singleton=1', 'singleton=1'],
  ["resource_type IN ('reservation','meeting')", "resource_type IN ('reservation','meeting')"],
  ["visibility IN ('public','internal','private')", "visibility IN ('public','internal','private')"],
  ["group_kind IN ('organization','team')", "group_kind IN ('organization','team')"],
  ["visibility != 'internal' OR (group_kind IS NOT NULL AND group_id IS NOT NULL)",
    "visibility != 'internal' OR (group_kind IS NOT NULL AND group_id IS NOT NULL)"],
  ["state != 'cancelled'", "state != 'cancelled'"],
]);

export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('invalid_identifier');
  return `"${value}"`;
}

export function predicate(value) {
  const result = predicates.get(value?.trim().replace(/\s+/g, ' '));
  if (!result) throw new Error('unsupported_predicate');
  return result;
}

export function defaultLiteral(value) {
  if (value === null) return '';
  if (typeof value !== 'string' || !/^(?:NULL|-?\d+(?:\.\d+)?|'(?:[^']|'')*')$/.test(value)) throw new Error('unsupported_default');
  return ` DEFAULT ${value}`;
}

export function checksFromSql(sql) {
  const checks = [];
  const pattern = /\bCHECK\s*\(/gi;
  for (let match; (match = pattern.exec(sql));) {
    let depth = 1, quoted = false, end = pattern.lastIndex;
    for (; end < sql.length && depth > 0; end++) {
      const c = sql[end];
      if (c === "'") {
        if (quoted && sql[end + 1] === "'") { end++; continue; }
        quoted = !quoted;
      } else if (!quoted) {
        if (c === '(') depth++;
        if (c === ')') depth--;
      }
    }
    if (depth !== 0 || quoted) throw new Error('invalid_check');
    const source = sql.slice(pattern.lastIndex, end - 1).trim().replace(/\s+/g, ' ');
    predicate(source);
    checks.push(source);
    pattern.lastIndex = end;
  }
  return checks;
}

export function normalizedRow(table, row) {
  if (!Array.isArray(row) || row.length !== table.columns.length) throw new Error('invalid_row');
  return row.map((value, i) => {
    if (value === null) return null;
    const type = table.columns[i].type;
    if (type === 'INTEGER') {
      if (typeof value !== 'string' || !/^-?\d+$/.test(value) || BigInt(value) < -(2n ** 63n) || BigInt(value) >= 2n ** 63n) throw new Error('invalid_integer');
      return BigInt(value).toString();
    }
    if (type === 'REAL') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid_real');
      return value;
    }
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid_text');
    return value;
  });
}

// Sorting complete typed rows avoids backend-specific collation and row ordering.
export function rowDigest(table, rows) {
  return createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(normalizedRow(table, row))).sort())).digest('hex');
}

export function validateBundle(bundle) {
  if (bundle?.service !== 'aedilis' || bundle?.version !== 1 || bundle?.source !== 'sqlite' || !Array.isArray(bundle.tables)) throw new Error('invalid_bundle');
  const names = bundle.tables.map(t => t.name);
  if (names.length !== TABLES.length || new Set(names).size !== names.length || TABLES.some(name => !names.includes(name))) throw new Error('unexpected_tables');
  for (const table of bundle.tables) {
    identifier(table.name);
    if (!Array.isArray(table.columns) || !table.columns.length || !Array.isArray(table.rows) || !Array.isArray(table.indexes) || !Array.isArray(table.foreignKeys) || !Array.isArray(table.checks)) throw new Error('invalid_table');
    const columns = table.columns.map(c => c.name);
    if (new Set(columns).size !== columns.length) throw new Error('duplicate_column');
    for (const column of table.columns) {
      identifier(column.name);
      if (!Object.hasOwn(PG_TYPES, column.type) || !Number.isInteger(column.pk) || column.pk < 0 || ![0, 1].includes(column.notnull)) throw new Error('unsupported_column');
      defaultLiteral(column.default);
    }
    if (!table.columns.some(c => c.pk > 0)) throw new Error('missing_primary_key');
    for (const check of table.checks) predicate(check);
    for (const index of table.indexes) {
      identifier(index.name);
      if (typeof index.unique !== 'boolean' || !Array.isArray(index.columns) || !index.columns.length || index.columns.some(c => !columns.includes(c))) throw new Error('invalid_index');
      if (index.where !== null) predicate(index.where);
    }
    for (const key of table.foreignKeys) {
      const parent = bundle.tables.find(t => t.name === key.table);
      if (!parent || !Array.isArray(key.columns) || !key.columns.length || !Array.isArray(key.parentColumns) || key.columns.length !== key.parentColumns.length || key.columns.some(c => !columns.includes(c)) || key.parentColumns.some(c => !parent.columns.some(p => p.name === c))) throw new Error('invalid_foreign_key');
      if (!['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT'].includes(key.onDelete) || !['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT'].includes(key.onUpdate)) throw new Error('invalid_foreign_key_action');
    }
    if (rowDigest(table, table.rows) !== table.digest) throw new Error('row_digest_mismatch');
  }
  // OAuth verifiers and site gateway authorization cannot be carried to another site.
  if (bundle.tables.find(t => t.name === 'meet_oauth_state').rows.length || bundle.tables.find(t => t.name === 'gateway_registry').rows.length) throw new Error('site_credentials_require_separate_migration');
  // Meeting browser IDs are ownership records, not host identities. Transfer only salted hashes.
  const devices = bundle.tables.find(t => t.name === 'meeting_device');
  const salt = devices.columns.findIndex(c => c.name === 'salt');
  const digest = devices.columns.findIndex(c => c.name === 'digest');
  if (devices.rows.some(row => !/^[a-f0-9]{32}$/.test(row[salt]) || !/^[a-f0-9]{64}$/.test(row[digest]))) throw new Error('invalid_browser_ownership_hash');
  return bundle;
}
