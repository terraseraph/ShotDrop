import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { hostname } from 'node:os'
import type { Destination, Settings } from '@shared/types'
import type { LibraryMeta } from '@shared/remote'
import type { Core } from '../core'
import { toolPath } from '../core/bundled'
import { ensureLibraryMeta, newLibraryId, readLibraryMeta, type LibraryDest, type LibraryRc } from '../core/cloud'

/** Destinations whose library.json writers[] entry this app run has already refreshed. */
const touched = new Set<string>()

const rcFor = (core: Core, dest: LibraryDest): LibraryRc => {
  const remote = dest.target.split(':')[0]
  return { bin: toolPath(core.settings.rclonePath, 'rclone'), cfg: dest.type === 'rclone' && core.cloud.has(remote) ? core.cloud.cfgArgs() : [] }
}

/** This library's id, generated once and kept in settings. */
async function libraryId(core: Core): Promise<string> {
  const have = core.settings.libraryId
  if (have) return have
  const id = newLibraryId()
  await core.updateSettings({ libraryId: id })
  return id
}

/** Best effort: writes library.json if absent, refreshes this host's writers[] entry once per app start. Never throws. */
export async function ensureDestLibrary(core: Core, dest: Destination): Promise<LibraryMeta | null> {
  try {
    return await ensureLibraryMeta(dest, rcFor(core, dest), { libraryId: await libraryId(core), host: hostname(), touched })
  } catch {
    return null
  }
}

/** GET /api/destinations/:id/info and POST /api/destinations/probe (the same check for a destination not saved yet). Local only. */
export function registerLibrary(app: FastifyInstance, core: Core, local: { preHandler: preHandlerHookHandler }): void {
  const look = async (dest: LibraryDest): Promise<{ library: LibraryMeta | null; reachable: boolean }> => {
    try {
      return { library: await readLibraryMeta(dest, rcFor(core, dest)), reachable: true }
    } catch {
      return { library: null, reachable: false }
    }
  }

  app.get('/api/destinations/:id/info', local, async (req, reply) => {
    const dest = core.settings.destinations.find((d) => d.id === (req.params as { id: string }).id)
    if (!dest) return reply.code(404).send({ error: 'Not found' })
    return { ...(await look(dest)), listedAt: null as number | null }
  })

  app.post(
    '/api/destinations/probe',
    {
      ...local,
      schema: {
        body: {
          type: 'object',
          required: ['type', 'target'],
          additionalProperties: false,
          properties: { type: { enum: ['folder', 'rclone'] }, target: { type: 'string', minLength: 1, pattern: '^[^-]' } }
        }
      }
    },
    async (req) => {
      const r = await look(req.body as LibraryDest)
      const ours = core.settings.libraryId
      return { ...r, other: !!r.library && r.library.libraryId !== ours }
    }
  )

  // Refresh this host's writers[] entry shortly after start, once per destination.
  setTimeout(() => {
    for (const d of core.settings.destinations) if (d.enabled) void ensureDestLibrary(core, d)
  }, 15_000).unref()
}
