import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConnectionQueue } from './queue.ts';
import { postgresParameters } from './sql-parameters.ts';

interface TransactionContext { database: PostgresDatabase; client: PoolClient; statements: ConnectionQueue; savepoint: number }
const context = new AsyncLocalStorage<TransactionContext>();

function databaseError(error: unknown): Error & { code?: string } {
  const state = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  // Preserve only categorical codes consumed by domain duplicate handling, never PostgreSQL detail/values.
  const codes: Record<string, string> = { '23505': 'SQLITE_CONSTRAINT_UNIQUE', '23503': 'SQLITE_CONSTRAINT_FOREIGNKEY', '23514': 'SQLITE_CONSTRAINT_CHECK', '23502': 'SQLITE_CONSTRAINT_NOTNULL' };
  return Object.assign(new Error('Database operation failed'), { code: codes[state] ?? 'DATABASE_UNAVAILABLE' });
}

export class PostgresDatabase {
  readonly kind = 'postgres';
  private readonly pool: pg.Pool;
  private readonly operations = new ConnectionQueue();

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000, statement_timeout: 10_000, application_name: 'aedilis',
      types: { getTypeParser: (oid, format) => oid === 20 ? (value: string): number => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds supported range');
        return number;
      } : pg.types.getTypeParser(oid, format) },
    });
    // Pool background errors must not crash Node or expose credential-bearing connection details.
    this.pool.on('error', () => console.error('[aedilis] PostgreSQL background connection unavailable'));
  }

  private async statement(sql: string, values: unknown[]): Promise<{ rows: QueryResultRow[]; changes: number }> {
    const active = context.getStore();
    try {
      if (active?.database === this) return await active.statements.run(async () => {
        const savepoint = `aedilis_statement_${active.savepoint++}`;
        await active.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await active.client.query(postgresParameters(sql), values);
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return { rows: result.rows, changes: result.rowCount ?? 0 };
        } catch (error) {
          await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      });
      return await this.operations.run(async () => {
        const result = await this.pool.query(postgresParameters(sql), values);
        return { rows: result.rows, changes: result.rowCount ?? 0 };
      });
    } catch (error) { throw databaseError(error); }
  }

  async all<Row>(sql: string, values: unknown[]): Promise<Row[]> {
    return (await this.statement(sql, values)).rows as Row[];
  }

  async run(sql: string, values: unknown[]): Promise<{ changes: number }> {
    // Every domain write participates in the same cross-process booking lock.
    if (context.getStore()?.database === this) return { changes: (await this.statement(sql, values)).changes };
    return this.transact(async () => ({ changes: (await this.statement(sql, values)).changes }));
  }

  async transact<T>(work: () => Promise<T>): Promise<T> {
    const active = context.getStore();
    if (active?.database === this) {
      const savepoint = `aedilis_nested_${active.savepoint++}`;
      await active.statements.run(() => active.client.query(`SAVEPOINT ${savepoint}`));
      try {
        const result = await work();
        await active.statements.run(() => active.client.query(`RELEASE SAVEPOINT ${savepoint}`));
        return result;
      } catch (error) {
        await active.statements.run(() => active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`));
        await active.statements.run(() => active.client.query(`RELEASE SAVEPOINT ${savepoint}`));
        throw error;
      }
    }
    return this.operations.run(async () => {
      let client: PoolClient | undefined;
      let inDomainWork = false;
      try {
        client = await this.pool.connect();
        await client.query('BEGIN');
        // One supporting-service lock preserves existing serial transaction semantics across AWS processes.
        await client.query('SELECT pg_advisory_xact_lock(17502, 2)');
        inDomainWork = true;
        const result = await context.run({ database: this, client, statements: new ConnectionQueue(), savepoint: 0 }, work);
        inDomainWork = false;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (client) {
          try { await client.query('ROLLBACK'); }
          catch { /* A disconnected session has already rolled back; release below still owns cleanup. */ }
        }
        throw inDomainWork ? error : databaseError(error);
      } finally { client?.release(); }
    });
  }

  async close(): Promise<void> {
    await this.operations.drain();
    await this.pool.end();
  }
}
