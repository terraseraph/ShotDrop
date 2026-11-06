import { join } from 'node:path'
import { existsSync, mkdirSync, statfsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { Settings, ShotPatch, Status } from '@shared/types'
import { ConfigStore } from './config'
import { openDb, type DB } from './db'
import { Library } from './library'
import { Previewer, lumaStats, shutdownMedia } from './media'
import { MetadataStore } from './metadata'
import { Ingestor } from './ingest'
import { FtpService } from './ftp'
import { SyncService } from './sync'
import { CloudAccounts } from './cloud'
import { toolPath } from './bundled'
import { Bus } from './events'
import { listInterfaces } from './net'
import { TunnelService } from './tunnel'
import { XmpService } from './xmp'

export interface CoreOptions {
  dataDir: string // settings, DB, preview cache
  picturesDir: string // default library parent
  version: string
  /** Send a file to the OS recycle bin. Defaults to permanent delete only if nothing else is provided. */
  trash?: (path: string) => Promise<void>
  /** Optional face/blink scanner (needs a browser runtime, so the host supplies it). Without it faces stay unscanned. */
  detectFaces?: (imagePath: string) => Promise<{ faces: number; blink: number | null } | null>
}

/**
 * Everything that isn't UI: FTP ingest, library, previews, sync. Has no Electron dependency,
 * so it can later run headless (e.g. on a NAS or the NXS box) behind the same REST API.
 */
export class Core {
  readonly bus = new Bus()
  readonly config: ConfigStore
  readonly db: DB
  readonly lib: Library
  readonly previews: Previewer
  readonly meta: MetadataStore
  readonly ingest: Ingestor
  readonly ftp: FtpService
  readonly sync: SyncService
  readonly cloud: CloudAccounts
  readonly xmp: XmpService
  readonly tunnel: TunnelService
  apiState = { port: 0, remote: false }

  constructor(private opts: CoreOptions) {
    mkdirSync(opts.dataDir, { recursive: true })
    this.config = new ConfigStore(opts.dataDir, opts.picturesDir)
    this.db = openDb(opts.dataDir)
    this.lib = new Library(this.db)
    this.previews = new Previewer(join(opts.dataDir, 'cache'))
    this.cloud = new CloudAccounts(join(opts.dataDir, 'rclone.conf'), () => toolPath(this.settings.rclonePath, 'rclone'))
    this.meta = new MetadataStore(join(opts.dataDir, 'cache'))
    this.sync = new SyncService(this.lib, this.bus, () => this.settings, () => this.emitStatus(), this.cloud)
    this.xmp = new XmpService(
      this.lib,
      this.bus,
      () => this.settings,
      () => this.settings.libraryDir,
      (fileId, shotId) => this.sync.sidecarChanged(fileId, shotId)
    )
    this.ingest = new Ingestor(
      this.lib,
      this.previews,
      this.bus,
      () => this.settings.libraryDir,
      (fileId, shotId) => this.sync.fileAdded(fileId, shotId),
      this.xmp
    )
    this.ftp = new FtpService(
      () => this.ingest.incomingDir,
      (path, user) => this.ingest.enqueue(path, { mode: 'move', source: user }),
      () => this.emitStatus()
    )
    this.bus.on((e) => {
      if (e.type === 'shot:added') {
        this.emitStatus()
        void this.faceScan()
      }
    })
    this.tunnel = new TunnelService(join(opts.dataDir, 'bin'), () => this.settings.tunnel.cloudflaredPath, () => this.emitStatus())
  }

  get settings(): Settings {
    return this.config.get()
  }

  async start(): Promise<void> {
    mkdirSync(this.settings.libraryDir, { recursive: true })
    this.ftp.preferredAddress = this.settings.ftp.preferredAddress
    await this.ingest.start(this.settings.watchFolders)
    if (this.settings.ftp.enabled) await this.ftp.start(this.settings.ftp)
    await this.sync.start()
    await this.tunnel.refreshInstalled()
    void this.scoreBackfill().then(() => this.faceScan())
  }

  private faceBusy = false
  private faceTried = new Set<number>() // failed this run; don't spin on them

  /** One scan loop at a time; re-queries so shots that arrive mid-scan are picked up too. */
  private async faceScan(): Promise<void> {
    const detect = this.opts.detectFaces
    if (!detect || this.faceBusy) return
    this.faceBusy = true
    try {
      for (;;) {
        const id = this.lib.unfacedIds().find((i) => !this.faceTried.has(i))
        if (id === undefined) break
        this.faceTried.add(id)
        const r = await detect(this.previews.previewPath(id)).catch(() => null)
        if (!r) continue
        this.lib.setFaces(id, r.faces, r.blink)
        const shot = this.lib.get(id)
        if (shot) this.bus.emit({ type: 'shot:updated', shot })
      }
    } finally {
      this.faceBusy = false
    }
  }

  /** Score shots that were imported before sharpness/hash existed, from their cached thumbnails. */
  private async scoreBackfill(): Promise<void> {
    for (const id of this.lib.unscoredIds()) {
      try {
        this.lib.setScores(id, await lumaStats(this.previews.thumbPath(id)))
        const shot = this.lib.get(id)
        if (shot) this.bus.emit({ type: 'shot:updated', shot })
      } catch {
        /* thumbnail missing: leave unscored */
      }
    }
  }

  /** Call once the API is listening. */
  async startTunnel(): Promise<void> {
    await this.tunnel.start(this.settings.api.port)
  }

  async stop(): Promise<void> {
    this.sync.stop()
    await this.tunnel.stop()
    await this.ftp.stop()
    await this.ingest.stop()
    await this.xmp.drain()
    await shutdownMedia()
    this.db.close()
  }

  status(): Status {
    const s = this.settings
    const pref = s.ftp.preferredAddress
    const interfaces = listInterfaces(pref)
    const addrs = interfaces.map((i) => i.address)
    const preferredMissing = pref && !addrs.includes(pref) ? pref : null
    const midnight = new Date().setHours(0, 0, 0, 0)
    const stats = this.lib.sourceStats(midnight)
    const prog = this.lib.destProgress()
    const bps = this.sync.throughput()
    let free: number | null = null
    let total: number | null = null
    try {
      const f = statfsSync(s.libraryDir)
      free = f.bavail * f.bsize
      total = f.blocks * f.bsize
    } catch {
      /* folder missing or unsupported fs: leave the gauge empty */
    }
    return {
      version: this.opts.version,
      ftp: { ...this.ftp.state, port: s.ftp.port, addresses: addrs, interfaces, preferredMissing },
      api: {
        port: this.apiState.port,
        remote: this.apiState.remote,
        urls: this.apiState.remote ? addrs.map((a) => `http://${a}:${this.apiState.port}`) : [`http://127.0.0.1:${this.apiState.port}`]
      },
      library: { dir: s.libraryDir, shots: this.lib.count(), free, total },
      sync: { ...this.lib.syncCounts(), rcloneAvailable: this.sync.rcloneAvailable },
      tunnel: this.tunnel.state,
      cameras: s.ftp.users.map((u) => ({
        username: u.username,
        label: u.label,
        connected: this.ftp.isConnected(u.username),
        lastAt: stats[u.username]?.lastAt ?? null,
        today: stats[u.username]?.today ?? 0
      })),
      destinations: s.destinations.map((d) => ({
        id: d.id,
        name: d.name,
        target: d.target,
        filter: d.filter,
        done: prog[d.id]?.done ?? 0,
        total: prog[d.id]?.total ?? 0,
        running: prog[d.id]?.running ?? 0,
        errors: prog[d.id]?.errors ?? 0,
        bps: bps[d.id] ?? 0
      }))
    }
  }

  emitStatus(): void {
    this.bus.emit({ type: 'status', status: this.status() })
  }

  /** Apply a settings change and restart whichever services it affects. Returns true if the API must restart. */
  async updateSettings(patch: Partial<Settings>): Promise<{ settings: Settings; restartApi: boolean }> {
    const before = this.settings
    const after = this.config.update(patch)
    const changed = (k: keyof Settings): boolean => JSON.stringify(before[k]) !== JSON.stringify(after[k])

    this.ftp.preferredAddress = after.ftp.preferredAddress
    // Picking a different host address must not drop camera connections, so it doesn't count as an FTP change.
    const ftpOf = (f: Settings['ftp']): string => JSON.stringify({ ...f, preferredAddress: null })
    if (ftpOf(before.ftp) !== ftpOf(after.ftp)) {
      if (after.ftp.enabled) await this.ftp.start(after.ftp)
      else await this.ftp.stop()
    }
    if (changed('libraryDir') || changed('watchFolders')) {
      mkdirSync(after.libraryDir, { recursive: true })
      await this.ingest.start(after.watchFolders)
    }
    if (changed('xmpSidecars') && after.xmpSidecars) for (const s of this.lib.list({}).items) this.xmp.schedule(s.id)
    if (changed('rclonePath')) await this.sync.start()
    if (changed('tunnel')) await this.tunnel.refreshInstalled()
    if (changed('destinations')) {
      for (const d of after.destinations) if (!before.destinations.some((b) => b.id === d.id)) this.sync.backfill(d)
      for (const b of before.destinations) if (!after.destinations.some((d) => d.id === b.id)) this.lib.dropSyncForDest(b.id)
    }
    this.emitStatus()
    return { settings: after, restartApi: changed('remote') || changed('api') }
  }

  updateShot(id: number, patch: ShotPatch) {
    const prev = this.lib.get(id)
    const shot = this.lib.update(id, patch)
    if (shot) {
      if (shot.flag === 1 && prev?.flag !== 1) this.sync.shotPicked(id)
      this.xmp.schedule(id)
      this.bus.emit({ type: 'shot:updated', shot })
    }
    return shot
  }

  /**
   * Removes a shot's files from disk (recycle bin first; a permanent delete if the bin refuses) and then from the library.
   * Windows can hold a file briefly (antivirus, preview decoder), so each file gets a few tries. A file that still can't
   * be removed is reported back, and its shot stays in the library, so nothing is left on disk with nothing pointing to it.
   */
  async deleteShot(id: number): Promise<DeleteResult | null> {
    this.xmp.cancel(id)
    const files = this.lib.files(id)
    if (!files.length && !this.lib.get(id)) return null
    const failed: DeleteResult['failed'] = []
    for (const f of files) {
      const error = await removeFromDisk(f.path, this.opts.trash)
      if (error) failed.push({ name: f.name, path: f.path, error })
      else {
        this.lib.removeFile(f.id)
        this.meta.clear(f.id)
      }
    }
    if (failed.length) {
      const shot = this.lib.get(id)
      if (shot) this.bus.emit({ type: 'shot:updated', shot })
      return { deleted: false, failed }
    }
    this.lib.remove(id)
    this.previews.clear(id)
    this.bus.emit({ type: 'shot:removed', id })
    this.emitStatus()
    return { deleted: true, failed: [] }
  }
}

export interface DeleteResult {
  deleted: boolean
  failed: { name: string; path: string; error: string }[]
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Recycle bin, retried; then a permanent delete, retried. Returns null once the file is gone, else the last error. */
async function removeFromDisk(path: string, trash?: (p: string) => Promise<void>): Promise<string | null> {
  const steps: (() => Promise<unknown>)[] = [
    ...(trash ? [() => trash(path), () => trash(path)] : []),
    () => rm(path, { force: true }),
    () => rm(path, { force: true })
  ]
  let error = 'still on disk after deleting'
  for (let i = 0; i < steps.length; i++) {
    if (!existsSync(path)) return null
    try {
      await steps[i]()
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      error = err.code === 'EBUSY' || err.code === 'EPERM' ? 'the file is open in another program' : err.message
    }
    if (!existsSync(path)) return null
    await pause(250 * (i + 1))
  }
  return existsSync(path) ? error : null
}
