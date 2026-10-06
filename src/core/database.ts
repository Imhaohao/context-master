import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function dataDirectory(): string {
  if (process.env.CONTEXT_MASTER_DATA_DIR) return process.env.CONTEXT_MASTER_DATA_DIR;
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Context Master')
    : join(homedir(), '.local', 'share', 'context-master');
}
export function openDatabase(path?: string): DatabaseSync {
  let filename = path;
  if (!filename) {
    const dir = dataDirectory(); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    filename = join(dir, 'library.db');
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  migrate(db);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  return db;
}
function migrate(db: DatabaseSync) {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 1) throw new Error('This library was created by a newer Context Master. Update the app before opening it.');
  if (version === 1) return;
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, external_id TEXT, title TEXT NOT NULL,
      source TEXT NOT NULL, project TEXT, created_at TEXT NOT NULL, imported_at TEXT NOT NULL,
      message_count INTEGER NOT NULL, character_count INTEGER NOT NULL, redactions INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT,
      UNIQUE(session_id, ordinal)
    );
    CREATE TABLE specialists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, brief TEXT NOT NULL,
      tags TEXT NOT NULL, cli TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE specialist_sessions (
      specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
      PRIMARY KEY(specialist_id, session_id)
    );
    CREATE TABLE brief_versions (
      specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(specialist_id, revision)
    );
    CREATE TABLE consultations (
      id TEXT PRIMARY KEY, specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
      specialist_name TEXT NOT NULL, question TEXT NOT NULL, mode TEXT NOT NULL, cli TEXT NOT NULL,
      status TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL,
      context TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
      duration_ms INTEGER, brief_revision INTEGER NOT NULL, owner TEXT, heartbeat TEXT
    );
    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      type TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX messages_session ON messages(session_id, ordinal);
    CREATE INDEX consultations_created ON consultations(created_at DESC);
    CREATE VIRTUAL TABLE message_search USING fts5(text, content='messages', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER message_insert AFTER INSERT ON messages BEGIN
      INSERT INTO message_search(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER message_delete AFTER DELETE ON messages BEGIN
      INSERT INTO message_search(message_search, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    PRAGMA user_version = 1;
    COMMIT;`);
}
export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
