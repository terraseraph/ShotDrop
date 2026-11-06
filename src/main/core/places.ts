/**
 * Folders and drives the UI offers as quick picks so nobody has to type a path:
 * the user's Pictures / Desktop / Documents / OneDrive, every fixed, removable and network
 * drive with its free space, plus a reachability check for any path.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, stat, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export interface Place { id: 'pictures' | 'desktop' | 'documents' | 'onedrive'; label: string; path: string }
export interface Drive { path: string; label: string; free: number; total: number; kind: 'fixed' | 'removable' | 'network' }
export interface Places { hostname: string; places: Place[]; drives: Drive[] }
export interface PathCheck { exists: boolean; writable: boolean; free: number | null }

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

async function homePlaces(): Promise<Place[]> {
  const home = homedir()
  const candidates: Place[] = [
    { id: 'pictures', label: 'Pictures', path: join(home, 'Pictures') },
    { id: 'desktop', label: 'Desktop', path: join(home, 'Desktop') },
    { id: 'documents', label: 'Documents', path: join(home, 'Documents') }
  ]
  const od = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial
  if (od) candidates.push({ id: 'onedrive', label: 'OneDrive', path: od })
  // Windows "known folder redirection" moves Pictures/Desktop/Documents under OneDrive; offer those when the plain ones are gone.
  for (const c of candidates) {
    if (od && c.id !== 'onedrive' && !(await exists(c.path)) && (await exists(join(od, c.label)))) c.path = join(od, c.label)
  }
  const present = await Promise.all(candidates.map((c) => exists(c.path)))
  return candidates.filter((_, i) => present[i])
}

/** Windows: Win32_LogicalDisk over PowerShell. Elsewhere: nothing (the home places still work). */
function windowsDrives(): Promise<Drive[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  const script =
    'Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3,4 } | ' +
    'Select-Object DeviceID,VolumeName,FreeSpace,Size,DriveType | ConvertTo-Json -Compress'
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true }, (err, out) => {
      if (err || !out.trim()) return resolve([])
      try {
        const raw = JSON.parse(out) as Record<string, unknown> | Record<string, unknown>[]
        const rows = Array.isArray(raw) ? raw : [raw]
        resolve(
          rows
            .filter((r) => typeof r.DeviceID === 'string' && r.Size)
            .map((r) => ({
              path: `${r.DeviceID as string}\\`,
              label: (r.VolumeName as string) || (r.DriveType === 4 ? 'Network drive' : r.DriveType === 2 ? 'Removable drive' : 'Local disk'),
              free: Number(r.FreeSpace ?? 0),
              total: Number(r.Size ?? 0),
              kind: r.DriveType === 4 ? 'network' : r.DriveType === 2 ? 'removable' : 'fixed'
            }))
        )
      } catch {
        resolve([])
      }
    })
  })
}

export async function listPlaces(): Promise<Places> {
  const [places, drives] = await Promise.all([homePlaces(), windowsDrives()])
  return { hostname: hostname(), places, drives }
}

/** Does the path exist, can we write there, how much room is left. Never creates anything. */
export async function checkPath(path: string): Promise<PathCheck> {
  if (!path || !(await exists(path))) return { exists: false, writable: false, free: null }
  const writable = await access(path, constants.W_OK).then(() => true, () => false)
  const free = await statfs(path).then((s) => Number(s.bavail) * Number(s.bsize), () => null)
  return { exists: true, writable, free }
}

/** Create a folder (mkdir -p) and report on it: used when a sheet picks a path that doesn't exist yet. */
export async function ensurePath(path: string): Promise<PathCheck> {
  await mkdir(path, { recursive: true })
  return checkPath(path)
}
