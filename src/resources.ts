import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, link, mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { LRUCache } from 'lru-cache'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import { Fault } from './core/model.js'
import type { Assets, Resources } from './core/model.js'

type Asset = Readonly<{
  path: string
  size: number
  type: string
}>

type Entry =
  | Readonly<{ kind: 'file', asset: Asset }>
  | Readonly<{ kind: 'deferred', load: () => Promise<string> }>

export class ResourceStore implements Resources, Assets {
  private readonly assets: LRUCache<string, Entry>
  private readonly downloads = new Map<string, Promise<string>>()
  private readonly directory: string

  private constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.directory = join(config.data, 'media')
    this.assets = new LRUCache({
      maxSize: config.cacheBytes,
      max: config.cacheEntries,
      ttl: config.cacheSeconds * 1000,
      ttlAutopurge: true,
      sizeCalculation: entry => {
        return entry.kind === 'file' ? Math.max(1, entry.asset.size) : 1
      },
      dispose: entry => this.retire(entry),
    })
  }

  static async open(config: Config, logger: Logger): Promise<ResourceStore> {
    const store = new ResourceStore(config, logger)
    await rm(store.directory, { recursive: true, force: true })
    await mkdir(store.directory, { recursive: true, mode: 0o700 })
    return store
  }

  publish(load: () => Promise<string>): string {
    const id = randomUUID()
    this.assets.set(id, { kind: 'deferred', load })
    return `asset:${id}`
  }

  private async materialize(id: string, load: () => Promise<string>) {
    const path = await load()
    const info = await stat(path)
    this.validateSize(info.size)
    if (!info.isFile()) throw new Fault('input', 'Expected a media file')
    const target = join(this.directory, id)
    try {
      await link(path, target)
    } catch (error) {
      const crossDevice = error instanceof Error
        && 'code' in error && error.code === 'EXDEV'
      if (!crossDevice) throw error
      await copyFile(path, target)
    }
    const asset = {
      path: target,
      size: info.size,
      type: 'application/octet-stream',
    }
    if (!this.assets.has(id)) {
      await rm(target, { force: true })
      throw new Fault('missing', 'Resource expired while being fetched')
    }
    this.assets.set(id, { kind: 'file', asset })
    return `asset:${id}`
  }

  async upload(
    body: ReadableStream<Uint8Array>,
    type: string,
    signal: AbortSignal,
  ): Promise<string> {
    const id = randomUUID()
    const path = join(this.directory, id)
    let size = 0
    const limit = this.config.mediaBytes
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength
        const error = size > limit
          ? new Fault('input', 'Media exceeds the configured size limit')
          : null
        callback(error, chunk)
      },
    })
    const input = Readable.fromWeb(body)
    const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })

    try {
      await pipeline(input, meter, output, { signal })
      this.validateSize(size)
      const asset = { path, size, type }
      this.assets.set(id, { kind: 'file', asset })
      return `asset:${id}`
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
  }

  async prepare(source: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (source.startsWith('asset:')) return this.acquire(source.slice(6))
    const url = URL.parse(source)
    const allowed = url?.protocol === 'https:' || url?.protocol === 'http:'
    if (!url || !allowed || url.username || url.password) {
      throw new Fault('input', 'Expected an HTTP media URL or uploaded asset')
    }

    const download = () => this.download(url, signal)
    const asset = await this.coalesce(url.href, download)
    return this.acquire(asset.slice(6))
  }

  private async coalesce(key: string, load: () => Promise<string>) {
    let pending = this.downloads.get(key)
    if (!pending) {
      pending = load()
      this.downloads.set(key, pending)
    }
    try {
      return await pending
    } finally {
      if (this.downloads.get(key) === pending) this.downloads.delete(key)
    }
  }

  async acquire(id: string): Promise<Asset & AsyncDisposable> {
    const entry = this.assets.get(id)
    if (!entry) throw new Fault('missing', 'Media is missing or expired')
    if (entry.kind === 'deferred') {
      await this.coalesce(`asset:${id}`, () => this.materialize(id, entry.load))
      return this.acquire(id)
    }
    const { asset } = entry
    const file = await open(asset.path, 'r')
    return {
      ...asset,
      path: `/proc/self/fd/${file.fd}`,
      [Symbol.asyncDispose]: () => file.close(),
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.downloads.values())
    this.assets.clear()
    await rm(this.directory, { recursive: true, force: true })
  }

  private validateSize(size: number): void {
    if (size > this.config.mediaBytes || size > this.config.cacheBytes) {
      throw new Fault('input', 'Media exceeds the configured size limit')
    }
  }

  private retire(entry: Entry): void {
    if (entry.kind !== 'file') return
    rm(entry.asset.path, { force: true }).catch(error => {
      this.logger.warn({ err: error }, 'Media cleanup failed')
    })
  }

  private async download(url: URL, signal: AbortSignal): Promise<string> {
    const deadline = AbortSignal.timeout(this.config.timeout)
    const cancellation = AbortSignal.any([signal, deadline])
    const response = await fetch(url, { signal: cancellation })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Fault('unavailable', 'Media download failed')
    }
    const declared = Number(response.headers.get('content-length'))
    if (declared > this.config.mediaBytes) {
      await response.body.cancel()
      throw new Fault('input', 'Media exceeds the configured size limit')
    }
    const supplied = response.headers.get('content-type')
    const type = supplied ?? 'application/octet-stream'
    return this.upload(response.body, type, cancellation)
  }
}
