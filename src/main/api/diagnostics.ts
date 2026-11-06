import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { FixId } from '@shared/diagnostics'
import type { Core } from '../core'
import { applyFix, runDiagnostics } from '../core/diagnostics'

const FIXES: FixId[] = ['firewall-allow', 'firewall-remove', 'use-free-port']

/**
 * Connection check. Local-only: it reveals firewall details and can change system settings,
 * so neither LAN remote clients nor tunnel visitors may use it.
 */
export function registerDiagnostics(app: FastifyInstance, core: Core): void {
  const localOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const loopback = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
    if (!loopback || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) {
      return reply.code(403).send({ error: 'Only available on the ShotDrop computer' })
    }
  }

  // One check at a time: the self-test and port scans shouldn't overlap.
  let running: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = running.then(fn, fn)
    running = next.catch(() => undefined)
    return next
  }

  app.get('/api/diagnostics', { preHandler: localOnly }, async () => serial(() => runDiagnostics(core, core.ftp.attempts)))

  app.get('/api/diagnostics/attempts', { preHandler: localOnly }, async () => core.ftp.attempts)

  app.post('/api/diagnostics/fix/:id', { preHandler: localOnly }, async (req, reply) => {
    const id = (req.params as { id: string }).id as FixId
    if (!FIXES.includes(id)) return reply.code(404).send({ error: 'Unknown fix' })
    return serial(() => applyFix(core, id, core.ftp.attempts))
  })
}
