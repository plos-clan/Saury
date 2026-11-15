import h from '@satorijs/element'
import type { Channel as SatoriChannel } from '@satorijs/protocol'
import { z } from 'zod'
import { Fault } from '../core/model.js'
import type { Channel, Message, Segment } from '../core/model.js'

const text = z.string()
const identifier = z.string().min(1)
const formatting = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'spl',
  'code', 'pre', 'span', 'a', 'p', 'message',
])

export function parseChannel(value: string): Channel {
  const separator = value.indexOf(':')
  const kind = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (separator < 0 || !id) throw new Fault('input', 'Invalid channel ID')
  if (kind === 'private') return { kind: 'direct', id }
  if (kind === 'group') return { kind: 'group', id }
  throw new Fault('input', 'Unknown channel kind')
}

export function channelResource(channel: Channel): SatoriChannel {
  const type = channel.kind === 'direct' ? 1 : 0
  const prefix = channel.kind === 'direct' ? 'private' : 'group'
  return { id: `${prefix}:${channel.id}`, type }
}

export function assetUrl(source: string, account: string): string {
  if (!source.startsWith('asset:')) return source
  return `internal:${account}/media/${source.slice(6)}`
}

export function assetSource(source: string, account: string): string {
  if (!source.startsWith('internal:')) return source
  const prefix = `internal:${account}/media/`
  if (!source.startsWith(prefix)) {
    throw new Fault('input', 'Resource belongs to another account')
  }
  const id = source.slice(prefix.length)
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    throw new Fault('input', 'Invalid resource ID')
  }
  return `asset:${id}`
}

export function encode(content: readonly Segment[], account: string): string {
  return content.map(segment => {
    switch (segment.type) {
      case 'text': return h.text(segment.text)
      case 'mention': return h('at', segment.user)
      case 'mention-all': return h('at', { type: 'all' })
      case 'image': return h('img', { src: assetUrl(segment.source, account) })
      case 'quote': return h('quote', { id: segment.id })
    }
  }).join('')
}

export function decode(content: string, account: string): readonly Segment[] {
  const pending = h.parse(content).reverse()
  const output: Segment[] = []
  while (pending.length) {
    const element = pending.pop()!
    if (formatting.has(element.type)) {
      for (const child of element.children.toReversed()) pending.push(child)
      continue
    }
    output.push(decodeElement(element, account))
  }
  return output
}

function decodeElement(element: h, account: string): Segment {
  const { type, attrs } = element
  switch (type) {
    case 'text':
      return { type: 'text', text: text.parse(attrs.content) }
    case 'br':
      return { type: 'text', text: '\n' }
    case 'at': {
      if (attrs.type === 'all') return { type: 'mention-all' }
      const id = identifier.parse(attrs.id)
      const name = text.optional().parse(attrs.name) ?? ''
      return { type: 'mention', user: { id, name } }
    }
    case 'img': {
      const source = assetSource(identifier.parse(attrs.src), account)
      return { type: 'image', source }
    }
    case 'quote':
      return { type: 'quote', id: identifier.parse(attrs.id) }
    default:
      throw new Fault('unsupported', `Message element ${type} is not supported`)
  }
}

export function messageResource(message: Message, account: string) {
  const resource = {
    id: message.id,
    content: encode(message.content, account),
    created_at: message.timestamp,
    channel: channelResource(message.channel),
    user: message.user,
  }
  if (message.channel.kind === 'direct') return resource
  return { ...resource, guild: { id: message.channel.id } }
}
