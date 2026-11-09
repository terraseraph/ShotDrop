import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type { SessionMeta, SessionRow } from '@shared/remote'
import type { Library } from './library'

/** Per-session metadata file, written inside the session folder and synced like a sidecar. */
export const META_FILE = '.shotdrop.json'
export const NAME_MAX = 80
const NOTES_MAX = 4000
const SHORT_MAX = 200

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const FOLDER_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:\s|$)/
const ID_RE = /^s_[0-9a-f]{8}$/

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const newSessionId = (): string => `s_${randomBytes(4).toString('hex')}`

export function localToday(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The date a folder name starts with, if any (`2026-11-08` or `2026-11-08 Smith wedding`). */
export const folderDate = (folder: string): string | null => FOLDER_DATE_RE.exec(folder)?.[1] ?? null

/** Strips what Windows or SMB can't hold in a file name, then edge dots and spaces. */
export function sanitizeName(name: string): string {
  return name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '').replace(/^[. ]+|[. ]+$/g, '').slice(0, NAME_MAX).replace(/[. ]+$/g, '')
}

/** `YYYY-MM-DD` or `YYYY-MM-DD <name>`. */
export function folderName(date: string, name?: string): string {
  const clean = name ? sanitizeName(name) : ''
  return clean ? `${date} ${clean}` : date
}

/** A folder name from a URL or request body, accepted only if it is one plain directory name inside the library. */
export function safeFolder(libDir: string, folder: unknown): string | null {
  if (typeof folder !== 'string' || !folder || folder.length > 200 || folder.startsWith('.') || /[/\\:*?"<>|\u0000-\u001f]/.test(folder)) return null
  const full = resolve(libDir, folder)
  const rel = relative(libDir, full)
  return rel === folder && !rel.split(sep).includes('..') ? folder : null
}

async function readRaw(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, META_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Untrusted file content in, a clean SessionMeta (or null) out. */
function toMeta(raw: Record<string, unknown> | null, folder: string): SessionMeta | null {
  if (!raw || raw.schema !== 1 || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
  const date = typeof raw.date === 'string' && DATE_RE.test(raw.date) ? raw.date : folderDate(folder) ?? ''
  const meta: SessionMeta = {
    schema: 1,
    id: raw.id,
    name: str(raw.name, NAME_MAX) ?? '',
    date,
    createdBy: str(raw.createdBy, SHORT_MAX) ?? '',
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt)
  }
  const client = str(raw.client, SHORT_MAX)
  const notes = str(raw.notes, NOTES_MAX)
  if (client) meta.client = client
  if (notes) meta.notes = notes
  return meta
}

/** Missing or invalid file means the folder is unnamed. Never throws. */
export async function readMeta(libDir: string, folder: string): Promise<SessionMeta | null> {
  return toMeta(await readRaw(join(libDir, folder)), folder)
}

export interface MetaPatch {
  name?: string
  client?: string
  notes?: string
}

/**
 * Create or update a folder's meta file. Keys this version doesn't know are written back untouched.
 * A file that fails validation is replaced by a fresh one (new id) rather than repaired.
 */
export async function writeMeta(libDir: string, folder: string, patch: MetaPatch, init?: { date?: string }): Promise<SessionMeta> {
  const dir = join(libDir, folder)
  const raw = await readRaw(dir)
  const cur = toMeta(raw, folder)
  const now = Date.now()
  const base: Record<string, unknown> = cur && raw ? { ...raw } : {}
  const next: Record<string, unknown> = {
    ...base,
    schema: 1,
    id: cur?.id ?? newSessionId(),
    name: cur?.name ?? '',
    date: cur?.date || init?.date || folderDate(folder) || localToday(),
    createdBy: cur?.createdBy || hostname(),
    createdAt: cur?.createdAt || now,
    updatedAt: Math.max(now, (cur?.updatedAt ?? 0) + 1)
  }
  if (patch.name !== undefined) next.name = patch.name.trim().slice(0, NAME_MAX)
  if (patch.client !== undefined) next.client = patch.client.slice(0, SHORT_MAX)
  if (patch.notes !== undefined) next.notes = patch.notes.slice(0, NOTES_MAX)
  const out = join(dir, META_FILE)
  const tmp = `${out}.${randomBytes(3).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await rename(tmp, out)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
  return toMeta(next, folder)!
}

/** Top-level, non-dot folders of the library. */
export function sessionFolders(libDir: string): string[] {
  try {
    return readdirSync(libDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** The `sessions` table is only a cache: rebuild it from the meta files on disk (a library rescan does this). */
export async function rebuildSessions(libDir: string, lib: Library): Promise<void> {
  const rows: { folder: string; meta: SessionMeta }[] = []
  for (const folder of sessionFolders(libDir)) {
    const meta = await readMeta(libDir, folder)
    if (meta) rows.push({ folder, meta })
  }
  lib.replaceSessions(rows)
}

/** Register the meta file with the sync queue (see Library.setSessionAnchor). Returns the file id, or null if the file isn't there. */
export async function anchorMeta(libDir: string, lib: Library, folder: string, meta: SessionMeta): Promise<number | null> {
  const path = join(libDir, folder, META_FILE)
  try {
    const [st, body] = await Promise.all([stat(path), readFile(path)])
    // files.hash is UNIQUE and a copied folder has identical content, so the folder goes into the hash.
    const hash = createHash('sha1').update(folder).update('\n').update(body).digest('hex')
    return lib.setSessionAnchor(folder, path, `${folder}/${META_FILE}`, st.size, hash)
  } catch {
    return null // missing file or a DB conflict: never breaks the caller
  }
}

/** First free `folder`, then `folder-2`, `folder-3`... */
export function freeFolder(libDir: string, folder: string): string {
  let n = 1
  let f = folder
  while (existsSync(join(libDir, f))) f = `${folder}-${++n}`
  return f
}

export type SessionListRow = SessionRow & { session: string }

/** "Session 1", "Session 2"…: the first one not already used by a session on `date` (folder or name). */
export function autoSessionName(date: string, rows: { folder: string; meta: { name?: string } | null }[]): string {
  const taken = new Set(rows.filter((r) => r.folder.startsWith(date)).flatMap((r) => [r.meta?.name ?? '', r.folder.slice(date.length + 1)]))
  let n = 1
  while (taken.has(`Session ${n}`)) n++
  return `Session ${n}`
}

/** Session list and edits behind /api/sessions. Disk is the truth; the `sessions` table is its cache. */
export class SessionService {
  private lastReconcile = 0

  constructor(
    private lib: Library,
    private libDir: () => string,
    private currentSession: () => string | null,
    private destIds: () => string[],
    private emitChanged: (folder: string) => void,
    private kickSync: () => void
  ) {}

  list(): SessionListRow[] {
    void this.reconcile()
    const metas = this.lib.sessionMetas()
    const counts = new Map(this.lib.sessions().map((s) => [s.session, s.count]))
    const folders = new Set([...counts.keys(), ...metas.keys()])
    const cur = this.currentSession()
    return [...folders]
      .sort((a, b) => b.localeCompare(a))
      .map((folder) => ({ session: folder, folder, count: counts.get(folder) ?? 0, meta: metas.get(folder) ?? null, current: cur === folder }))
  }

  row(folder: string): SessionListRow {
    return this.list().find((r) => r.folder === folder) ?? { session: folder, folder, count: 0, meta: null, current: false }
  }

  /** `makeCurrent` is accepted but not acted on until wave 2 adds the current-session setting. */
  async create(input: { name?: string; client?: string; notes?: string; date?: string; makeCurrent?: boolean }): Promise<SessionListRow> {
    const libDir = this.libDir()
    const date = input.date ?? localToday()
    const name = input.name?.trim() || autoSessionName(date, this.list())
    const folder = freeFolder(libDir, folderName(date, name))
    mkdirSync(join(libDir, folder), { recursive: true })
    const meta = await writeMeta(libDir, folder, { name, client: input.client, notes: input.notes }, { date })
    // wave 2: if (input.makeCurrent) set ingest.currentSession = folder
    await this.afterWrite(folder, meta)
    return this.row(folder)
  }

  /** Metadata only; the folder keeps its name (rename and remote moves arrive in wave 2). Returns null for an unknown folder. */
  async patch(folder: string, patch: MetaPatch): Promise<SessionListRow | null> {
    const libDir = this.libDir()
    const known = existsSync(join(libDir, folder)) && statSync(join(libDir, folder)).isDirectory()
    if (!known) return null
    const meta = await writeMeta(libDir, folder, patch)
    await this.afterWrite(folder, meta)
    return this.row(folder)
  }

  private async afterWrite(folder: string, meta: SessionMeta): Promise<void> {
    this.lib.upsertSession(folder, meta)
    await this.queueMeta(folder, meta, true)
    this.emitChanged(folder)
  }

  /** Hand the written meta file to the sync queue the way a sidecar goes: a files row, then a sync job per destination. */
  private async queueMeta(folder: string, meta: SessionMeta, changed: boolean): Promise<void> {
    const fileId = await anchorMeta(this.libDir(), this.lib, folder, meta)
    if (fileId === null) return
    for (const d of this.destIds()) (changed ? this.lib.requeueSync : this.lib.enqueueSync).call(this.lib, fileId, d)
    this.kickSync()
  }

  /** Meta files found on disk (rescan, another machine) and destinations added later: make sure both are in the queue. */
  private async reconcile(): Promise<void> {
    if (Date.now() - this.lastReconcile < 30_000) return
    this.lastReconcile = Date.now()
    try {
      const have = new Set(this.lib.sessionAnchorFiles().map((a) => a.folder))
      for (const [folder, meta] of this.lib.sessionMetas()) await this.queueMeta(folder, meta, !have.has(folder))
    } catch {
      /* best effort: the next call tries again */
    }
  }
}
