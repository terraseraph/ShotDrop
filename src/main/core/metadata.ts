import { exiftool } from 'exiftool-vendored'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { MetaGroup, MetaItem, ShotMetadata } from '@shared/types'

/**
 * Every tag exiftool can read, grouped, with a handful of useful maker-note fields lifted into a summary.
 * Results are cached as JSON per library file (library files never change once ingested).
 */
export class MetadataStore {
  private dir: string

  constructor(cacheDir: string) {
    this.dir = join(cacheDir, 'meta')
    mkdirSync(this.dir, { recursive: true })
  }

  clear(fileId: number): void {
    rmSync(join(this.dir, `${fileId}.json`), { force: true })
  }

  async get(fileId: number, fileName: string, path: string): Promise<ShotMetadata> {
    const cache = join(this.dir, `${fileId}.json`)
    if (existsSync(cache)) {
      try {
        return JSON.parse(readFileSync(cache, 'utf8')) as ShotMetadata
      } catch {
        /* corrupt cache: re-read */
      }
    }
    const [raw, gps] = await Promise.all([
      // -G0:1 → "Family0:Family1:Tag"; -a keeps duplicates; -u unknown tags; composites (lens, GPS position) stay on.
      exiftool.readRaw(path, ['-G0:1', '-a', '-u', '-struct']) as Promise<Record<string, unknown>>,
      exiftool.readRaw(path, ['-n', '-GPSLatitude', '-GPSLongitude', '-GPSAltitude']) as Promise<Record<string, unknown>>
    ])
    const items = Object.entries(raw).flatMap(([k, v]) => toItem(k, v) ?? [])
    const lat = Number(gps.GPSLatitude)
    const lon = Number(gps.GPSLongitude)
    const alt = Number(gps.GPSAltitude)
    const hasGps = gps.GPSLatitude != null && gps.GPSLongitude != null && Number.isFinite(lat) && Number.isFinite(lon)
    const out: ShotMetadata = {
      fileId,
      fileName,
      summary: summarise(items),
      gps: hasGps ? { lat, lon, alt: Number.isFinite(alt) ? alt : null, mapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}` } : null,
      groups: group(items)
    }
    mkdirSync(this.dir, { recursive: true }) // the cache folder may have been cleared while running
    writeFileSync(cache, JSON.stringify(out))
    return out
  }
}

const NOISE = /^(SR2DataIFD\d+|ExifTool)$/ // 13 near-identical Sony blocks; exiftool's own warnings/version

function toItem(key: string, v: unknown): MetaItem | null {
  const parts = key.split(':')
  if (parts.length < 2) return null
  const tag = parts[parts.length - 1]
  const fam0 = parts[0]
  const fam1 = parts.length > 2 ? parts[1] : parts[0]
  if (NOISE.test(fam1) || NOISE.test(fam0)) return null
  let value = typeof v === 'string' ? v : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)
  if (value.startsWith('base64:')) value = `(binary data, ${Math.round((value.length * 3) / 4 / 1024)} KB)`
  if (value.length > 600) value = `${value.slice(0, 600)}…`
  return { group: key.slice(0, key.length - tag.length - 1), tag, value }
}

function bucket(item: MetaItem): MetaGroup['name'] {
  const [f0, f1] = item.group.split(':')
  if (f1 === 'GPS' || (f0 === 'Composite' && /^GPS/.test(item.tag))) return 'GPS'
  if (f0 === 'EXIF' || f0 === 'MakerNotes' || f0 === 'XMP' || f0 === 'IPTC' || f0 === 'File') return f0
  return 'Other'
}

const ORDER: MetaGroup['name'][] = ['EXIF', 'MakerNotes', 'GPS', 'XMP', 'IPTC', 'File', 'Other']

function group(items: MetaItem[]): MetaGroup[] {
  const m = new Map<MetaGroup['name'], MetaItem[]>()
  for (const it of items) {
    const b = bucket(it)
    m.set(b, [...(m.get(b) ?? []), it])
  }
  return ORDER.filter((n) => m.has(n)).map((name) => ({ name, items: m.get(name)! }))
}

// [label, tag names in priority order]. Same tag in several groups: MakerNotes first, then EXIF, then the rest.
const SUMMARY: [string, string[]][] = [
  ['Shutter count', ['ShutterCount', 'MechanicalShutterCount', 'ImageCount', 'ShutterCount2']],
  ['AF mode', ['AFAreaMode', 'AFAreaModeSetting', 'FocusMode', 'AFMode']],
  ['AF point', ['AFPointSelected', 'AFPointsUsed', 'AFPointsInFocus', 'AFPoint']],
  ['Drive mode', ['DriveMode', 'ContinuousDrive', 'ShootingMode']],
  ['Stabilisation', ['ImageStabilization', 'VibrationReduction', 'SteadyShot', 'SequenceImageStabilization']],
  ['Lens serial', ['LensSerialNumber']],
  ['Body serial', ['SerialNumber', 'BodySerialNumber', 'InternalSerialNumber']],
  ['Firmware', ['FirmwareVersion', 'CanonFirmwareVersion']],
  ['White balance', ['WhiteBalance']],
  ['Profile', ['PictureProfile', 'PictureControlName', 'FilmMode', 'PictureStyle', 'CreativeStyle', 'PictureEffect']],
  ['Focus distance', ['FocusDistance', 'FocusDistanceUpper', 'SubjectDistance']]
]
const EMPTY = /^(|n\/a|none|\(none\)|unknown|0|-1|0 0|off \(?0\)?)$/i

function summarise(items: MetaItem[]): { label: string; value: string }[] {
  const rank = (g: string): number => (g.startsWith('MakerNotes') ? 0 : g.startsWith('EXIF') ? 1 : 2)
  const out: { label: string; value: string }[] = []
  for (const [label, names] of SUMMARY) {
    for (const name of names) {
      const hit = items
        .filter((i) => i.tag === name && !EMPTY.test(i.value.trim()) && !i.group.startsWith('XMP'))
        .sort((a, b) => rank(a.group) - rank(b.group))[0]
      if (hit) {
        out.push({ label, value: hit.value.trim() })
        break
      }
    }
  }
  // Canon reports focus distance as a Lower/Upper pair.
  const up = items.find((i) => i.tag === 'FocusDistanceUpper')
  const lo = items.find((i) => i.tag === 'FocusDistanceLower')
  const fd = out.find((o) => o.label === 'Focus distance')
  if (fd && up && lo && fd.value === up.value.trim()) fd.value = `${lo.value.trim()} – ${up.value.trim()}`
  return out
}
