import { spawn } from 'node:child_process'
import { copyFile, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { Destination } from '@shared/types'
import type { RemoteEntry } from '@shared/remote'
import { toolPath } from './bundled'
import { isUnreachable, type SyncError } from './retry'
import type { CloudAccounts } from './cloud'

/** One level of a destination, read-only unless the caller explicitly uses move/remove. */
export interface RemoteFs {
  list(path: string): Promise<RemoteEntry[]> // one level, no recursion
  readRange(path: string, offset: number, length: number): Promise<Buffer>
  download(path: string, toLocal: string): Promise<void> // temp + rename
  move(from: string, to: string): Promise<void> // server-side where possible
  remove(path: string): Promise<void> // trash where the provider has one
  reachable(): Promise<boolean>
}

export interface RemoteDeps {
  rclonePath: string
  cloud: CloudAccounts
  /** Recycle bin for folder destinations; falls back to a plain delete. */
  trash?: (path: string) => Promise<void>
  /** Which of these destination-relative paths are already in the local library (files.rel_path). */
  libraryHas?: (paths: string[]) => Set<string>
}

export class BadPath extends Error {}

/**
 * The one check every route uses. Returns a normalised POSIX path relative to the destination target ('' = the root),
 * or throws BadPath for `..`, a leading slash, a drive letter, a backslash or a NUL.
 */
export function safeRel(p: unknown): string {
  if (p === undefined || p === null || p === '') return ''
  if (typeof p !== 'string') throw new BadPath('Bad path')
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new BadPath('Bad path')
  const parts = p.split('/').filter((s) => s !== '' && s !== '.')
  if (parts.some((s) => s === '..')) throw new BadPath('Bad path')
  return parts.join('/')
}

const RAW = new Set(['.arw', '.cr2', '.cr3', '.nef', '.nrw', '.raf', '.dng', '.orf', '.rw2', '.pef', '.srw', '.3fr', '.iiq', '.x3f'])
const HEIF = new Set(['.heif', '.heic', '.hif'])
const VIDEO = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m4v'])

export function kindOfName(name: string): RemoteEntry['kind'] {
  const ext = extname(name).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg'
  if (RAW.has(ext)) return 'raw'
  if (HEIF.has(ext)) return 'heif'
  if (VIDEO.has(ext)) return 'video'
  if (ext === '.xmp') return 'sidecar'
  return 'other'
}

const unreachable = (message: string): SyncError => Object.assign(new Error(message), { unreachable: true })

function entryOf(path: string, name: string, dir: boolean, size: number, mtime: number): RemoteEntry {
  return { name, path, dir, size: dir ? 0 : size, mtime, kind: dir ? 'other' : kindOfName(name), inLibrary: false }
}

function withLibrary(entries: RemoteEntry[], deps: RemoteDeps): RemoteEntry[] {
  if (!deps.libraryHas) return entries
  const files = entries.filter((e) => !e.dir).map((e) => e.path)
  if (!files.length) return entries
  const have = deps.libraryHas(files)
  return entries.map((e) => (e.dir ? e : { ...e, inLibrary: have.has(e.path) }))
}

const sortEntries = (a: RemoteEntry, b: RemoteEntry): number => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true })

// ---------------------------------------------------------------- folders

class FolderFs implements RemoteFs {
  constructor(private root: string, private deps: RemoteDeps) {}

  private abs(p: string): string {
    return join(this.root, ...safeRel(p).split('/').filter(Boolean))
  }

  private async rootCheck(): Promise<void> {
    await stat(this.root).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT' || isUnreachable(e) ? unreachable(`${this.root} is not reachable`) : e
    })
  }

  async list(path: string): Promise<RemoteEntry[]> {
    await this.rootCheck()
    const rel = safeRel(path)
    const names = await readdir(this.abs(rel)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [] as string[]
      throw e
    })
    const out: RemoteEntry[] = []
    for (const name of names) {
      if (name.endsWith('.shotdrop-part')) continue
      const st = await stat(join(this.abs(rel), name)).catch(() => null)
      if (!st) continue
      out.push(entryOf(rel ? `${rel}/${name}` : name, name, st.isDirectory(), st.size, Math.round(st.mtimeMs)))
    }
    return withLibrary(out.sort(sortEntries), this.deps)
  }

  async readRange(path: string, offset: number, length: number): Promise<Buffer> {
    const fh = await open(this.abs(path), 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, offset)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }

  async download(path: string, toLocal: string): Promise<void> {
    const tmp = `${toLocal}.shotdrop-part`
    await mkdir(dirname(toLocal), { recursive: true })
    try {
      await copyFile(this.abs(path), tmp)
      await rename(tmp, toLocal)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw e
    }
  }

  async move(from: string, to: string): Promise<void> {
    await this.rootCheck()
    await mkdir(dirname(this.abs(to)), { recursive: true })
    await rename(this.abs(from), this.abs(to))
  }

  async remove(path: string): Promise<void> {
    await this.rootCheck()
    const p = this.abs(path)
    if (this.deps.trash) {
      try {
        await this.deps.trash(p)
        return
      } catch {
        /* no recycle bin here (network share): plain delete */
      }
    }
    await rm(p, { recursive: true, force: true })
  }

  async reachable(): Promise<boolean> {
    return stat(this.root).then(
      (s) => s.isDirectory(),
      () => false
    )
  }
}

// ---------------------------------------------------------------- rclone

interface LsJson { Path: string; Name: string; Size: number; ModTime: string; IsDir: boolean }

class RcloneFs implements RemoteFs {
  private remoteName: string
  constructor(private target: string, private deps: RemoteDeps) {
    this.remoteName = target.split(':')[0]
  }

  private bin(): string {
    return toolPath(this.deps.rclonePath, 'rclone')
  }

  private cfg(): string[] {
    return this.deps.cloud.has(this.remoteName) ? this.deps.cloud.cfgArgs() : []
  }

  private at(path: string): string {
    const rel = safeRel(path)
    const base = this.target.replace(/\/+$/, '')
    if (!rel) return base
    return base.endsWith(':') ? `${base}${rel}` : `${base}/${rel}`
  }

  private run(args: string[], timeoutMs = 120_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin(), [...args, '--contimeout', '20s', '--timeout', '2m', '--retries', '1', '--low-level-retries', '3', ...this.cfg()], { windowsHide: true })
      const out: Buffer[] = []
      let stderr = ''
      const timer = setTimeout(() => p.kill(), timeoutMs)
      p.stdout.on('data', (d: Buffer) => out.push(d))
      p.stderr.on('data', (d) => (stderr += d.toString()))
      p.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve(Buffer.concat(out))
        const e: SyncError = new Error(stderr.trim().split('\n').pop() || `rclone exit ${code}`)
        e.exitCode = code ?? undefined
        reject(e)
      })
    })
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const rel = safeRel(path)
    let rows: LsJson[]
    try {
      rows = JSON.parse((await this.run(['lsjson', this.at(rel), '--no-mimetype', '--hash=false'])).toString('utf8') || '[]') as LsJson[]
    } catch (e) {
      // exit 3 = directory not found: an empty (not yet created) folder, not an error.
      if ((e as SyncError).exitCode === 3) return []
      throw e
    }
    const out = rows.map((r) => entryOf(rel ? `${rel}/${r.Name}` : r.Name, r.Name, r.IsDir, Math.max(r.Size, 0), Date.parse(r.ModTime) || 0))
    return withLibrary(out.sort(sortEntries), this.deps)
  }

  readRange(path: string, offset: number, length: number): Promise<Buffer> {
    return this.run(['cat', this.at(path), '--offset', String(offset), '--count', String(length)])
  }

  async download(path: string, toLocal: string): Promise<void> {
    const tmp = `${toLocal}.shotdrop-part`
    await mkdir(dirname(toLocal), { recursive: true })
    try {
      await this.run(['copyto', this.at(path), tmp])
      await rename(tmp, toLocal)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw e
    }
  }

  async move(from: string, to: string): Promise<void> {
    await this.run(['moveto', this.at(from), this.at(to)])
  }

  async remove(path: string): Promise<void> {
    try {
      await this.run(['deletefile', this.at(path), '--drive-use-trash=true'])
    } catch (e) {
      const err = e as SyncError
      if (err.exitCode === 3 || err.exitCode === 4) return
      throw e
    }
  }

  async reachable(): Promise<boolean> {
    try {
      await this.run(['lsd', this.at(''), '--max-depth', '0'], 30_000)
      return true
    } catch (e) {
      // Reachable but the folder doesn't exist yet still counts as reachable.
      return (e as SyncError).exitCode === 3
    }
  }
}

export function remoteFor(dest: Destination, deps: RemoteDeps): RemoteFs {
  return dest.type === 'folder' ? new FolderFs(dest.target, deps) : new RcloneFs(dest.target, deps)
}
