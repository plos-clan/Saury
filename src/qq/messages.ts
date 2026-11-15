import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { imageSizeFromFile } from 'image-size/fromFile'
import type {
  Channel, Message, Resources, Segment, User,
} from '../core/model.js'
import { Fault } from '../core/model.js'
import { bounded } from '../core/operation.js'
import { Directory, portrait } from './directory.js'
import { uin } from './native.js'
import type {
  Identity, Messages, Native, Peer, Picture, RawElement,
  RawMessage, SendElement, Text,
} from './native.js'

type Confirmation = ReturnType<typeof Promise.withResolvers<RawMessage>>

export class Messenger {
  private readonly pending = new Map<string, Confirmation>()
  private lastTime = 0

  constructor(
    private readonly service: Messages,
    private readonly util: Native['NodeQQNTWrapperUtil'],
    private readonly directory: Directory,
    private readonly resources: Resources,
    private readonly self: Identity,
    private readonly root: string,
    private readonly signal: AbortSignal,
    private readonly timeout: number,
  ) {}

  confirm(messages: readonly RawMessage[]): void {
    for (const message of messages) {
      const pending = this.pending.get(message.guildId)
      if (!pending) continue
      if (message.sendStatus === 2 || message.sendStatus === 3) {
        pending.resolve(message)
      }
      if (message.sendStatus === 0) {
        pending.reject(new Fault('unavailable', 'QQ rejected the message'))
      }
    }
  }

  async send(channel: Channel, content: readonly Segment[]): Promise<Message> {
    this.signal.throwIfAborted()
    if (!content.length) throw new Fault('input', 'Message content is empty')
    const peer = await this.peer(channel)
    const elements: SendElement[] = []
    for (const segment of content) {
      elements.push(await this.encode(segment, peer))
    }
    const time = performance.timeOrigin + performance.now()
    this.lastTime = Math.max(Math.trunc(time), this.lastTime + 1)
    const clock = `${this.lastTime}`
    const tag = this.service.generateMsgUniqueId(peer.chatType, clock)
    const destination = { ...peer, guildId: tag }
    const confirmation = Promise.withResolvers<RawMessage>()
    this.pending.set(tag, confirmation)

    try {
      const sent = Promise.resolve().then(() => {
        return this.service.sendMsg('0', destination, elements, new Map())
      })
      const operation = Promise.all([sent, confirmation.promise])
      const [, raw] = await bounded(operation, this.signal, this.timeout)
      return {
        id: raw.msgId,
        channel,
        user: portrait(this.self.uin, this.self.nick),
        content,
        timestamp: Number(raw.msgTime) * 1000,
      }
    } finally {
      this.pending.delete(tag)
    }
  }

  async get(channel: Channel, id: string): Promise<Message> {
    const peer = await this.peer(channel)
    return this.decode(await this.find(peer, id))
  }

  async remove(channel: Channel, id: string): Promise<void> {
    const peer = await this.peer(channel)
    const operation = this.service.recallMsg(peer, [id])
    const result = await bounded(operation, this.signal, this.timeout)
    if (result.result !== 0) {
      throw new Fault('unavailable', 'QQ could not recall the message')
    }
  }

  async decode(raw: RawMessage): Promise<Message> {
    const channel = await this.channel(raw)
    const id = raw.senderUin || await this.directory.resolveUin(raw.senderUid)
    const name = raw.sendMemberName || raw.sendNickName || id
    const content: Segment[] = []
    for (const element of raw.elements) {
      const segment = await this.decodeElement(element, raw)
      if (segment) content.push(segment)
    }
    return {
      id: raw.msgId,
      channel,
      user: portrait(id, name),
      content,
      timestamp: Number(raw.msgTime) * 1000,
    }
  }

  async channel(raw: RawMessage): Promise<Channel> {
    if (raw.chatType === 2) return { kind: 'group', id: raw.peerUid }
    if (raw.chatType !== 1) {
      throw new Fault('unsupported', 'QQ chat type is not supported')
    }
    const id = await this.directory.resolveUin(raw.peerUid)
    return { kind: 'direct', id }
  }

  private async peer(channel: Channel): Promise<Peer> {
    uin.parse(channel.id)
    if (channel.kind === 'group') {
      return { chatType: 2, peerUid: channel.id, guildId: '' }
    }
    const peerUid = await this.directory.uid(channel.id)
    return { chatType: 1, peerUid, guildId: '' }
  }

  private async find(peer: Peer, id: string): Promise<RawMessage> {
    const operation = this.service.getMsgsByMsgId(peer, [id])
    const result = await bounded(operation, this.signal, this.timeout)
    if (result.result !== 0) {
      throw new Fault('unavailable', 'QQ message lookup failed')
    }
    const message = result.msgList.find(message => message.msgId === id)
    if (!message) throw new Fault('missing', 'Message was not found')
    return message
  }

  private async encode(segment: Segment, peer: Peer): Promise<SendElement> {
    switch (segment.type) {
      case 'text':
        return { elementType: 1, textElement: { content: segment.text } }
      case 'mention-all':
        return {
          elementType: 1,
          textElement: { content: '@全体成员', atType: 1 },
        }
      case 'mention':
        return this.mention(segment.user)
      case 'quote':
        return this.quote(peer, segment.id)
      case 'image':
        return this.image(segment.source)
    }
  }

  private async mention(user: User): Promise<SendElement> {
    const atNtUid = await this.directory.uid(user.id)
    const info = user.name ? user : await this.directory.user(user.id)
    const content = info.name.startsWith('@') ? info.name : `@${info.name}`
    const textElement = {
      content,
      atType: 2,
      atUid: user.id,
      atNtUid,
    }
    return { elementType: 1, textElement }
  }

  private async quote(peer: Peer, id: string): Promise<SendElement> {
    const source = await this.find(peer, id)
    const replyElement = {
      replayMsgId: source.msgId,
      replayMsgSeq: source.msgSeq,
      senderUid: source.senderUid,
      senderUin: source.senderUin,
    }
    return { elementType: 7, replyElement }
  }

  private async image(source: string): Promise<SendElement> {
    await using file = await this.resources.prepare(source, this.signal)
    const { path } = file
    const [size, dimensions] = await Promise.all([
      stat(path), imageSizeFromFile(path),
    ])
    const digest = createHash('md5')
    const input = createReadStream(path, { signal: this.signal })
    for await (const chunk of input) digest.update(chunk)
    const md5HexStr = digest.digest('hex')
    const fileName = `${md5HexStr}.${dimensions.type}`
    const request = {
      md5HexStr,
      fileName,
      elementType: 2,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    }
    const sourcePath = this.service.getRichMediaFilePathForGuild(request)
    const copied = this.util.copyFile(path, sourcePath)
    const success = await bounded(copied, this.signal, this.timeout)
    if (!success) throw new Fault('unavailable', 'QQ image copy failed')
    const picElement = {
      md5HexStr,
      fileName,
      sourcePath,
      fileSize: `${size.size}`,
      picWidth: dimensions.width,
      picHeight: dimensions.height,
      original: true,
      picType: 1000,
      picSubType: 0,
      fileUuid: '',
      fileSubId: '',
      thumbFileSize: 0,
      summary: '',
    }
    return { elementType: 2, elementId: '', picElement }
  }

  private async decodeElement(
    element: RawElement,
    message: RawMessage,
  ): Promise<Segment | undefined> {
    switch (element.elementType) {
      case 1: {
        const text = element.textElement
        if (!text) return
        return this.decodeText(text)
      }
      case 2:
        if (!element.picElement) return
        return this.receiveImage(element.picElement, element, message)
      case 7:
        if (!element.replyElement) return
        return { type: 'quote', id: element.replyElement.replayMsgId }
      default:
        return
    }
  }

  private async decodeText(text: Text): Promise<Segment> {
    if (text.atType === 1) return { type: 'mention-all' }
    if (text.atType !== 2 && text.atType !== 4) {
      return { type: 'text', text: text.content }
    }
    const parsed = uin.safeParse(text.atUid)
    if (!parsed.success && !text.atNtUid) {
      throw new Fault('input', 'QQ mention has no valid user identity')
    }
    const id = parsed.success
      ? parsed.data
      : await this.directory.resolveUin(text.atNtUid!)
    const user = portrait(id, text.content.replace(/^@/, ''))
    return { type: 'mention', user }
  }

  private receiveImage(
    picture: Picture,
    element: RawElement,
    message: RawMessage,
  ): Segment {
    if (picture.picUrl) return { type: 'image', source: picture.picUrl }
    const request = {
      msgId: message.msgId,
      elemId: element.elementId,
      chatType: message.chatType,
      downloadType: 1,
      thumbSize: 0,
    }
    const source = this.resources.publish(async () => {
      const path = await this.picturePath(picture)
      if (path) return path
      const operation = this.service.downloadRichMedia(request)
      await bounded(operation, this.signal, this.timeout)
      return this.waitForImage(picture)
    })
    return { type: 'image', source }
  }

  private async waitForImage(picture: Picture): Promise<string> {
    const deadline = performance.now() + this.timeout
    while (performance.now() < deadline) {
      const path = await this.picturePath(picture)
      if (path) return path
      await delay(100, undefined, { signal: this.signal })
    }
    throw new Fault('timeout', 'QQ did not download the image')
  }

  private async picturePath(picture: Picture): Promise<string | undefined> {
    const paths = [picture.sourcePath, picture.picPath]
    const expected = Number(picture.fileSize)
    for (const candidate of paths) {
      if (!candidate) continue
      const path = isAbsolute(candidate)
        ? candidate
        : resolve(this.root, candidate)
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile() || info.size === 0) continue
      if (expected > 0 && info.size !== expected) continue
      return path
    }
    return undefined
  }
}
