import { exiftool, type Tags } from 'exiftool-vendored'
import sharp, { type Sharp } from 'sharp'
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FileKind, ShotSource } from '@shared/types'
import { bundledBin } from './bundled'

// libvips keeps files it has read open in its cache; on Windows that makes deleting/renaming them fail with EPERM.
sharp.cache(false)

const RAW_EXT = new Set([
  '.arw', '.cr2', '.cr3', '.nef', '.nrw', '.raf', '.dng', '.orf', '.rw2', '.pef', '.srw', '.3fr', '.iiq', '.x3f'
])
const JPEG_EXT = new Set(['.jpg', '.jpeg'])
const HEIF_EXT = new Set(['.heif', '.heic', '.hif'])

export function fileKind(path: string): FileKind {
  const ext = extname(path).toLowerCase()
  if (JPEG_EXT.has(ext)) return 'jpeg'
  if (HEIF_EXT.has(ext)) return 'heif'
  if (RAW_EXT.has(ext)) return 'raw'
  return 'other'
}

export function isImage(path: string): boolean {
  return fileKind(path) !== 'other'
}

export interface Exif {
  capturedAt: number | null
  camera: string | null
  lens: string | null
  iso: number | null
  shutter: string | null
  aperture: number | null
  focalLength: number | null
  width: number | null
  height: number | null
  orientation: number | null
}

function toEpoch(v: unknown): number | null {
  if (!v || typeof v === 'number') return null
  if (typeof v === 'string') {
    const t = Date.parse(v.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'))
    return Number.isNaN(t) ? null : t
  }
  // ExifDateTime without a zone is treated as local wall-clock time.
  const d = v as unknown as { toMillis?: () => number }
  return typeof d.toMillis === 'function' ? d.toMillis() : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export async function readExif(path: string): Promise<Exif> {
  const t = await exiftool.read(path)
  const make = t.Make?.trim()
  const model = t.Model?.trim()
  const camera = model ? (make && !model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? `${make} ${model}` : model) : null
  const exposure = t.ExposureTime
  return {
    capturedAt: toEpoch(t.SubSecDateTimeOriginal ?? t.DateTimeOriginal ?? t.CreateDate),
    camera,
    lens: (t.LensModel ?? t.LensID ?? t.Lens ?? null) as string | null,
    iso: num(t.ISO),
    shutter: exposure != null ? String(exposure) : null,
    aperture: num(t.FNumber),
    focalLength: num(t.FocalLength),
    width: num(t.ImageWidth),
    height: num(t.ImageHeight),
    orientation: num(t.Orientation)
  }
}

export interface LumaStats {
  hist: number[] // 64 luminance bins, scaled so the tallest is 100
  clipped: number // % of pixels at or near pure white
}

/** Luminance histogram + highlight clipping from the already-rendered thumbnail (cheap, 480px). */
async function lumaStats(path: string): Promise<LumaStats> {
  const px = await sharp(path).greyscale().raw().toBuffer()
  const bins = new Array<number>(64).fill(0)
  let clip = 0
  for (const v of px) {
    bins[v >> 2]++
    if (v >= 250) clip++
  }
  const max = Math.max(...bins, 1)
  return { hist: bins.map((b) => Math.round((b / max) * 100)), clipped: Math.round((clip / Math.max(px.length, 1)) * 1000) / 10 }
}

const ORIENT_TO_DEG: Record<number, number> = { 3: 180, 6: 90, 8: 270 }

/**
 * Renders a small thumbnail and a screen-sized preview for a file.
 * JPEGs decode directly; RAW/HEIF use the camera's embedded JPEG (fast, and what the camera showed on its LCD).
 */
export class Previewer {
  readonly thumbDir: string
  readonly previewDir: string
  readonly fullDir: string // full-resolution renditions made on demand: <id>.embedded.jpg, <id>.raw.jpg (+ .json size info)
  private queue: Promise<unknown> = Promise.resolve()
  private inflight = new Map<string, Promise<ShotSource>>()

  constructor(cacheDir: string) {
    this.fullDir = join(cacheDir, 'full')
    mkdirSync(this.fullDir, { recursive: true })
    this.thumbDir = join(cacheDir, 'thumbs')
    this.previewDir = join(cacheDir, 'previews')
    mkdirSync(this.thumbDir, { recursive: true })
    mkdirSync(this.previewDir, { recursive: true })
  }

  thumbPath(shotId: number): string {
    return join(this.thumbDir, `${shotId}.jpg`)
  }

  previewPath(shotId: number): string {
    return join(this.previewDir, `${shotId}.jpg`)
  }

  async render(shotId: number, sourcePath: string, orientation: number | null): Promise<LumaStats> {
    const kind = fileKind(sourcePath)
    let input = sourcePath
    let rotate: number | undefined // undefined = auto-rotate from EXIF in the input
    let tmp: string | null = null

    if (kind !== 'jpeg') {
      tmp = join(tmpdir(), `shotdrop-${randomUUID()}.jpg`)
      await extractEmbeddedJpeg(sourcePath, tmp)
      input = tmp
      // Embedded previews usually lack orientation; use the RAW's.
      rotate = ORIENT_TO_DEG[orientation ?? 1] ?? 0
    }

    try {
      const base = (): Sharp => (rotate === undefined ? sharp(input).rotate() : sharp(input).rotate(rotate))
      await Promise.all([
        base().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(this.previewPath(shotId)),
        base().resize({ width: 480, height: 480, fit: 'inside' }).jpeg({ quality: 75 }).toFile(this.thumbPath(shotId))
      ])
      return await lumaStats(this.thumbPath(shotId))
    } finally {
      if (tmp) rmQuiet(tmp)
    }
  }

  clear(shotId: number): void {
    rmSync(this.thumbPath(shotId), { force: true })
    rmSync(this.previewPath(shotId), { force: true })
    for (const k of ['embedded', 'raw']) for (const e of ['jpg', 'json']) rmSync(this.fullPath(shotId, k, e), { force: true })
  }

  fullPath(shotId: number, key: string, ext = 'jpg'): string {
    return join(this.fullDir, `${shotId}.${key}.${ext}`)
  }

  /** Cached size info for a developed rendition, or null if it hasn't been made. */
  cached(shotId: number, key: 'embedded' | 'raw'): ShotSource | null {
    try {
      if (!existsSync(this.fullPath(shotId, key))) return null
      return JSON.parse(readFileSync(this.fullPath(shotId, key, 'json'), 'utf8')) as ShotSource
    } catch {
      return null
    }
  }

  /** Full-size embedded JPEG of a RAW (the largest the camera stored), rotated upright. Cheap; cached. */
  embedded(shotId: number, rawPath: string, orientation: number | null): Promise<ShotSource> {
    return this.once(`${shotId}:embedded`, async () => {
      const hit = this.cached(shotId, 'embedded')
      if (hit) return hit
      const tmp = join(tmpdir(), `shotdrop-${randomUUID()}.jpg`)
      try {
        const found = await extractEmbeddedJpeg(rawPath, tmp)
        const deg = ORIENT_TO_DEG[orientation ?? 1] ?? 0
        const dest = this.fullPath(shotId, 'embedded')
        if (deg) await sharp(tmp).rotate(deg).jpeg({ quality: 95 }).toFile(dest)
        else writeFileSync(dest, readFileSync(tmp)) // lossless: keep the camera's own JPEG bytes
        const m = await sharp(dest).metadata()
        return this.remember(shotId, { key: 'embedded', label: 'Camera preview', width: m.width ?? null, height: m.height ?? null, ready: true, detail: found, bytes: statSync(dest).size })
      } finally {
        rmQuiet(tmp)
      }
    })
  }

  /** Real RAW decode (LibRaw dcraw_emu) to a full-resolution JPEG. Seconds per frame; one at a time. */
  develop(shotId: number, rawPath: string): Promise<ShotSource> {
    return this.once(`${shotId}:raw`, async () => {
      const hit = this.cached(shotId, 'raw')
      if (hit) return hit
      const t = Date.now()
      const tiff = await decodeRaw(rawPath)
      const dest = this.fullPath(shotId, 'raw')
      const info = await sharp(tiff).jpeg({ quality: 92 }).toFile(dest) // dcraw_emu already applies EXIF orientation
      return this.remember(shotId, { key: 'raw', label: 'RAW decode', width: info.width, height: info.height, ready: true, detail: `LibRaw, ${((Date.now() - t) / 1000).toFixed(1)}s`, bytes: info.size })
    })
  }

  private remember(shotId: number, s: ShotSource): ShotSource {
    writeFileSync(this.fullPath(shotId, s.key, 'json'), JSON.stringify(s))
    return s
  }

  /** Serialise heavy work (RAW decode is CPU/RAM hungry) and share the result between concurrent callers. */
  private once(key: string, job: () => Promise<ShotSource>): Promise<ShotSource> {
    let p = this.inflight.get(key)
    if (!p) {
      p = this.queue.then(job, job)
      this.queue = p.catch(() => undefined)
      this.inflight.set(key, p)
      const done = (): void => void this.inflight.delete(key)
      p.then(done, done)
    }
    return p
  }
}

const DCRAW_NAME = 'dcraw_emu'

/** The bundled LibRaw decoder: packaged resources/bin, a dev checkout's resources/bin/win-x64, else PATH (Linux/macOS libraw-bin). */
export function rawDecoderPath(): string | null {
  const exe = process.platform === 'win32' ? `${DCRAW_NAME}.exe` : DCRAW_NAME
  const dev = join(process.cwd(), 'resources', 'bin', 'win-x64', exe)
  const found = bundledBin(DCRAW_NAME) ?? (existsSync(dev) ? dev : null)
  if (found) return found
  return process.platform === 'win32' ? null : DCRAW_NAME
}

/** dcraw_emu -w (camera white balance) -T (TIFF) to stdout. Returns the 8-bit sRGB TIFF. */
function decodeRaw(rawPath: string): Promise<Buffer> {
  const bin = rawDecoderPath()
  if (!bin) return Promise.reject(new Error('RAW decoder (dcraw_emu) is not installed. Run `npm run fetch-binaries`.'))
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-w', '-T', '-Z', '-', rawPath], { windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => out.push(c))
    p.stderr.on('data', (c: Buffer) => (err += c))
    p.on('error', reject)
    p.on('close', (code) => {
      const buf = Buffer.concat(out)
      if (buf.length) resolve(buf)
      // 0xC0000135 = STATUS_DLL_NOT_FOUND: the Microsoft VC++ runtime that LibRaw's build links against is missing.
      else if (code === 0xc0000135 || code === -1073741515)
        reject(new Error('Develop RAW needs the Microsoft Visual C++ Redistributable (x64). Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and try again.'))
      else reject(new Error(`RAW decode failed (exit ${code}): ${err.trim().slice(0, 200)}`))
    })
  })
}

/** Extracts every embedded JPEG (JpgFromRaw / PreviewImage / ThumbnailImage) and keeps the one with the most pixels. */
async function extractEmbeddedJpeg(src: string, dest: string): Promise<string> {
  const tags: [string, (d: string) => Promise<void>][] = [
    ['JpgFromRaw', (d) => exiftool.extractJpgFromRaw(src, d)],
    ['PreviewImage', (d) => exiftool.extractPreview(src, d)],
    ['ThumbnailImage', (d) => exiftool.extractThumbnail(src, d)]
  ]
  let best: { tag: string; file: string; px: number } | null = null
  let lastErr: unknown
  for (const [tag, run] of tags) {
    const file = `${dest}.${tag}`
    try {
      await run(file)
      const m = await sharp(file).metadata()
      const px = (m.width ?? 0) * (m.height ?? 0)
      if (px > (best?.px ?? 0)) {
        if (best) rmQuiet(best.file)
        best = { tag, file, px }
      } else rmQuiet(file)
    } catch (e) {
      lastErr = e
      rmQuiet(file)
    }
  }
  if (!best) throw new Error(`No embedded preview found in ${src}: ${String(lastErr)}`)
  writeFileSync(dest, readFileSync(best.file))
  rmQuiet(best.file)
  return best.tag
}

export async function shutdownMedia(): Promise<void> {
  await exiftool.end()
}

/** Temp-file cleanup must never fail the job (Windows keeps files locked while libvips still has them open). */
const rmQuiet = (p: string): void => {
  try {
    rmSync(p, { force: true })
  } catch {
    /* leaked temp file: the OS cleans %TEMP% eventually */
  }
}
