import { existsSync, statSync } from 'node:fs'
import { copyFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { exiftool } from 'exiftool-vendored'
import type { Flag, Label, Settings } from '@shared/types'
import type { Library } from './library'
import type { Bus } from './events'

/**
 * XMP sidecars: one `<stem>.xmp` per shot, next to its files (a RAW+JPEG pair shares it).
 *
 * Field mapping (what Lightroom, Camera Raw/Bridge, Capture One and Photo Mechanic read):
 *  - xmp:Rating  0-5; -1 when the shot is rejected (Lightroom/Photo Mechanic reject convention)
 *  - xmp:Label   Red | Yellow | Green | Blue | Purple
 *  - xmpDM:Pick  1 pick, -1 reject, 0 none (Adobe's pick flag in XMP; apps that ignore it still see Rating)
 * Existing sidecars are updated in place so other fields (develop settings, keywords...) survive.
 */

const DEBOUNCE_MS = 400

const LABEL_OUT: Record<string, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' }
const LABEL_IN: Record<string, Label> = { red: 'red', yellow: 'yellow', green: 'green', blue: 'blue', purple: 'purple' }

const EMPTY_XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="ShotDrop">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`

export interface SidecarValues {
  rating: number // 0-5
  flag: Flag
  label: Label
}

/** Read culling values out of a sidecar. Returns null if unreadable. */
export async function readSidecar(path: string): Promise<SidecarValues | null> {
  try {
    const t = (await exiftool.read(path)) as unknown as Record<string, unknown>
    const rawRating = Number(t.Rating ?? 0)
    const pick = Number(t.Pick ?? 0)
    let flag: Flag = pick === 1 ? 1 : pick === -1 ? -1 : 0
    let rating = Number.isFinite(rawRating) ? Math.round(rawRating) : 0
    if (rating < 0) {
      flag = -1
      rating = 0
    }
    rating = Math.max(0, Math.min(5, rating))
    const label = typeof t.Label === 'string' ? (LABEL_IN[t.Label.trim().toLowerCase()] ?? null) : null
    return { rating, flag, label }
  } catch {
    return null
  }
}

export function sidecarPathFor(dir: string, stem: string): string {
  return join(dir, `${stem}.xmp`)
}

/** Writes sidecars off the UI path, debounced per shot, and registers them as 'sidecar' files for sync. */
export class XmpService {
  private timers = new Map<number, NodeJS.Timeout>()
  private inflight = new Set<Promise<void>>()

  constructor(
    private lib: Library,
    private bus: Bus,
    private settings: () => Settings,
    private libraryDir: () => string,
    /** Called after a sidecar was written or adopted, so sync can (re)send it. */
    private onChanged: (fileId: number, shotId: number) => void
  ) {}

  /** Queue a (debounced) sidecar write for a shot. Never throws. */
  schedule(shotId: number): void {
    if (!this.settings().xmpSidecars) return
    const t = this.timers.get(shotId)
    if (t) clearTimeout(t)
    this.timers.set(
      shotId,
      setTimeout(() => {
        this.timers.delete(shotId)
        const p = this.write(shotId).finally(() => this.inflight.delete(p))
        this.inflight.add(p)
      }, DEBOUNCE_MS)
    )
  }

  cancel(shotId: number): void {
    const t = this.timers.get(shotId)
    if (t) clearTimeout(t)
    this.timers.delete(shotId)
  }

  /** Flush pending writes (app shutdown). */
  async drain(): Promise<void> {
    for (const id of [...this.timers.keys()]) {
      this.cancel(id)
      const p = this.write(id).finally(() => this.inflight.delete(p))
      this.inflight.add(p)
    }
    await Promise.all([...this.inflight])
  }

  private async write(shotId: number): Promise<void> {
    try {
      const shot = this.lib.get(shotId)
      if (!shot) return
      const photo = this.lib.files(shotId).find((f) => f.kind !== 'sidecar')
      if (!photo) return
      const path = sidecarPathFor(dirname(photo.path), shot.name)
      if (!existsSync(path)) await writeFile(path, EMPTY_XMP, 'utf8')
      await exiftool.write(
        path,
        {},
        [
          '-overwrite_original',
          `-XMP-xmp:Rating=${shot.flag === -1 ? -1 : shot.rating}`,
          `-XMP-xmp:Label=${shot.label ? LABEL_OUT[shot.label] : ''}`,
          `-XMP-xmpDM:Pick=${shot.flag}`
        ]
      )
      this.register(shotId, path)
    } catch (e) {
      this.bus.emit({
        type: 'ingest:error',
        file: `shot ${shotId}`,
        error: `XMP sidecar write failed: ${e instanceof Error ? e.message : String(e)}`
      })
    }
  }

  /** Ensure the sidecar is a tracked file row (kind 'sidecar') and tell sync it changed. */
  private register(shotId: number, path: string): void {
    const size = statSync(path).size
    const existing = this.lib.sidecarFile(shotId)
    let fileId: number
    if (existing) {
      this.lib.setFileSize(existing.id, size)
      fileId = existing.id
    } else {
      fileId = this.lib.addFile({
        shot_id: shotId,
        path,
        rel_path: relative(this.libraryDir(), path).split(sep).join('/'),
        name: path.split(sep).pop()!,
        kind: 'sidecar',
        size,
        hash: `sidecar:${shotId}`
      })
    }
    this.onChanged(fileId, shotId)
  }

  /**
   * A sidecar that arrived with a photo (card, watched folder, FTP). Copy it next to the shot's files
   * if the shot has none yet; when `apply` is set, import its rating/flag/label into the DB.
   * Returns true if the sidecar was taken.
   */
  async adopt(shotId: number, src: string, apply: boolean): Promise<boolean> {
    if (this.lib.sidecarFile(shotId)) return false
    const shot = this.lib.get(shotId)
    const photo = this.lib.files(shotId).find((f) => f.kind !== 'sidecar')
    if (!shot || !photo) return false
    const dest = sidecarPathFor(dirname(photo.path), shot.name)
    if (!existsSync(dest)) await copyFile(src, dest)
    if (apply) {
      const v = await readSidecar(dest)
      if (v) this.lib.update(shotId, v)
    }
    this.register(shotId, dest)
    return true
  }

  /** Remove a leftover source sidecar (move mode). */
  static async discard(path: string): Promise<void> {
    await unlink(path).catch(() => undefined)
  }
}
