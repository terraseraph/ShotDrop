import type { DestProgress, RemoteEntry, RemoteRollup, RemoteState } from '@shared/remote'
import type { DB } from './db'
import { kindOfName } from './remote'

interface LocalRow { id: number; rel_path: string; name: string; kind: string; size: number; status: string | null }

/** Local, non-anchor files that live directly in `path` (a library folder), with their sync job state for one destination. */
export function localFolderFiles(db: DB, destId: string, path: string): LocalRow[] {
  const prefix = path ? `${path}/` : ''
  return db
    .prepare(
      `SELECT f.id, f.rel_path, f.name, f.kind, f.size, j.status FROM files f JOIN shots s ON s.id = f.shot_id
       LEFT JOIN sync_jobs j ON j.file_id = f.id AND j.dest_id = ?
       WHERE s.name NOT LIKE '.%' AND substr(f.rel_path, 1, ?) = ? AND instr(substr(f.rel_path, ?), '/') = 0`
    )
    .all(destId, prefix.length, prefix, prefix.length + 1) as LocalRow[]
}

/**
 * Adds `state` to a remote listing versus the local library, for the folder `path`:
 *  - `synced`      on the remote and here, same size
 *  - `differs`     on both, size differs
 *  - `missingHere` remote only
 *  - `waiting`     here only (queued, or not queued yet): these are extra entries appended after the remote ones,
 *                  with `inLibrary: true`. They are told apart from remote files by not being in the listing.
 * Folders get no state. At the destination root nothing is compared.
 */
export function diffEntries(db: DB, destId: string, path: string, entries: RemoteEntry[]): RemoteEntry[] {
  if (!path) return entries.map((e) => (e.dir ? { ...e, rollup: folderRollup(db, destId, e.path) } : e))
  const local = new Map(localFolderFiles(db, destId, path).map((r) => [r.rel_path, r]))
  const out: RemoteEntry[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (e.dir) {
      out.push({ ...e, rollup: folderRollup(db, destId, e.path) })
      continue
    }
    seen.add(e.path)
    const l = local.get(e.path)
    const state: RemoteState = !l ? 'missingHere' : l.size !== e.size ? 'differs' : 'synced'
    out.push({ ...e, inLibrary: !!l, state })
  }
  for (const l of local.values()) {
    if (seen.has(l.rel_path)) continue
    out.push({ name: l.name, path: l.rel_path, dir: false, size: l.size, mtime: 0, kind: kindOfName(l.name), inLibrary: true, state: 'waiting' })
  }
  return out
}

/**
 * Sync state of everything under the folder `dir` (any depth), sidecars not counted. Local files with a finished job count as
 * synced unless the cached remote size differs; no job (or an unfinished one) counts as waiting; files only in the cached
 * remote listing count as missingHere. Folders never listed on the destination have no cache, so their missingHere is 0.
 */
export function folderRollup(db: DB, destId: string, dir: string): RemoteRollup {
  const prefix = `${dir}/`
  const local = db
    .prepare(
      `SELECT f.rel_path, f.size, j.status FROM files f JOIN shots s ON s.id = f.shot_id
       LEFT JOIN sync_jobs j ON j.file_id = f.id AND j.dest_id = ?
       WHERE s.name NOT LIKE '.%' AND f.kind != 'sidecar' AND substr(f.rel_path, 1, ?) = ?`
    )
    .all(destId, prefix.length, prefix) as { rel_path: string; size: number; status: string | null }[]
  const remote = new Map(
    (db.prepare(`SELECT path, size FROM remote_entries WHERE dest_id = ? AND dir = 0 AND kind != 'sidecar' AND substr(path, 1, ?) = ?`).all(destId, prefix.length, prefix) as { path: string; size: number }[]).map((r) => [r.path, r.size])
  )
  const r: RemoteRollup = { total: 0, waiting: 0, differs: 0, missingHere: 0 }
  for (const l of local) {
    r.total++
    const size = remote.get(l.rel_path)
    if (size !== undefined) { if (size !== l.size) r.differs++ }
    else if (l.status !== 'done') r.waiting++
    remote.delete(l.rel_path)
  }
  r.missingHere = remote.size
  r.total += remote.size
  return r
}

/** sent/total per session folder x destination from sync_jobs alone, anchors and sidecars not counted. */
export function destProgressBySession(db: DB): Map<string, DestProgress[]> {
  const rows = db
    .prepare(
      `SELECT s.session, j.dest_id, j.status, COUNT(*) AS n FROM sync_jobs j JOIN files f ON f.id = j.file_id JOIN shots s ON s.id = f.shot_id
       WHERE s.name NOT LIKE '.%' AND f.kind != 'sidecar' GROUP BY s.session, j.dest_id, j.status`
    )
    .all() as { session: string; dest_id: string; status: string; n: number }[]
  const out = new Map<string, DestProgress[]>()
  for (const r of rows) {
    const list = out.get(r.session) ?? []
    let p = list.find((x) => x.destId === r.dest_id)
    if (!p) list.push((p = { destId: r.dest_id, sent: 0, total: 0, pending: 0, errors: 0 }))
    p.total += r.n
    if (r.status === 'done') p.sent += r.n
    else if (r.status === 'error') p.errors += r.n
    else p.pending += r.n
    out.set(r.session, list)
  }
  return out
}

/**
 * Queue a session's files for a destination. Missing = no job yet, a job that isn't done, or (when that folder has been
 * listed on the destination) no remote copy. `resendDiffers` also requeues files whose cached remote size differs.
 * Returns how many photo files were queued (the meta anchor is queued too but not counted).
 */
export function queueSessionSend(
  db: DB,
  enqueue: (fileId: number, destId: string) => void,
  requeue: (fileId: number, destId: string) => void,
  destId: string,
  session: string,
  resendDiffers: boolean,
  wanted: (fileId: number) => boolean
): number {
  const rows = db
    .prepare(
      `SELECT f.id, f.rel_path, f.size, f.kind, s.name AS shot_name, j.status FROM files f JOIN shots s ON s.id = f.shot_id
       LEFT JOIN sync_jobs j ON j.file_id = f.id AND j.dest_id = ? WHERE s.session = ?`
    )
    .all(destId, session) as { id: number; rel_path: string; size: number; kind: string; shot_name: string; status: string | null }[]
  const cached = new Map(
    (db.prepare(`SELECT path, size FROM remote_entries WHERE dest_id = ? AND dir = 0 AND substr(path, 1, ?) = ?`).all(destId, session.length + 1, `${session}/`) as { path: string; size: number }[]).map((r) => [r.path, r.size])
  )
  const listed = cached.size > 0
  let queued = 0
  for (const r of rows) {
    if (r.shot_name.startsWith('.') || !wanted(r.id)) continue // anchors are never sent from here; filtered files stay out
    const anchor = false
    const remoteSize = cached.get(r.rel_path)
    const missing = r.status === null || r.status !== 'done' || (listed && remoteSize === undefined)
    const differs = resendDiffers && remoteSize !== undefined && remoteSize !== r.size
    if (!missing && !differs) continue
    if (r.status === null) enqueue(r.id, destId)
    else if (r.status !== 'pending' && r.status !== 'running') requeue(r.id, destId)
    // (a differs file with a done job is requeued by the branch above)
    // a pending or running job is already in the queue; it still counts as queued
    if (!anchor) queued++
  }
  return queued
}
