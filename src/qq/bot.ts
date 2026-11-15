import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { LRUCache } from 'lru-cache'
import type { Logger } from 'pino'
import type { Config } from '../config.js'
import { bounded } from '../core/operation.js'
import { Fault } from '../core/model.js'
import type {
  Account, Bot, BotEvent, Channel, Message, Resources, Segment, User,
} from '../core/model.js'
import { Directory, portrait } from './directory.js'
import { NativeHost } from './host.js'
import { Messenger } from './messages.js'
import type { RawMessage } from './native.js'

type Live = Readonly<{
  user: User
  messenger: Messenger
  directory: Directory
}>

type State =
  | Readonly<{ status: 'connecting' }>
  | Readonly<{ status: 'offline', live?: Live }>
  | Readonly<{ status: 'online', live: Live }>

const ignore = () => {}

export class QqBot implements Bot {
  readonly platform = 'qq'
  private state: State = { status: 'connecting' }
  private readonly lifetime = new AsyncDisposableStack()
  private readonly events = new EventEmitter<{ event: [BotEvent] }>()
  private readonly seen: LRUCache<string, true>
  private queued = Promise.resolve()

  constructor(
    private readonly config: Config,
    private readonly resources: Resources,
    private readonly logger: Logger,
    private readonly signal: AbortSignal,
  ) {
    this.seen = new LRUCache({ max: config.cacheEntries })
  }

  get account(): Account {
    const { state } = this
    if (state.status === 'connecting') return state
    if (!state.live) return { status: 'offline' }
    return { status: state.status, user: state.live.user }
  }

  subscribe(listener: (event: BotEvent) => void): () => void {
    this.events.on('event', listener)
    return () => { this.events.off('event', listener) }
  }

  async connect(): Promise<void> {
    const offline = () => this.connection(false)
    const online = () => this.connection(true)
    const host = await NativeHost.open(
      this.config, this.logger, this.signal, offline, online,
    )
    this.lifetime.defer(() => host.close())
    const self = await host.connect()
    const messages = host.session.getMsgService()
    const groups = host.session.getGroupService()
    const buddies = host.session.getBuddyService()
    if (!messages || !groups || !buddies) {
      throw new Error('QQ did not initialize the required services')
    }

    const { signal, config } = this
    const directory = new Directory(
      groups, buddies, self, signal, config.timeout, config.cacheEntries,
    )
    this.lifetime.defer(() => directory.close())
    const util = host.native.NodeQQNTWrapperUtil
    const root = join(config.session, 'nt_qq', 'global')
    const messenger = new Messenger(
      messages, util, directory, this.resources, self,
      root, signal, config.timeout,
    )
    const listener = {
      onRecvMsg: (list: readonly RawMessage[]) => this.enqueue(list),
      onMsgInfoListUpdate: (list: readonly RawMessage[]) => {
        messenger.confirm(list)
        const complete = list.filter(message => {
          return message.sendStatus === 2 || message.sendStatus === 3
        })
        this.enqueue(complete)
      },
      onRecvMsgReadReport: ignore,
      onRecvMsgReceipt: ignore,
      onRecvOfflineFileMsg: ignore,
      onFileMsgCome: ignore,
      onRecvOnlineFileMsg: ignore,
      onRecvSysMsg: ignore,
    }
    const id = messages.addKernelMsgListener(listener)
    this.lifetime.defer(() => messages.removeKernelMsgListener(id))
    const status = {
      status: 10,
      extStatus: 0,
      batteryStatus: 0,
      customStatus: { faceId: '', wording: '', faceType: '1' },
    }
    const registered = messages.setStatus(status)
    const result = await bounded(registered, signal, config.timeout)
    if (result.result !== 0) throw new Error('QQ online registration failed')
    const user = portrait(self.uin, self.nick)
    this.state = { status: 'online', live: { user, messenger, directory } }
    this.events.emit('event', { type: 'account-added', account: this.account })
    this.logger.info('QQ account is online')
  }

  send(channel: Channel, content: readonly Segment[]): Promise<Message> {
    return this.ready().messenger.send(channel, content)
  }

  message(channel: Channel, id: string): Promise<Message> {
    return this.ready().messenger.get(channel, id)
  }

  remove(channel: Channel, id: string): Promise<void> {
    return this.ready().messenger.remove(channel, id)
  }

  user(id: string) {
    return this.ready().directory.user(id)
  }

  friends() {
    return this.ready().directory.friends()
  }

  groups() {
    return this.ready().directory.groups()
  }

  members(group: string) {
    return this.ready().directory.members(group)
  }

  async close(): Promise<void> {
    this.connection(false)
    await this.queued
    await this.lifetime.disposeAsync()
    this.events.removeAllListeners()
    this.seen.clear()
    this.state = { status: 'offline' }
  }

  private ready(): Live {
    this.signal.throwIfAborted()
    if (this.state.status !== 'online') {
      throw new Fault('offline', 'QQ account is not online')
    }
    return this.state.live
  }

  private connection(online: boolean): void {
    if (this.state.status === 'connecting' || !this.state.live) return
    const status = online ? 'online' : 'offline'
    if (this.state.status === status) return
    this.state = { status, live: this.state.live }
    const account = this.account
    this.events.emit('event', { type: 'account-updated', account })
  }

  private enqueue(list: readonly RawMessage[]): void {
    if (this.signal.aborted) return
    for (const message of list) {
      this.queued = this.queued.then(() => this.receive(message))
        .catch(error => {
          if (this.signal.aborted) return
          this.logger.warn({ err: error }, 'QQ message conversion failed')
        })
    }
  }

  private async receive(raw: RawMessage): Promise<void> {
    if (this.state.status !== 'online') return
    const { messenger } = this.state.live
    const key = `${raw.chatType}:${raw.peerUid}:${raw.msgId}`
    const revoked = raw.elements.find(element => {
      return element.grayTipElement?.revokeElement != null
    })
    if (revoked) {
      if (!this.seen.has(key)) return
      const id = raw.msgId
      const channel = await messenger.channel(raw)
      const timestamp = Number(raw.msgTime) * 1000
      this.events.emit('event', { type: 'delete', channel, id, timestamp })
      return
    }

    if (this.seen.has(key)) return
    if (raw.chatType !== 1 && raw.chatType !== 2) return
    const message = await messenger.decode(raw)
    if (!message.content.length) return
    this.seen.set(key, true)
    this.events.emit('event', { type: 'message', message })
  }
}
