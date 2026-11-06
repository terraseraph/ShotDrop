import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import { existsSync, mkdirSync } from 'node:fs'
import { join, parse } from 'node:path'
import type { ExportOptions } from '@shared/types'
import type { Core } from './index'
import { metadataFile, resolveImage } from './sources'

/** Dimensions of the output differ from the source's, so don't copy those tags over. */
const SIZE_TAGS = ['ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'RelatedImageWidth', 'RelatedImageLength']

/** Exports one shot as a JPEG into `o.dir`. Returns the written path. */
export async function exportJpeg(core: Core, shotId: number, o: ExportOptions): Promise<string> {
  const shot = core.lib.get(shotId)
  if (!shot) throw new Error('Shot not found')
  const want = o.source && o.source !== 'auto' ? o.source : undefined
  // auto: camera JPEG, else a RAW decode if one was already made, else the embedded preview.
  const order = want ? [want] : (['jpeg', 'raw', 'embedded'] as const)
  let src: Awaited<ReturnType<typeof resolveImage>> = null
  for (const k of order) {
    src = await resolveImage(core, shotId, k, !!want)
    if (src) break
  }
  if (!src) throw new Error('No image source available')

  mkdirSync(o.dir, { recursive: true })
  const base = parse(shot.name).name + (o.size === 'original' ? '' : `_${o.size}`)
  let dest = join(o.dir, `${base}.jpg`)
  for (let n = 1; existsSync(dest); n++) dest = join(o.dir, `${base}-${n}.jpg`)

  let img = sharp(src.path).rotate().keepIccProfile()
  if (o.size !== 'original') img = img.resize({ width: o.size, height: o.size, fit: 'inside', withoutEnlargement: true })
  await img.jpeg({ quality: Math.min(100, Math.max(1, Math.round(o.quality))), mozjpeg: true }).toFile(dest)

  if (o.metadata !== 'none') {
    const meta = metadataFile(core, shotId)
    if (meta) {
      const args = ['-overwrite_original', '-TagsFromFile', meta.path, '-all:all', ...SIZE_TAGS.flatMap((t) => ['-x', t]), '-Orientation#=1', '-ThumbnailImage=', '-PreviewImage=', '-JpgFromRaw=']
      if (o.metadata === 'noGps') args.push('-gps:all=', '-xmp:gps*=')
      await exiftool.write(dest, {}, args)
    }
  }
  return dest
}
