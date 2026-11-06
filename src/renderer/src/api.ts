import type { Destination, ServerEvent, Session, Settings, Shot, ShotPatch, Status, TunnelState } from '@shared/types'

interface DesktopBridge {
  apiBase: string
  desktop: true
  pickFolder: () => Promise<string | null>
  reveal: (path: string) => Promise<void>
  openPath: (path: string) => Promise<string>
}

declare global {
  interface Window {
    shotdrop?: DesktopBridge
  }
}

export const desktop = window.shotdrop ?? null

/** A browser on another device (LAN or tunnel). It can view and cull, but configuration is desktop-only. */
export const isRemote = !desktop && !import.meta.env.DEV

/** In the Electron window the API base comes from preload; in a remote browser it's the page's own origin. */
const base = desktop?.apiBase ?? (import.meta.env.DEV ? 'http://127.0.0.1:8787' : location.origin)

const KEY_STORAGE = 'shotdrop.key'
let key: string | null = (() => {
  try {
    return localStorage.getItem(KEY_STORAGE)
  } catch {
    return null
  }
})()

export function setKey(k: string): void {
  key = k
  try {
    localStorage.setItem(KEY_STORAGE, k)
  } catch {
    /* private mode */
  }
}

export class AuthError extends Error {}

const withKey = (url: string): string => (key && !desktop ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url)

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key && !desktop ? { 'x-shotdrop-key': key } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) throw new AuthError('PIN required')
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status} ${res.statusText}`)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const api = {
  status: () => req<Status>('GET', '/api/status'),
  sessions: () => req<Session[]>('GET', '/api/sessions'),
  shots: () => req<{ items: Shot[]; total: number; seq: number }>('GET', '/api/shots?order=asc&limit=10000'),
  changes: (after: number) =>
    req<{ seq: number; events: ServerEvent[]; reset: boolean; status: Status }>('GET', `/api/changes?after=${after}`),
  patchShot: (id: number, patch: ShotPatch) => req<Shot>('PATCH', `/api/shots/${id}`, patch),
  deleteShot: (id: number) => req<void>('DELETE', `/api/shots/${id}`),
  settings: () => req<Settings>('GET', '/api/settings'),
  patchSettings: (patch: Partial<Settings>) => req<Settings>('PATCH', '/api/settings', patch),
  addDestination: (d: Omit<Destination, 'id'>) => req<Destination>('POST', '/api/destinations', d),
  patchDestination: (id: string, d: Partial<Destination>) => req<Destination>('PATCH', `/api/destinations/${id}`, d),
  deleteDestination: (id: string) => req<void>('DELETE', `/api/destinations/${id}`),
  resync: (id: string) => req<{ queued: number }>('POST', `/api/destinations/${id}/resync`),
  retrySync: () => req<{ retried: number }>('POST', '/api/sync/retry'),
  tunnelInstall: () => req<TunnelState>('POST', '/api/tunnel/install'),
  tunnelStart: () => req<TunnelState>('POST', '/api/tunnel/start'),
  tunnelStop: () => req<TunnelState>('POST', '/api/tunnel/stop'),

  thumbUrl: (id: number) => withKey(`${base}/api/shots/${id}/thumb`),
  previewUrl: (id: number) => withKey(`${base}/api/shots/${id}/preview`),
  originalUrl: (id: number, fileId?: number) => withKey(`${base}/api/shots/${id}/original${fileId ? `?file=${fileId}` : ''}`),

  events(onEvent: (e: ServerEvent) => void, onError: () => void): () => void {
    const es = new EventSource(withKey(`${base}/api/events`))
    const types: ServerEvent['type'][] = ['shot:added', 'shot:updated', 'shot:removed', 'status', 'ingest:error']
    for (const t of types) es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data)))
    es.onerror = onError
    return () => es.close()
  }
}
