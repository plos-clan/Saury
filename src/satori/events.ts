import type { Login } from '@satorijs/protocol'
import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import type { BotEvent } from '../core/model.js'
import { channelResource, encode } from './codec.js'

const Opcode = { EVENT: 0, PING: 1, PONG: 2, IDENTIFY: 3, READY: 4 } as const
const loginEvents = {
  'account-added': 'login-added',
  'account-updated': 'login-updated',
} as const

const identify = z.object({
  op: z.literal(Opcode.IDENTIFY),
  body: z.object({
    token: z.string(),
    sn: z.number().int().nonnegative().optional(),
  }),
})
const ping = z.object({ op: z.literal(Opcode.PING) })
const incoming = z.discriminatedUnion('op', [identify, ping])

type Frame = Readonly<{ sn: number, payload: string }>
type MessageEvent = Extract<BotEvent, { type: 'message' | 'delete' }>
type Client = {
  socket: WebSocket
  identified: boolean
  deadline: number
}

export class EventStream {
  private readonly server: WebSocketServer
  private readonly clients = new Set<Client>()
  private readonly buffer: (Frame | undefined)[]
  private readonly heartbeat: NodeJS.Timeout
  private sequence = Math.trunc(performance.timeOrigin)
  private written = 0

  constructor(
    server: Server,
    private readonly login: () => Login | undefined,
    private readonly authenticate: (token: string) => boolean,
    capacity: number,
    private readonly maxBytes: number,
  ) {
    this.buffer = new Array(capacity)
    this.server = new WebSocketServer({
      server,
      path: '/v1/events',
      maxPayload: maxBytes,
      perMessageDeflate: false,
    })
    this.server.on('connection', socket => this.accept(socket))
    this.heartbeat = setInterval(() => this.expire(), 10_000)
    this.heartbeat.unref()
  }

  publish(event: BotEvent): void {
    const login = this.login()
    if (!login) return
    const timestamp = Math.trunc(performance.timeOrigin + performance.now())
    const sn = ++this.sequence
    if (event.type === 'account-added' || event.type === 'account-updated') {
      const body = { sn, type: loginEvents[event.type], timestamp, login }
      this.broadcast(JSON.stringify({ op: Opcode.EVENT, body }))
      return
    }
    if (!login.user || !login.platform) return
    const account = { sn: login.sn, platform: login.platform, user: login.user }
    const owner = `${login.platform}/${login.user.id}`
    const content = this.content(event, owner)
    const body = { sn, login: account, ...content }
    const payload = JSON.stringify({ op: Opcode.EVENT, body })
    const slot = this.written++ % this.buffer.length
    this.buffer[slot] = { sn, payload }
    this.broadcast(payload)
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat)
    for (const client of this.clients) {
      client.socket.close(1001, 'Server is shutting down')
    }
    const force = setTimeout(() => {
      for (const client of this.clients) client.socket.terminate()
    }, 1000)
    try {
      await new Promise<void>(resolve => this.server.close(() => resolve()))
    } finally {
      clearTimeout(force)
    }
    this.clients.clear()
    this.buffer.fill(undefined)
  }

  private content(event: MessageEvent, id: string) {
    const source = event.type === 'message' ? event.message : event
    const channel = channelResource(source.channel)
    const guild = source.channel.kind === 'group'
      ? { id: source.channel.id }
      : undefined
    const common = { channel, guild, timestamp: source.timestamp }
    if (event.type === 'delete') {
      return { ...common, type: 'message-deleted', message: { id: event.id } }
    }
    const message = {
      id: event.message.id,
      content: encode(event.message.content, id),
      created_at: event.message.timestamp,
    }
    return {
      ...common,
      type: 'message-created',
      message,
      user: event.message.user,
    }
  }

  private accept(socket: WebSocket): void {
    const client = {
      socket,
      identified: false,
      deadline: performance.now() + 10_000,
    }
    this.clients.add(client)
    socket.on('message', (data, binary) => {
      if (binary) return socket.close(4000, 'Expected JSON text')
      try {
        this.receive(client, JSON.parse(data.toString()))
      } catch {
        socket.close(4000, 'Invalid Satori frame')
      }
    })
    socket.on('error', () => socket.terminate())
    socket.on('close', () => this.clients.delete(client))
  }

  private receive(client: Client, value: unknown): void {
    const { socket } = client
    const now = performance.now()
    if (now > client.deadline) return socket.terminate()
    const frame = incoming.parse(value)
    if (frame.op === Opcode.PING) {
      if (!client.identified) return socket.close(4003, 'Identify first')
      client.deadline = now + 30_000
      socket.send('{"op":2}')
      return
    }
    if (client.identified) return socket.close(4000, 'Already identified')
    if (!this.authenticate(frame.body.token)) {
      return socket.close(4003, 'Authentication failed')
    }
    const after = frame.body.sn
    client.identified = true
    client.deadline = now + 30_000
    const login = this.login()
    const body = { logins: login ? [login] : [], proxy_urls: [] }
    socket.send(JSON.stringify({ op: Opcode.READY, body }))
    if (after !== undefined) this.replay(client, after)
  }

  private replay(client: Client, after: number): void {
    const first = Math.max(0, this.written - this.buffer.length)
    for (let index = first; index < this.written; index++) {
      const frame = this.buffer[index % this.buffer.length]
      if (frame && frame.sn > after) this.deliver(client, frame.payload)
    }
  }

  private broadcast(payload: string): void {
    for (const client of this.clients) {
      if (client.identified) this.deliver(client, payload)
    }
  }

  private deliver(client: Client, payload: string): void {
    const { socket } = client
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > this.maxBytes) {
      socket.close(1013, 'Consumer is too slow')
      return
    }
    socket.send(payload)
  }

  private expire(): void {
    const now = performance.now()
    for (const client of this.clients) {
      if (now > client.deadline) client.socket.terminate()
    }
  }
}
