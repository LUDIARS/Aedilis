import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { prepare, transaction } from '../server/persistence/database.ts';
import { postgresParameters } from '../server/persistence/sql-parameters.ts';
import { openRuntimeDatabase } from '../server/lib/database-bootstrap.ts';

const databases: Database.Database[] = [];
function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  databases.push(db);
  return db;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('async database transaction lifetime', () => {
  it('keeps unrelated reads out of an uncommitted transaction across an await', async () => {
    const db = database();
    let resume!: () => void, ready!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const writer = transaction(db, async () => {
      await prepare(db, 'INSERT INTO fixture VALUES (?,?)').run('first', 'committed');
      ready(); await paused;
    })();
    await started;
    let readFinished = false;
    const read = prepare<[], { value: string }>(db, 'SELECT value FROM fixture').all().then(rows => { readFinished = true; return rows; });
    await Promise.resolve(); expect(readFinished).toBe(false);
    resume(); await writer;
    expect(await read).toEqual([{ value: 'committed' }]);
  });

  it('rolls back writes on rejection after an await and makes the queue usable again', async () => {
    const db = database();
    await expect(transaction(db, async () => {
      await prepare(db, 'INSERT INTO fixture VALUES (?,?)').run('first', 'rolled back');
      await Promise.resolve(); throw new Error('domain rejection');
    })()).rejects.toThrow('domain rejection');
    expect(await prepare(db, 'SELECT * FROM fixture').all()).toEqual([]);
    await prepare(db, 'INSERT INTO fixture VALUES (?,?)').run('second', 'retained');
    expect(await prepare(db, 'SELECT id FROM fixture').all()).toEqual([{ id: 'second' }]);
  });

  it('rolls back a nested unit without losing the surrounding transaction', async () => {
    const db = database();
    await transaction(db, async () => {
      await prepare(db, 'INSERT INTO fixture VALUES (?,?)').run('outer', 'retained');
      await expect(transaction(db, async () => {
        await prepare(db, 'INSERT INTO fixture VALUES (?,?)').run('nested', 'rolled back');
        throw new Error('nested rejection');
      })()).rejects.toThrow('nested rejection');
    })();
    expect(await prepare(db, 'SELECT id FROM fixture').all()).toEqual([{ id: 'outer' }]);
  });
});

describe('PostgreSQL boundaries', () => {
  it('rewrites only unquoted positional markers and retains question marks in text/comments', () => {
    const source = `SELECT '?' AS "?", 'it''s ?' WHERE id=? -- ?\n AND name=? /* ? */`;
    expect(postgresParameters(source)).toBe(`SELECT '?' AS "?", 'it''s ?' WHERE id=$1 -- ?\n AND name=$2 /* ? */`);
    expect(() => postgresParameters("SELECT 'unterminated ?")).toThrow('Invalid SQL literal');
  });

  it('fails before connecting when PostgreSQL configuration is missing or targets another DB', async () => {
    await expect(openRuntimeDatabase(':memory:', { AEDILIS_DB_BACKEND: 'postgres' })).rejects.toThrow('AEDILIS_DATABASE_URL');
    await expect(openRuntimeDatabase(':memory:', { AEDILIS_DB_BACKEND: 'invalid' })).rejects.toThrow('Unsupported');
    await expect(openRuntimeDatabase(':memory:', { AEDILIS_DB_BACKEND: 'postgres', AEDILIS_DATABASE_URL: 'postgresql://other@127.0.0.1/cernere' })).rejects.toThrow('approved local database');
  });
});
