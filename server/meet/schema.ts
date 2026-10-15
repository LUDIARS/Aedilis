import { isPostgres, type DatabaseInput } from '../persistence/database.ts';
export function migrateMeet(db: DatabaseInput): void {
    if (isPostgres(db))
        return;
    db.exec(`
    CREATE TABLE IF NOT EXISTS meet_organizer (singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meet_group_organizer (group_kind TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(group_kind, group_id));
    CREATE TABLE IF NOT EXISTS meet_oauth_state (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL, return_path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meeting_meet (
      meeting_id TEXT PRIMARY KEY REFERENCES meeting_poll(id), organizer_id TEXT NOT NULL,
      creator_id TEXT NOT NULL, space_name TEXT, meeting_uri TEXT,
      status TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}
