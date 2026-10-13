import { PG_TYPES, defaultLiteral, identifier, predicate, validateBundle } from './transfer-format.mjs';

function creationOrder(tables) {
  const result = [], remaining = [...tables];
  while (remaining.length) {
    const i = remaining.findIndex(t => t.foreignKeys.every(k => k.table === t.name || result.some(p => p.name === k.table)));
    if (i < 0) throw new Error('cyclic_schema_not_supported');
    result.push(remaining.splice(i, 1)[0]);
  }
  return result;
}

function createTable(table) {
  const definitions = table.columns.map(c => `${identifier(c.name)} ${PG_TYPES[c.type]}${c.notnull ? ' NOT NULL' : ''}${defaultLiteral(c.default)}`);
  const primary = table.columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
  definitions.push(`PRIMARY KEY (${primary.map(c => identifier(c.name)).join(',')})`);
  for (const check of table.checks) definitions.push(`CHECK (${predicate(check)})`);
  for (const key of table.foreignKeys) definitions.push(`FOREIGN KEY (${key.columns.map(identifier).join(',')}) REFERENCES public.${identifier(key.table)} (${key.parentColumns.map(identifier).join(',')}) ON DELETE ${key.onDelete} ON UPDATE ${key.onUpdate} DEFERRABLE INITIALLY DEFERRED`);
  return `CREATE TABLE IF NOT EXISTS public.${identifier(table.name)} (${definitions.join(',')})`;
}

export function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_number');
    return String(value);
  }
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid_literal');
  return `'${value.replaceAll("'", "''")}'`;
}

function guard(body) {
  // Personal text can contain arbitrary dollar delimiters; select one absent from the entire body.
  let i = 0, tag;
  do { tag = `$aedilis_guard_${i++}$`; } while (body.includes(tag));
  return `DO ${tag}\nBEGIN\n${body}\nEND\n${tag};`;
}

/** Generate a single psql transaction; the server performs exact typed-row multiset comparisons. */
export function postgresProgram(input, hash, importedAt) {
  const bundle = validateBundle(input);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid_hash');
  const statements = ['BEGIN;', "SET LOCAL lock_timeout = '10s';", "SET LOCAL statement_timeout = '30s';", 'SET LOCAL standard_conforming_strings = on;', 'SELECT pg_advisory_xact_lock(17502, 1);'];
  statements.push(guard(`IF current_database() <> 'aedilis' OR current_user <> 'aedilis_app' THEN RAISE EXCEPTION 'unexpected_target_database'; END IF;
IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f','S')) THEN RAISE EXCEPTION 'target_not_empty'; END IF;`));
  const tables = creationOrder(bundle.tables);
  for (const table of tables) {
    statements.push(createTable(table) + ';');
    for (const index of table.indexes) {
      statements.push(`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${identifier(index.name)} ON public.${identifier(table.name)} (${index.columns.map(identifier).join(',')})${index.where ? ` WHERE ${predicate(index.where)}` : ''};`);
    }
  }
  for (const table of tables) {
    const prefix = `INSERT INTO public.${identifier(table.name)} (${table.columns.map(c => identifier(c.name)).join(',')}) VALUES `;
    for (const row of table.rows) statements.push(prefix + `(${row.map(sqlLiteral).join(',')});`);
  }
  const verification = [];
  for (const table of tables) {
    const fields = table.columns.map(c => c.type === 'INTEGER' ? `${identifier(c.name)}::text` : identifier(c.name)).join(',');
    const expected = sqlLiteral(JSON.stringify(table.rows));
    const actual = `SELECT jsonb_build_array(${fields}) AS value FROM public.${identifier(table.name)}`;
    const source = `SELECT value FROM jsonb_array_elements(${expected}::jsonb)`;
    statements.push(guard(`IF (SELECT count(*) FROM public.${identifier(table.name)}) <> ${table.rows.length}
OR EXISTS ((${actual}) EXCEPT ALL (${source}))
OR EXISTS ((${source}) EXCEPT ALL (${actual}))
THEN RAISE EXCEPTION 'destination_verification_failed'; END IF;`));
    verification.push({ table: table.name, count: table.rows.length, digest: table.digest });
  }
  statements.push('SET CONSTRAINTS ALL IMMEDIATE;',
    'CREATE TABLE IF NOT EXISTS public.aedilis_transfer_receipt (artifact_sha256 TEXT PRIMARY KEY, imported_at TEXT NOT NULL, source_created_at TEXT NOT NULL, verification_json TEXT NOT NULL);',
    `INSERT INTO public.aedilis_transfer_receipt VALUES (${[hash, importedAt, bundle.createdAt, JSON.stringify(verification)].map(sqlLiteral).join(',')});`,
    'COMMIT;',
    `SELECT json_build_object('service','aedilis','target','postgresql','verified',true,'sha256',artifact_sha256,'tables',verification_json::jsonb) FROM public.aedilis_transfer_receipt WHERE artifact_sha256=${sqlLiteral(hash)};`);
  return statements.join('\n');
}
