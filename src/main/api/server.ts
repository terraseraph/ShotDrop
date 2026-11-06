import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { registerDiagnostics } from './diagnostics'
import type { Core } from '../core'
import type { Destination, Flag, ServerEvent, Settings, ShotPatch, SyncStatus } from '@shared/types'

const isLoopback = (ip: string): boolean => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

const MIME: Record<string, string> = {
  jpeg: 'image/jpeg', heif: 'image/heif', raw: 'application/octet-stream', other: 'application/octet-stream'
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
    enabled: { type: 'boolean' }
  }
} as const

export interface ApiOptions {
  rendererDir?: string // built UI to serve to remote browsers
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
    // Outside access is allowed through LAN remote mode or a running tunnel, and always needs the PIN.
    const open = remote.enabled || (proxied && core.tunnel.state.status === 'running')
    if (!open || !remote.pin || key !== remote.pin) return reply.code(401).send({ error: 'PIN required' })
  })

  // Anything that changes configuration, runs programs or moves files elsewhere is only for the ShotDrop computer.
  // Remote clients (LAN or tunnel, with the PIN) can view and cull, nothing more.
  const localOnly = async (req: FastifyRequest, reply: import('fastify').FastifyReply): Promise<void> => {
    if (!isLoopback(req.ip) || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) {
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

  app.get('/api/shots', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const flag = q.flag === 'notRejected' ? 'notRejected' : q.flag !== undefined ? (Number(q.flag) as Flag) : undefined
    const seq = core.bus.current
    const page = core.lib.list({
      session: q.session || undefined,
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

  app.delete('/api/shots/:id', async (req, reply) => {
    const ok = await core.deleteShot(shotId(req))
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'Not found' })
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

  /** Original file. `?file=<fileId>` picks one of a RAW+JPEG pair; default is the preview source. */
  app.get('/api/shots/:id/original', async (req, reply) => {
    const id = shotId(req)
    const fileId = Number((req.query as { file?: string }).file) || core.lib.previewFileId(id)
    const file = fileId ? core.lib.file(fileId) : undefined
    if (!file || file.shot_id !== id) return reply.code(404).send({ error: 'Not found' })
    reply.header('content-disposition', `inline; filename="${file.name}"`)
    return sendImage(file.path, reply, MIME[file.kind])
  })

  // ---- settings ----
  app.get('/api/settings', local, async () => core.settings)

  app.patch('/api/settings', local, async (req, reply) => {
    const patch = req.body as Partial<Settings>
    delete (patch as Partial<Settings>).destinations // managed via /api/destinations
    const { settings, restartApi } = await core.updateSettings(patch)
    if (restartApi) reply.raw.once('finish', () => setTimeout(restart, 50))
    return settings
  })

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
    await core.updateSettings({ destinations: [...core.settings.destinations, dest] })
    return reply.code(201).send(dest)
  })

  app.patch('/api/destinations/:id', local, async (req, reply) => {
    const id = (req.params as { id: string }).id
    const list = core.settings.destinations
    const i = list.findIndex((d) => d.id === id)
    if (i < 0) return reply.code(404).send({ error: 'Not found' })
    const next = [...list]
    next[i] = { ...list[i], ...(req.body as Partial<Destination>), id }
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

  app.post('/api/sync/retry', local, async () => {
    const n = core.lib.retryFailedSync()
    core.sync.pump()
    return { retried: n }
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

  // ---- connection check (firewall, ports, self-test) ----
  registerDiagnostics(app, core)

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
