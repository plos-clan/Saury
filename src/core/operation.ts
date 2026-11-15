import { Fault } from './model.js'

export async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  milliseconds: number,
): Promise<T> {
  const stopped = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    const error = new Fault('timeout', 'Operation timed out')
    stopped.reject(error)
  }, milliseconds)
  const abort = () => stopped.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()

  try {
    return await Promise.race([operation, stopped.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
