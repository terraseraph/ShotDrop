import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { Destination, ServerEvent } from '@shared/types'
import type { RemoteEntry, SessionMeta, TransferJob } from '@shared/remote'
import type { Core } from './index'
import { copyRemoteToRemote, remoteFor, safeRel, type RemoteFs } from './remote'
import { META_FILE, anchorMeta, folderDate, readMeta, safeFolder, sanitizeName, writeMeta } from './sessions'

const DATED = /^\d{4}-\d{2}-\d{2}( |$)/

interface Spec { paths: string[]; recursive: boolean; session?: string; toDestId?: string; toPath?: string }
interface Job { row: TransferJob; spec: Spec; cancelled: boolean }

const localDate = (ms: number): string => {
  const d = new Date(ms || Date.now())
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1')
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * One queue for import (remote to library) and copy (remote to remote). At most one job per destination runs at a time
 * (a copy holds both its destinations). Progress is saved to `transfer_jobs` and sent as SSE `transfer:progress`.
 * Import writes locally only; copy writes to the target destination because the user asked for it.
 */
export class TransferService {
  private jobs = new Map<number, Job>()
  private waiting: Job[] = []
  private busy = new Set<string>()

  constructor(private core: Core) {}

  private get db(): Core['db'] {
    return this.core.db
  }

  private dest(id: string): Destination | undefined {
    return this.core.settings.destinations.find((d) => d.id === id)
  }

  fsFor(d: Destination): RemoteFs {
    const db = this.db
    return remoteFor(d, {
      rclonePath: this.core.settings.rclonePath,
      cloud: this.core.cloud,
      libraryHas: (paths) => {
        const have = new Set<string>()
        for (let i = 0; i < paths.length; i += 500) {
          const chunk = paths.slice(i, i + 500)
          for (const r of db.prepare(`SELECT rel_path FROM files WHERE rel_path IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { rel_path: string }[]) have.add(r.rel_path)
        }
        return have
      }
    })
  }

  list(): TransferJob[] {
    return (this.db.prepare(`SELECT * FROM transfer_jobs ORDER BY id DESC LIMIT 30`).all() as Record<string, unknown>[]).map((r) => this.fromRow(r))
  }

  private fromRow(r: Record<string, unknown>): TransferJob {
    const j: TransferJob = { id: r.id as number, kind: r.kind as TransferJob['kind'], destId: r.dest_id as string, total: r.total as number, done: r.done as number, failed: r.failed as number, status: r.status as TransferJob['status'] }
    if (r.to_dest_id) j.toDestId = r.to_dest_id as string
    if (r.error) j.error = r.error as string
    return j
  }

  /** Cancels a queued or running job; a finished one is just removed from the list. False if there is no such job. */
  cancel(id: number): boolean {
    const job = this.jobs.get(id)
    if (job) {
      job.cancelled = true
      const q = this.waiting.indexOf(job)
      if (q >= 0) {
        this.waiting.splice(q, 1)
        this.finish(job, 'cancelled')
      }
      return true
    }
    return this.db.prepare(`DELETE FROM transfer_jobs WHERE id = ?`).run(id).changes > 0
  }

  enqueue(kind: 'import' | 'copy', destId: string, spec: Spec): TransferJob {
    const res = this.db.prepare(`INSERT INTO transfer_jobs (kind, dest_id, to_dest_id, total, status, created_at) VALUES (?,?,?,?, 'running', ?)`).run(kind, destId, spec.toDestId ?? null, spec.paths.length, Date.now())
    const row: TransferJob = { id: Number(res.lastInsertRowid), kind, destId, total: spec.paths.length, done: 0, failed: 0, status: 'running' }
    if (spec.toDestId) row.toDestId = spec.toDestId
    const job: Job = { row, spec, cancelled: false }
    this.jobs.set(row.id, job)
    this.waiting.push(job)
    this.emit(row)
    this.pump()
    return { ...row }
  }

  private emit(row: TransferJob): void {
    this.db.prepare(`UPDATE transfer_jobs SET total = ?, done = ?, failed = ?, status = ?, error = ? WHERE id = ?`).run(row.total, row.done, row.failed, row.status, row.error ?? null, row.id)
    this.core.bus.emit({ type: 'transfer:progress', ...row } as unknown as ServerEvent)
  }

  private finish(job: Job, status: TransferJob['status'], error?: string): void {
    job.row.status = status
    if (error) job.row.error = error
    this.jobs.delete(job.row.id)
    this.emit(job.row)
  }

  private pump(): void {
    for (const job of [...this.waiting]) {
      const keys = [job.row.destId, ...(job.row.toDestId ? [job.row.toDestId] : [])]
      if (keys.some((k) => this.busy.has(k))) continue
      this.waiting.splice(this.waiting.indexOf(job), 1)
      keys.forEach((k) => this.busy.add(k))
      void this.run(job)
        .catch((e: unknown) => this.finish(job, 'error', e instanceof Error ? e.message : String(e)))
        .finally(() => {
          keys.forEach((k) => this.busy.delete(k))
          this.pump()
        })
    }
  }

  private async run(job: Job): Promise<void> {
    const dest = this.dest(job.row.destId)
    if (!dest) throw new Error('Unknown destination')
    const staging = join(this.core.settings.libraryDir, '.import-staging', String(job.row.id))
    try {
      if (job.row.kind === 'import') await this.runImport(job, dest, staging)
      else await this.runCopy(job, dest, staging)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
    if (job.cancelled) return this.finish(job, 'cancelled')
    this.finish(job, job.row.failed && !job.row.done ? 'error' : 'done', job.row.failed ? job.row.error : undefined)
  }

  /** Files under the selected paths. A folder gives its files (and, if `deep`, everything below). Remote listing only. */
  private async expand(fs: RemoteFs, paths: string[], deep: boolean): Promise<{ e: RemoteEntry; root: string }[]> {
    const cache = new Map<string, RemoteEntry[]>()
    const ls = async (dir: string): Promise<RemoteEntry[]> => {
      let l = cache.get(dir)
      if (!l) cache.set(dir, (l = await fs.list(dir)))
      return l
    }
    const out = new Map<string, { e: RemoteEntry; root: string }>()
    const walk = async (dir: string, root: string, recurse: boolean): Promise<void> => {
      for (const e of await ls(dir)) {
        if (e.name.startsWith('.')) continue
        if (e.dir) {
          if (recurse) await walk(e.path, root, true)
        } else out.set(e.path, { e, root })
      }
    }
    for (const raw of paths) {
      const p = safeRel(raw)
      if (!p) {
        await walk('', '', deep)
        continue
      }
      const hit = (await ls(dirname(p) === '.' ? '' : dirname(p))).find((x) => x.path === p)
      if (!hit) continue
      if (hit.dir) await walk(p, p, deep)
      else out.set(p, { e: hit, root: p })
    }
    return [...out.values()]
  }

  private async runImport(job: Job, dest: Destination, staging: string): Promise<void> {
    const core = this.core
    const fs = this.fsFor(dest)
    const libDir = core.settings.libraryDir
    const sessionOverride = job.spec.session ? safeFolder(libDir, job.spec.session) : null
    if (job.spec.session && !sessionOverride) throw new Error('Bad session folder')
    const listed = new Map<string, RemoteEntry[]>()
    const ls = async (dir: string): Promise<RemoteEntry[]> => {
      let l = listed.get(dir)
      if (!l) listed.set(dir, (l = await fs.list(dir)))
      return l
    }
    const found = await this.expand(fs, job.spec.paths, job.spec.recursive)
    const photos = found.filter(({ e }) => ['jpeg', 'raw', 'heif'].includes(e.kind))
    job.row.total = photos.length
    this.emit(job.row)

    // The folder each remote folder lands in: same name, or the override. A name without a date gets one so the library keeps it as a session.
    const earliest = new Map<string, number>()
    for (const { e } of photos) {
      const top = e.path.includes('/') ? e.path.split('/')[0] : ''
      earliest.set(top, Math.min(earliest.get(top) ?? Infinity, e.mtime || Date.now()))
    }
    const folderFor = (e: RemoteEntry): string => {
      if (sessionOverride) return sessionOverride
      const top = e.path.includes('/') ? e.path.split('/')[0] : ''
      if (!top) return localDate(e.mtime)
      if (DATED.test(top)) return top
      return `${localDate(earliest.get(top) ?? 0)} ${sanitizeName(top)}`
    }

    const touched = new Map<string, string>() // local folder -> remote top folder ('' = none)
    const pending: { hash: string }[] = []
    for (const { e } of photos) {
      if (job.cancelled) break
      const folder = folderFor(e)
      try {
        // Cheap check first: same folder and name already in the library.
        const relPath = `${folder}/${e.name}`
        if (core.db.prepare(`SELECT 1 FROM files WHERE rel_path = ?`).get(relPath)) {
          job.row.done++
          this.emit(job.row)
          continue
        }
        const stage = join(staging, `${job.row.done + job.row.failed}-${e.name}`)
        await fs.download(e.path, stage)
        const hash = await hashFile(stage)
        if (core.lib.findFileByHash(hash)) {
          job.row.done++
          this.emit(job.row)
          continue
        }
        const dir = join(libDir, folder)
        await mkdir(dir, { recursive: true })
        const dir0 = dirname(e.path) === '.' ? '' : dirname(e.path)
        const stem = basename(e.name, extname(e.name))
        const unique = (name: string): string => {
          let n = 1
          let out = name
          while (existsSync(join(dir, out)) || core.lib.pathTaken(join(dir, out))) out = `${basename(name, extname(name))}-${n++}${extname(name)}`
          return out
        }
        const finalName = unique(e.name)
        // The sidecar goes first so ingest finds it next to the photo.
        const xmp = (await ls(dir0)).find((x) => !x.dir && x.name.toLowerCase() === `${stem.toLowerCase()}.xmp`)
        if (xmp) {
          try {
            const xs = join(staging, `${job.row.done + job.row.failed}-${xmp.name}`)
            await fs.download(xmp.path, xs)
            const xName = `${basename(finalName, extname(finalName))}.xmp`
            if (!existsSync(join(dir, xName))) await rename(xs, join(dir, xName))
          } catch {
            /* the photo is still worth importing */
          }
        }
        const target = join(dir, finalName)
        await rename(stage, target)
        core.ingest.enqueue(target, { mode: 'adopt', source: null })
        pending.push({ hash })
        touched.set(folder, e.path.includes('/') ? e.path.split('/')[0] : '')
        job.row.done++
        this.emit(job.row)
      } catch (err) {
        job.row.failed++
        job.row.error = err instanceof Error ? err.message : String(err)
        this.emit(job.row)
      }
    }

    // Wait for ingest to register what we handed it, so the sync queue can be told these files are already on this destination.
    const deadline = Date.now() + 120_000
    for (const p of pending) {
      while (!core.lib.findFileByHash(p.hash) && Date.now() < deadline) await sleep(150)
      const f = core.lib.findFileByHash(p.hash)
      if (f) this.markSent(f.id, dest.id)
    }

    for (const [folder, remoteTop] of touched) await this.ensureMeta(fs, dest, folder, remoteTop)
  }

  /** The file is on `destId` already (that's where it came from): its sync job would only re-upload it. */
  private markSent(fileId: number, destId: string): void {
    this.db.prepare(`UPDATE sync_jobs SET status = 'done', error = NULL WHERE file_id = ? AND dest_id = ? AND status = 'pending'`).run(fileId, destId)
  }

  /** `.shotdrop.json` locally if absent: the remote folder's own, else a fresh one made through sessions.ts. */
  private async ensureMeta(fs: RemoteFs, dest: Destination, folder: string, remoteTop: string): Promise<void> {
    const core = this.core
    const libDir = core.settings.libraryDir
    const hadFile = existsSync(join(libDir, folder, META_FILE))
    let meta: SessionMeta | null = hadFile ? await readMeta(libDir, folder) : null
    let copied = false
    if (!hadFile && remoteTop) {
      try {
        await fs.download(`${remoteTop}/${META_FILE}`, join(libDir, folder, META_FILE))
        meta = await readMeta(libDir, folder)
        copied = !!meta
        if (!meta) await rm(join(libDir, folder, META_FILE), { force: true })
      } catch {
        /* the remote folder has none */
      }
    }
    if (!meta) {
      const name = folder.replace(/^\d{4}-\d{2}-\d{2}\s*/, '')
      meta = await writeMeta(libDir, folder, { name }, { date: folderDate(folder) ?? undefined })
    }
    core.lib.upsertSession(folder, meta)
    const fileId = await anchorMeta(libDir, core.lib, folder, meta)
    if (fileId !== null) {
      for (const d of core.settings.destinations) {
        if (!d.enabled) continue
        if (d.id === dest.id) {
          // Import never writes to the remote it read from: record the anchor as already sent so the session reconcile's enqueueSync is a no-op.
          core.lib.enqueueSync(fileId, d.id)
          this.markSent(fileId, d.id)
          continue
        }
        core.lib.enqueueSync(fileId, d.id)
      }
      core.sync.pump()
    }
    core.bus.emit({ type: 'session:changed', folder } as unknown as ServerEvent)
  }

  private async runCopy(job: Job, src: Destination, staging: string): Promise<void> {
    const to = this.dest(job.spec.toDestId ?? '')
    if (!to) throw new Error('Unknown destination')
    const toPath = safeRel(job.spec.toPath)
    const from = this.fsFor(src)
    const target = this.fsFor(to)
    const deps = { rclonePath: this.core.settings.rclonePath, cloud: this.core.cloud }
    const files = await this.expand(from, job.spec.paths, true)
    job.row.total = files.length
    this.emit(job.row)
    let n = 0
    for (const { e, root } of files) {
      if (job.cancelled) break
      // A selected folder keeps its own name under toPath; a selected file goes straight in.
      const rel = root === e.path ? e.name : `${basename(root)}/${e.path.slice(root.length + 1)}`
      const out = toPath ? `${toPath}/${rel}` : rel
      try {
        if (!(await copyRemoteToRemote(src, e.path, to, out, deps))) {
          const tmp = join(staging, `${n++}-${e.name}`)
          await from.download(e.path, tmp)
          await target.upload(tmp, out)
          await rm(tmp, { force: true })
        }
        job.row.done++
      } catch (err) {
        job.row.failed++
        job.row.error = err instanceof Error ? err.message : String(err)
      }
      this.emit(job.row)
    }
  }
}
