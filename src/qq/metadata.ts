import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const metadata = z.object({
  appid: z.string().regex(/^\d+$/),
  qua: z.string().regex(/^V1_LNX_NQ_\d+\.\d+\.\d+_\d+_GW_B$/),
}).transform(value => {
  const version = value.qua.slice(10, -5).replace('_', '-')
  return Object.freeze({ ...value, version })
})

export type Metadata = z.infer<typeof metadata>

export async function inspect(qq: string): Promise<Metadata> {
  const stream = createReadStream(join(qq, 'major.node'))
  let tail = Buffer.alloc(0)
  let appid: string | undefined
  let qua: string | undefined

  for await (const chunk of stream) {
    const bytes = chunk as Buffer
    const buffer = Buffer.concat([tail, bytes])
    appid ??= find(buffer, 'QQAppId/', /^QQAppId\/(\d+)\0/)
    qua ??= find(buffer, 'V1_LNX_NQ_', /^(V1_LNX_NQ_[\d._]+_GW_B)/)
    if (appid && qua) return metadata.parse({ appid, qua })
    tail = buffer.subarray(-128)
  }

  throw new Error('QQ major.node contains no valid Linux app metadata')
}

function find(buffer: Buffer, marker: string, pattern: RegExp) {
  let offset = buffer.indexOf(marker)
  while (offset !== -1) {
    const candidate = buffer.subarray(offset, offset + 128)
    const match = pattern.exec(candidate.toString('latin1'))?.[1]
    if (match) return match
    offset = buffer.indexOf(marker, offset + marker.length)
  }
  return undefined
}
