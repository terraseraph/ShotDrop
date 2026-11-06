import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { copyFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Destination, FileKind, Settings } from '@shared/types'
import type { FileRow, Library } from './library'
import type { Bus } from './events'
import { toolPath } from './bundled'
import { isUnreachable, offlineDelay, type SyncError } from './retry'
import type { CloudAccounts } from './cloud'

const CONCURRENCY = 2
const MAX_ATTEMPTS = 5 // real errors only; an unreachable destination waits without spending these

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) return resolve()
      const e: SyncError = new Error(stderr.trim().split('\n').pop() || `exit ${code}`)
      e.exitCode = code ?? undefined
      reject(e)
    })
  })
}

function unreachable(message: string): SyncError {
  return Object.assign(new Error(message), { unreachable: true })
}

/** Background queue pushing library files to each destination. State lives in SQLite, so it survives restarts. */
export class SyncService {
  private active = 0
  private timer: NodeJS.Timeout | null = null
  rcloneAvailable = false
  private recent: { t: number; dest: string; size: number }[] = []
  /** Destinations that couldn't be reached: skipped by pump() until `until`; `streak` drives the backoff. */
  private offline = new Map<string, { until: number; streak: number }>()

  constructor(
    private lib: Library,
    private bus: Bus,
    private settings: () => Settings,
    private onState: () => void,
    private cloud: CloudAccounts
  ) {}

  async start(): Promise<void> {
    this.rcloneAvailable = await run(toolPath(this.settings().rclonePath, 'rclone'), ['version']).then(
      () => true,
      () => false
    )
    this.timer = setInterval(() => this.pump(), 5000)
    this.pump()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Decide which destinations want a newly added file. */
  fileAdded(fileId: number, shotId: number): void {
    const file = this.lib.file(fileId)
    const shot = this.lib.get(shotId)
    if (!file || !shot) return
    for (const d of this.settings().destinations) {
      if (d.enabled && wants(d, file, shot.flag === 1, this.kinds(shotId))) this.lib.enqueueSync(fileId, d.id)
    }
    this.pump()
  }

  /** A sidecar was written or replaced: (re)send it to every destination that wants it. */
  sidecarChanged(fileId: number, shotId: number): void {
    const file = this.lib.file(fileId)
    const shot = this.lib.get(shotId)
    if (!file || !shot) return
    for (const d of this.settings().destinations) {
      if (d.enabled && wants(d, file, shot.flag === 1, this.kinds(shotId))) this.lib.requeueSync(fileId, d.id)
    }
    this.pump()
  }

  private kinds(shotId: number): Set<FileKind> {
    return new Set(this.lib.files(shotId).map((f) => f.kind))
  }

  /** A shot was picked: enqueue it for "picks only" destinations. */
  shotPicked(shotId: number): void {
    const picksDests = this.settings().destinations.filter((d) => d.enabled && d.filter === 'picks')
    if (!picksDests.length) return
    for (const f of this.lib.files(shotId)) for (const d of picksDests) this.lib.enqueueSync(f.id, d.id)
    this.pump()
  }

  /** Queue every existing library file for a destination (after adding it, or "resync"). */
  backfill(dest: Destination): number {
    const picked = new Set(this.lib.shotIdsWithFlag(1))
    let n = 0
    const all = this.lib.allFiles()
    const kinds = new Map<number, Set<FileKind>>()
    for (const f of all) {
      if (!kinds.has(f.shot_id)) kinds.set(f.shot_id, new Set())
      kinds.get(f.shot_id)!.add(f.kind)
    }
    for (const f of all) {
      if (wants(dest, f, picked.has(f.shot_id), kinds.get(f.shot_id)!)) {
        this.lib.enqueueSync(f.id, dest.id)
        n++
      }
    }
    // An explicit resync is also the user saying "try it now".
    this.offline.delete(dest.id)
    this.pump()
    return n
  }

  pump(): void {
    const free = CONCURRENCY - this.active
    if (free <= 0) return
    const now = Date.now()
    const waiting = [...this.offline].filter(([, o]) => o.until > now).map(([id]) => id)
    const jobs = this.lib.nextSyncJobs(free, waiting)
    for (const job of jobs) {
      const dest = this.settings().destinations.find((d) => d.id === job.dest_id)
      const file = this.lib.file(job.file_id)
      if (!dest || !dest.enabled || !file) continue
      this.active++
      this.lib.setSyncStatus(job.id, 'running')
      this.changed(file.shot_id)
      this.transfer(dest, file)
        .then(() => {
          this.lib.finishSync(job.id)
          this.offline.delete(dest.id)
          this.recent.push({ t: Date.now(), dest: dest.id, size: file.size })
        })
        .catch((e: SyncError) => {
          if (isUnreachable(e)) {
            // Back to pending without spending an attempt; the whole destination pauses and backs off.
            const streak = (this.offline.get(dest.id)?.streak ?? -1) + 1
            this.offline.set(dest.id, { until: Date.now() + offlineDelay(streak), streak })
            this.lib.setSyncStatus(job.id, 'pending', `Waiting for destination: ${e.message}`)
            return
          }
          // Real error: retry this job a few times with a growing delay, then leave it in 'error' for the user.
          this.lib.setSyncStatus(job.id, 'error', e.message)
          if (job.attempts + 1 < MAX_ATTEMPTS) setTimeout(() => this.lib.retrySyncJob(job.id), 15000 * (job.attempts + 1))
        })
        .finally(() => {
          this.active--
          this.changed(file.shot_id)
          this.pump()
        })
    }
  }

  /** Bytes per second per destination over the last 10 s. */
  throughput(): Record<string, number> {
    const cutoff = Date.now() - 10_000
    this.recent = this.recent.filter((r) => r.t >= cutoff)
    const out: Record<string, number> = {}
    for (const r of this.recent) out[r.dest] = (out[r.dest] ?? 0) + r.size / 10
    return out
  }

  private async transfer(dest: Destination, file: FileRow): Promise<void> {
    if (dest.type === 'folder') return copyToFolder(dest.target, file)
    if (!this.rcloneAvailable) throw new Error('rclone not found. Install it or set its path in Settings.')
    const remote = `${dest.target.replace(/\/+$/, '')}/${file.rel_path}`
    // rclone already verifies size and, where both ends support it, hash after each upload.
    // --checksum makes it compare by hash (not modtime) when deciding whether a changed sidecar needs resending.
    // Remotes linked in the app live in ShotDrop's own rclone.conf; anything else (Advanced) uses the user's.
    const cfg = this.cloud.has(dest.target.split(':')[0]) ? this.cloud.cfgArgs() : []
    await run(toolPath(this.settings().rclonePath, 'rclone'), [
      'copyto',
      file.path,
      remote,
      '--checksum',
      '--retries',
      '2',
      '--low-level-retries',
      '10',
      '--timeout',
      '2m',
      '--contimeout',
      '20s',
      ...cfg
    ])
  }

  private changed(shotId: number): void {
    const shot = this.lib.get(shotId)
    if (shot) this.bus.emit({ type: 'shot:updated', shot })
    this.onState()
  }
}

/** Copy into a temp name beside the target, check the size, then rename, so a dropped share never leaves a truncated file that looks done. */
async function copyToFolder(root: string, file: FileRow): Promise<void> {
  // If the destination root itself is gone (NAS offline, drive unplugged), wait rather than recreate it on the wrong disk.
  await stat(root).catch((e: SyncError) => {
    throw e.code === 'ENOENT' || isUnreachable(e) ? unreachable(`${root} is not reachable`) : e
  })
  const out = join(root, ...file.rel_path.split('/'))
  const tmp = `${out}.shotdrop-part`
  mkdirSync(dirname(out), { recursive: true })
  try {
    const want = (await stat(file.path)).size
    await copyFile(file.path, tmp)
    const got = (await stat(tmp)).size
    if (got !== want) throw new Error(`Size mismatch after copy (${got} of ${want} bytes)`)
    await rename(tmp, out)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

function wants(d: Destination, f: FileRow, picked: boolean, shotKinds: Set<FileKind>): boolean {
  if (f.kind === 'sidecar') {
    // A sidecar follows its photos: it goes wherever at least one of them goes.
    const photoKinds = [...shotKinds].filter((k) => k !== 'sidecar')
    return photoKinds.some((k) => wants(d, { ...f, kind: k }, picked, shotKinds))
  }
  switch (d.filter) {
    case 'jpeg':
      return f.kind === 'jpeg' || f.kind === 'heif'
    case 'raw':
      return f.kind === 'raw'
    case 'picks':
      return picked
    default:
      return true
  }
}
