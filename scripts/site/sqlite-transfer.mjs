import { TABLES, checksFromSql, identifier, rowDigest, validateBundle } from './transfer-format.mjs';

/** Capture the service-owned schema and values in one consistent read transaction. */
export function captureSqlite(db, createdAt) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('source_integrity_failed');
  db.defaultSafeIntegers(true);
  return db.transaction(() => {
    if (db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type IN ('trigger','view')").get().n !== 0n) throw new Error('unsupported_source_objects');
    const schemas = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (schemas.length !== TABLES.length || schemas.some(t => !TABLES.includes(t.name))) throw new Error('unexpected_source_tables');
    const tables = schemas.map(({ name, sql }) => {
      const columns = db.prepare(`PRAGMA table_info(${identifier(name)})`).all().map(c => ({
        name: c.name, type: c.type, notnull: Number(c.notnull), default: c.dflt_value, pk: Number(c.pk),
      }));
      const indexes = db.prepare(`PRAGMA index_list(${identifier(name)})`).all().filter(i => i.origin !== 'pk').map((index, ordinal) => {
        const info = db.prepare(`PRAGMA index_info(${identifier(index.name)})`).all();
        if (info.some(c => c.name === null)) throw new Error('expression_index_not_supported');
        const original = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(index.name)?.sql;
        const where = index.partial ? original?.match(/\bWHERE\s+([\s\S]+)$/i)?.[1]?.trim() : null;
        if (index.partial && !where) throw new Error('unsupported_partial_index');
        return { name: index.origin === 'u' ? `${name}_transfer_unique_${ordinal}` : index.name,
          unique: Number(index.unique) === 1, columns: info.map(c => c.name), where };
      });
      const keys = new Map();
      for (const key of db.prepare(`PRAGMA foreign_key_list(${identifier(name)})`).all()) {
        const id = Number(key.id);
        if (!keys.has(id)) keys.set(id, { table: key.table, columns: [], parentColumns: [], onDelete: key.on_delete, onUpdate: key.on_update });
        const grouped = keys.get(id);
        grouped.columns[Number(key.seq)] = key.from;
        grouped.parentColumns[Number(key.seq)] = key.to;
      }
      const rows = db.prepare(`SELECT ${columns.map(c => identifier(c.name)).join(',')} FROM ${identifier(name)}`).raw().all().map(row => row.map(v => typeof v === 'bigint' ? v.toString() : v));
      const table = { name, columns, indexes, foreignKeys: [...keys.values()], checks: checksFromSql(sql), rows };
      return { ...table, digest: rowDigest(table, rows) };
    });
    return validateBundle({ service: 'aedilis', version: 1, source: 'sqlite', createdAt, tables });
  })();
}
