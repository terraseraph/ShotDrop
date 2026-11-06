import Database from 'better-sqlite3'
import { join } from 'node:path'

export type DB = Database.Database

export function openDb(dataDir: string): DB {
  const db = new Database(join(dataDir, 'library.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS shots (
      id           INTEGER PRIMARY KEY,
      key          TEXT NOT NULL UNIQUE,      -- session/name (lowercase), groups RAW+JPEG
      session      TEXT NOT NULL,
      name         TEXT NOT NULL,
      captured_at  INTEGER NOT NULL,
      imported_at  INTEGER NOT NULL,
      camera       TEXT, lens TEXT, iso INTEGER, shutter TEXT, aperture REAL, focal_length REAL,
      width        INTEGER, height INTEGER, orientation INTEGER,
      rating       INTEGER NOT NULL DEFAULT 0,
      flag         INTEGER NOT NULL DEFAULT 0,
      label        TEXT,
      source       TEXT,
      preview_file_id INTEGER,
      has_preview  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS shots_captured ON shots(captured_at);
    CREATE INDEX IF NOT EXISTS shots_session ON shots(session);

    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY,
      shot_id     INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      path        TEXT NOT NULL UNIQUE,
      rel_path    TEXT NOT NULL,              -- relative to library dir, used for sync targets
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      hash        TEXT NOT NULL UNIQUE,
      imported_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_shot ON files(shot_id);

    CREATE TABLE IF NOT EXISTS sync_jobs (
      id         INTEGER PRIMARY KEY,
      file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      dest_id    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      attempts   INTEGER NOT NULL DEFAULT 0,
      error      TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(file_id, dest_id)
    );
    CREATE INDEX IF NOT EXISTS sync_status ON sync_jobs(status);
  `)
  // Anything left "running" from a previous crash goes back to the queue.
  db.prepare(`UPDATE sync_jobs SET status = 'pending' WHERE status = 'running'`).run()
  return db
}
