import type Database from 'better-sqlite3';

/** Additive schema only; existing reservation data is never rewritten. */
export function migrateMeetings(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_identity (
      id TEXT PRIMARY KEY, user_id TEXT, notify INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meeting_identity_user ON meeting_identity(user_id);
    CREATE TABLE IF NOT EXISTS meeting_device (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES meeting_identity(id),
      salt TEXT NOT NULL, digest TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meeting_poll (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES meeting_identity(id),
      title TEXT NOT NULL, description TEXT NOT NULL, organizer_name TEXT NOT NULL,
      slots_json TEXT NOT NULL, venues_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', selected_slot TEXT,
      revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meeting_poll_owner ON meeting_poll(owner_id);
    CREATE TABLE IF NOT EXISTS meeting_response (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meeting_poll(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES meeting_identity(id), name TEXT NOT NULL,
      comment TEXT NOT NULL, topic TEXT NOT NULL, answers_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, UNIQUE(meeting_id, owner_id)
    );
    CREATE INDEX IF NOT EXISTS meeting_response_owner ON meeting_response(owner_id);
    CREATE TABLE IF NOT EXISTS meeting_outbox (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meeting_poll(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES meeting_identity(id), event TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL, last_error TEXT, message_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meeting_outbox_due ON meeting_outbox(status, due_at);
  `);
  const columns = db.prepare('PRAGMA table_info(meeting_poll)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'online_allowed')) {
    db.exec('ALTER TABLE meeting_poll ADD COLUMN online_allowed INTEGER NOT NULL DEFAULT 0 CHECK (online_allowed IN (0,1))');
  }
}
