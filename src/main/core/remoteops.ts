import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Destination, ServerEvent } from '@shared/types'
import type { RemoteOp } from '@shared/remote'
import type { Core } from './index'
import type { RemoteOpRow } from './library'
import { remoteFor } from './remote'
import { isUnreachable, type SyncError } from './retry'
import { folderDate, folderName } from './sessions'

const MAX_ATTEMPTS = 5 // real errors only; an unreachable destination waits without spending these
const IDLE_WAIT_MS = 60_000

/** An error the route turns into a status code. */
export class OpError extends Error {
  constructor(
    message: string,
    readonly status = 409
  ) {
    super(message)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const toOp = (r: RemoteOpRow): RemoteOp => ({
  id: r.id,
  destId: r.dest_id,
  op: r.op,
  from: r.src,
  to: r.dst ?? undefined,
  status: r.status,
  attempts: r.attempts,
  error: r.error ?? undefined
})

/** "Already gone" counts as done: the folder was never sent, or an earlier op moved it. */
function isGone(e: unknown): boolean {
  const err = e as SyncError & { code?: string }
  return err.code === 'ENOENT' || err.exitCode === 3 || err.exitCode === 4 || /not found|doesn't exist|no such file|object not found/i.test(err.message ?? '')
}

/**
 * Remote moves behind session rename and "move to session", run from a persistent queue (`remote_ops`) so they survive
 * restarts and offline destinations. Mirror deletes live in the same table; SyncService still runs those.
 * Per destination, ops run strictly in id order, because a later op can depend on an earlier one (rename, then move a shot out).
 */
export class RemoteOpsService {
  private running = new Set<string>() // dest ids with a move in flight

  constructor(private core: Core) {
    core.sync.onPump = () => this.pump()
    core.sync.uploadBlocked = (destId, rel) => core.lib.pendingMoveTargets(destId).some((t) => rel === t || rel.startsWith(`${t}/`))
  }

  private get libDir(): string {
    return this.core.settings.libraryDir
  }

  private emit(row: RemoteOpRow | undefined): void {
    if (row) this.core.bus.emit({ type: 'remoteop:updated', op: toOp(row) } as unknown as ServerEvent)
  }

  list(): RemoteOp[] {
    return this.core.lib.remoteOps().map(toOp)
  }

  retry(): number {
    const n = this.core.lib.retryFailedRemoteOps()
    this.core.sync.pump()
    return n
  }

  // ---------------------------------------------------------------- worker

  pump(): void {
    const { lib, sync } = this.core
    for (const job of lib.nextRemoteMoves(sync.skippedDests())) {
      const dest = this.core.settings.destinations.find((d) => d.id === job.dest_id)
      if (!dest || this.running.has(dest.id)) continue
      // An upload or delete still touching either end: wait, the next pump tries again.
      if (sync.isBusyUnder(job.src, dest.id) || sync.isBusyUnder(job.dst, dest.id)) continue
      this.running.add(dest.id)
      this.setStatus(job.id, 'running')
      void this.run(dest, job)
    }
  }

  private setStatus(id: number, status: 'pending' | 'running' | 'error', error: string | null = null): void {
    this.core.db
      .prepare(`UPDATE remote_ops SET status = ?, error = ?, updated_at = ?, attempts = attempts + CASE WHEN ? = 'error' THEN 1 ELSE 0 END WHERE id = ?`)
      .run(status, error, Date.now(), status, id)
    this.emit(this.core.lib.remoteOp(id))
  }

  private async run(dest: Destination, job: { id: number; src: string; dst: string; attempts: number }): Promise<void> {
    const { sync } = this.core
    try {
      const fs = remoteFor(dest, { rclonePath: this.core.settings.rclonePath, cloud: this.core.cloud, trash: sync.trash })
      try {
        await fs.move(job.src, job.dst)
      } catch (e) {
        if (!isGone(e)) throw e
      }
      sync.markOnline(dest.id)
      sync.forgetDirs(dest, job.src)
      sync.forgetDirs(dest, job.dst)
      const last = this.core.lib.remoteOp(job.id)
      this.core.db.prepare(`DELETE FROM remote_ops WHERE id = ?`).run(job.id)
      this.emit(last)
    } catch (e) {
      const err = e as SyncError
      if (isUnreachable(err)) {
        sync.markOffline(dest.id)
        this.setStatus(job.id, 'pending', `Waiting for destination: ${err.message}`)
      } else {
        this.setStatus(job.id, 'error', err.message)
        if (job.attempts + 1 < MAX_ATTEMPTS)
          setTimeout(() => {
            this.core.db.prepare(`UPDATE remote_ops SET status = 'pending' WHERE id = ? AND status = 'error'`).run(job.id)
            sync.pump()
          }, 15000 * (job.attempts + 1)).unref?.()
      }
    } finally {
      this.running.delete(dest.id)
      sync.pump()
    }
  }

  private queueMoves(src: string, dst: string): void {
    for (const d of this.core.settings.destinations) if (d.enabled) this.core.lib.queueRemoteMove(d.id, src, dst)
  }

  // ---------------------------------------------------------------- rename

  /** First free folder for `base` locally and in every destination's cached listing: `base`, `base-2`, ... */
  freeFolder(base: string, current?: string): string {
    let n = 1
    let f = base
    const taken = (x: string): boolean => x !== current && (existsSync(join(this.libDir, x)) || this.core.lib.remoteFolderCached(x))
    while (taken(f)) f = `${base}-${++n}`
    return f
  }

  /** Wait until no upload or delete is in flight under any of these library paths; new ones are held off meanwhile. */
  private async idle(prefixes: string[]): Promise<void> {
    const until = Date.now() + IDLE_WAIT_MS
    while (prefixes.some((p) => this.core.sync.isBusyUnder(p))) {
      if (Date.now() > until) throw new OpError('Files in this session are still uploading. Try again in a moment.')
      await sleep(250)
    }
  }

  /** The folder a session of this name gets: the folder's own date, then the name. */
  targetFolder(folder: string, name: string, metaDate?: string): string {
    return folderName(folderDate(folder) ?? metaDate ?? folder.slice(0, 10), name)
  }

  /**
   * Rename a session folder: local folder and database rows, then one folder-level move per enabled destination.
   * Returns the new folder name (the old one if nothing changes). Does not touch .shotdrop.json: the caller writes the meta after.
   */
  async renameSession(folder: string, name: string, metaDate?: string): Promise<string> {
    const { lib, sync, ingest } = this.core
    const wanted = this.targetFolder(folder, name, metaDate)
    if (wanted === folder) return folder
    const target = this.freeFolder(wanted, folder)
    if (target === folder) return folder
    const oldDir = join(this.libDir, folder)
    const newDir = join(this.libDir, target)
    if (!existsSync(oldDir)) throw new OpError('Unknown session', 404)

    sync.hold(folder)
    ingest.mute([oldDir, newDir])
    try {
      await this.idle([folder])
      await renameDir(oldDir, newDir)
      try {
        lib.renameSessionRows(folder, target, (p) => join(newDir, p.slice(oldDir.length + 1)))
      } catch (e) {
        await rename(newDir, oldDir).catch(() => undefined)
        throw e
      }
      this.queueMoves(folder, target)
      lib.forgetRemoteEntries(folder)
      for (const d of this.core.settings.destinations) sync.forgetDirs(d, folder)
    } finally {
      ingest.unmute([oldDir, newDir])
      sync.release(folder)
    }
    this.emitChanged(folder, target)
    return target
  }

  // ---------------------------------------------------------------- move shots

  /**
   * Move shots into another session folder: each file on disk and in the database, and for every destination that already
   * has the file a remote move. Files not sent yet just get their new rel_path. Returns how many shots moved.
   */
  async moveShots(toFolder: string, shotIds: number[]): Promise<number> {
    const { lib, sync, ingest } = this.core
    const destDir = join(this.libDir, toFolder)
    if (!existsSync(destDir)) throw new OpError('Unknown session', 404)
    for (const id of shotIds) if (lib.isAnchorId(id)) throw new OpError('Not a shot', 400)

    const plan: { shotId: number; from: string; files: { fileId: number; from: string; to: string; fromRel: string; toRel: string }[] }[] = []
    for (const id of new Set(shotIds)) {
      const shot = lib.get(id)
      if (!shot || shot.session === toFolder) continue
      const files = lib.files(id).map((f) => {
        const base = basename(f.path)
        return { fileId: f.id, from: f.path, to: join(destDir, base), fromRel: f.rel_path, toRel: `${toFolder}/${base}` }
      })
      // A same-named file already there would be overwritten: leave this shot where it is.
      if (files.some((f) => existsSync(f.to)) || lib.shotKeyTaken(`${toFolder}/${shot.name.toLowerCase()}`)) continue
      plan.push({ shotId: id, from: shot.session, files })
    }
    if (!plan.length) return 0

    const held = plan.flatMap((p) => p.files.map((f) => f.fromRel))
    const muted = plan.flatMap((p) => p.files.flatMap((f) => [f.from, f.to]))
    held.forEach((h) => sync.hold(h))
    ingest.mute(muted)
    const touched = new Set<string>([toFolder])
    let moved = 0
    try {
      await this.idle(held)
      const enabled = new Set(this.core.settings.destinations.filter((d) => d.enabled).map((d) => d.id))
      for (const p of plan) {
        const done: typeof p.files = []
        try {
          for (const f of p.files) {
            await rename(f.from, f.to)
            done.push(f)
          }
          lib.relocateShot(p.shotId, toFolder, p.files.map((f) => ({ fileId: f.fileId, path: f.to, relPath: f.toRel })))
        } catch {
          for (const f of done) await rename(f.to, f.from).catch(() => undefined)
          continue
        }
        for (const f of p.files) {
          for (const d of lib.sentDests(f.fileId)) if (enabled.has(d)) lib.queueRemoteMove(d, f.fromRel, f.toRel)
        }
        touched.add(p.from)
        moved++
        const shot = lib.get(p.shotId)
        if (shot) this.core.bus.emit({ type: 'shot:updated', shot })
      }
    } finally {
      ingest.unmute(muted)
      held.forEach((h) => sync.release(h))
    }
    this.emitChanged(...touched)
    sync.pump()
    return moved
  }

  private emitChanged(...folders: string[]): void {
    for (const folder of new Set(folders)) this.core.bus.emit({ type: 'session:changed', folder } as unknown as ServerEvent)
  }
}

/** Renaming a directory can fail briefly on Windows while a watcher or indexer holds a handle on it. */
async function renameDir(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await sleep(250)
    }
  }
}
