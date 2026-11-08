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

    -- Persistent queue of remote moves and deletes (rename a session, move shots, mirror deletes). A finished op removes its row.
    CREATE TABLE IF NOT EXISTS remote_ops (id INTEGER PRIMARY KEY, dest_id TEXT NOT NULL, op TEXT NOT NULL, src TEXT NOT NULL, dst TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER NOT NULL, UNIQUE(dest_id, op, src));

    -- Local cache of each session folder's .shotdrop.json; a library rescan rebuilds it from disk.
    CREATE TABLE IF NOT EXISTS sessions (folder TEXT PRIMARY KEY, id TEXT UNIQUE, name TEXT, client TEXT, notes TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    -- Last known listing of each remote folder (Browse). Rebuilt from the provider on every live list.
    CREATE TABLE IF NOT EXISTS remote_entries (
      dest_id TEXT, path TEXT, name TEXT, dir INTEGER, size INTEGER, mtime INTEGER, kind TEXT, seen_at INTEGER,
      PRIMARY KEY(dest_id, path)
    );
    -- Import and copy jobs (Browse). Their file lists live in memory; a restart marks unfinished ones as interrupted.
    CREATE TABLE IF NOT EXISTS transfer_jobs (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, dest_id TEXT NOT NULL, to_dest_id TEXT,
      total INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL
    );
  `)
  // Session meta of a found folder, as JSON on the folder's own row.
  try {
    db.exec(`ALTER TABLE remote_entries ADD COLUMN meta_json TEXT`)
  } catch {
    /* already there */
  }
  // Columns added after v0.1; CREATE TABLE IF NOT EXISTS won't add them to an existing library.
  for (const col of ['hist TEXT', 'clipped REAL', 'dark REAL', 'sharpness REAL', 'hash TEXT', 'faces INTEGER', 'blink REAL']) {
    try {
      db.exec(`ALTER TABLE shots ADD COLUMN ${col}`)
    } catch {
      /* already there */
    }
  }
  // Anything left "running" from a previous crash goes back to the queue.
  db.prepare(`UPDATE sync_jobs SET status = 'pending' WHERE status = 'running'`).run()
  db.prepare(`UPDATE transfer_jobs SET status = 'error', error = 'Interrupted by a restart' WHERE status = 'running'`).run()
  // remote_deletes moved into remote_ops (op = 'delete'); the old table is dropped in the same transaction as the copy.
  db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'remote_deletes'`).get()) return
    db.exec(`INSERT OR IGNORE INTO remote_ops (dest_id, op, src, status, attempts, error, updated_at)
             SELECT dest_id, 'delete', rel_path, CASE WHEN status = 'error' THEN 'error' ELSE 'pending' END, attempts, error, updated_at FROM remote_deletes`)
    db.exec('DROP TABLE remote_deletes')
  })()
  db.prepare(`UPDATE remote_ops SET status = 'pending' WHERE status = 'running'`).run()
  return db
}
