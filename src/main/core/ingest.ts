import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { copyFile, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { Library } from './library'
import type { Previewer } from './media'
import { fileKind, isImage, readExif } from './media'
import type { Bus } from './events'

export interface IngestOptions {
  /** Move the file into the library (FTP incoming) or copy it (watched card/folder, leave the original). */
  mode: 'move' | 'copy'
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

  constructor(
    private lib: Library,
    private previews: Previewer,
    private bus: Bus,
    private getLibraryDir: () => string,
    private onFileAdded: (fileId: number, shotId: number) => void
  ) {}

  get incomingDir(): string {
    return join(this.getLibraryDir(), '.incoming')
  }

  /** Watch the FTP incoming dir (move) and any user folders (copy). */
  async start(watchFolders: string[]): Promise<void> {
    await this.stop()
    mkdirSync(this.incomingDir, { recursive: true })
    const stable = { stabilityThreshold: 600, pollInterval: 150 }

    const incoming = watch(this.incomingDir, { ignoreInitial: false, awaitWriteFinish: stable })
    incoming.on('add', (p) => this.enqueue(p, { mode: 'move', source: this.sourceFromIncoming(p) }))
    this.watchers.push(incoming)

    for (const folder of watchFolders.filter((f) => existsSync(f))) {
      const w = watch(folder, { ignoreInitial: true, awaitWriteFinish: stable })
      w.on('add', (p) => this.enqueue(p, { mode: 'copy', source: basename(folder) }))
      this.watchers.push(w)
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.map((w) => w.close()))
    this.watchers = []
  }

  /** FTP user name is the first folder under .incoming. */
  sourceFromIncoming(p: string): string | null {
    const rel = relative(this.incomingDir, p)
    const first = rel.split(sep)[0]
    return first && first !== rel ? first : null
  }

  enqueue(path: string, opts: IngestOptions): void {
    if (!isImage(path) || this.queued.has(path)) return
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
        await this.ingest(job.path, job.opts)
      } catch (e) {
        this.bus.emit({ type: 'ingest:error', file: job.path, error: e instanceof Error ? e.message : String(e) })
      } finally {
        this.queued.delete(job.path)
      }
    }
    this.running = false
  }

  private async ingest(path: string, opts: IngestOptions): Promise<void> {
    if (!existsSync(path)) return
    const size = statSync(path).size
    if (size === 0) return

    const hash = await hashFile(path)
    if (this.lib.findFileByHash(hash)) {
      // Camera re-sent a frame we already have.
      if (opts.mode === 'move') await unlink(path).catch(() => undefined)
      return
    }

    const exif = await readExif(path).catch(() => null)
    const capturedAt = exif?.capturedAt ?? Date.now()
    const session = localDate(capturedAt)
    const libDir = this.getLibraryDir()
    const destDir = join(libDir, session)
    mkdirSync(destDir, { recursive: true })

    const ext = extname(path)
    const stem = basename(path, ext)
    let destName = basename(path)
    let n = 1
    while (existsSync(join(destDir, destName)) || this.lib.pathTaken(join(destDir, destName))) {
      destName = `${stem}-${n++}${ext}`
    }
    const dest = join(destDir, destName)
    if (opts.mode === 'move') await moveFile(path, dest)
    else await copyFile(path, dest)

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
        await this.previews.render(shotId, best.path, this.lib.orientation(shotId))
        this.lib.setPreview(shotId, best.id)
      } catch (e) {
        this.bus.emit({ type: 'ingest:error', file: dest, error: `Preview failed: ${String(e)}` })
      }
    }

    this.onFileAdded(fileId, shotId)
    const shot = this.lib.get(shotId)!
    this.bus.emit(created ? { type: 'shot:added', shot } : { type: 'shot:updated', shot })

    // Tidy empty camera sub-folders under .incoming.
    if (opts.mode === 'move') {
      const parent = dirname(path)
      if (parent !== this.incomingDir && parent.startsWith(this.incomingDir)) {
        await rmdir(parent).catch(() => undefined)
      }
    }
  }
}
