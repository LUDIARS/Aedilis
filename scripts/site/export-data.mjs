/** @implements SPEC-AEDILIS-PG-TRANSFER */
import Database from 'better-sqlite3';
import { resolve, join } from 'node:path';
import { captureSqlite } from './sqlite-transfer.mjs';
import { argument, writeBundle } from './transfer-file.mjs';
import { withTransferDiagnostics } from './transfer-diagnostics.mjs';

let db;
try {
  const output = argument(process.argv.slice(2), '--output');
  const directory = process.env.AEDILIS_DATA?.trim() || join(process.cwd(), 'data');
  const { bundle, hash } = await withTransferDiagnostics(process.cwd(), async step => {
    const bundle = await step('sqlite-snapshot', () => {
      db = new Database(join(resolve(directory), 'aedilis.db'), { readonly: true, fileMustExist: true });
      return captureSqlite(db, new Date().toISOString());
    });
    const hash = await step('artifact-write', () => writeBundle(output, bundle));
    return { bundle, hash };
  });
  process.stdout.write(JSON.stringify({ service: 'aedilis', version: 1, sha256: hash, tables: bundle.tables.map(t => ({ table: t.name, count: t.rows.length })) }) + '\n');
} catch {
  // Never expose SQL rows, paths containing user details, or credential-bearing exception messages.
  process.stderr.write('Ae export failed; source data was not changed.\n');
  process.exitCode = 1;
} finally { db?.close(); }
