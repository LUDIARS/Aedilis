import type Database from 'better-sqlite3';
export function migrateMeet(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meet_organizer (singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meet_oauth_state (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL, return_path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meeting_meet (
      meeting_id TEXT PRIMARY KEY REFERENCES meeting_poll(id), organizer_id TEXT NOT NULL,
      creator_id TEXT NOT NULL, space_name TEXT, meeting_uri TEXT,
      status TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}
