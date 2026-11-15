import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Context, Env } from 'hono'
import type { Logger } from 'pino'
import { ZodError } from 'zod'
import type { Config } from '../config.js'
import { Fault } from '../core/model.js'
import type { Assets, Bot } from '../core/model.js'
import { SatoriApi } from './api.js'
import { assetUrl } from './codec.js'
import { EventStream } from './events.js'

const statusCodes = {
  input: 400,
  offline: 503,
  missing: 404,
  unsupported: 501,
  timeout: 504,
  unavailable: 502,
} as const

const mediaPath = '/v1/internal/:platform/:user/media/:id'

export async function serve(
  config: Config,
  bot: Bot,
  resources: Assets,
  logger: Logger,
  signal: AbortSignal,
) {
  await using startup = new AsyncDisposableStack()
  const api = new SatoriApi(bot)
  const app = new Hono()
  const expected = createHash('sha256').update(config.token).digest()
  const authenticate = (token: string) => {
    const actual = createHash('sha256').update(token).digest()
    return timingSafeEqual(actual, expected)
  }
  app.use('*', async (context, next) => {
    const header = context.req.header('authorization') ?? ''
    const token = /^Bearer (.+)$/i.exec(header)?.[1]
    if (!token || !authenticate(token)) return context.body(null, 401)
    await next()
  })
  app.use('*', bodyLimit({ maxSize: config.mediaBytes }))
  app.onError((error, context) => {
    if (error instanceof ZodError) {
      return context.json({ message: 'Invalid request parameters' }, 400)
    }
    if (error instanceof Fault) {
      return context.json({ message: error.message }, statusCodes[error.code])
    }
    if (signal.aborted) return context.body(null, 503)
    logger.error({ err: error }, 'Satori request failed')
    return context.json({ message: 'Internal server error' }, 500)
  })
  app.post('/v1/meta', context => {
    const login = api.login()
    return context.json({ logins: login ? [login] : [], proxy_urls: [] })
  })
  app.get(mediaPath, context => media(context, api, resources))
  app.post('/v1/:action', async context => {
    const platform = context.req.header('satori-platform')
    const account = context.req.header('satori-user-id')
    const login = api.login()
    if (!login || platform !== login.platform || account !== login.user?.id) {
      return context.json({ message: 'Unknown login' }, 404)
    }
    const name = context.req.param('action')
    if (name === 'upload.create') {
      return upload(context, api, resources, signal)
    }
    const action = api.actions.get(name)
    if (!action) return context.json({ message: 'API is not available' }, 404)
    const type = context.req.header('content-type') ?? ''
    if (!/^application\/json\b/i.test(type)) return context.body(null, 415)
    const payload: unknown = await context.req.json().catch(() => {
      throw new Fault('input', 'Expected a JSON request body')
    })
    const result = await action(payload)
    return Response.json(result ?? null)
  })

  const listener = getRequestListener(app.fetch)
  const server = createServer(listener)
  startup.defer(async () => {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeIdleConnections()
    })
  })
  const login = () => api.login()
  const events = new EventStream(
    server, login, authenticate, config.eventBuffer, config.mediaBytes,
  )
  startup.defer(() => events.close())
  const unsubscribe = bot.subscribe(event => events.publish(event))
  startup.defer(unsubscribe)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  logger.info({ host: config.host, port: config.port }, 'Satori is listening')

  const lifetime = startup.move()
  return () => lifetime.disposeAsync()
}

async function upload(
  context: Context,
  api: SatoriApi,
  resources: Assets,
  signal: AbortSignal,
) {
  const account = api.account()
  const form = await context.req.formData()
  const results: string[] = []
  const cancellation = AbortSignal.any([signal, context.req.raw.signal])
  for (const value of form.values()) {
    if (typeof value === 'string') {
      throw new Fault('input', 'Uploads must contain files')
    }
    const type = value.type || 'application/octet-stream'
    const source = await resources.upload(value.stream(), type, cancellation)
    results.push(assetUrl(source, account))
  }
  return context.json(results)
}

async function media(
  context: Context<Env, typeof mediaPath>,
  api: SatoriApi,
  resources: Assets,
) {
  const login = api.login()
  if (!login?.user || !login.platform) {
    throw new Fault('offline', 'Account is not available')
  }
  const { platform, user } = context.req.param()
  if (platform !== login.platform || user !== login.user.id) {
    throw new Fault('input', 'Resource belongs to another account')
  }
  const id = context.req.param('id')
  const asset = await resources.acquire(id)
  const input = createReadStream(asset.path)
  input.once('close', () => {
    Promise.resolve(asset[Symbol.asyncDispose]()).catch(() => input.destroy())
  })
  const stream = Readable.toWeb(input)
  const headers = {
    'content-type': asset.type,
    'content-length': String(asset.size),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }
  return new Response(stream, { headers })
}
