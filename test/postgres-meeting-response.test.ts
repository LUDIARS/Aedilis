import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ meetingId: 'existing-meeting', responses: [
  { id: 'answer-one', meeting_id: 'existing-meeting', answers_json: '{"slot":"yes"}' },
  { id: 'answer-two', meeting_id: 'existing-meeting', answers_json: '{"slot":"maybe"}' },
] }));

vi.mock('pg', () => ({ default: {
  types: { getTypeParser: () => (value: string) => value },
  Pool: class {
    on(): void {}
    async query(sql: string, values: unknown[]) {
      // PostgreSQL does not provide SQLite's implicit rowid column.
      if (/\browid\b/.test(sql)) throw Object.assign(new Error('undefined column'), { code: '42703' });
      if (!sql.includes('FROM meeting_response WHERE meeting_id = $1')) throw new Error('unexpected query');
      return { rows: values[0] === fixture.meetingId ? fixture.responses : [], rowCount: 2 };
    }
    async end(): Promise<void> {}
  },
} }));

import { PostgresDatabase } from '../server/persistence/postgres.ts';
import { MeetingRepository } from '../server/meetings/repository.ts';

it('reads existing PostgreSQL meeting answers without an implicit SQLite column', async () => {
  const db = new PostgresDatabase('postgresql://fixture.invalid');
  try {
    const repository = new MeetingRepository(db);
    expect(await repository.responses(fixture.meetingId)).toEqual(fixture.responses);
    expect(await repository.responses('another-meeting')).toEqual([]);
  } finally { await db.close(); }
});
