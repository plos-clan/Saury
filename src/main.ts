import { once } from 'node:events'
import { pino } from 'pino'
import { configure } from './config.js'
import { QqBot } from './qq/bot.js'
import { ResourceStore } from './resources.js'
import { serve } from './satori/server.js'

const controller = new AbortController()
const stop = () => controller.abort(new Error('Saury is shutting down'))
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

const config = configure(process.env)
const logger = pino({ level: config.level, base: { name: 'saury' } })
const lifetime = new AsyncDisposableStack()
const { signal } = controller
let code = 0

try {
  const resources = await ResourceStore.open(config, logger)
  lifetime.defer(() => resources.close())
  const bot = new QqBot(config, resources, logger, signal)
  lifetime.defer(() => bot.close())
  const closeServer = await serve(config, bot, resources, logger, signal)
  lifetime.defer(closeServer)
  await bot.connect()
  if (!signal.aborted) await once(signal, 'abort')
} catch (error) {
  if (!signal.aborted) {
    logger.error({ err: error }, 'Saury could not continue')
    code = 1
  }
} finally {
  stop()
  const deadline = setTimeout(() => process.exit(1), 10_000)
  try {
    await lifetime.disposeAsync()
  } catch (error) {
    logger.error({ err: error }, 'Saury shutdown failed')
    code = 1
  }
  clearTimeout(deadline)
  logger.flush()
  process.exit(code)
}
