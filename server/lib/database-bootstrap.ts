import { openDb } from '../db.ts';
import { migrateMeetings } from '../meetings/schema.ts';
import { migrateMeet } from '../meet/schema.ts';
import { ensureBookingAccessSchema } from '../booking-access/policy.ts';
import { type DatabaseInput } from '../persistence/database.ts';
import { PostgresDatabase } from '../persistence/postgres.ts';

/** Verify the transferred schema against the same service-owned schema used by HQ and tests. */
async function verifyPostgres(database: PostgresDatabase): Promise<void> {
  const identity = (await database.all<{ database: string; role: string }>('SELECT current_database() AS database, current_user AS role', []))[0];
  if (identity?.database !== 'aedilis' || identity.role !== 'aedilis_app') throw new Error('Ae PostgreSQL database or role does not match the approved target');
  const reference = openDb(':memory:');
  try {
    migrateMeetings(reference); migrateMeet(reference); ensureBookingAccessSchema(reference);
    const tables = reference.prepare<[], { name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const actual = await database.all<{ table_name: string; column_name: string; udt_name: string }>("SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema='public'", []);
    const types: Record<string, string> = { INTEGER: 'int8', TEXT: 'text', REAL: 'float8' };
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table.name)) throw new Error('Invalid service-owned schema identifier');
      const columns = reference.prepare<[], { name: string; type: string }>(`PRAGMA table_info(${table.name})`).all();
      for (const column of columns) {
        if (!actual.some(c => c.table_name === table.name && c.column_name === column.name && c.udt_name === types[column.type])) {
          throw new Error('Ae PostgreSQL schema is incomplete; apply the approved service migration before starting');
        }
      }
    }
    const receipt = await database.all<{ artifact_sha256: string }>('SELECT artifact_sha256 FROM aedilis_transfer_receipt LIMIT 1', []);
    if (!receipt[0] || !/^[a-f0-9]{64}$/.test(receipt[0].artifact_sha256)) throw new Error('Ae PostgreSQL data transfer receipt is missing');
  } finally { reference.close(); }
}

export async function openRuntimeDatabase(sqlitePath: string, environment: NodeJS.ProcessEnv): Promise<DatabaseInput> {
  const backend = environment.AEDILIS_DB_BACKEND?.trim() || 'sqlite';
  if (backend === 'sqlite') return openDb(sqlitePath);
  if (backend !== 'postgres') throw new Error('Unsupported AEDILIS_DB_BACKEND');
  let url: URL;
  try { url = new URL(environment.AEDILIS_DATABASE_URL || ''); }
  catch { throw new Error('AEDILIS_DATABASE_URL is required for the PostgreSQL backend'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/aedilis' || decodeURIComponent(url.username) !== 'aedilis_app') throw new Error('Ae PostgreSQL connection must use the approved local database and role');
  const database = new PostgresDatabase(url.toString());
  try { await verifyPostgres(database); return database; }
  catch (error) { await database.close(); throw error; }
}
