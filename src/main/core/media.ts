import { exiftool, type Tags } from 'exiftool-vendored'
import sharp, { type Sharp } from 'sharp'
import { mkdirSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FileKind } from '@shared/types'
import { toolPath } from './bundled'

const execFileP = promisify(execFile)

const RAW_EXT = new Set([
  '.arw', '.cr2', '.cr3', '.nef', '.nrw', '.raf', '.dng', '.orf', '.rw2', '.pef', '.srw', '.3fr', '.iiq', '.x3f'
])
const JPEG_EXT = new Set(['.jpg', '.jpeg'])
const HEIF_EXT = new Set(['.heif', '.heic', '.hif'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m4v'])

export function fileKind(path: string): FileKind {
  const ext = extname(path).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
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
  dark: number // % of pixels at or near pure black
  sharpness: number // variance of the Laplacian; higher = sharper (only comparable between similar scenes)
  hash: string // 64-bit difference hash, 16 hex chars; near-identical frames differ in few bits
}

/** Difference hash: 9x8 greyscale, one bit per "is this pixel brighter than its right neighbour". */
async function dHash(path: string): Promise<string> {
  const px = await sharp(path).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
  let bits = 0n
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n)
  return bits.toString(16).padStart(16, '0')
}

/** Histogram, clipping, sharpness and hash from the already-rendered thumbnail (cheap, 480px). */
export async function lumaStats(path: string): Promise<LumaStats> {
  const [{ data: px, info }, hash] = await Promise.all([
    sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true }),
    dHash(path)
  ])
  const bins = new Array<number>(64).fill(0)
  let clip = 0
  let dark = 0
  for (const v of px) {
    bins[v >> 2]++
    if (v >= 250) clip++
    else if (v <= 5) dark++
  }
  // 4-neighbour Laplacian over the interior; variance of the response is the classic blur metric.
  const w = info.width
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = px[i - 1] + px[i + 1] + px[i - w] + px[i + w] - 4 * px[i]
      sum += l
      sumSq += l * l
      n++
    }
  }
  const mean = sum / Math.max(n, 1)
  const total = Math.max(px.length, 1)
  const pct = (c: number): number => Math.round((c / total) * 1000) / 10
  const max = Math.max(...bins, 1)
  return {
    hist: bins.map((b) => Math.round((b / max) * 100)),
    clipped: pct(clip),
    dark: pct(dark),
    sharpness: Math.round((sumSq / Math.max(n, 1) - mean * mean) * 10) / 10,
    hash
  }
}

const ORIENT_TO_DEG: Record<number, number> = { 3: 180, 6: 90, 8: 270 }

/**
 * Renders a small thumbnail and a screen-sized preview for a file.
 * JPEGs decode directly; RAW/HEIF use the camera's embedded JPEG (fast, and what the camera showed on its LCD).
 */
export class Previewer {
  readonly thumbDir: string
  readonly previewDir: string
  readonly proxyDir: string
  private proxying = new Set<number>()
  private proxyFailed = new Map<number, string>()

  constructor(cacheDir: string) {
    this.thumbDir = join(cacheDir, 'thumbs')
    this.previewDir = join(cacheDir, 'previews')
    this.proxyDir = join(cacheDir, 'proxies')
    mkdirSync(this.thumbDir, { recursive: true })
    mkdirSync(this.previewDir, { recursive: true })
    mkdirSync(this.proxyDir, { recursive: true })
  }

  proxyPath(shotId: number): string {
    return join(this.proxyDir, `${shotId}.mp4`)
  }

  /**
   * A 720p H.264/AAC copy any browser can play, for clips the original codec won't play in (HEVC, ProRes, 10-bit, MXF).
   * Starts the transcode once and returns at once; callers poll until `ready` (long clips outlive a tunnel request).
   */
  proxy(shotId: number, src: string): { ready: boolean; error?: string } {
    const out = this.proxyPath(shotId)
    if (existsSync(out)) return { ready: true }
    const error = this.proxyFailed.get(shotId)
    if (error) return { ready: false, error }
    if (!this.proxying.has(shotId)) {
      this.proxying.add(shotId)
      const part = join(this.proxyDir, `${shotId}.part.mp4`)
      const args = ['-v', 'error', '-y', '-i', src, '-sn', '-dn', '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', part]
      execFileP(toolPath('ffmpeg', 'ffmpeg'), args, { timeout: 30 * 60_000 })
        .then(() => renameSync(part, out))
        .catch((e: unknown) => {
          this.proxyFailed.set(shotId, e instanceof Error ? e.message.slice(0, 300) : String(e))
          rmSync(part, { force: true })
        })
        .finally(() => this.proxying.delete(shotId))
    }
    return { ready: false }
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
      if (kind === 'video') await extractVideoFrame(sourcePath, tmp)
      else await extractEmbeddedJpeg(sourcePath, tmp)
      input = tmp
      // ffmpeg already applies the video's rotation. Embedded RAW previews usually lack orientation; use the RAW's.
      rotate = kind === 'video' ? 0 : (ORIENT_TO_DEG[orientation ?? 1] ?? 0)
    }

    try {
      const base = (): Sharp => (rotate === undefined ? sharp(input).rotate() : sharp(input).rotate(rotate))
      await Promise.all([
        base().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(this.previewPath(shotId)),
        base().resize({ width: 480, height: 480, fit: 'inside' }).jpeg({ quality: 75 }).toFile(this.thumbPath(shotId))
      ])
      return await lumaStats(this.thumbPath(shotId))
    } finally {
      // Windows can briefly lock a just-written file (antivirus, libvips); a leftover temp file must not fail the preview.
      if (tmp) {
        try {
          rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          /* leave it for the OS temp cleaner */
        }
      }
    }
  }

  clear(shotId: number): void {
    rmSync(this.thumbPath(shotId), { force: true })
    rmSync(this.previewPath(shotId), { force: true })
    rmSync(this.proxyPath(shotId), { force: true })
  }
}

/** One frame at 1 s (skips a black first frame); clips shorter than that write nothing, so retry from the start. */
async function extractVideoFrame(src: string, dest: string): Promise<void> {
  const ffmpeg = toolPath('ffmpeg', 'ffmpeg')
  for (const ss of ['1', '0']) {
    await execFileP(ffmpeg, ['-v', 'error', '-y', '-ss', ss, '-i', src, '-frames:v', '1', '-q:v', '2', dest], { timeout: 60_000 }).catch(() => undefined)
    if (existsSync(dest)) return
  }
  throw new Error(`ffmpeg could not read a frame from ${src} (is ffmpeg installed?)`)
}

async function extractEmbeddedJpeg(src: string, dest: string): Promise<void> {
  // Largest first: full-size JpgFromRaw, then PreviewImage, then the tiny ThumbnailImage.
  const attempts = [
    () => exiftool.extractJpgFromRaw(src, dest),
    () => exiftool.extractPreview(src, dest),
    () => exiftool.extractThumbnail(src, dest)
  ]
  let lastErr: unknown
  for (const attempt of attempts) {
    try {
      await attempt()
      if (existsSync(dest)) return
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`No embedded preview found in ${src}: ${String(lastErr)}`)
}

export async function shutdownMedia(): Promise<void> {
  await exiftool.end()
}
