import type { FastifyInstance } from 'fastify'
import type { Core } from '../core'
import { OpError, type RemoteOpsService } from '../core/remoteops'
import { safeFolder } from '../core/sessions'

/** Remote op queue (pending renames, moves and deletes on destinations) and moving shots between sessions. All pin access. */
export function registerRemoteOps(app: FastifyInstance, core: Core, ops: RemoteOpsService): void {
  app.get('/api/remote-ops', async () => ops.list())
  app.post('/api/remote-ops/retry', async () => ({ retried: ops.retry() }))

  app.post(
    '/api/sessions/:folder/move',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['shotIds'], properties: { shotIds: { type: 'array', maxItems: 5000, items: { type: 'integer' } } } } } },
    async (req, reply) => {
      const folder = safeFolder(core.settings.libraryDir, (req.params as { folder: string }).folder)
      if (!folder) return reply.code(400).send({ error: 'Bad session folder' })
      try {
        return { moved: await ops.moveShots(folder, (req.body as { shotIds: number[] }).shotIds) }
      } catch (e) {
        if (e instanceof OpError) return reply.code(e.status).send({ error: e.message })
        throw e
      }
    }
  )
}
