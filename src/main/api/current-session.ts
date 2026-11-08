import type { FastifyInstance } from 'fastify'
import type { ServerEvent } from '@shared/types'
import type { Core } from '../core'
import { safeFolder } from '../core/sessions'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface CurrentSession { folder: string | null; endsAt: number | null }

export function getCurrentSession(core: Core): CurrentSession {
  const { currentSession, currentSessionEndsAt } = core.config.get().ingest
  return { folder: currentSession, endsAt: currentSessionEndsAt }
}

/** Point ingest at `folder` (or back to the shoot-date folders with null) and tell every client. */
export function setCurrentSession(core: Core, folder: string | null, endAfterMin?: number): CurrentSession {
  const endsAt = folder && endAfterMin && endAfterMin > 0 ? Date.now() + Math.round(endAfterMin * 60_000) : null
  const prev = core.config.get().ingest.currentSession
  core.config.update({ ingest: { currentSession: folder, currentSessionEndsAt: endsAt } })
  core.bus.emit({ type: 'session:changed', folder: folder ?? prev ?? '' } as unknown as ServerEvent)
  return { folder, endsAt }
}

/** GET and PUT /api/ingest/current-session: which session folder new photos are filed into. */
export function registerCurrentSession(app: FastifyInstance, core: Core): void {
  app.get('/api/ingest/current-session', async () => {
    const cur = getCurrentSession(core)
    // An expired or vanished session reads as none; Ingestor clears the setting itself.
    const gone = cur.folder && ((cur.endsAt !== null && Date.now() >= cur.endsAt) || !existsSync(join(core.settings.libraryDir, cur.folder)))
    return gone ? { folder: null, endsAt: null } : cur
  })

  app.put(
    '/api/ingest/current-session',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['folder'],
          properties: { folder: { type: ['string', 'null'] }, endAfterMin: { type: 'number', minimum: 0, maximum: 14 * 24 * 60 } }
        }
      }
    },
    async (req, reply) => {
      const b = req.body as { folder: string | null; endAfterMin?: number }
      if (b.folder === null) return setCurrentSession(core, null)
      const dir = core.settings.libraryDir
      const folder = safeFolder(dir, b.folder)
      if (!folder || !existsSync(join(dir, folder)) || !statSync(join(dir, folder)).isDirectory()) return reply.code(404).send({ error: 'Unknown session' })
      return setCurrentSession(core, folder, b.endAfterMin)
    }
  )
}
