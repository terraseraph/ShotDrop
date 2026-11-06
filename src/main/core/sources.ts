import sharp from 'sharp'
import type { ShotSource, ShotSources } from '@shared/types'
import type { Core } from './index'
import { rawDecoderPath } from './media'

const jpegDims = new Map<number, { w: number | null; h: number | null }>()

function pick(core: Core, shotId: number) {
  const files = core.lib.files(shotId)
  return { jpeg: files.find((f) => f.kind === 'jpeg'), raw: files.find((f) => f.kind === 'raw'), all: files.filter((f) => f.kind !== 'sidecar') }
}

/** The views available for a shot, with their true pixel sizes. The RAW's embedded preview is extracted (and cached) to measure it. */
export async function listSources(core: Core, shotId: number): Promise<ShotSources> {
  const { jpeg, raw } = pick(core, shotId)
  const sources: ShotSource[] = []
  if (jpeg) {
    let d = jpegDims.get(jpeg.id)
    if (!d) {
      const m = await sharp(jpeg.path).metadata().catch(() => null)
      // Sensor-rotated JPEGs report pre-rotation size; swap for 90°/270° orientations.
      const swap = (m?.orientation ?? 1) >= 5
      d = { w: (swap ? m?.height : m?.width) ?? null, h: (swap ? m?.width : m?.height) ?? null }
      jpegDims.set(jpeg.id, d)
    }
    sources.push({ key: 'jpeg', label: 'Camera JPEG', width: d.w, height: d.h, ready: true, bytes: jpeg.size })
  }
  if (raw) {
    sources.push(await core.previews.embedded(shotId, raw.path, core.lib.orientation(shotId)))
    sources.push(core.previews.cached(shotId, 'raw') ?? { key: 'raw', label: 'RAW decode', width: null, height: null, ready: false })
  }
  return { sources, canDevelop: rawDecoderPath() !== null }
}

/**
 * Path of a full-resolution rendition. `develop: true` makes the RAW decode if it doesn't exist yet
 * (seconds); the embedded preview is always made on demand because it's cheap.
 */
export async function resolveImage(core: Core, shotId: number, key: ShotSource['key'], develop: boolean): Promise<{ path: string; source: ShotSource } | null> {
  const { jpeg, raw } = pick(core, shotId)
  if (key === 'jpeg') {
    if (!jpeg) return null
    return { path: jpeg.path, source: { key, label: 'Camera JPEG', width: null, height: null, ready: true, bytes: jpeg.size } }
  }
  if (!raw) return null
  if (key === 'embedded') {
    const source = await core.previews.embedded(shotId, raw.path, core.lib.orientation(shotId))
    return { path: core.previews.fullPath(shotId, 'embedded'), source }
  }
  const have = core.previews.cached(shotId, 'raw')
  if (!have && !develop) return null
  const source = have ?? (await core.previews.develop(shotId, raw.path))
  return { path: core.previews.fullPath(shotId, 'raw'), source }
}

/** The file whose metadata describes the shot best: RAW (full maker notes), else the best other file. */
export function metadataFile(core: Core, shotId: number, fileId?: number) {
  const { raw, all } = pick(core, shotId)
  return (fileId ? all.find((f) => f.id === fileId) : undefined) ?? raw ?? all.sort((a, b) => b.size - a.size)[0]
}

/** What to drag, copy or open for a shot: the camera JPEG, else the RAW. */
export function primaryFile(core: Core, shotId: number) {
  const { jpeg, raw, all } = pick(core, shotId)
  return jpeg ?? raw ?? all[0]
}
