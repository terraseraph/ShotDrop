import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface FoundEditor {
  id: string
  name: string
  exe: string
}

// [display name, parent folder, folder-name prefix, exe]; Adobe/Affinity/Capture One put a version in the folder name.
const KNOWN: [string, string, string, string][] = [
  ['Lightroom Classic', 'Adobe', 'Adobe Lightroom Classic', 'Lightroom.exe'],
  ['Lightroom', 'Adobe', 'Adobe Lightroom', 'lightroom.exe'],
  ['Photoshop', 'Adobe', 'Adobe Photoshop', 'Photoshop.exe'],
  ['Affinity Photo', 'Affinity', 'Photo', 'Photo.exe'],
  ['Capture One', '', 'Capture One', 'CaptureOne.exe'],
  ['DxO PhotoLab', 'DxO', 'DxO PhotoLab', 'DxO.PhotoLab.exe']
]

/** Photo editors installed in the usual Windows locations. Empty elsewhere; the UI then offers the OS "Open with" dialog. */
export function findEditors(): FoundEditor[] {
  if (process.platform !== 'win32') return []
  const out: FoundEditor[] = []
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
    for (const [name, parent, prefix, exe] of KNOWN) {
      const dir = parent ? join(root, parent) : root
      if (!existsSync(dir)) continue
      for (const d of readdirSync(dir).filter((x) => x.startsWith(prefix) && !(name === 'Lightroom' && x.includes('Classic')))) {
        const p = join(dir, d, exe)
        if (!existsSync(p)) continue
        if (!out.some((o) => o.name === name)) out.push({ id: name, name, exe: p })
      }
    }
  }
  return out
}
