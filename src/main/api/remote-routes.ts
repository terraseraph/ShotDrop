import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Destination, ServerEvent } from '@shared/types'
import type { BrowseResult, RemoteEntry, RemoteSessions, SessionMeta } from '@shared/remote'
import type { Core } from '../core'
import { BadPath, remoteFor, safeRel, type RemoteFs } from '../core/remote'
import { RemoteThumbs } from '../core/remote-thumbs'
import { isUnreachable, type SyncError } from '../core/retry'

const FRESH_MS = 15_000 // a listing this young is not re-fetched on every request
const META_NAME = '.shotdrop.json'

const MIME: Record<RemoteEntry['kind'], string> = { jpeg: 'image/jpeg', heif: 'image/heif', raw: 'application/octet-stream', video: 'video/mp4', sidecar: 'application/xml', other: 'application/octet-stream' }
const EXT_MIME: Record<string, string> = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json' }

interface Row { path: string; name: string; dir: number; size: number; mtime: number; kind: RemoteEntry['kind']; seen_at: number }

/**
 * Read-only browsing of destinations: /browse (cached listing, then live), /thumb, /file, and the "found" half of
 * /remote/sessions. Nothing here writes to a remote.
 */
export function registerRemoteBrowse(app: FastifyInstance, core: Core): void {
  const cacheDir = dirname(core.previews.thumbDir)
  const thumbs = new RemoteThumbs(join(cacheDir, 'remote-thumbs'))
  const filesDir = join(cacheDir, 'remote-files')
  const db = core.db

  /** Last reachability seen per destination (from live lists); the sessions route reads this and does no network work. */
  const reach = new Map<string, boolean>()
  /** Session meta read from `<folder>/.shotdrop.json`, remembered per "dest|folder" for the found group. */
  const metas = new Map<string, SessionMeta | null>()
  const lastLive = new Map<string, number>()
  const inFlight = new Map<string, Promise<{ entries: RemoteEntry[]; meta: SessionMeta | null }>>()

  void readdir(filesDir)
    .then(async (dests) => {
      // Temp copies from earlier runs: drop anything older than a day.
      for (const d of dests) for (const f of await readdir(join(filesDir, d)).catch(() => [])) {
        const p = join(filesDir, d, f)
        const st = await stat(p).catch(() => null)
        if (st && Date.now() - st.mtimeMs > 86_400_000) await rm(p, { force: true, recursive: true }).catch(() => undefined)
      }
    })
    .catch(() => undefined)

  const libraryHas = (paths: string[]): Set<string> => {
    const have = new Set<string>()
    for (let i = 0; i < paths.length; i += 500) {
      const chunk = paths.slice(i, i + 500)
      const rows = db.prepare(`SELECT rel_path FROM files WHERE rel_path IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { rel_path: string }[]
      for (const r of rows) have.add(r.rel_path)
    }
    return have
  }

  const fsFor = (d: Destination): RemoteFs => remoteFor(d, { rclonePath: core.settings.rclonePath, cloud: core.cloud, libraryHas })

  const dest = (req: FastifyRequest): Destination | undefined => core.settings.destinations.find((d) => d.id === (req.params as { id: string }).id)

  const fail = (reply: FastifyReply, e: unknown): FastifyReply => {
    if (e instanceof BadPath) return reply.code(400).send({ error: e.message })
    const err = e as SyncError
    return reply.code(isUnreachable(err) || err.code === 'ENOENT' ? 409 : 502).send({ error: err.message })
  }

  const childRows = (destId: string, path: string): Row[] => {
    const prefix = path ? `${path}/` : ''
    return db
      .prepare(`SELECT path, name, dir, size, mtime, kind, seen_at FROM remote_entries WHERE dest_id = ? AND substr(path, 1, ?) = ? AND instr(substr(path, ?), '/') = 0 ORDER BY dir DESC, name COLLATE NOCASE`)
      .all(destId, prefix.length, prefix, prefix.length + 1) as Row[]
  }

  const toEntries = (rows: Row[]): RemoteEntry[] => {
    const have = libraryHas(rows.filter((r) => !r.dir).map((r) => r.path))
    return rows.map((r) => ({ name: r.name, path: r.path, dir: !!r.dir, size: r.size, mtime: r.mtime, kind: r.kind, inLibrary: !r.dir && have.has(r.path) }))
  }

  const readMeta = async (fs: RemoteFs, path: string): Promise<SessionMeta | null> => {
    try {
      const m = JSON.parse((await fs.readRange(path ? `${path}/${META_NAME}` : META_NAME, 0, 64 * 1024)).toString('utf8')) as Partial<SessionMeta>
      return m && typeof m === 'object' && m.schema === 1 && typeof m.id === 'string' && typeof m.name === 'string' ? (m as SessionMeta) : null
    } catch {
      return null
    }
  }

  const upsert = (destId: string, path: string, entries: RemoteEntry[]): void => {
    const now = Date.now()
    const prefix = path ? `${path}/` : ''
    db.transaction(() => {
      const keep = new Set(entries.map((e) => e.path))
      for (const r of childRows(destId, path)) {
        if (!keep.has(r.path)) {
          db.prepare(`DELETE FROM remote_entries WHERE dest_id = ? AND (path = ? OR substr(path, 1, ?) = ?)`).run(destId, r.path, r.path.length + 1, `${r.path}/`)
        }
      }
      const put = db.prepare(`INSERT INTO remote_entries (dest_id, path, name, dir, size, mtime, kind, seen_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(dest_id, path) DO UPDATE SET name=excluded.name, dir=excluded.dir, size=excluded.size, mtime=excluded.mtime, kind=excluded.kind, seen_at=excluded.seen_at`)
      for (const e of entries) if (e.path.startsWith(prefix)) put.run(destId, e.path, e.name, e.dir ? 1 : 0, e.size, e.mtime, e.kind, now)
    })()
  }

  /** One live list per destination+path at a time; stores the result and tells clients. */
  const liveList = (d: Destination, path: string): Promise<{ entries: RemoteEntry[]; meta: SessionMeta | null }> => {
    const key = `${d.id}|${path}`
    const running = inFlight.get(key)
    if (running) return running
    const job = (async () => {
      const fs = fsFor(d)
      try {
        const all = await fs.list(path)
        reach.set(d.id, true)
        const hasMeta = all.some((e) => !e.dir && e.name === META_NAME)
        const entries = all.filter((e) => !e.name.startsWith('.'))
        const meta = hasMeta ? await readMeta(fs, path) : null
        if (path) metas.set(key, meta)
        const before = JSON.stringify(childRows(d.id, path).map((r) => [r.path, r.size, r.mtime]))
        upsert(d.id, path, entries)
        lastLive.set(key, Date.now())
        const changed = before !== JSON.stringify(childRows(d.id, path).map((r) => [r.path, r.size, r.mtime]))
        if (changed) core.bus.emit({ type: 'browse:updated', destId: d.id, path } as unknown as ServerEvent)
        return { entries, meta }
      } catch (e) {
        if (isUnreachable(e as SyncError)) reach.set(d.id, false)
        throw e
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, job)
    return job
  }

  // ---- browse ----
  app.get('/api/destinations/:id/browse', async (req, reply) => {
    const d = dest(req)
    if (!d) return reply.code(404).send({ error: 'Unknown destination' })
    let path: string
    try {
      path = safeRel((req.query as { path?: string }).path)
    } catch (e) {
      return fail(reply, e)
    }
    const key = `${d.id}|${path}`
    const rows = childRows(d.id, path)
    if (rows.length) {
      const cachedAt = Math.max(...rows.map((r) => r.seen_at))
      const recent = Date.now() - (lastLive.get(key) ?? 0) < FRESH_MS
      if (!recent) void liveList(d, path).catch(() => undefined)
      const res: BrowseResult = { path, entries: toEntries(rows), meta: metas.get(key) ?? null, cachedAt, fresh: recent }
      return res
    }
    try {
      const { entries, meta } = await liveList(d, path)
      const res: BrowseResult = { path, entries, meta, cachedAt: Date.now(), fresh: true }
      return res
    } catch (e) {
      return fail(reply, e)
    }
  })

  // ---- thumbnails ----
  app.get('/api/destinations/:id/thumb', async (req, reply) => {
    const d = dest(req)
    if (!d) return reply.code(404).send({ error: 'Unknown destination' })
    const q = req.query as { path?: string; size?: string; mtime?: string }
    try {
      const path = safeRel(q.path)
      if (!path) throw new BadPath('Bad path')
      const jpg = await thumbs.get(d.id, fsFor(d), path, Number(q.size) || 0, Number(q.mtime) || 0)
      if (!jpg) return reply.code(204).send()
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(jpg)
    } catch (e) {
      return fail(reply, e)
    }
  })

  // ---- file ----
  const fetching = new Map<string, Promise<void>>()
  app.get('/api/destinations/:id/file', async (req, reply) => {
    const d = dest(req)
    if (!d) return reply.code(404).send({ error: 'Unknown destination' })
    const q = req.query as { path?: string; download?: string }
    let path: string
    try {
      path = safeRel(q.path)
      if (!path) throw new BadPath('Bad path')
    } catch (e) {
      return fail(reply, e)
    }
    const name = basename(path)
    const row = db.prepare(`SELECT size, mtime, kind FROM remote_entries WHERE dest_id = ? AND path = ?`).get(d.id, path) as { size: number; mtime: number; kind: RemoteEntry['kind'] } | undefined
    const local = join(filesDir, d.id.replace(/[^\w-]/g, '_'), `${createHash('sha1').update(`${path}|${row?.size ?? 0}|${row?.mtime ?? 0}`).digest('hex')}-${name.replace(/[^\w.-]/g, '_')}`)
    try {
      if (!(await stat(local).catch(() => null))) {
        let job = fetching.get(local)
        if (!job) {
          job = fsFor(d).download(path, local).finally(() => fetching.delete(local))
          fetching.set(local, job)
        }
        await job
      }
      const size = (await stat(local)).size
      const ext = /\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? ''
      const type = EXT_MIME[ext] ?? MIME[row?.kind ?? 'other']
      reply.header('accept-ranges', 'bytes').header('content-type', type).header('content-disposition', `${q.download === '1' ? 'attachment' : 'inline'}; filename="${name.replace(/["\r\n]/g, '_')}"`)
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(size - Number(m[2]), 0)
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
        if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send()
        return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(createReadStream(local, { start, end }))
      }
      return reply.header('content-length', size).send(createReadStream(local))
    } catch (e) {
      await mkdir(dirname(local), { recursive: true }).catch(() => undefined)
      return fail(reply, e)
    }
  })

  // ---- sessions: the "found" group (folders on destinations that have no local session). `mine` is filled in by b2-import. ----
  app.get('/api/remote/sessions', async (): Promise<RemoteSessions> => {
    const known = new Set(core.settings.destinations.map((d) => d.id))
    const local = new Set(core.lib.sessions().map((s) => s.session))
    const dirs = (db.prepare(`SELECT dest_id, path FROM remote_entries WHERE dir = 1 AND instr(path, '/') = 0`).all() as { dest_id: string; path: string }[])
      .filter((r) => known.has(r.dest_id) && !local.has(r.path))
    const counts = new Map<string, number>()
    for (const r of db.prepare(`SELECT dest_id, substr(path, 1, instr(path, '/') - 1) AS top, COUNT(*) AS n FROM remote_entries WHERE dir = 0 AND instr(path, '/') > 0 AND kind != 'sidecar' GROUP BY dest_id, top`).all() as { dest_id: string; top: string; n: number }[]) {
      counts.set(`${r.dest_id}|${r.top}`, r.n)
    }
    const groups = new Map<string, RemoteSessions['found'][number]>()
    for (const r of dirs) {
      const meta = metas.get(`${r.dest_id}|${r.path}`) ?? null
      const key = meta ? meta.id : `f:${r.path}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { key, folder: r.path, meta, perDest: [] }))
      g.perDest.push({ destId: r.dest_id, count: counts.get(`${r.dest_id}|${r.path}`) ?? null, offline: reach.get(r.dest_id) === false })
    }
    return { mine: [], found: [...groups.values()].sort((a, b) => b.folder.localeCompare(a.folder)) }
  })
}
