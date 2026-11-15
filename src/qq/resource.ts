import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync } from 'node:fs'
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Logger } from 'pino'
import { x } from 'tar'
import { z } from 'zod'
import { inspect } from './metadata.js'

const manifestUrl =
  'https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js'
const platforms: Readonly<Record<string, string>> = {
  x64: 'x64DownloadUrl',
  arm64: 'armDownloadUrl',
  loong64: 'loongarchDownloadUrl',
  mips64el: 'mipsDownloadUrl',
}
const httpsUrl = z.url({ protocol: /^https$/ })
const download = z.union([
  httpsUrl,
  z.object({ deb: httpsUrl }).transform(value => value.deb),
])
const files = new Set([
  'wrapper.node',
  'major.node',
  'pub.key',
  'cacert.pem',
  'package.json',
  'application.json',
])
const prefix = './opt/QQ/resources/app/'

export async function provision(
  data: string,
  logger: Logger,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const path = join(data, 'resources')
  const staging = join(path, '.install')
  await rm(staging, { recursive: true, force: true })
  const wrapper = join(path, 'wrapper.node')
  if (existsSync(wrapper)) return { path, metadata: await inspect(path) }

  const archive = join(staging, 'qq.deb')
  const directory = join(staging, 'app')
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const url = await locate(signal)
    logger.info('Downloading QQ resources')
    await downloadArchive(url, archive, signal)
    await unpack(archive, directory, signal)
    await access(join(directory, 'wrapper.node'))
    const metadata = await inspect(directory)
    signal.throwIfAborted()
    await install(directory, path)
    logger.info({ version: metadata.version }, 'QQ resources are ready')
    return { path, metadata }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function install(source: string, target: string): Promise<void> {
  const entries = await readdir(source)
  const dependencies = entries.filter(name => name !== 'wrapper.node')
  const order = [...dependencies, 'wrapper.node']
  for (const name of order) {
    const path = join(target, name)
    await rm(path, { recursive: true, force: true })
    await rename(join(source, name), path)
  }
}

async function locate(signal: AbortSignal): Promise<URL> {
  const field = platforms[process.arch]
  if (!field) throw new Error(`QQ does not support ${process.arch}`)
  const deadline = AbortSignal.timeout(20_000)
  const cancellation = AbortSignal.any([signal, deadline])
  const response = await fetch(manifestUrl, { signal: cancellation })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`QQ release lookup failed: HTTP ${response.status}`)
  }
  const source = await response.text()
  const json = /\bvar params\s*=\s*(\{[\s\S]*?\})\s*;/.exec(source)?.[1]
  if (!json) throw new Error('QQ release metadata is missing')
  const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(json))
  const url = new URL(download.parse(manifest[field]))
  url.pathname = url.pathname.replace('/QQNTV2/', '/qqntv2/')
  return url
}

async function downloadArchive(
  url: URL,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = AbortSignal.timeout(30 * 60_000)
  const cancellation = AbortSignal.any([signal, deadline])
  const response = await fetch(url, { signal: cancellation })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`QQ download failed: HTTP ${response.status}`)
  }
  const input = Readable.fromWeb(response.body)
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })
  await pipeline(input, output, { signal: cancellation })
}

async function unpack(
  archive: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  const strip = prefix.split('/').length - 1
  const options = { cwd: directory, strip, filter: runtimeFile, strict: true }
  const output = x(options)
  const env = { ...process.env, LD_PRELOAD: '' }
  const child = spawn('dpkg-deb', ['--fsys-tarfile', archive], {
    env, signal, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exited = once(child, 'close').then(([code]) => {
    if (code !== 0) throw new Error(`QQ package extraction failed: ${code}`)
  })
  const transfer = pipeline(child.stdout, output, { signal })
  try {
    await Promise.all([exited, transfer])
  } finally {
    child.kill()
    await Promise.allSettled([exited, transfer])
  }
}

function runtimeFile(path: string): boolean {
  if (!path.startsWith(prefix)) return false
  const name = path.slice(prefix.length)
  if (name.startsWith('sharp-lib/')) return true
  if (name.includes('/')) return false
  return files.has(name) || /\.so(?:\.\d+)*$/.test(name)
}
