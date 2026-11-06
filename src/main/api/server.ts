import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import { registerDiagnostics } from './diagnostics'
import { registerCloud } from './cloud'
import { listSources, metadataFile, resolveImage } from '../core/sources'
import { exportJpeg } from '../core/exporter'
import { checkPath, ensurePath, listPlaces } from '../core/places'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Core } from '../core'
import type { Destination, ExportOptions, Flag, ServerEvent, Settings, ShotPatch, ShotSource, SyncStatus } from '@shared/types'

const isLoopback = (ip: string): boolean => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

/** Scoped, PIN-derived token that lets a shared link fetch one shot's image but nothing else. */
const shareToken = (pin: string, id: number | string): string => createHmac('sha256', pin).update(`share:${id}`).digest('hex').slice(0, 24)

const MIME: Record<string, string> = {
  jpeg: 'image/jpeg', heif: 'image/heif', raw: 'application/octet-stream', video: 'video/mp4', other: 'application/octet-stream'
}

const shotPatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rating: { type: 'integer', minimum: 0, maximum: 5 },
    flag: { type: 'integer', enum: [-1, 0, 1] },
    label: { type: ['string', 'null'], enum: ['red', 'yellow', 'green', 'blue', 'purple', null] }
  }
} as const

const destinationSchema = {
  type: 'object',
  required: ['name', 'type', 'target'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: ['folder', 'rclone'] },
    target: { type: 'string', minLength: 1 },
    filter: { type: 'string', enum: ['all', 'jpeg', 'raw', 'picks'] },
    enabled: { type: 'boolean' },
    mirrorDeletes: { type: 'boolean' }
  }
} as const

/**
 * A folder destination the user just chose is created now. Sync itself never creates a missing root, because a missing
 * root later usually means an unplugged drive or offline NAS, and recreating it would write to the wrong disk.
 */
function ensureFolder(d: Destination): void {
  if (d.type !== 'folder') return
  try {
    mkdirSync(d.target, { recursive: true })
  } catch {
    /* drive or share not there: the card shows "Can't reach" until it is */
  }
}

export interface ApiOptions {
  rendererDir?: string // built UI to serve to remote browsers
  /** Opens the native folder picker on this PC (Electron). Lets a phone ask "Browse on the PC…". */
  pickFolder?: () => Promise<string | null>
}

/**
 * REST API + SSE event stream. The desktop UI uses it exactly like a remote browser does,
 * so anything the app can do is scriptable over HTTP.
 *
 * Bound to 127.0.0.1 unless remote access is on; non-loopback requests then need the PIN
 * (header `x-shotdrop-key` or `?key=` for <img> URLs).
 */
export async function createApi(core: Core, opts: ApiOptions = {}, restart: () => void = () => undefined): Promise<FastifyInstance> {
  // forceCloseConnections: SSE streams would otherwise keep close() waiting forever.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, forceCloseConnections: true })
  await app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'], allowedHeaders: ['content-type', 'x-shotdrop-key'] })

  app.addHook('onRequest', async (req, reply) => {
    // A tunnel/proxy (cloudflared etc.) connects from loopback but forwards someone else's request.
    const proxied = !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])
    if ((isLoopback(req.ip) && !proxied) || !req.url.startsWith('/api/')) return
    const { remote } = core.settings
    const key = (req.headers['x-shotdrop-key'] as string | undefined) ?? (req.query as { key?: string }).key
    // LAN remote mode needs no PIN. Tunnel (public internet) requests still do.
    if (!proxied && remote.enabled) return
    const open = remote.enabled || (proxied && core.tunnel.state.status === 'running')
    const img = /^\/api\/shots\/(\d+)\/preview(?:$|\?)/.exec(req.url)
    const share = (req.query as { share?: string }).share
    if (req.method === 'GET' && open && remote.pin && img && share && share === shareToken(remote.pin, img[1])) return
    if (!open || !remote.pin || key !== remote.pin) return reply.code(401).send({ error: 'PIN required' })
  })

  // Anything that changes configuration, runs programs or moves files elsewhere is only for the ShotDrop computer.
  // Remote clients (LAN or tunnel, with the PIN) can view and cull, nothing more.
  const isLocalReq = (req: FastifyRequest): boolean => isLoopback(req.ip) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for']
  const localOnly = async (req: FastifyRequest, reply: import('fastify').FastifyReply): Promise<void> => {
    if (!isLocalReq(req)) {
      return reply.code(403).send({ error: 'Only available on the ShotDrop computer' })
    }
  }
  const local = { preHandler: localOnly }

  const shotId = (req: FastifyRequest): number => Number((req.params as { id: string }).id)

  // ---- meta ----
  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/status', async () => core.status())

  // ---- shots ----
  app.get('/api/sessions', async () => core.lib.sessions())
  app.get('/api/library/counts', async () => core.lib.filterCounts())

  app.get('/api/shots', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const flag = q.flag === 'notRejected' ? 'notRejected' : q.flag !== undefined ? (Number(q.flag) as Flag) : undefined
    const seq = core.bus.current
    const page = core.lib.list({
      session: q.session || undefined,
      source: q.source || undefined,
      minRating: q.minRating ? Number(q.minRating) : undefined,
      flag,
      label: q.label || undefined,
      order: q.order === 'desc' ? 'desc' : 'asc',
      limit: q.limit ? Math.min(Number(q.limit), 10000) : undefined,
      offset: q.offset ? Number(q.offset) : undefined
    })
    return { ...page, seq }
  })

  /** Polling alternative to /api/events for clients behind proxies that don't pass SSE (Cloudflare quick tunnels). */
  app.get('/api/changes', async (req) => {
    const after = Number((req.query as { after?: string }).after ?? 0)
    return { ...core.bus.since(Number.isFinite(after) ? after : 0), status: core.status() }
  })

  app.get('/api/shots/:id', async (req, reply) => {
    const shot = core.lib.get(shotId(req))
    return shot ?? reply.code(404).send({ error: 'Not found' })
  })

  app.patch('/api/shots/:id', { schema: { body: shotPatchSchema } }, async (req, reply) => {
    const shot = core.updateShot(shotId(req), req.body as ShotPatch)
    return shot ?? reply.code(404).send({ error: 'Not found' })
  })

  app.patch(
    '/api/shots',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ids', 'patch'],
          properties: { ids: { type: 'array', items: { type: 'integer' } }, patch: shotPatchSchema }
        }
      }
    },
    async (req) => {
      const { ids, patch } = req.body as { ids: number[]; patch: ShotPatch }
      return ids.map((id) => core.updateShot(id, patch)).filter(Boolean)
    }
  )

  /** Before deleting: which destinations hold copies, and which of them will lose theirs too (mirror deletes). */
  app.get('/api/shots/delete-preview', async (req, reply) => {
    const raw = String((req.query as { ids?: string }).ids ?? '')
    const ids = raw.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
    if (!ids.length) return reply.code(400).send({ error: 'ids required' })
    return core.deletePreview(ids)
  })

  app.delete('/api/shots/:id', async (req, reply) => {
    const r = await core.deleteShot(shotId(req))
    if (!r) return reply.code(404).send({ error: 'Not found' })
    if (!r.deleted) return reply.code(409).send({ error: "Some files couldn't be deleted from disk", failed: r.failed })
    return reply.code(204).send()
  })

  const sendImage = (path: string, reply: import('fastify').FastifyReply, type = 'image/jpeg') => {
    if (!existsSync(path)) return reply.code(404).send({ error: 'Not ready' })
    return reply
      .header('content-type', type)
      .header('content-length', statSync(path).size)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(path))
  }

  app.get('/api/shots/:id/thumb', async (req, reply) => sendImage(core.previews.thumbPath(shotId(req)), reply))
  app.get('/api/shots/:id/preview', async (req, reply) => sendImage(core.previews.previewPath(shotId(req)), reply))

  /** sendImage plus Range support: <video> seeks (and Chromium starts playback) with Range requests. */
  const sendFile = (req: FastifyRequest, reply: import('fastify').FastifyReply, path: string, type: string) => {
    reply.header('accept-ranges', 'bytes')
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (!m || !existsSync(path)) return sendImage(path, reply, type)
    const size = statSync(path).size
    const start = m[1] ? Number(m[1]) : Math.max(size - Number(m[2]), 0)
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if ((!m[1] && !m[2]) || start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send()
    return reply
      .code(206)
      .header('content-type', type)
      .header('content-range', `bytes ${start}-${end}/${size}`)
      .header('content-length', end - start + 1)
      .send(createReadStream(path, { start, end }))
  }

  /** Original file. `?file=<fileId>` picks one of a RAW+JPEG pair; default is the preview source. `?dl=1` forces a download. */
  app.get('/api/shots/:id/original', async (req, reply) => {
    const id = shotId(req)
    const q = req.query as { file?: string; dl?: string }
    const fileId = Number(q.file) || core.lib.previewFileId(id)
    const file = fileId ? core.lib.file(fileId) : undefined
    if (!file || file.shot_id !== id) return reply.code(404).send({ error: 'Not found' })
    reply.header('content-disposition', `${q.dl ? 'attachment' : 'inline'}; filename="${file.name}"`)
    return sendFile(req, reply, file.path, MIME[file.kind])
  })

  /** Browser-playable copy of a video. POST starts the transcode (idempotent) and says whether it's ready; GET serves it. */
  app.post('/api/shots/:id/proxy', async (req, reply) => {
    const id = shotId(req)
    const video = core.lib.files(id).find((f) => f.kind === 'video')
    if (!video) return reply.code(404).send({ error: 'Not a video' })
    return core.previews.proxy(id, video.path)
  })
  app.get('/api/shots/:id/proxy', async (req, reply) => sendFile(req, reply, core.previews.proxyPath(shotId(req)), 'video/mp4'))

  /** Where a file lives on disk, so the desktop app can open it in the user's own player. */
  app.get('/api/files/:id/path', local, async (req, reply) => {
    const file = core.lib.file(Number((req.params as { id: string }).id))
    return file ? { path: file.path } : reply.code(404).send({ error: 'Not found' })
  })

  // ---- RAW sources, develop, full-res ----
  app.get('/api/shots/:id/sources', async (req, reply) => {
    if (!core.lib.get(shotId(req))) return reply.code(404).send({ error: 'Not found' })
    return listSources(core, shotId(req))
  })

  /** Full-resolution rendition: `?src=jpeg|embedded|raw`. embedded is made on demand; raw must be developed first. */
  app.get('/api/shots/:id/full', async (req, reply) => {
    const src = (req.query as { src?: string }).src as ShotSource['key']
    if (!['jpeg', 'embedded', 'raw'].includes(src)) return reply.code(400).send({ error: 'src must be jpeg, embedded or raw' })
    try {
      const r = await resolveImage(core, shotId(req), src, false)
      return r ? sendImage(r.path, reply) : reply.code(404).send({ error: 'Not ready' })
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }
  })

  /** Make the full-size RAW decode (seconds). Only on the ShotDrop computer: it runs a program and eats CPU/RAM. */
  app.post('/api/shots/:id/develop', local, async (req, reply) => {
    try {
      const r = await resolveImage(core, shotId(req), 'raw', true)
      return r ? r.source : reply.code(404).send({ error: 'This shot has no RAW file' })
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }
  })

  // ---- metadata ----
  app.get('/api/shots/:id/metadata', async (req, reply) => {
    const f = metadataFile(core, shotId(req), Number((req.query as { file?: string }).file) || undefined)
    if (!f) return reply.code(404).send({ error: 'Not found' })
    try {
      return await core.meta.get(f.id, f.name, f.path)
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }
  })

  // ---- export & sharing ----
  app.post(
    '/api/shots/:id/export',
    {
      ...local,
      schema: {
        body: {
          type: 'object',
          required: ['dir', 'size', 'quality', 'metadata'],
          properties: {
            dir: { type: 'string', minLength: 1 },
            size: { anyOf: [{ const: 'original' }, { type: 'integer', minimum: 16, maximum: 20000 }] },
            quality: { type: 'integer', minimum: 1, maximum: 100 },
            metadata: { enum: ['all', 'noGps', 'none'] },
            source: { enum: ['auto', 'jpeg', 'embedded', 'raw'] }
          }
        }
      }
    },
    async (req, reply) => {
      try {
        return { path: await exportJpeg(core, shotId(req), req.body as ExportOptions) }
      } catch (e) {
        return reply.code(500).send({ error: (e as Error).message })
      }
    }
  )

  /** A link to the shot's preview for people outside the LAN, via the tunnel or remote mode. Its token opens that one image only. */
  app.get('/api/shots/:id/link', local, async (req) => {
    const id = shotId(req)
    const { remote } = core.settings
    const t = core.tunnel.state
    const origin = t.status === 'running' && t.url ? t.url : remote.enabled ? core.status().api.urls[0] : null
    if (!origin || !remote.pin) return { url: null, reason: 'Turn on the tunnel or remote access (with a PIN) to share links.' }
    return { url: `${origin}/api/shots/${id}/preview?share=${shareToken(remote.pin, id)}`, via: t.status === 'running' ? 'tunnel' : 'LAN' }
  })

  // ---- settings ----
  /** Full settings on this PC. Remote viewers get a redacted copy (no PIN, no camera passwords, no secrets) so the phone can show them. */
  app.get('/api/settings', async (req) => {
    const s = core.settings
    if (isLocalReq(req)) return s
    return {
      ...s,
      remote: { enabled: s.remote.enabled, pin: '' },
      ftp: { ...s.ftp, users: s.ftp.users.map((u) => ({ ...u, password: '' })) },
      rclonePath: '',
      tunnel: { autoStart: s.tunnel.autoStart, cloudflaredPath: '' }
    }
  })

  app.patch('/api/settings', local, async (req, reply) => {
    const patch = req.body as Partial<Settings>
    delete (patch as Partial<Settings>).destinations // managed via /api/destinations
    const { settings, restartApi } = await core.updateSettings(patch)
    if (restartApi) reply.raw.once('finish', () => setTimeout(restart, 50))
    return settings
  })

  app.post('/api/library/rescan', local, async () => ({ queued: await core.ingest.rescanLibrary() }))

  // ---- FTP ----
  app.post('/api/ftp/start', local, async () => {
    await core.updateSettings({ ftp: { ...core.settings.ftp, enabled: true } })
    return core.status().ftp
  })
  app.post('/api/ftp/stop', local, async () => {
    await core.updateSettings({ ftp: { ...core.settings.ftp, enabled: false } })
    return core.status().ftp
  })

  // ---- Cloudflare quick tunnel ----
  app.get('/api/tunnel', async () => core.tunnel.state)
  app.post('/api/tunnel/install', local, async (_req, reply) => {
    try {
      await core.tunnel.install()
      return core.tunnel.state
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }
  })
  app.post('/api/tunnel/start', local, async (_req, reply) => {
    try {
      await core.startTunnel()
      return core.tunnel.state
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message })
    }
  })
  app.post('/api/tunnel/stop', local, async () => {
    await core.tunnel.stop()
    return core.tunnel.state
  })

  // ---- destinations & sync ----
  app.get('/api/destinations', local, async () => core.settings.destinations)

  app.post('/api/destinations', { ...local, schema: { body: destinationSchema } }, async (req, reply) => {
    const body = req.body as Omit<Destination, 'id'>
    const dest: Destination = { ...body, filter: body.filter ?? 'all', enabled: body.enabled ?? true, id: randomUUID().slice(0, 8) }
    ensureFolder(dest)
    await core.updateSettings({ destinations: [...core.settings.destinations, dest] })
    return reply.code(201).send(dest)
  })

  /** Remote viewers may only pause/resume (`{ enabled }`); everything else stays on this PC. */
  app.patch('/api/destinations/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const list = core.settings.destinations
    const i = list.findIndex((d) => d.id === id)
    if (i < 0) return reply.code(404).send({ error: 'Not found' })
    const body = req.body as Partial<Destination>
    const patch: Partial<Destination> = isLocalReq(req) ? body : typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}
    if (!isLocalReq(req) && !('enabled' in patch)) return reply.code(403).send({ error: 'Only pause and resume are available away from the ShotDrop computer' })
    const next = [...list]
    next[i] = { ...list[i], ...patch, id }
    if (next[i].target !== list[i].target) ensureFolder(next[i])
    await core.updateSettings({ destinations: next })
    return next[i]
  })

  app.delete('/api/destinations/:id', local, async (req, reply) => {
    const id = (req.params as { id: string }).id
    await core.updateSettings({ destinations: core.settings.destinations.filter((d) => d.id !== id) })
    return reply.code(204).send()
  })

  app.post('/api/destinations/:id/resync', local, async (req, reply) => {
    const dest = core.settings.destinations.find((d) => d.id === (req.params as { id: string }).id)
    if (!dest) return reply.code(404).send({ error: 'Not found' })
    return { queued: core.sync.backfill(dest) }
  })

  app.get('/api/sync/jobs', local, async (req) => {
    const { status } = req.query as { status?: SyncStatus }
    return core.lib.syncJobs(status)
  })

  app.post('/api/sync/retry', async () => {
    const n = core.lib.retryFailedSync() + core.lib.retryFailedRemoteDeletes()
    core.sync.pump()
    return { retried: n }
  })

  // ---- folders and drives: quick picks so nothing has to be typed ----
  app.get('/api/fs/places', local, async () => listPlaces())

  app.get('/api/fs/check', local, async (req, reply) => {
    const { path } = req.query as { path?: string }
    if (!path) return reply.code(400).send({ error: 'path required' })
    return checkPath(path)
  })

  app.post('/api/fs/ensure', { ...local, schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } } }, async (req, reply) => {
    try {
      return await ensurePath((req.body as { path: string }).path)
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }
  })

  /** Opens the folder picker on this PC and waits for the choice. Remote callers (the phone's "Browse on the PC…") may use it:
   *  nothing changes until someone at the PC picks a folder, and the caller still has to PATCH the setting. */
  let picking: Promise<string | null> | null = null
  app.post('/api/fs/pick', async (_req, reply) => {
    if (!opts.pickFolder) return reply.code(501).send({ error: 'No folder picker in this build' })
    if (!picking) picking = opts.pickFolder().finally(() => (picking = null))
    return { path: await picking }
  })

  /** Export as a download (phone "Save to phone" / "Share to…"). Written to a temp folder, served once. */
  app.get('/api/shots/:id/export', async (req, reply) => {
    const q = req.query as { size?: string; quality?: string; metadata?: string; source?: string }
    const size = !q.size || q.size === 'original' ? 'original' : Number(q.size)
    const quality = q.quality ? Number(q.quality) : 92
    const metadata = (['all', 'noGps', 'none'].includes(q.metadata ?? '') ? q.metadata : 'all') as ExportOptions['metadata']
    const source = (['auto', 'jpeg', 'embedded', 'raw'].includes(q.source ?? '') ? q.source : 'auto') as ExportOptions['source']
    if (size !== 'original' && !(Number.isInteger(size) && size >= 16 && size <= 20000)) return reply.code(400).send({ error: 'bad size' })
    if (!(Number.isInteger(quality) && quality >= 1 && quality <= 100)) return reply.code(400).send({ error: 'bad quality' })
    const dir = join(tmpdir(), 'shotdrop-export', randomUUID())
    mkdirSync(dir, { recursive: true })
    try {
      const path = await exportJpeg(core, shotId(req), { dir, size, quality, metadata, source })
      reply.header('content-disposition', `attachment; filename="${path.split(/[\\/]/).pop()}"`)
      return sendImage(path, reply)
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }
  })

  // ---- live events (Server-Sent Events) ----
  app.get('/api/events', (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      // no-transform stops proxies/tunnels (Cloudflare) compressing, which buffers the stream.
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
      'access-control-allow-origin': (req.headers.origin as string) ?? '*'
    })
    const send = (e: ServerEvent): void => {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    }
    res.write(`: ${' '.repeat(2048)}

`) // padding pushes the first bytes through buffering proxies
    send({ type: 'status', status: core.status() })
    const off = core.bus.on(send)
    const ping = setInterval(() => res.write(': ping\n\n'), 20000)
    req.raw.on('close', () => {
      off()
      clearInterval(ping)
    })
  })

  // ---- live view (PTP/IP camera) as MJPEG, so a plain <img> can show it ----
  app.get('/api/live', (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': (req.headers.origin as string) ?? '*'
    })
    const off = core.ptp.subscribe((jpeg) => {
      if (res.writableNeedDrain) return // slow viewer: drop frames rather than queue them
      res.write(`--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ${jpeg.length}\r\n\r\n`)
      res.write(jpeg)
      res.write('\r\n')
    })
    req.raw.on('close', off)
  })

  // ---- connection check (firewall, ports, self-test) ----
  registerDiagnostics(app, core)
  registerCloud(app, core)

  // ---- remote web UI ----
  if (opts.rendererDir && existsSync(opts.rendererDir)) {
    await app.register(fastifyStatic, { root: opts.rendererDir })
  }

  return app
}

/** Create and listen; returns a handle that can rebind when remote/port settings change. */
export async function startApi(core: Core, opts: ApiOptions = {}): Promise<{ stop: () => Promise<void> }> {
  let app: FastifyInstance | null = null

  const listen = async (): Promise<void> => {
    if (app) await app.close()
    app = await createApi(core, opts, () => void listen().catch((e) => console.error('[api] restart failed', e)))
    const { api, remote } = core.settings
    const host = remote.enabled ? '0.0.0.0' : '127.0.0.1'
    const prevPort = core.apiState.port
    await app.listen({ port: api.port, host })
    core.apiState = { port: api.port, remote: remote.enabled }
    core.emitStatus()
    // The tunnel forwards to a fixed local port; follow a port change.
    if (prevPort && prevPort !== api.port && core.tunnel.state.status === 'running') {
      await core.tunnel.stop()
      await core.startTunnel().catch(() => undefined)
    }
  }

  await listen()
  return { stop: async () => void (await app?.close()) }
}
