import type { DB } from './db'
import type { FileKind, Flag, Label, Session, Shot, ShotPatch, SyncStatus } from '@shared/types'
import type { LumaStats } from './media'

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
    return row ? this.toShot(row) : undefined
  }

  list(q: ShotQuery): { items: Shot[]; total: number } {
    const where: string[] = []
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
      .prepare(`SELECT session, COUNT(*) AS count FROM shots GROUP BY session ORDER BY session DESC`)
      .all() as Session[]
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM shots`).get() as { n: number }).n
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
            `INSERT INTO remote_deletes (dest_id, rel_path, status, updated_at)
             SELECT j.dest_id, f.rel_path, 'pending', @now FROM sync_jobs j JOIN files f ON f.id = j.file_id
             WHERE j.file_id = @fileId AND j.dest_id IN (SELECT value FROM json_each(@dests))
             ON CONFLICT(dest_id, rel_path) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, updated_at = excluded.updated_at`
          )
          .run({ fileId, dests: JSON.stringify(mirrorDests), now: Date.now() })
      }
      this.removeFile(fileId)
    })()
  }

  /** A new file is going to the same path: the old delete must not remove it. Running deletes are left to finish first. */
  private cancelRemoteDelete(fileId: number, destId: string): void {
    this.db
      .prepare(`DELETE FROM remote_deletes WHERE dest_id = ? AND status != 'running' AND rel_path = (SELECT rel_path FROM files WHERE id = ?)`)
      .run(destId, fileId)
  }

  nextRemoteDeletes(limit: number, skipDests: string[] = []): { id: number; dest_id: string; rel_path: string; attempts: number }[] {
    return this.db
      .prepare(
        `SELECT id, dest_id, rel_path, attempts FROM remote_deletes
         WHERE status = 'pending' AND dest_id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`
      )
      .all(JSON.stringify(skipDests), limit) as { id: number; dest_id: string; rel_path: string; attempts: number }[]
  }

  setRemoteDeleteStatus(id: number, status: 'pending' | 'running' | 'error', error: string | null = null): void {
    this.db
      .prepare(
        `UPDATE remote_deletes SET status = ?, error = ?, updated_at = ?,
           attempts = attempts + CASE WHEN ? = 'error' THEN 1 ELSE 0 END WHERE id = ?`
      )
      .run(status, error, Date.now(), status, id)
  }

  /** Done: the row goes (only if still running, so a re-queue in the meantime survives). */
  finishRemoteDelete(id: number): void {
    this.db.prepare(`DELETE FROM remote_deletes WHERE id = ? AND status = 'running'`).run(id)
  }

  retryRemoteDelete(id: number): void {
    this.db.prepare(`UPDATE remote_deletes SET status = 'pending' WHERE id = ? AND status = 'error'`).run(id)
  }

  retryFailedRemoteDeletes(destId?: string): number {
    const sql = `UPDATE remote_deletes SET status = 'pending' WHERE status = 'error'${destId ? ' AND dest_id = ?' : ''}`
    return (destId ? this.db.prepare(sql).run(destId) : this.db.prepare(sql).run()).changes
  }

  /** Destination removed, or mirroring switched off: nothing more gets deleted there. */
  dropRemoteDeletes(destId: string): void {
    this.db.prepare(`DELETE FROM remote_deletes WHERE dest_id = ? AND status != 'running'`).run(destId)
  }

  /** Per destination: deletes still to do, and the newest failure. */
  remoteDeleteState(): Record<string, { waiting: number; error: string | null }> {
    const out: Record<string, { waiting: number; error: string | null }> = {}
    const rows = this.db.prepare(`SELECT dest_id, COUNT(*) AS n FROM remote_deletes GROUP BY dest_id`).all() as { dest_id: string; n: number }[]
    for (const r of rows) out[r.dest_id] = { waiting: r.n, error: null }
    const errs = this.db
      .prepare(`SELECT dest_id, error, MAX(updated_at) AS at FROM remote_deletes WHERE status = 'error' GROUP BY dest_id`)
      .all() as { dest_id: string; error: string }[]
    for (const e of errs) (out[e.dest_id] ??= { waiting: 0, error: null }).error = e.error
    return out
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
         FROM files f JOIN shots s ON s.id = f.shot_id`
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
    return (this.db.prepare(`SELECT id FROM shots WHERE flag = ?`).all(flag) as { id: number }[]).map((r) => r.id)
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
