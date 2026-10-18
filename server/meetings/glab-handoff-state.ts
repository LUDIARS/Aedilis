import { prepare, type DatabaseInput } from '../persistence/database.ts';
import { MeetingError } from './types.ts';

/** The immutable snapshot survives cancellation so a lost reply never creates a second event. */
export const GLAB_HANDOFF_SCHEMA = `CREATE TABLE IF NOT EXISTS meeting_glab_handoff (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_poll(id), snapshot_json TEXT NOT NULL
)`;

export async function glabHandoff(db: DatabaseInput, id: string): Promise<string | null> {
  const row = await prepare<unknown[], { snapshot_json: string }>(db,
    'SELECT snapshot_json FROM meeting_glab_handoff WHERE meeting_id=?').get(id);
  return row?.snapshot_json ?? null;
}

export async function requireLocalMeeting(db: DatabaseInput, id: string): Promise<void> {
  if (await glabHandoff(db, id)) {
    throw new MeetingError(409, 'GLABの予定に引き継いだ会議です。中止はGLABの予定から行ってください');
  }
}
