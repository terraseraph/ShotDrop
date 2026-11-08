import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Destination, ServerEvent } from '@shared/types'
import type { SessionMeta } from '@shared/remote'
import type { Core } from '../core'
import { queueSessionSend } from '../core/diff'
import { BadPath, safeRel } from '../core/remote'
import type { SyncError } from '../core/retry'
import { isUnreachable } from '../core/retry'
import { META_FILE, NAME_MAX, folderDate, localToday, newSessionId, safeFolder } from '../core/sessions'
import { TransferService } from '../core/transfers'

/** Import, copy, send, adopt and the transfer list. Import writes locally only; the rest are explicit user actions. */
export function registerTransfers(app: FastifyInstance, core: Core): void {
  const transfers = new TransferService(core)
  const dest = (id: string | undefined): Destination | undefined => core.settings.destinations.find((d) => d.id === id)
  const paramDest = (req: FastifyRequest): Destination | undefined => dest((req.params as { id: string }).id)

  const fail = (reply: FastifyReply, e: unknown): FastifyReply => {
    if (e instanceof BadPath) return reply.code(400).send({ error: e.message })
    const err = e as SyncError
    return reply.code(isUnreachable(err) || err.code === 'ENOENT' ? 409 : 502).send({ error: err.message })
  }

  const pathList = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 5000) throw new BadPath('paths must be a non-empty list')
    return v.map((p) => safeRel(p))
  }

  app.post('/api/destinations/:id/import', async (req, reply) => {
    const d = paramDest(req)
    if (!d) return reply.code(404).send({ error: 'Unknown destination' })
    const b = (req.body ?? {}) as { paths?: unknown; recursive?: boolean; session?: string }
    try {
      const paths = pathList(b.paths)
      if (b.session !== undefined && !safeFolder(core.settings.libraryDir, b.session)) throw new BadPath('Bad session folder')
      return transfers.enqueue('import', d.id, { paths, recursive: b.recursive === true, session: b.session })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post('/api/destinations/:id/copy', async (req, reply) => {
    const d = paramDest(req)
    if (!d) return reply.code(404).send({ error: 'Unknown destination' })
    const b = (req.body ?? {}) as { paths?: unknown; toDestId?: string; toPath?: unknown }
    const to = dest(b.toDestId)
    if (!to) return reply.code(404).send({ error: 'Unknown destination' })
    try {
      const paths = pathList(b.paths)
      const toPath = safeRel(b.toPath)
      if (to.id === d.id && paths.some((p) => p === toPath || (toPath + '/').startsWith(`${p}/`))) throw new BadPath('Cannot copy a folder into itself')
      return transfers.enqueue('copy', d.id, { paths, recursive: true, toDestId: to.id, toPath })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post('/api/destinations/:id/send', async (req, reply) => {
    const d = paramDest(req)
    if (!d) return reply.code(404).send({ error: 'Unknown destination' })
    const b = (req.body ?? {}) as { session?: string; onlyMissing?: boolean; resendDiffers?: boolean }
    if (!b.session || !safeFolder(core.settings.libraryDir, b.session)) return reply.code(400).send({ error: 'Bad session folder' })
    const queued = queueSessionSend(core.db, (f, id) => core.lib.enqueueSync(f, id), (f, id) => core.lib.requeueSync(f, id), d.id, b.session, b.resendDiffers === true && b.onlyMissing !== true)
    core.sync.pump()
    return { queued }
  })

  app.post('/api/destinations/:id/adopt', async (req, reply) => {
    const d = paramDest(req)
    if (!d) return reply.code(404).send({ error: 'Unknown destination' })
    const b = (req.body ?? {}) as { path?: unknown; name?: unknown; client?: unknown }
    let path: string
    try {
      path = safeRel(b.path)
      if (!path || path.includes('/')) throw new BadPath('Adopt works on a folder at the top level of the destination')
    } catch (e) {
      return fail(reply, e)
    }
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, NAME_MAX) : ''
    if (!name) return reply.code(400).send({ error: 'A name is required' })
    const fs = transfers.fsFor(d)
    const tmp = join(core.settings.libraryDir, '.import-staging', `adopt-${Date.now()}`)
    try {
      const existing = await fs.readRange(`${path}/${META_FILE}`, 0, 16).catch(() => null)
      if (existing && existing.length) return reply.code(409).send({ error: 'This folder already has a name' })
      const now = Date.now()
      const meta: SessionMeta = {
        schema: 1,
        id: newSessionId(),
        name,
        date: folderDate(path) ?? localToday(),
        ...(typeof b.client === 'string' && b.client ? { client: b.client.slice(0, 200) } : {}),
        createdBy: hostname(),
        createdAt: now,
        updatedAt: now
      }
      await mkdir(tmp, { recursive: true })
      const file = join(tmp, META_FILE)
      await writeFile(file, JSON.stringify(meta, null, 2) + '\n', 'utf8')
      await fs.upload(file, `${path}/${META_FILE}`)
      core.db.prepare(`UPDATE remote_entries SET meta_json = ? WHERE dest_id = ? AND path = ?`).run(JSON.stringify(meta), d.id, path)
      core.bus.emit({ type: 'browse:updated', destId: d.id, path } as unknown as ServerEvent)
      return meta
    } catch (e) {
      return fail(reply, e)
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  app.get('/api/transfers', async () => transfers.list())
  app.delete('/api/transfers/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || !transfers.cancel(id)) return reply.code(404).send({ error: 'Unknown transfer' })
    return reply.code(204).send()
  })
}
