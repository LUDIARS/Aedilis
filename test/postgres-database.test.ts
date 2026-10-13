import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ events: [] as string[], failWrite: false }));
vi.mock('pg', () => {
  class Pool {
    on(): void {}
    async connect() {
      fake.events.push('connect');
      return {
        async query(sql: string) {
          fake.events.push(sql);
          if (fake.failWrite && sql.startsWith('INSERT')) {
            fake.failWrite = false;
            throw Object.assign(new Error('private user data'), { code: '23505', detail: 'private row values' });
          }
          return { rows: sql.startsWith('SELECT value') ? [{ value: 'retained' }] : [], rowCount: 1 };
        },
        release() { fake.events.push('release'); },
      };
    }
    async query(sql: string) { fake.events.push('pool:'+sql); return { rows: [], rowCount: 0 }; }
    async end(): Promise<void> { fake.events.push('end'); }
  }
  return { default: { Pool, types: { getTypeParser: () => (value: string) => value } } };
});

import { PostgresDatabase } from '../server/persistence/postgres.ts';
import { prepare, transaction } from '../server/persistence/database.ts';

beforeEach(() => { fake.events = []; fake.failWrite = false; });

describe('PostgreSQL transaction protocol', () => {
  it('pins all statements across awaits and releases the client after commit', async () => {
    const db = new PostgresDatabase('postgresql://fixture.invalid');
    try {
      await transaction(db, async () => {
        await prepare(db, 'INSERT INTO fixture VALUES (?)').run('first');
        await Promise.resolve();
        await prepare(db, 'SELECT value FROM fixture WHERE id=?').get('first');
      })();
      expect(fake.events.filter(e => e === 'connect')).toHaveLength(1);
      expect(fake.events.some(e => e.startsWith('pool:'))).toBe(false);
      expect(fake.events).toContain('SELECT pg_advisory_xact_lock(17502, 2)');
      expect(fake.events).toContain('INSERT INTO fixture VALUES ($1)');
      expect(fake.events.at(-2)).toBe('COMMIT'); expect(fake.events.at(-1)).toBe('release');
    } finally { await db.close(); }
  });

  it('sanitizes duplicate errors, restores the statement savepoint and can commit later work', async () => {
    const db = new PostgresDatabase('postgresql://fixture.invalid');
    try {
      fake.failWrite = true;
      await transaction(db, async () => {
        await expect(prepare(db, 'INSERT INTO fixture VALUES (?)').run('duplicate')).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'Database operation failed' });
        expect(await prepare<[], { value: string }>(db, 'SELECT value FROM fixture').get()).toEqual({ value: 'retained' });
      })();
      expect(fake.events.some(e => e.startsWith('ROLLBACK TO SAVEPOINT aedilis_statement_'))).toBe(true);
      expect(fake.events).toContain('COMMIT');
      expect(fake.events.some(e => e.includes('private'))).toBe(false);
    } finally { await db.close(); }
  });

  it('rolls back and releases the connection when the domain rejects the transaction', async () => {
    const db = new PostgresDatabase('postgresql://fixture.invalid');
    try {
      await expect(transaction(db, async () => {
        await prepare(db, 'INSERT INTO fixture VALUES (?)').run('first');
        throw new Error('domain rejection');
      })()).rejects.toThrow('domain rejection');
      expect(fake.events.at(-2)).toBe('ROLLBACK'); expect(fake.events.at(-1)).toBe('release');
      expect(fake.events).not.toContain('COMMIT');
    } finally { await db.close(); }
  });
});
