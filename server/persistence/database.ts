import type Sqlite from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresDatabase } from './postgres.ts';
import { ConnectionQueue } from './queue.ts';

export type DatabaseInput = Sqlite.Database | PostgresDatabase;
export const isPostgres = (database: DatabaseInput): database is PostgresDatabase => database instanceof PostgresDatabase;
const sqliteContext = new AsyncLocalStorage<Sqlite.Database>();
const sqliteQueues = new WeakMap<Sqlite.Database, ConnectionQueue>();
let nextSqliteSavepoint = 0;

function queue(database: Sqlite.Database): ConnectionQueue {
  let result = sqliteQueues.get(database);
  if (!result) { result = new ConnectionQueue(); sqliteQueues.set(database, result); }
  return result;
}

function sqliteWork<T>(database: Sqlite.Database, work: () => T | Promise<T>): Promise<T> {
  return sqliteContext.getStore() === database ? Promise.resolve().then(work) : queue(database).run(work);
}

interface AsyncStatement<Bind extends unknown[], Row> {
  get(...values: Bind): Promise<Row | undefined>;
  all(...values: Bind): Promise<Row[]>;
  run(...values: Bind): Promise<{ changes: number }>;
}

export function prepare<Bind extends unknown[] = unknown[], Row = unknown>(database: DatabaseInput, sql: string): AsyncStatement<Bind, Row> {
  return {
    async all(...values): Promise<Row[]> {
      return isPostgres(database) ? database.all<Row>(sql, values) : sqliteWork(database, () => database.prepare<Bind, Row>(sql).all(...values));
    },
    async get(...values): Promise<Row | undefined> {
      if (isPostgres(database)) return (await database.all<Row>(sql, values))[0];
      return sqliteWork(database, () => database.prepare<Bind, Row>(sql).get(...values));
    },
    async run(...values): Promise<{ changes: number }> {
      if (isPostgres(database)) return database.run(sql, values);
      return sqliteWork(database, () => ({ changes: database.prepare<Bind>(sql).run(...values).changes }));
    },
  };
}

/** Both backends keep a transaction pinned through every await and exclude unrelated requests. */
export function transaction<Args extends unknown[], Result>(database: DatabaseInput, work: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
  return async (...args) => {
    if (isPostgres(database)) return database.transact(() => work(...args));
    if (sqliteContext.getStore() === database) {
      const savepoint = `aedilis_nested_${nextSqliteSavepoint++}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = await work(...args);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
    return queue(database).run(async () => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = await sqliteContext.run(database, () => work(...args));
        database.exec('COMMIT');
        return result;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    });
  };
}
