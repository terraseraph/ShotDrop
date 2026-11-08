import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { copyFile, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { Library } from './library'
import type { Previewer } from './media'
import { fileKind, isImage, readExif } from './media'
import type { Bus } from './events'
import { XmpService } from './xmp'
import { rebuildSessions } from './sessions'

export interface IngestOptions {
  /**
   * Move the file into the library (FTP incoming), copy it (watched card/folder, leave the original),
   * or adopt it where it is (already inside a library day folder, e.g. dropped in by hand).
   */
  mode: 'move' | 'copy' | 'adopt'
  source: string | null
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function isSidecar(path: string): boolean {
  return extname(path).toLowerCase() === '.xmp'
}

function localDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
  } catch {
    // Cross-device: copy then delete.
    await copyFile(src, dest)
    await unlink(src)
  }
}

/**
 * Turns files landing on disk into library shots, one at a time and in arrival order,
 * so "follow mode" in the UI sees frames in the order they were shot.
 */
export class Ingestor {
  private queue: { path: string; opts: IngestOptions }[] = []
  private queued = new Set<string>()
  private running = false
  private watchers: FSWatcher[] = []
  /** Library files left alone because they're copies of a shot we already have; rescans skip them. */
  private libraryDupes = new Set<string>()
  /** Where the current session (ingest target) lives; wired up by Core. Clears itself once `endsAt` passes. */
  currentSessionSource: { get: () => { folder: string | null; endsAt: number | null }; clear: () => void } | null = null
  private currentTimer: NodeJS.Timeout | null = null
  /** Library paths a rename or move is shuffling: the watcher would see unlink+add and re-ingest them. Counted, so overlapping calls nest. */
  private muted = new Map<string, number>()

  constructor(
    private lib: Library,
    private previews: Previewer,
    private bus: Bus,
    private getLibraryDir: () => string,
    private onFileAdded: (fileId: number, shotId: number) => void,
    private xmp: XmpService
  ) {}

  get incomingDir(): string {
    return join(this.getLibraryDir(), '.incoming')
  }

  /** The folder new files go into, or null for the usual shoot-date folders. Also auto-clears an expired session. */
  currentFolder(): string | null {
    const src = this.currentSessionSource
    const cur = src?.get()
    if (!src || !cur?.folder) return null
    if (cur.endsAt !== null && Date.now() >= cur.endsAt) {
      src.clear()
      return null
    }
    return existsSync(join(this.getLibraryDir(), cur.folder)) ? cur.folder : null
  }

  /** Watch the FTP incoming dir (move) and any user folders (copy). */
  async start(watchFolders: string[]): Promise<void> {
    await this.stop()
    this.currentTimer = setInterval(() => this.currentFolder(), 30_000)
    this.currentTimer.unref()
    mkdirSync(this.incomingDir, { recursive: true })
    const stable = { stabilityThreshold: 600, pollInterval: 150 }

    const incoming = watch(this.incomingDir, { ignoreInitial: false, awaitWriteFinish: stable })
    incoming.on('add', (p) => this.enqueue(p, { mode: 'move', source: this.sourceFromIncoming(p) }))
    this.watchers.push(incoming)

    // Photos dropped straight into the library by hand. Dot folders (.incoming) have their own handling.
    const libDir = this.getLibraryDir()
    const lib = watch(libDir, { ignoreInitial: true, awaitWriteFinish: stable, ignored: (p) => this.isHidden(libDir, p) })
    lib.on('add', (p) => this.enqueueLibraryFile(libDir, p))
    this.watchers.push(lib)

    for (const folder of watchFolders.filter((f) => existsSync(f))) {
      const w = watch(folder, { ignoreInitial: true, awaitWriteFinish: stable })
      w.on('add', (p) => this.enqueue(p, { mode: 'copy', source: basename(folder) }))
      this.watchers.push(w)
    }

    // Catch up on anything added to the library while ShotDrop wasn't running.
    void this.rescanLibrary().catch((e) => this.bus.emit({ type: 'ingest:error', file: libDir, error: `Library rescan failed: ${String(e)}` }))
  }

  /** Queue every photo in the library that isn't in the database yet. Returns how many were queued. */
  async rescanLibrary(): Promise<number> {
    const libDir = this.getLibraryDir()
    if (!existsSync(libDir)) return 0
    await rebuildSessions(libDir, this.lib).catch(() => undefined) // cache of the .shotdrop.json files
    const entries = await readdir(libDir, { recursive: true, withFileTypes: true })
    let n = 0
    for (const e of entries) {
      if (!e.isFile()) continue
      const p = join(e.parentPath, e.name)
      if (this.isHidden(libDir, p) || !isImage(p) || this.lib.pathTaken(p) || this.libraryDupes.has(p)) continue
      this.enqueueLibraryFile(libDir, p)
      n++
    }
    return n
  }

  /** Ignore watcher events at or under these paths until unmute(). */
  mute(paths: string[]): void {
    for (const p of paths) this.muted.set(resolve(p), (this.muted.get(resolve(p)) ?? 0) + 1)
  }

  /** Lifts a mute after `holdMs`, so add events still in chokidar's write-finish window are swallowed too. */
  unmute(paths: string[], holdMs = 3000): void {
    setTimeout(() => {
      for (const p of paths) {
        const k = resolve(p)
        const n = (this.muted.get(k) ?? 1) - 1
        if (n <= 0) this.muted.delete(k)
        else this.muted.set(k, n)
      }
    }, holdMs).unref?.()
  }

  private isMuted(p: string): boolean {
    if (!this.muted.size) return false
    const r = resolve(p)
    for (const m of this.muted.keys()) if (r === m || r.startsWith(m + sep)) return true
    return false
  }

  /** Anything under a dot folder or dot file inside the library (.incoming, .trash...). */
  private isHidden(libDir: string, p: string): boolean {
    const rel = relative(libDir, p)
    return rel !== '' && rel.split(sep).some((part) => part.startsWith('.'))
  }

  /** Loose files at the library root go into a day folder; files already in a subfolder stay put. */
  private enqueueLibraryFile(libDir: string, p: string): void {
    // Sidecars next to photos are picked up with their photo; ShotDrop writes its own .xmp files here too.
    if (!isImage(p) || this.isMuted(p)) return
    this.enqueue(p, { mode: dirname(p) === libDir ? 'move' : 'adopt', source: null })
  }

  async stop(): Promise<void> {
    if (this.currentTimer) clearInterval(this.currentTimer)
    this.currentTimer = null
    await Promise.all(this.watchers.map((w) => w.close()))
    this.watchers = []
  }

  private isInLibraryRoot(path: string): boolean {
    return dirname(path) === this.getLibraryDir()
  }

  /** FTP user name is the first folder under .incoming. */
  sourceFromIncoming(p: string): string | null {
    const rel = relative(this.incomingDir, p)
    const first = rel.split(sep)[0]
    return first && first !== rel ? first : null
  }

  enqueue(path: string, opts: IngestOptions): void {
    if (!(isImage(path) || isSidecar(path)) || this.queued.has(path)) return
    this.queued.add(path)
    this.queue.push({ path, opts })
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.queue.length) {
      const job = this.queue.shift()!
      try {
        if (isSidecar(job.path)) await this.ingestSidecar(job.path, job.opts)
        else await this.ingest(job.path, job.opts)
      } catch (e) {
        this.bus.emit({ type: 'ingest:error', file: job.path, error: e instanceof Error ? e.message : String(e) })
      } finally {
        this.queued.delete(job.path)
      }
    }
    this.running = false
  }

  /** A lone .xmp: never a shot. If its photo is already in the library, adopt it; otherwise the photo's ingest picks it up. */
  private async ingestSidecar(path: string, opts: IngestOptions): Promise<void> {
    if (!existsSync(path)) return
    const shotId = this.lib.findShotByName(basename(path, extname(path)))
    if (shotId === undefined) return
    if (await this.xmp.adopt(shotId, path, true)) {
      if (opts.mode === 'move') await XmpService.discard(path)
      const shot = this.lib.get(shotId)
      if (shot) this.bus.emit({ type: 'shot:updated', shot })
    }
  }

  private async ingest(path: string, opts: IngestOptions): Promise<void> {
    if (!existsSync(path)) return
    // The library watcher also sees files ShotDrop itself just filed there.
    if (opts.mode === 'adopt' && this.lib.pathTaken(path)) return
    const size = statSync(path).size
    if (size === 0) return

    const hash = await hashFile(path)
    if (this.lib.findFileByHash(hash)) {
      // Camera re-sent a frame we already have. Never delete a file the user put in the library.
      if (opts.mode === 'adopt' || this.isInLibraryRoot(path)) this.libraryDupes.add(path)
      if (opts.mode === 'move' && !this.isInLibraryRoot(path)) await unlink(path).catch(() => undefined)
      return
    }

    const exif = await readExif(path).catch(() => null)
    const capturedAt = exif?.capturedAt ?? Date.now()
    const libDir = this.getLibraryDir()
    // A photo already inside a dated session folder ("2026-11-08 Smith wedding") belongs to that folder, not just to its date.
    const inFolder = opts.mode === 'adopt' ? relative(libDir, path).split(sep)[0] : ''
    const target = opts.mode === 'adopt' ? null : this.currentFolder() // the current session takes everything incoming, whatever its EXIF date
    const session = target ?? (inFolder && /^\d{4}-\d{2}-\d{2}( |$)/.test(inFolder) && relative(libDir, path).split(sep).length > 1 ? inFolder : localDate(capturedAt))
    const destDir = join(libDir, session)

    const ext = extname(path)
    const stem = basename(path, ext)
    let destName = basename(path)
    let dest = path
    if (opts.mode !== 'adopt') {
      mkdirSync(destDir, { recursive: true })
      let n = 1
      while (existsSync(join(destDir, destName)) || this.lib.pathTaken(join(destDir, destName))) {
        destName = `${stem}-${n++}${ext}`
      }
      dest = join(destDir, destName)
      if (opts.mode === 'move') await moveFile(path, dest)
      else await copyFile(path, dest)
    }

    // RAW+JPEG with the same stem become one shot. A renamed duplicate name is its own shot.
    const name = basename(destName, ext)
    const { id: shotId, created } = this.lib.upsertShot({
      key: `${session}/${name.toLowerCase()}`,
      session,
      name,
      capturedAt,
      camera: exif?.camera ?? null,
      lens: exif?.lens ?? null,
      iso: exif?.iso ?? null,
      shutter: exif?.shutter ?? null,
      aperture: exif?.aperture ?? null,
      focalLength: exif?.focalLength ?? null,
      width: exif?.width ?? null,
      height: exif?.height ?? null,
      orientation: exif?.orientation ?? null,
      source: opts.source
    })

    const fileId = this.lib.addFile({
      shot_id: shotId,
      path: dest,
      rel_path: relative(libDir, dest).split(sep).join('/'),
      name: destName,
      kind: fileKind(dest),
      size,
      hash
    })

    // Re-render the preview if this file is now the best source (e.g. JPEG arrived after the RAW).
    const best = this.lib.bestPreviewSource(shotId)
    if (best && best.id !== this.lib.previewFileId(shotId)) {
      try {
        const stats = await this.previews.render(shotId, best.path, this.lib.orientation(shotId))
        this.lib.setPreview(shotId, best.id, stats)
      } catch (e) {
        this.bus.emit({ type: 'ingest:error', file: dest, error: `Preview failed: ${String(e)}` })
      }
    }

    this.onFileAdded(fileId, shotId)

    // A sidecar next to the source photo carries its rating/label: import it (new shots only) and keep it with the shot.
    const srcSidecar = [join(dirname(path), `${stem}.xmp`), join(dirname(path), `${stem}.XMP`)].find((p) => existsSync(p))
    if (srcSidecar) {
      try {
        if (await this.xmp.adopt(shotId, srcSidecar, created)) {
          if (opts.mode === 'move') await XmpService.discard(srcSidecar)
        }
      } catch (e) {
        this.bus.emit({ type: 'ingest:error', file: srcSidecar, error: `Sidecar import failed: ${String(e)}` })
      }
    }
    const shot = this.lib.get(shotId)!
    this.bus.emit(created ? { type: 'shot:added', shot } : { type: 'shot:updated', shot })

    // Tidy empty camera sub-folders under .incoming.
    if (opts.mode === 'move') {
      const parent = dirname(path)
      // Never remove the FTP user's own folder (first level): the FTP session's root lives there and the next STOR would 550.
      if (dirname(parent) !== this.incomingDir && parent.startsWith(this.incomingDir)) {
        await rmdir(parent).catch(() => undefined)
      }
    }
  }
}
