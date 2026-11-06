import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Destination, Settings } from '@shared/types'
import type { FileRow, Library } from './library'
import type { Bus } from './events'

const CONCURRENCY = 2
const MAX_ATTEMPTS = 5

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').pop() || `exit ${code}`))))
  })
}

/** Background queue pushing library files to each destination. State lives in SQLite, so it survives restarts. */
export class SyncService {
  private active = 0
  private timer: NodeJS.Timeout | null = null
  rcloneAvailable = false

  constructor(
    private lib: Library,
    private bus: Bus,
    private settings: () => Settings,
    private onState: () => void
  ) {}

  async start(): Promise<void> {
    this.rcloneAvailable = await run(this.settings().rclonePath, ['version']).then(
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
      if (d.enabled && wants(d, file, shot.flag === 1)) this.lib.enqueueSync(fileId, d.id)
    }
    this.pump()
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
    for (const f of this.lib.allFiles()) {
      if (wants(dest, f, picked.has(f.shot_id))) {
        this.lib.enqueueSync(f.id, dest.id)
        n++
      }
    }
    this.pump()
    return n
  }

  pump(): void {
    const free = CONCURRENCY - this.active
    if (free <= 0) return
    const jobs = this.lib.nextSyncJobs(free)
    for (const job of jobs) {
      const dest = this.settings().destinations.find((d) => d.id === job.dest_id)
      const file = this.lib.file(job.file_id)
      if (!dest || !dest.enabled || !file) continue
      this.active++
      this.lib.setSyncStatus(job.id, 'running')
      this.changed(file.shot_id)
      this.transfer(dest, file)
        .then(() => this.lib.setSyncStatus(job.id, 'done'))
        .catch((e: Error) => {
          // Keep retrying on the next pump until MAX_ATTEMPTS, then leave it in 'error' for the user.
          this.lib.setSyncStatus(job.id, 'error', e.message)
          if (job.attempts + 1 < MAX_ATTEMPTS) setTimeout(() => this.lib.retryFailedSync(dest.id), 15000 * (job.attempts + 1))
        })
        .finally(() => {
          this.active--
          this.changed(file.shot_id)
          this.pump()
        })
    }
  }

  private async transfer(dest: Destination, file: FileRow): Promise<void> {
    if (dest.type === 'folder') {
      const out = join(dest.target, ...file.rel_path.split('/'))
      mkdirSync(dirname(out), { recursive: true })
      await copyFile(file.path, out)
      return
    }
    if (!this.rcloneAvailable) throw new Error('rclone not found. Install it or set its path in Settings.')
    const remote = `${dest.target.replace(/\/+$/, '')}/${file.rel_path}`
    await run(this.settings().rclonePath, ['copyto', file.path, remote, '--retries', '2'])
  }

  private changed(shotId: number): void {
    const shot = this.lib.get(shotId)
    if (shot) this.bus.emit({ type: 'shot:updated', shot })
    this.onState()
  }
}

function wants(d: Destination, f: FileRow, picked: boolean): boolean {
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
