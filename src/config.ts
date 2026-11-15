import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'

const environment = z.object({
  SAURY_DATA: z.string().min(1),
  SAURY_ACCOUNT: z.string().regex(/^[1-9]\d*$/).optional(),
  SAURY_HOST: z.string().default('127.0.0.1'),
  SAURY_PORT: z.coerce.number().int().min(1).max(65535).default(5500),
  SAURY_TOKEN: z.string().min(1).optional(),
  SAURY_LOG: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).readonly()

export type Config = ReturnType<typeof configure>

export function configure(env: NodeJS.ProcessEnv) {
  const parsed = environment.parse(env)
  const data = resolve(parsed.SAURY_DATA)
  const token = parsed.SAURY_TOKEN ?? randomBytes(32).toString('base64url')

  return Object.freeze({
    data,
    session: resolve(data, 'session'),
    account: parsed.SAURY_ACCOUNT,
    host: parsed.SAURY_HOST,
    port: parsed.SAURY_PORT,
    level: parsed.SAURY_LOG,
    timeout: 20_000,
    mediaBytes: 32 << 20,
    cacheSeconds: 3600,
    cacheBytes: 256 << 20,
    cacheEntries: 4096,
    eventBuffer: 1024,
    token,
  })
}
