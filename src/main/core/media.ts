import { exiftool, type Tags } from 'exiftool-vendored'
import sharp, { type Sharp } from 'sharp'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FileKind } from '@shared/types'

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

  constructor(cacheDir: string) {
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
      if (tmp && existsSync(tmp)) rmSync(tmp, { force: true })
    }
  }

  clear(shotId: number): void {
    rmSync(this.thumbPath(shotId), { force: true })
    rmSync(this.previewPath(shotId), { force: true })
  }
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
