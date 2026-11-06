import type { CloudAccount, CloudFolder, CloudLinkOptions, CloudProvider, CloudQuota, CloudState, Destination, ExportOptions, ServerEvent, Session, Settings, Shot, ShotMetadata, ShotPatch, ShotSource, ShotSources, Status, TunnelState } from '@shared/types'

interface DesktopBridge {
  apiBase: string
  desktop: true
  pickFolder: () => Promise<string | null>
  reveal: (path: string) => Promise<void>
  openPath: (path: string) => Promise<string>
  editors: () => Promise<{ id: string; name: string }[]>
  shotAction: (id: number, action: 'reveal' | 'open' | 'openWith' | 'copyImage', arg?: string) => Promise<string | null>
  dragShot: (id: number) => void
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
export const apiBase = base

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

const ver = (s: Shot): string => `${s.importedAt}.${s.files.length}`
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
  cloudAccounts: () => req<{ accounts: CloudAccount[]; linking: CloudState['linking'] }>('GET', '/api/cloud/accounts'),
  cloudLink: (provider: CloudProvider, o: CloudLinkOptions = {}) => req<CloudAccount>('POST', '/api/cloud/link', { provider, ...o }),
  cloudCancel: () => req<void>('DELETE', '/api/cloud/link'),
  cloudFolders: (name: string, path: string) => req<CloudFolder[]>('GET', `/api/cloud/accounts/${encodeURIComponent(name)}/folders?path=${encodeURIComponent(path)}`),
  cloudMkdir: (name: string, path: string) => req<void>('POST', `/api/cloud/accounts/${encodeURIComponent(name)}/folders`, { path }),
  cloudInfo: (name: string) => req<{ email: string | null; quota: CloudQuota | null }>('GET', `/api/cloud/accounts/${encodeURIComponent(name)}/info`),
  cloudDisconnect: (name: string) => req<void>('DELETE', `/api/cloud/accounts/${encodeURIComponent(name)}`),
  retrySync: () => req<{ retried: number }>('POST', '/api/sync/retry'),
  tunnelInstall: () => req<TunnelState>('POST', '/api/tunnel/install'),
  tunnelStart: () => req<TunnelState>('POST', '/api/tunnel/start'),
  tunnelStop: () => req<TunnelState>('POST', '/api/tunnel/stop'),
  /** Starts (once) a browser-playable copy of a video; poll until `ready`. */
  proxy: (id: number) => req<{ ready: boolean; error?: string }>('POST', `/api/shots/${id}/proxy`),
  filePath: (fileId: number) => req<{ path: string }>('GET', `/api/files/${fileId}/path`),
  sources: (id: number) => req<ShotSources>('GET', `/api/shots/${id}/sources`),
  develop: (id: number) => req<ShotSource>('POST', `/api/shots/${id}/develop`),
  metadata: (id: number) => req<ShotMetadata>('GET', `/api/shots/${id}/metadata`),
  exportJpeg: (id: number, o: ExportOptions) => req<{ path: string }>('POST', `/api/shots/${id}/export`, o),
  shareLink: (id: number) => req<{ url: string | null; reason?: string; via?: string }>('GET', `/api/shots/${id}/link`),

  // Images are served `immutable` and ids restart at 1 per library, so the URL carries a version.
  // File count changes when a better source (JPEG after RAW) re-renders the preview.
  thumbUrl: (s: Shot) => withKey(`${base}/api/shots/${s.id}/thumb?v=${ver(s)}`),
  previewUrl: (s: Shot) => withKey(`${base}/api/shots/${s.id}/preview?v=${ver(s)}`),
  proxyUrl: (s: Shot) => withKey(`${base}/api/shots/${s.id}/proxy?v=${ver(s)}`),
  downloadUrl: (s: Shot, fileId: number) => withKey(`${base}/api/shots/${s.id}/original?v=${ver(s)}&file=${fileId}&dl=1`),
  fullUrl: (s: Shot, src: ShotSource['key'], tag = ''): string => withKey(`${base}/api/shots/${s.id}/full?src=${src}&v=${ver(s)}${tag}`),
  originalUrl: (s: Shot, fileId?: number) =>
    withKey(`${base}/api/shots/${s.id}/original?v=${ver(s)}${fileId ? `&file=${fileId}` : ''}`),

  events(onEvent: (e: ServerEvent) => void, onError: () => void): () => void {
    const es = new EventSource(withKey(`${base}/api/events`))
    const types: ServerEvent['type'][] = ['shot:added', 'shot:updated', 'shot:removed', 'status', 'ingest:error']
    for (const t of types) es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data)))
    es.onerror = onError
    return () => es.close()
  }
}

/** Spread on a thumbnail <img>: in the desktop app, dragging it hands the photo to the OS (Explorer, mail, Lightroom...). */
export const dragProps = (id: number): { draggable: boolean; onDragStart?: (e: import("react").DragEvent) => void } =>
  desktop ? { draggable: true, onDragStart: (e) => { e.preventDefault(); desktop.dragShot(id) } } : { draggable: false }
