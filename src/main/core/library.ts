import type { DB } from './db'
import type { FileKind, Flag, Label, Session, Shot, ShotPatch, SyncStatus } from '@shared/types'
import type { LumaStats } from './media'
import type { SessionMeta } from '@shared/remote'

/** Hidden anchor shots (one per session, holding its .shotdrop.json for sync) have dot names; real photos never do. */
const REAL = `name NOT LIKE '.%'`
export const isAnchorName = (name: string): boolean => name.startsWith('.')

interface ShotRow {
  id: number
  session: string
  name: string
  captured_at: number
  imported_at: number
  camera: string | null
  lens: string | null
  iso: number | null
  shutter: string | null
  aperture: number | null
  focal_length: number | null
  width: number | null
  height: number | null
  rating: number
  flag: number
  label: string | null
  source: string | null
  has_preview: number
  hist: string | null
  clipped: number | null
  dark: number | null
  sharpness: number | null
  hash: string | null
  faces: number | null
  blink: number | null
}

export interface RemoteOpRow {
  id: number
  dest_id: string
  op: 'move' | 'delete'
  src: string
  dst: string | null
  status: 'pending' | 'running' | 'error'
  attempts: number
  error: string | null
}

export interface FileRow {
  id: number
  shot_id: number
  path: string
  rel_path: string
  name: string
  kind: FileKind
  size: number
  hash: string
}

export interface ShotQuery {
  session?: string
  source?: string
  minRating?: number
  flag?: Flag | 'notRejected'
  label?: string
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface NewShot {
  key: string
  session: string
  name: string
  capturedAt: number
  camera: string | null
  lens: string | null
  iso: number | null
  shutter: string | null
  aperture: number | null
  focalLength: number | null
  width: number | null
  height: number | null
  orientation: number | null
  source: string | null
}

interface SessionCacheRow {
  folder: string
  id: string
  name: string | null
  client: string | null
  notes: string | null
  created_by: string | null
  created_at: number | null
  updated_at: number | null
}

function cacheToMeta(r: SessionCacheRow): SessionMeta {
  const m: SessionMeta = {
    schema: 1,
    id: r.id,
    name: r.name ?? '',
    date: /^\d{4}-\d{2}-\d{2}/.exec(r.folder)?.[0] ?? '',
    createdBy: r.created_by ?? '',
    createdAt: r.created_at ?? 0,
    updatedAt: r.updated_at ?? 0
  }
  if (r.client) m.client = r.client
  if (r.notes) m.notes = r.notes
  return m
}

const KIND_RANK: Record<FileKind, number> = { jpeg: 0, heif: 1, raw: 2, video: 4, sidecar: 8, other: 3 }

/** All database access for shots, files and sync state. */
export class Library {
  constructor(private db: DB) {}

  findFileByHash(hash: string): FileRow | undefined {
    return this.db.prepare(`SELECT * FROM files WHERE hash = ?`).get(hash) as FileRow | undefined
  }

  pathTaken(path: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM files WHERE path = ?`).get(path)
  }

  /** Returns existing shot id for the key, or inserts a new shot. */
  upsertShot(s: NewShot): { id: number; created: boolean } {
    const existing = this.db.prepare(`SELECT id FROM shots WHERE key = ?`).get(s.key) as { id: number } | undefined
    if (existing) return { id: existing.id, created: false }
    const info = this.db
      .prepare(
        `INSERT INTO shots (key, session, name, captured_at, imported_at, camera, lens, iso, shutter, aperture,
          focal_length, width, height, orientation, source)
         VALUES (@key, @session, @name, @capturedAt, @importedAt, @camera, @lens, @iso, @shutter, @aperture,
          @focalLength, @width, @height, @orientation, @source)`
      )
      .run({ ...s, importedAt: Date.now() })
    return { id: Number(info.lastInsertRowid), created: true }
  }

  addFile(f: Omit<FileRow, 'id'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO files (shot_id, path, rel_path, name, kind, size, hash, imported_at)
         VALUES (@shot_id, @path, @rel_path, @name, @kind, @size, @hash, @importedAt)`
      )
      .run({ ...f, importedAt: Date.now() })
    return Number(info.lastInsertRowid)
  }

  /** The file the preview should be rendered from: JPEG beats HEIF beats RAW. */
  bestPreviewSource(shotId: number): FileRow | undefined {
    const files = this.files(shotId).filter((f) => f.kind !== 'sidecar')
    return files.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0]
  }

  setPreview(shotId: number, fileId: number, stats: LumaStats): void {
    this.db
      .prepare(
        `UPDATE shots SET preview_file_id = ?, has_preview = 1, hist = ?, clipped = ?, dark = ?, sharpness = ?, hash = ? WHERE id = ?`
      )
      .run(fileId, JSON.stringify(stats.hist), stats.clipped, stats.dark, stats.sharpness, stats.hash, shotId)
  }

  /** Shots rendered before scoring existed. */
  unscoredIds(): number[] {
    return (this.db.prepare(`SELECT id FROM shots WHERE has_preview = 1 AND sharpness IS NULL`).all() as { id: number }[]).map((r) => r.id)
  }

  setScores(shotId: number, s: LumaStats): void {
    this.db.prepare(`UPDATE shots SET dark = ?, sharpness = ?, hash = ? WHERE id = ?`).run(s.dark, s.sharpness, s.hash, shotId)
  }

  /** Newest first, so live shooting is scanned before the backlog. */
  unfacedIds(): number[] {
    return (this.db.prepare(`SELECT id FROM shots WHERE has_preview = 1 AND faces IS NULL ORDER BY id DESC`).all() as { id: number }[]).map((r) => r.id)
  }

  setFaces(shotId: number, faces: number, blink: number | null): void {
    this.db.prepare(`UPDATE shots SET faces = ?, blink = ? WHERE id = ?`).run(faces, blink, shotId)
  }

  previewFileId(shotId: number): number | null {
    const r = this.db.prepare(`SELECT preview_file_id FROM shots WHERE id = ?`).get(shotId) as
      | { preview_file_id: number | null }
      | undefined
    return r?.preview_file_id ?? null
  }

  orientation(shotId: number): number | null {
    const r = this.db.prepare(`SELECT orientation FROM shots WHERE id = ?`).get(shotId) as
      | { orientation: number | null }
      | undefined
    return r?.orientation ?? null
  }

  files(shotId: number): FileRow[] {
    return this.db.prepare(`SELECT * FROM files WHERE shot_id = ? ORDER BY id`).all(shotId) as FileRow[]
  }

  sidecarFile(shotId: number): FileRow | undefined {
    return this.db.prepare(`SELECT * FROM files WHERE shot_id = ? AND kind = 'sidecar'`).get(shotId) as FileRow | undefined
  }

  setFileSize(fileId: number, size: number): void {
    this.db.prepare(`UPDATE files SET size = ? WHERE id = ?`).run(size, fileId)
  }

  /** Most recently imported shot with this base name (used to attach a late-arriving sidecar). */
  findShotByName(name: string): number | undefined {
    const r = this.db.prepare(`SELECT id FROM shots WHERE lower(name) = lower(?) ORDER BY id DESC LIMIT 1`).get(name) as
      | { id: number }
      | undefined
    return r?.id
  }

  file(fileId: number): FileRow | undefined {
    return this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(fileId) as FileRow | undefined
  }

  get(id: number): Shot | undefined {
    const row = this.db.prepare(`SELECT * FROM shots WHERE id = ?`).get(id) as ShotRow | undefined
    return row && !isAnchorName(row.name) ? this.toShot(row) : undefined // session meta anchors are never shots outside this class
  }

  list(q: ShotQuery): { items: Shot[]; total: number } {
    const where: string[] = [REAL]
    const params: Record<string, unknown> = {}
    if (q.session) {
      where.push('session = @session')
      params.session = q.session
    }
    if (q.source) {
      where.push('source = @source')
      params.source = q.source
    }
    if (q.minRating) {
      where.push('rating >= @minRating')
      params.minRating = q.minRating
    }
    if (q.flag === 'notRejected') where.push('flag != -1')
    else if (q.flag !== undefined) {
      where.push('flag = @flag')
      params.flag = q.flag
    }
    if (q.label) {
      where.push('label = @label')
      params.label = q.label
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const order = q.order === 'desc' ? 'DESC' : 'ASC'
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM shots ${clause}`).get(params) as { n: number }).n
    const rows = this.db
      .prepare(`SELECT * FROM shots ${clause} ORDER BY captured_at ${order}, id ${order} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: q.limit ?? 5000, offset: q.offset ?? 0 }) as ShotRow[]
    return { items: rows.map((r) => this.toShot(r)), total }
  }

  sessions(): Session[] {
    return this.db
      .prepare(`SELECT session, COUNT(*) AS count FROM shots WHERE ${REAL} GROUP BY session ORDER BY session DESC`)
      .all() as Session[]
  }

  // ---- sessions (cache of each folder's .shotdrop.json) ----

  sessionMetas(): Map<string, SessionMeta> {
    const rows = this.db.prepare(`SELECT * FROM sessions`).all() as SessionCacheRow[]
    return new Map(rows.map((r) => [r.folder, cacheToMeta(r)]))
  }

  upsertSession(folder: string, m: SessionMeta): void {
    this.db.transaction(() => {
      // A copied folder carries its twin's id: the folder just written keeps it, the other shows as unnamed.
      this.db.prepare(`DELETE FROM sessions WHERE id = ? AND folder != ?`).run(m.id, folder)
      this.insertSession(folder, m)
    })()
  }

  replaceSessions(rows: { folder: string; meta: SessionMeta }[]): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM sessions`).run()
      for (const r of rows) {
        try {
          this.insertSession(r.folder, r.meta)
        } catch {
          /* duplicate id on another folder: this one stays unnamed in the cache */
        }
      }
    })()
  }

  private insertSession(folder: string, m: SessionMeta): void {
    this.db
      .prepare(
        `INSERT INTO sessions (folder, id, name, client, notes, created_by, created_at, updated_at)
         VALUES (@folder, @id, @name, @client, @notes, @createdBy, @createdAt, @updatedAt)
         ON CONFLICT(folder) DO UPDATE SET id = excluded.id, name = excluded.name, client = excluded.client, notes = excluded.notes,
           created_by = excluded.created_by, created_at = excluded.created_at, updated_at = excluded.updated_at`
      )
      .run({ folder, id: m.id, name: m.name, client: m.client ?? null, notes: m.notes ?? null, createdBy: m.createdBy, createdAt: m.createdAt, updatedAt: m.updatedAt })
  }

  /**
   * The sync queue only knows `files` rows, and a file row needs a shot, so each session's .shotdrop.json hangs off one
   * hidden anchor shot (dot name, kind 'other'). Creates or refreshes it and returns the file id to enqueue.
   */
  setSessionAnchor(folder: string, path: string, relPath: string, size: number, hash: string): number {
    this.anchorIds = null
    return this.db.transaction(() => {
      const now = Date.now()
      const key = `${folder}/.shotdrop.json`
      const shot = this.db.prepare(`SELECT id FROM shots WHERE key = ?`).get(key) as { id: number } | undefined
      const shotId =
        shot?.id ??
        Number(
          this.db
            .prepare(`INSERT INTO shots (key, session, name, captured_at, imported_at) VALUES (?, ?, '.shotdrop.json', ?, ?)`)
            .run(key, folder, now, now).lastInsertRowid
        )
      const f = this.db.prepare(`SELECT id FROM files WHERE shot_id = ?`).get(shotId) as { id: number } | undefined
      if (f) {
        this.db.prepare(`UPDATE files SET path = ?, rel_path = ?, size = ?, hash = ? WHERE id = ?`).run(path, relPath, size, hash, f.id)
        return f.id
      }
      return Number(
        this.db
          .prepare(`INSERT INTO files (shot_id, path, rel_path, name, kind, size, hash, imported_at) VALUES (?, ?, ?, '.shotdrop.json', 'other', ?, ?, ?)`)
          .run(shotId, path, relPath, size, hash, now).lastInsertRowid
      )
    })()
  }

  /** Folder and file id of every session meta file already registered for sync. */
  sessionAnchorFiles(): { folder: string; fileId: number }[] {
    return this.db
      .prepare(`SELECT s.session AS folder, f.id AS fileId FROM shots s JOIN files f ON f.shot_id = s.id WHERE s.name = '.shotdrop.json'`)
      .all() as { folder: string; fileId: number }[]
  }

  /** True for the hidden shot that carries a session's .shotdrop.json; routes treat its id as unknown. */
  isAnchorId(id: number): boolean {
    this.anchorIds ??= new Set((this.db.prepare(`SELECT id, name FROM shots WHERE name LIKE '.%'`).all() as { id: number; name: string }[]).filter((r) => isAnchorName(r.name)).map((r) => r.id))
    return this.anchorIds.has(id)
  }

  /** Cached set of anchor shot ids (one query instead of one per /api/shots request); dropped whenever anchors change. */
  private anchorIds: Set<number> | null = null

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM shots WHERE ${REAL}`).get() as { n: number }).n
  }

  update(id: number, patch: ShotPatch): Shot | undefined {
    const sets: string[] = []
    const params: Record<string, unknown> = { id }
    if (patch.rating !== undefined) {
      sets.push('rating = @rating')
      params.rating = Math.max(0, Math.min(5, Math.round(patch.rating)))
    }
    if (patch.flag !== undefined) {
      sets.push('flag = @flag')
      params.flag = patch.flag
    }
    if (patch.label !== undefined) {
      sets.push('label = @label')
      params.label = patch.label as Label
    }
    if (sets.length) this.db.prepare(`UPDATE shots SET ${sets.join(', ')} WHERE id = @id`).run(params)
    return this.get(id)
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM shots WHERE id = ?`).run(id)
  }

  removeFile(fileId: number): void {
    this.db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId)
  }

  // ---- sync jobs ----

  enqueueSync(fileId: number, destId: string): void {
    this.cancelRemoteDelete(fileId, destId)
    this.db
      .prepare(
        `INSERT INTO sync_jobs (file_id, dest_id, status, updated_at) VALUES (?, ?, 'pending', ?)
         ON CONFLICT(file_id, dest_id) DO NOTHING`
      )
      .run(fileId, destId, Date.now())
  }

  /** Oldest pending jobs, skipping destinations that are currently unreachable so they don't starve the rest. */
  nextSyncJobs(limit: number, skipDests: string[] = []): { id: number; file_id: number; dest_id: string; attempts: number }[] {
    return this.db
      .prepare(
        `SELECT id, file_id, dest_id, attempts FROM sync_jobs
         WHERE status = 'pending' AND dest_id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`
      )
      .all(JSON.stringify(skipDests), limit) as { id: number; file_id: number; dest_id: string; attempts: number }[]
  }

  /** Put one failed job back in the queue (only if nothing else has touched it since). */
  retrySyncJob(jobId: number): void {
    this.db.prepare(`UPDATE sync_jobs SET status = 'pending' WHERE id = ? AND status = 'error'`).run(jobId)
  }

  setSyncStatus(jobId: number, status: SyncStatus, error: string | null = null): void {
    this.db
      .prepare(
        `UPDATE sync_jobs SET status = ?, error = ?, updated_at = ?,
           attempts = attempts + CASE WHEN ? = 'error' THEN 1 ELSE 0 END WHERE id = ?`
      )
      .run(status, error, Date.now(), status, jobId)
  }

  /** Mark done only if still running (a requeue in the meantime must stay pending). */
  finishSync(jobId: number): void {
    this.db.prepare(`UPDATE sync_jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ? AND status = 'running'`).run(Date.now(), jobId)
  }

  retryFailedSync(destId?: string): number {
    const sql = destId
      ? `UPDATE sync_jobs SET status = 'pending' WHERE status = 'error' AND dest_id = ?`
      : `UPDATE sync_jobs SET status = 'pending' WHERE status = 'error'`
    return (destId ? this.db.prepare(sql).run(destId) : this.db.prepare(sql).run()).changes
  }

  /** Re-send a file whose content changed (sidecar): back to pending even if already done. */
  requeueSync(fileId: number, destId: string): void {
    this.cancelRemoteDelete(fileId, destId)
    this.db
      .prepare(
        `INSERT INTO sync_jobs (file_id, dest_id, status, updated_at) VALUES (?, ?, 'pending', ?)
         ON CONFLICT(file_id, dest_id) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, updated_at = excluded.updated_at`
      )
      .run(fileId, destId, Date.now())
  }

  dropSyncForDest(destId: string): void {
    this.db.prepare(`DELETE FROM sync_jobs WHERE dest_id = ?`).run(destId)
    this.dropRemoteDeletes(destId)
  }

  // ---- remote deletes ("mirror deletes") ----

  /**
   * Forget a file locally and, in the same transaction, queue its deletion on each given destination that was ever
   * sent it. Any sync row counts, not just 'done': a re-sent sidecar is 'pending' while an older copy is already there,
   * and deleting something that isn't there is harmless.
   */
  removeFileMirroring(fileId: number, mirrorDests: string[]): void {
    this.db.transaction(() => {
      if (mirrorDests.length) {
        this.db
          .prepare(
            `INSERT INTO remote_ops (dest_id, op, src, status, updated_at)
             SELECT j.dest_id, 'delete', f.rel_path, 'pending', @now FROM sync_jobs j JOIN files f ON f.id = j.file_id
             WHERE j.file_id = @fileId AND j.dest_id IN (SELECT value FROM json_each(@dests))
             ON CONFLICT(dest_id, op, src) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, updated_at = excluded.updated_at`
          )
          .run({ fileId, dests: JSON.stringify(mirrorDests), now: Date.now() })
      }
      this.removeFile(fileId)
    })()
  }

  /** A new file is going to the same path: the old delete must not remove it. Running deletes are left to finish first. */
  private cancelRemoteDelete(fileId: number, destId: string): void {
    this.db
      .prepare(`DELETE FROM remote_ops WHERE op = 'delete' AND dest_id = ? AND status != 'running' AND src = (SELECT rel_path FROM files WHERE id = ?)`)
      .run(destId, fileId)
  }

  nextRemoteDeletes(limit: number, skipDests: string[] = []): { id: number; dest_id: string; rel_path: string; attempts: number }[] {
    return this.db
      .prepare(
        `SELECT id, dest_id, src AS rel_path, attempts FROM remote_ops
         WHERE op = 'delete' AND status = 'pending' AND dest_id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`
      )
      .all(JSON.stringify(skipDests), limit) as { id: number; dest_id: string; rel_path: string; attempts: number }[]
  }

  setRemoteDeleteStatus(id: number, status: 'pending' | 'running' | 'error', error: string | null = null): void {
    this.db
      .prepare(
        `UPDATE remote_ops SET status = ?, error = ?, updated_at = ?,
           attempts = attempts + CASE WHEN ? = 'error' THEN 1 ELSE 0 END WHERE id = ?`
      )
      .run(status, error, Date.now(), status, id)
  }

  /** Done: the row goes (only if still running, so a re-queue in the meantime survives). */
  finishRemoteDelete(id: number): void {
    this.db.prepare(`DELETE FROM remote_ops WHERE id = ? AND status = 'running'`).run(id)
  }

  retryRemoteDelete(id: number): void {
    this.db.prepare(`UPDATE remote_ops SET status = 'pending' WHERE id = ? AND status = 'error'`).run(id)
  }

  retryFailedRemoteDeletes(destId?: string): number {
    const sql = `UPDATE remote_ops SET status = 'pending' WHERE op = 'delete' AND status = 'error'${destId ? ' AND dest_id = ?' : ''}`
    return (destId ? this.db.prepare(sql).run(destId) : this.db.prepare(sql).run()).changes
  }

  /** Destination removed, or mirroring switched off: nothing more gets deleted there. */
  dropRemoteDeletes(destId: string): void {
    this.db.prepare(`DELETE FROM remote_ops WHERE op = 'delete' AND dest_id = ? AND status != 'running'`).run(destId)
  }

  /** Per destination: deletes still to do, and the newest failure. */
  remoteDeleteState(): Record<string, { waiting: number; error: string | null }> {
    const out: Record<string, { waiting: number; error: string | null }> = {}
    const rows = this.db.prepare(`SELECT dest_id, COUNT(*) AS n FROM remote_ops WHERE op = 'delete' GROUP BY dest_id`).all() as { dest_id: string; n: number }[]
    for (const r of rows) out[r.dest_id] = { waiting: r.n, error: null }
    const errs = this.db
      .prepare(`SELECT dest_id, error, MAX(updated_at) AS at FROM remote_ops WHERE op = 'delete' AND status = 'error' GROUP BY dest_id`)
      .all() as { dest_id: string; error: string }[]
    for (const e of errs) (out[e.dest_id] ??= { waiting: 0, error: null }).error = e.error
    return out
  }

  // ---- remote ops (moves; deletes share the table, see above) ----

  /** Queue a server-side move on a destination. A repeat for the same source replaces the target and resets the attempts. */
  queueRemoteMove(destId: string, src: string, dst: string): void {
    this.db
      .prepare(
        `INSERT INTO remote_ops (dest_id, op, src, dst, status, updated_at) VALUES (?, 'move', ?, ?, 'pending', ?)
         ON CONFLICT(dest_id, op, src) DO UPDATE SET dst = excluded.dst, status = 'pending', attempts = 0, error = NULL, updated_at = excluded.updated_at`
      )
      .run(destId, src, dst, Date.now())
  }

  /** The oldest unfinished op of each destination, if it's a pending move. Strictly in order, so a later op never runs before the one it depends on. */
  nextRemoteMoves(skipDests: string[] = []): { id: number; dest_id: string; src: string; dst: string; attempts: number }[] {
    return this.db
      .prepare(
        `SELECT id, dest_id, src, dst, attempts FROM remote_ops o
         WHERE op = 'move' AND status = 'pending' AND dest_id NOT IN (SELECT value FROM json_each(?))
           AND id = (SELECT MIN(id) FROM remote_ops WHERE dest_id = o.dest_id)
         ORDER BY id`
      )
      .all(JSON.stringify(skipDests)) as { id: number; dest_id: string; src: string; dst: string; attempts: number }[]
  }

  /** Pending or running move targets of a destination: uploads under these prefixes wait for the move. */
  pendingMoveTargets(destId: string): string[] {
    return (this.db.prepare(`SELECT dst FROM remote_ops WHERE op = 'move' AND dest_id = ?`).all(destId) as { dst: string }[]).map((r) => r.dst)
  }

  remoteOp(id: number): RemoteOpRow | undefined {
    return this.db.prepare(`SELECT id, dest_id, op, src, dst, status, attempts, error FROM remote_ops WHERE id = ?`).get(id) as RemoteOpRow | undefined
  }

  remoteOps(): RemoteOpRow[] {
    return this.db.prepare(`SELECT id, dest_id, op, src, dst, status, attempts, error FROM remote_ops ORDER BY id`).all() as RemoteOpRow[]
  }

  retryFailedRemoteOps(): number {
    return this.db.prepare(`UPDATE remote_ops SET status = 'pending', attempts = 0 WHERE status = 'error'`).run().changes
  }

  // ---- renaming and moving ----

  /** Every file of a session folder, anchor included. */
  sessionFiles(session: string): FileRow[] {
    return this.db.prepare(`SELECT f.* FROM files f JOIN shots s ON s.id = f.shot_id WHERE s.session = ?`).all(session) as FileRow[]
  }

  /** Destinations that already received this file: only these need a remote move. */
  sentDests(fileId: number): string[] {
    return (this.db.prepare(`SELECT dest_id FROM sync_jobs WHERE file_id = ? AND status = 'done'`).all(fileId) as { dest_id: string }[]).map((r) => r.dest_id)
  }

  /** Rename a session folder in the database in one transaction. Sync jobs hang off file ids, so they follow the new rel_path. */
  renameSessionRows(oldF: string, newF: string, newPath: (oldPath: string) => string): void {
    this.anchorIds = null
    this.db.transaction(() => {
      const upd = this.db.prepare(`UPDATE files SET path = ?, rel_path = ? WHERE id = ?`)
      for (const f of this.sessionFiles(oldF)) upd.run(newPath(f.path), `${newF}/${f.rel_path.slice(oldF.length + 1)}`, f.id)
      this.db.prepare(`UPDATE shots SET session = ?, key = ? || substr(key, ?) WHERE session = ?`).run(newF, newF, oldF.length + 1, oldF)
      this.db.prepare(`UPDATE sessions SET folder = ? WHERE folder = ?`).run(newF, oldF)
    })()
  }

  /** Point one shot (and its files, sidecar included) at another session folder, in one transaction. */
  relocateShot(shotId: number, newF: string, moves: { fileId: number; path: string; relPath: string }[]): void {
    this.db.transaction(() => {
      const upd = this.db.prepare(`UPDATE files SET path = ?, rel_path = ? WHERE id = ?`)
      for (const m of moves) upd.run(m.path, m.relPath, m.fileId)
      const s = this.db.prepare(`SELECT name FROM shots WHERE id = ?`).get(shotId) as { name: string }
      this.db.prepare(`UPDATE shots SET session = ?, key = ? WHERE id = ?`).run(newF, `${newF}/${s.name.toLowerCase()}`, shotId)
    })()
  }

  shotKeyTaken(key: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM shots WHERE key = ?`).get(key)
  }

  /** A top-level folder of this name is in some destination's cached listing: renaming onto it would merge two sessions. */
  remoteFolderCached(name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM remote_entries WHERE path = ? COLLATE NOCASE AND dir = 1`).get(name)
  }

  /** Drop cached listings under a prefix that was just moved; Browse refetches them live. */
  forgetRemoteEntries(prefix: string): void {
    this.db.prepare(`DELETE FROM remote_entries WHERE path = ? OR substr(path, 1, ?) = ?`).run(prefix, prefix.length + 1, `${prefix}/`)
  }

  /** How many of these shots' photos each destination has (or is receiving), for the delete confirmation. Not-yet-sent ones just get dropped. */
  destFileCounts(shotIds: number[]): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT j.dest_id, COUNT(*) AS n FROM sync_jobs j JOIN files f ON f.id = j.file_id
         WHERE f.shot_id IN (SELECT value FROM json_each(?)) AND f.kind != 'sidecar' AND j.status != 'pending' GROUP BY j.dest_id`
      )
      .all(JSON.stringify(shotIds)) as { dest_id: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.dest_id, r.n]))
  }

  syncCounts(): { pending: number; running: number; errors: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM sync_jobs GROUP BY status`).all() as {
      status: SyncStatus
      n: number
    }[]
    const get = (s: SyncStatus): number => rows.find((r) => r.status === s)?.n ?? 0
    return { pending: get('pending'), running: get('running'), errors: get('error') }
  }

  /** Per-destination job totals, for progress rings. */
  destProgress(): Record<string, { done: number; total: number; running: number; errors: number }> {
    const rows = this.db.prepare(`SELECT dest_id, status, COUNT(*) AS n FROM sync_jobs GROUP BY dest_id, status`).all() as {
      dest_id: string
      status: SyncStatus
      n: number
    }[]
    const out: Record<string, { done: number; total: number; running: number; errors: number }> = {}
    for (const r of rows) {
      const d = (out[r.dest_id] ??= { done: 0, total: 0, running: 0, errors: 0 })
      d.total += r.n
      if (r.status === 'done') d.done = r.n
      else if (r.status === 'running') d.running = r.n
      else if (r.status === 'error') d.errors = r.n
    }
    return out
  }

  /** Newest unresolved error and newest finished upload, per destination. */
  destHealth(): Record<string, { lastError: string | null; lastDoneAt: number | null }> {
    const out: Record<string, { lastError: string | null; lastDoneAt: number | null }> = {}
    // SQLite returns the bare column from the row holding MAX(updated_at).
    const errs = this.db
      .prepare(`SELECT dest_id, error, MAX(updated_at) AS at FROM sync_jobs WHERE error IS NOT NULL AND status != 'done' GROUP BY dest_id`)
      .all() as { dest_id: string; error: string }[]
    const done = this.db
      .prepare(`SELECT dest_id, MAX(updated_at) AS at FROM sync_jobs WHERE status = 'done' GROUP BY dest_id`)
      .all() as { dest_id: string; at: number }[]
    for (const e of errs) (out[e.dest_id] ??= { lastError: null, lastDoneAt: null }).lastError = e.error
    for (const d of done) (out[d.dest_id] ??= { lastError: null, lastDoneAt: null }).lastDoneAt = d.at
    return out
  }

  /** Files and bytes each sync filter would send (XMP sidecars ride along and aren't counted). */
  filterCounts(): { all: { files: number; bytes: number }; jpeg: { files: number; bytes: number }; raw: { files: number; bytes: number }; picks: { files: number; bytes: number } } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(f.kind != 'sidecar') AS allN, SUM(CASE WHEN f.kind != 'sidecar' THEN f.size ELSE 0 END) AS allB,
           SUM(f.kind IN ('jpeg','heif')) AS jpgN, SUM(CASE WHEN f.kind IN ('jpeg','heif') THEN f.size ELSE 0 END) AS jpgB,
           SUM(f.kind = 'raw') AS rawN, SUM(CASE WHEN f.kind = 'raw' THEN f.size ELSE 0 END) AS rawB,
           SUM(s.flag = 1 AND f.kind != 'sidecar') AS pickN, SUM(CASE WHEN s.flag = 1 AND f.kind != 'sidecar' THEN f.size ELSE 0 END) AS pickB
         FROM files f JOIN shots s ON s.id = f.shot_id WHERE s.name NOT LIKE '.%'`
      )
      .get() as Record<string, number | null>
    const n = (k: string): number => row[k] ?? 0
    return {
      all: { files: n('allN'), bytes: n('allB') },
      jpeg: { files: n('jpgN'), bytes: n('jpgB') },
      raw: { files: n('rawN'), bytes: n('rawB') },
      picks: { files: n('pickN'), bytes: n('pickB') }
    }
  }

  /** Shots imported since `since` and the newest import time, per source (ftp user). */
  sourceStats(since: number): Record<string, { today: number; lastAt: number }> {
    const rows = this.db
      .prepare(`SELECT source, SUM(imported_at >= ?) AS today, MAX(imported_at) AS lastAt FROM shots WHERE source IS NOT NULL GROUP BY source`)
      .all(since) as { source: string; today: number; lastAt: number }[]
    return Object.fromEntries(rows.map((r) => [r.source, { today: r.today, lastAt: r.lastAt }]))
  }

  syncJobs(status?: SyncStatus, limit = 200): unknown[] {
    return this.db
      .prepare(
        `SELECT j.id, j.dest_id AS destId, j.status, j.attempts, j.error, j.updated_at AS updatedAt,
                f.name AS file, f.shot_id AS shotId
         FROM sync_jobs j JOIN files f ON f.id = j.file_id
         ${status ? 'WHERE j.status = @status' : ''} ORDER BY j.updated_at DESC LIMIT @limit`
      )
      .all({ status, limit })
  }

  allFiles(): FileRow[] {
    return this.db.prepare(`SELECT * FROM files ORDER BY id`).all() as FileRow[]
  }

  shotIdsWithFlag(flag: Flag): number[] {
    return (this.db.prepare(`SELECT id FROM shots WHERE flag = ? AND ${REAL}`).all(flag) as { id: number }[]).map((r) => r.id)
  }

  private toShot(r: ShotRow): Shot {
    const files = this.files(r.id)
    const syncRows = this.db
      .prepare(
        `SELECT j.dest_id AS dest, j.status FROM sync_jobs j JOIN files f ON f.id = j.file_id WHERE f.shot_id = ?`
      )
      .all(r.id) as { dest: string; status: SyncStatus }[]
    const sync: Record<string, SyncStatus> = {}
    for (const { dest, status } of syncRows) {
      const cur = sync[dest]
      // error > running > pending > done
      const rank = { error: 3, running: 2, pending: 1, done: 0 }
      if (!cur || rank[status] > rank[cur]) sync[dest] = status
    }
    return {
      id: r.id,
      session: r.session,
      name: r.name,
      capturedAt: r.captured_at,
      importedAt: r.imported_at,
      camera: r.camera,
      lens: r.lens,
      iso: r.iso,
      shutter: r.shutter,
      aperture: r.aperture,
      focalLength: r.focal_length,
      width: r.width,
      height: r.height,
      rating: r.rating,
      flag: r.flag as Flag,
      label: r.label as Label,
      source: r.source,
      hasPreview: !!r.has_preview,
      histogram: r.hist ? (JSON.parse(r.hist) as number[]) : null,
      clipped: r.clipped,
      dark: r.dark,
      sharpness: r.sharpness,
      hash: r.hash,
      faces: r.faces,
      blink: r.blink,
      files: files.filter((f) => f.kind !== 'sidecar').map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: f.size })),
      sync
    }
  }
}
