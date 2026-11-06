// Types shared by the server (main process) and the UI (renderer / remote browser).

export type Flag = -1 | 0 | 1 // reject | none | pick
export type Label = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null
export type FileKind = 'jpeg' | 'heif' | 'raw' | 'sidecar' | 'other'
export type SyncStatus = 'pending' | 'running' | 'done' | 'error'

export interface ShotFile {
  id: number
  name: string
  kind: FileKind
  size: number
}

export interface Shot {
  id: number
  session: string // YYYY-MM-DD
  name: string // base name without extension
  capturedAt: number // epoch ms
  importedAt: number
  camera: string | null
  lens: string | null
  iso: number | null
  shutter: string | null
  aperture: number | null
  focalLength: number | null
  width: number | null
  height: number | null
  rating: number // 0-5
  flag: Flag
  label: Label
  source: string | null // ftp user / folder name
  hasPreview: boolean
  histogram: number[] | null // 64 luminance bins, 0-100
  clipped: number | null // % of pixels at pure white
  files: ShotFile[]
  sync: Record<string, SyncStatus> // destinationId -> aggregate status
}

export interface ShotPatch {
  rating?: number
  flag?: Flag
  label?: Label
}

export interface FtpUser {
  username: string
  password: string
  label: string
}

export type DestinationType = 'folder' | 'rclone'
export type DestinationFilter = 'all' | 'jpeg' | 'raw' | 'picks'

export interface Destination {
  id: string
  name: string
  type: DestinationType
  target: string // folder path, or rclone remote path e.g. "gdrive:Photos/ShotDrop"
  filter: DestinationFilter
  enabled: boolean
}

export interface Settings {
  libraryDir: string
  ftp: {
    enabled: boolean
    port: number
    pasvMin: number
    pasvMax: number
    users: FtpUser[]
  }
  api: { port: number }
  remote: { enabled: boolean; pin: string }
  watchFolders: string[]
  destinations: Destination[]
  rclonePath: string
  xmpSidecars: boolean // write <name>.xmp next to each shot with rating/flag/label
  tunnel: { autoStart: boolean; cloudflaredPath: string }
}

export interface TunnelState {
  status: 'off' | 'installing' | 'starting' | 'running' | 'error'
  url: string | null
  error: string | null
  installed: boolean
  installable: boolean // we can download cloudflared for this OS
}

export interface CameraStatus {
  username: string
  label: string
  connected: boolean
  lastAt: number | null // epoch ms of the newest shot from this user
  today: number
}

export interface DestStatus {
  id: string
  name: string
  target: string
  filter: DestinationFilter
  done: number
  total: number
  running: number
  errors: number
  bps: number // bytes/s over the last 10 s
}

export interface Status {
  version: string
  ftp: { running: boolean; port: number; addresses: string[]; error: string | null; activeConnections: number }
  api: { port: number; urls: string[]; remote: boolean }
  library: { dir: string; shots: number; free: number | null; total: number | null }
  sync: { pending: number; running: number; errors: number; rcloneAvailable: boolean }
  tunnel: TunnelState
  cameras: CameraStatus[]
  destinations: DestStatus[]
}

export interface Session {
  session: string
  count: number
}

export type ServerEvent =
  | { type: 'shot:added'; shot: Shot }
  | { type: 'shot:updated'; shot: Shot }
  | { type: 'shot:removed'; id: number }
  | { type: 'status'; status: Status }
  | { type: 'ingest:error'; file: string; error: string }
