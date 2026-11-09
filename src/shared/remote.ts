// Remote browse / sessions contract types (Wave 0). Kept out of types.ts until the rating work lands.

export type RemoteState = 'synced' | 'waiting' | 'missingHere' | 'differs'
/** Sync state of everything under a folder (diff mode only). `missingHere` only counts what has been listed on the destination so far. */
export interface RemoteRollup { total: number; waiting: number; differs: number; missingHere: number }
export interface RemoteEntry { name: string; path: string; dir: boolean; size: number; mtime: number; kind: 'jpeg'|'raw'|'heif'|'video'|'sidecar'|'other'; inLibrary: boolean; state?: RemoteState; rollup?: RemoteRollup }
export interface SessionMeta { schema: 1; id: string; name: string; date: string; client?: string; notes?: string; createdBy: string; createdAt: number; updatedAt: number }
export interface LibraryMeta { schema: 1; libraryId: string; name: string; writers: { host: string; lastSync: number }[] }
export interface SessionRow { folder: string; count: number; meta: SessionMeta | null; current: boolean }
export interface DestProgress { destId: string; sent: number; total: number; pending: number; errors: number }
export interface FoundDest { destId: string; count: number | null; offline: boolean }
export interface RemoteSessions { mine: (SessionRow & { perDest: DestProgress[] })[]; found: { key: string; folder: string; meta: SessionMeta | null; perDest: FoundDest[] }[] }
export interface BrowseResult { path: string; entries: RemoteEntry[]; meta: SessionMeta | null; cachedAt: number | null; fresh: boolean }
export interface TransferJob { id: number; kind: 'import'|'copy'; destId: string; toDestId?: string; total: number; done: number; failed: number; status: 'running'|'done'|'error'|'cancelled'; error?: string }
export interface RemoteOp { id: number; destId: string; op: 'move'|'delete'; from: string; to?: string; status: 'pending'|'running'|'error'; attempts: number; error?: string }

