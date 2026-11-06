import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CloudLinkOptions, CloudProvider } from '@shared/types'
import type { Core } from '../core'

/** Cloud sign-in and folder browsing. Local-only: linking runs programs and stores account tokens. */
export function registerCloud(app: FastifyInstance, core: Core): void {
  const localOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const loopback = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
    if (!loopback || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) {
      return reply.code(403).send({ error: 'Only available on the ShotDrop computer' })
    }
  }
  const local = { preHandler: localOnly }
  const name = (req: FastifyRequest): string => (req.params as { name: string }).name
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(/Unknown account/.test((e as Error).message) ? 404 : 502).send({ error: (e as Error).message })

  app.get('/api/cloud/accounts', local, async (_req, reply) => {
    try {
      return { accounts: await core.cloud.list(), ...core.cloud.state() }
    } catch (e) {
      return fail(reply, e)
    }
  })

  const linkSchema = {
    type: 'object',
    required: ['provider'],
    additionalProperties: false,
    properties: {
      provider: { type: 'string', enum: ['drive', 'dropbox'] },
      fullAccess: { type: 'boolean' },
      clientId: { type: 'string', maxLength: 200 },
      clientSecret: { type: 'string', maxLength: 200 }
    }
  } as const

  // Held open until the user finishes (or cancels) in the browser, at most 5 minutes.
  app.post('/api/cloud/link', { ...local, schema: { body: linkSchema } }, async (req, reply) => {
    const { provider, ...opts } = req.body as { provider: CloudProvider } & CloudLinkOptions
    try {
      return reply.code(201).send(await core.cloud.link(provider, opts))
    } catch (e) {
      const m = (e as Error).message
      return reply.code(m === 'Cancelled' || /already in progress/.test(m) ? 409 : 502).send({ error: m })
    }
  })

  app.delete('/api/cloud/link', local, async (_req, reply) => reply.code(core.cloud.cancelLink() ? 204 : 404).send())

  app.get('/api/cloud/accounts/:name/folders', local, async (req, reply) => {
    try {
      return await core.cloud.folders(name(req), (req.query as { path?: string }).path ?? '')
    } catch (e) {
      return fail(reply, e)
    }
  })

  const mkdirSchema = { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } as const
  app.post('/api/cloud/accounts/:name/folders', { ...local, schema: { body: mkdirSchema } }, async (req, reply) => {
    try {
      await core.cloud.mkdir(name(req), (req.body as { path: string }).path)
      return reply.code(201).send({ ok: true })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get('/api/cloud/accounts/:name/info', local, async (req, reply) => {
    try {
      const [email, quota] = await Promise.all([core.cloud.email(name(req)), core.cloud.quota(name(req)).catch(() => null)])
      return { email, quota }
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete('/api/cloud/accounts/:name', local, async (req, reply) => {
    const n = name(req)
    if (core.settings.destinations.some((d) => d.target.startsWith(`${n}:`))) {
      return reply.code(409).send({ error: 'A destination still uses this account. Remove the destination first.' })
    }
    try {
      await core.cloud.disconnect(n)
      return reply.code(204).send()
    } catch (e) {
      return fail(reply, e)
    }
  })
}
