// Types shared by the server (main process) and the UI (renderer / remote browser).

export type Flag = -1 | 0 | 1 // reject | none | pick
export type Label = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null
export type FileKind = 'jpeg' | 'heif' | 'raw' | 'video' | 'sidecar' | 'other'
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
  dark: number | null // % of pixels at pure black
  sharpness: number | null // Laplacian variance of the thumbnail; compare within a burst only
  hash: string | null // 64-bit perceptual hash (hex) for grouping near-duplicate frames
  faces: number | null // faces found; null = not scanned yet
  blink: number | null // worst eye closure among faces, 0 open .. 1 shut; null = none/unscanned
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

export type CloudProvider = 'drive' | 'dropbox'

export interface CloudAccount {
  name: string // rclone remote name in ShotDrop's own rclone.conf, e.g. "gdrive-a1b2"
  provider: CloudProvider
  fullAccess: boolean // false = Drive scope drive.file: only sees folders ShotDrop created
  ownClient: boolean // linked with the user's own client ID
}

export interface CloudLinkOptions {
  fullAccess?: boolean
  clientId?: string
  clientSecret?: string
}

export interface CloudState {
  linking: { provider: CloudProvider; authUrl?: string; startedAt: number } | null
}

export interface CloudFolder {
  name: string
}

export interface CloudQuota {
  total?: number
  used?: number
  free?: number
}

export interface Settings {
  libraryDir: string
  ftp: {
    enabled: boolean
    port: number
    pasvMin: number
    pasvMax: number
    users: FtpUser[]
    /** LAN address the user chose to show cameras; null = automatic. */
    preferredAddress: string | null
  }
  api: { port: number }
  remote: { enabled: boolean; pin: string }
  watchFolders: string[]
  destinations: Destination[]
  rclonePath: string
  xmpSidecars: boolean // write <name>.xmp next to each shot with rating/flag/label
  tunnel: { autoStart: boolean; cloudflaredPath: string }
  /** Wi-Fi camera over PTP/IP (live view + downloads). */
  ptp: PtpSettings
}

export interface PtpSettings {
  enabled: boolean
  host: string
  /** Our PTP/IP identity, 32 hex chars. Never change it: a paired Nikon only accepts the GUID it paired with. */
  guid: string
}

export interface PtpState {
  status: 'off' | 'connecting' | 'pairing' | 'connected' | 'error'
  camera: string | null
  /** Digits the camera is also showing while it waits for the user to confirm pairing. */
  pairingCode: string | null
  error: string | null
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
  enabled: boolean // false = paused
  lastError: string | null // newest unresolved error from the sync queue
  authExpired: boolean // the cloud sign-in was revoked or expired: needs Reconnect, not Retry
  lastDoneAt: number | null // epoch ms of the newest finished upload
}

/** What each "what to send" choice would cover in the current library, for the add-destination sheet. */
export interface LibraryCounts {
  all: { files: number; bytes: number }
  jpeg: { files: number; bytes: number }
  raw: { files: number; bytes: number }
  picks: { files: number; bytes: number }
}

export interface NetInterface {
  address: string
  adapter: string
  kind: 'wifi' | 'ethernet' | 'vpn-virtual' | 'other'
  preferred: boolean
}

export interface Status {
  version: string
  ftp: {
    running: boolean
    port: number
    /** Preferred address first. */
    addresses: string[]
    interfaces: NetInterface[]
    /** The saved preferred address is no longer on this PC (network changed); we fell back. */
    preferredMissing: string | null
    error: string | null
    activeConnections: number
  }
  api: { port: number; urls: string[]; remote: boolean }
  library: { dir: string; shots: number; free: number | null; total: number | null }
  sync: { pending: number; running: number; errors: number; rcloneAvailable: boolean }
  tunnel: TunnelState
  ptp: PtpState
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

// ---- RAW sources, metadata, export ----

/** One way to look at a shot: the camera JPEG, the RAW's embedded preview, or a real RAW decode. */
export interface ShotSource {
  key: 'jpeg' | 'embedded' | 'raw'
  label: string // "Camera JPEG", "Camera preview", "RAW decode"
  width: number | null // null until known (RAW decode is sized when developed)
  height: number | null
  ready: boolean // false: needs developing first (RAW decode only)
  detail?: string // e.g. which embedded tag the preview came from
  bytes?: number
}

export interface ShotSources {
  sources: ShotSource[]
  canDevelop: boolean // a RAW decoder is available on this machine
}

export interface MetaItem {
  group: string // exiftool family-1 group, e.g. "ExifIFD", "Nikon"
  tag: string
  value: string
}

export interface MetaGroup {
  name: 'EXIF' | 'MakerNotes' | 'XMP' | 'IPTC' | 'GPS' | 'File' | 'Other'
  items: MetaItem[]
}

export interface ShotMetadata {
  fileId: number
  fileName: string
  summary: { label: string; value: string }[] // useful maker-note fields
  gps: { lat: number; lon: number; alt: number | null; mapUrl: string } | null
  groups: MetaGroup[]
}

export interface ExportOptions {
  dir: string
  size: 'original' | number // long edge in px
  quality: number // 1-100
  metadata: 'all' | 'noGps' | 'none'
  source?: 'auto' | ShotSource['key']
}

export interface Editor {
  id: string
  name: string
}
