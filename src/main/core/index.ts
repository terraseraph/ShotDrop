import { join } from 'node:path'
import { mkdirSync, statfsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { Settings, ShotPatch, Status } from '@shared/types'
import { ConfigStore } from './config'
import { openDb, type DB } from './db'
import { Library } from './library'
import { Previewer, shutdownMedia } from './media'
import { Ingestor } from './ingest'
import { FtpService } from './ftp'
import { SyncService } from './sync'
import { Bus } from './events'
import { lanAddresses } from './net'
import { TunnelService } from './tunnel'
import { XmpService } from './xmp'

export interface CoreOptions {
  dataDir: string // settings, DB, preview cache
  picturesDir: string // default library parent
  version: string
  /** Send a file to the OS recycle bin. Defaults to permanent delete only if nothing else is provided. */
  trash?: (path: string) => Promise<void>
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
  readonly ingest: Ingestor
  readonly ftp: FtpService
  readonly sync: SyncService
  readonly xmp: XmpService
  readonly tunnel: TunnelService
  apiState = { port: 0, remote: false }

  constructor(private opts: CoreOptions) {
    mkdirSync(opts.dataDir, { recursive: true })
    this.config = new ConfigStore(opts.dataDir, opts.picturesDir)
    this.db = openDb(opts.dataDir)
    this.lib = new Library(this.db)
    this.previews = new Previewer(join(opts.dataDir, 'cache'))
    this.sync = new SyncService(this.lib, this.bus, () => this.settings, () => this.emitStatus())
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
      if (e.type === 'shot:added') this.emitStatus()
    })
    this.tunnel = new TunnelService(join(opts.dataDir, 'bin'), () => this.settings.tunnel.cloudflaredPath, () => this.emitStatus())
  }

  get settings(): Settings {
    return this.config.get()
  }

  async start(): Promise<void> {
    mkdirSync(this.settings.libraryDir, { recursive: true })
    await this.ingest.start(this.settings.watchFolders)
    if (this.settings.ftp.enabled) await this.ftp.start(this.settings.ftp)
    await this.sync.start()
    await this.tunnel.refreshInstalled()
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
    const addrs = lanAddresses()
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
      ftp: { ...this.ftp.state, port: s.ftp.port, addresses: addrs },
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

    if (changed('ftp')) {
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

  async deleteShot(id: number): Promise<boolean> {
    this.xmp.cancel(id)
    const files = this.lib.files(id)
    if (!files.length && !this.lib.get(id)) return false
    for (const f of files) {
      if (this.opts.trash) await this.opts.trash(f.path).catch(() => undefined)
      else await rm(f.path, { force: true })
    }
    this.lib.remove(id)
    this.previews.clear(id)
    this.bus.emit({ type: 'shot:removed', id })
    this.emitStatus()
    return true
  }
}
