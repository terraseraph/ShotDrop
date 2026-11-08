import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exiftool } from 'exiftool-vendored'
import sharp from 'sharp'
import type { RemoteFs } from './remote'
import { kindOfName } from './remote'

const MAX_IN_FLIGHT = 4
/** Bump when make() changes, so files cached as "no preview" by an older version get another try. */
const VERSION = 2

/** Tiny per-destination concurrency gate so a screen of tiles can't open dozens of provider connections. */
class Gate {
  private active = 0
  private waiting: (() => void)[] = []
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

/**
 * Thumbnails for files that are not in the local library: read the first bytes, pull the embedded preview with
 * exiftool, resize to 480 px. Returns null for "no preview" (also remembered on disk as a zero-byte marker).
 */
export class RemoteThumbs {
  private gates = new Map<string, Gate>()
  private pending = new Map<string, Promise<Buffer | null>>()

  constructor(private dir: string) {}

  private key(path: string, size: number, mtime: number): string {
    return createHash('sha1').update(`${VERSION}|${path}|${size}|${mtime}`).digest('hex')
  }

  /**
   * `hosted`: an uploaded thumbnail to read instead of the photo. `onBuilt` runs with a thumbnail made from the photo
   * itself (not a hosted or cached one), so the caller can upload it.
   */
  async get(destId: string, fs: RemoteFs, path: string, size: number, mtime: number, hosted?: string, onBuilt?: (jpg: Buffer) => void): Promise<Buffer | null> {
    const file = join(this.dir, destId.replace(/[^\w-]/g, '_'), `${this.key(path, size, mtime)}.jpg`)
    const cached = await readFile(file).catch(() => null)
    if (cached) return cached.length ? cached : null
    const existing = this.pending.get(file)
    if (existing) return existing
    let gate = this.gates.get(destId)
    if (!gate) this.gates.set(destId, (gate = new Gate()))
    const job = gate
      .run(async () => {
        const up = hosted ? await this.hosted(fs, hosted) : null
        const jpg = up ?? (await this.make(fs, path, size).catch((e: Error) => {
          if (/ENOENT|not found/i.test(e.message)) return null
          throw e // unreachable or provider errors are not cached as "no preview"
        }))
        if (jpg && !up) onBuilt?.(jpg)
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, jpg ?? Buffer.alloc(0)).catch(() => undefined)
        return jpg
      })
      .finally(() => this.pending.delete(file))
    this.pending.set(file, job)
    return job
  }

  /** An uploaded thumbnail, if it is there and decodes; anything else falls back to the photo. */
  private async hosted(fs: RemoteFs, path: string): Promise<Buffer | null> {
    const buf = await fs.readRange(path, 0, 4 * 1024 * 1024).catch(() => null)
    return buf?.length ? this.resize(buf).catch(() => null) : null
  }

  private async make(fs: RemoteFs, path: string, size: number): Promise<Buffer | null> {
    const kind = kindOfName(path)
    if (kind !== 'jpeg' && kind !== 'raw' && kind !== 'heif') return null
    // 128 KB, not 64: an EXIF APP1 segment can be up to 64 KB on its own (a Nikon Z50II's is 65,534 bytes), and exiftool
    // can't find the thumbnail inside a segment that is cut short.
    const want = kind === 'raw' ? 512 * 1024 : 128 * 1024
    const head = await fs.readRange(path, 0, want)
    if (!head.length) return null
    const whole = size > 0 && size <= head.length

    // A small JPEG was read whole: resize it directly.
    if (kind === 'jpeg' && whole) {
      const direct = await this.resize(head).catch(() => null)
      if (direct) return direct
    }

    const tmp = join(this.dir, `.tmp-${createHash('sha1').update(path + Date.now() + Math.random()).digest('hex')}${kind === 'raw' ? '.raw' : '.jpg'}`)
    await mkdir(this.dir, { recursive: true })
    await writeFile(tmp, head)
    const out = `${tmp}.preview.jpg`
    try {
      for (const extract of [() => exiftool.extractPreview(tmp, out), () => exiftool.extractThumbnail(tmp, out)]) {
        try {
          await extract()
          const buf = await readFile(out)
          await rm(out, { force: true })
          if (buf.length) {
            const jpg = await this.resize(buf).catch(() => null)
            if (jpg) return jpg
          }
        } catch {
          /* try the next source */
        }
      }
      // A JPEG with no embedded thumbnail inside the first 128 KB: sharp can often decode the truncated start.
      if (kind === 'jpeg') return await this.resize(head).catch(() => null)
      return null
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
      await rm(out, { force: true }).catch(() => undefined)
    }
  }

  private resize(buf: Buffer): Promise<Buffer> {
    return sharp(buf, { failOn: 'none' }).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
  }
}
