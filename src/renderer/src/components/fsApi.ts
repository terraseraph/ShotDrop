import { useEffect, useState } from 'react'
import type { Settings, Status } from '@shared/types'
import { apiBase, desktop } from '../api'

/** Optional server helpers (see side-session-notes/sync-settings-needs.md). Every call degrades to null when the endpoint is missing. */
export interface Place { id: string; label: string; path: string }
export interface Drive { path: string; label: string; free: number | null; total: number | null; kind: 'fixed' | 'removable' | 'network' }
export interface Places { hostname: string | null; places: Place[]; drives: Drive[] }
export interface PathCheck { exists: boolean; writable: boolean; free: number | null }

const keyHeader = (): Record<string, string> => {
  if (desktop) return {}
  try {
    const k = localStorage.getItem('shotdrop.key')
    return k ? { 'x-shotdrop-key': k } : {}
  } catch {
    return {}
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(apiBase + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...keyHeader() },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

let placesP: Promise<Places | null> | null = null
export const fetchPlaces = (): Promise<Places | null> => (placesP ??= call<Places>('GET', '/api/fs/places'))
export const checkPath = (p: string): Promise<PathCheck | null> => call<PathCheck>('GET', `/api/fs/check?path=${encodeURIComponent(p)}`)
/** Phone: ask the PC to open its folder picker; resolves with the chosen path, null if cancelled or unsupported. */
export const pickOnPc = async (): Promise<string | null> => (await call<{ path: string | null }>('POST', '/api/fs/pick'))?.path ?? null

/** Path from a dropped File (Electron 32+ needs webUtils through preload; older builds still have File.path). */
export function droppedPath(f: File): string | null {
  const bridge = desktop as unknown as { pathForFile?: (f: File) => string } | null
  return bridge?.pathForFile?.(f) || (f as File & { path?: string }).path || null
}

/** Spread on any element: a folder dragged from Explorer onto it calls onPath. */
export function dropProps(onPath: (p: string) => void, enabled = true): { onDragOver?: (e: React.DragEvent) => void; onDrop?: (e: React.DragEvent) => void } {
  if (!enabled || !desktop) return {}
  return {
    onDragOver: (e) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault()
    },
    onDrop: (e) => {
      const f = e.dataTransfer.files[0]
      const p = f && droppedPath(f)
      if (!p) return
      e.preventDefault()
      // A file (has an extension, non-empty type) means its folder.
      onPath(f.type || /\.[A-Za-z0-9]{1,5}$/.test(p) ? p.replace(/[\\/][^\\/]*$/, '') : p)
    }
  }
}

export const sep = (p: string): string => (p.includes('/') && !p.includes('\\') ? '/' : '\\')
export const join = (a: string, b: string): string => (a.endsWith('\\') || a.endsWith('/') ? a : a + sep(a)) + b
export const lastPart = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const driveOf = (p: string): string | null => (/^[A-Za-z]:/.test(p) ? p.slice(0, 2).toUpperCase() + '\\' : null)

export interface Chips { places: Place[]; drives: Drive[]; shares: Place[]; ready: boolean }

/** Chip sources: the server's list when it has one, otherwise what can be inferred from paths already known. */
export function useChips(s: Settings | null, status: Status | null): Chips {
  const [srv, setSrv] = useState<Places | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    void fetchPlaces().then((p) => { if (live) { setSrv(p); setReady(true) } })
    return () => {
      live = false
    }
  }, [])

  const known = [status?.library.dir, s?.libraryDir, ...(s?.watchFolders ?? []), ...(s?.destinations.filter((d) => d.type === 'folder').map((d) => d.target) ?? [])].filter(Boolean) as string[]
  const shares = [...new Set(known.filter((p) => p.startsWith('\\\\')).map((p) => p.split('\\').slice(0, 4).join('\\')))].map((p) => ({ id: p, label: p, path: p }))

  if (srv) return { places: srv.places, drives: srv.drives, shares, ready }

  const home = known.map((p) => /^(.*?[\\/]Users[\\/][^\\/]+)/i.exec(p)?.[1]).find(Boolean)
  const places: Place[] = []
  if (home) {
    for (const n of ['Pictures', 'Desktop', 'Documents']) places.push({ id: n.toLowerCase(), label: n, path: join(home, n) })
    const od = known.map((p) => /^(.*?[\\/]OneDrive[^\\/]*)/i.exec(p)?.[1]).find(Boolean)
    if (od) places.push({ id: 'onedrive', label: 'OneDrive', path: od })
  }
  const letters = [...new Set(known.map(driveOf).filter(Boolean) as string[])]
  const drives: Drive[] = letters
    .filter((l) => !(home && home.toUpperCase().startsWith(l.slice(0, 2)) && letters.length === 1))
    .map((l) => ({ path: l, label: l.slice(0, 2), free: status?.library.dir && driveOf(status.library.dir) === l ? status.library.free : null, total: null, kind: 'fixed' as const }))
  return { places, drives, shares, ready }
}

// ---- culling preferences: stored locally, announced on window for App to honour ----
export type PrefKey = 'bursts' | 'shiftAdvance' | 'deleteMode'
const DEFAULT: Record<PrefKey, string> = { bursts: '1', shiftAdvance: '1', deleteMode: 'bin' }
export const getPref = (k: PrefKey): string => {
  try {
    return localStorage.getItem(`shotdrop.pref.${k}`) ?? DEFAULT[k]
  } catch {
    return DEFAULT[k]
  }
}
export const setPref = (k: PrefKey, v: string): void => {
  try {
    localStorage.setItem(`shotdrop.pref.${k}`, v)
  } catch {
    /* not remembered */
  }
  window.dispatchEvent(new CustomEvent('shotdrop:prefs', { detail: { key: k, value: v } }))
}

export const getJson = <T,>(path: string): Promise<T | null> => call<T>('GET', path)
