import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const uin = z.string().regex(/^[1-9]\d*$/)
export const uid = z.string().regex(/^u_[A-Za-z0-9_-]+$/)

export const identity = z.object({
  uin,
  uid,
  nick: z.string().default(''),
}).readonly()

export type Identity = z.infer<typeof identity>

export type Peer = Readonly<{
  chatType: 1 | 2
  peerUid: string
  guildId: string
}>

export type Result = Readonly<{ result: number, errMsg: string }>

export type Text = Readonly<{
  content: string
  atType?: number
  atUid?: string
  atNtUid?: string
}>

export type Picture = Readonly<{
  sourcePath?: string
  picPath?: string
  picUrl?: string
  fileSize?: string
}>

export type Reply = Readonly<{
  replayMsgId: string
  replayMsgSeq: string
  senderUid: string
  senderUin: string
}>

export type RawElement = Readonly<{
  elementType: number
  elementId: string
  textElement?: Text | null
  picElement?: Picture | null
  replyElement?: Reply | null
  grayTipElement?: Readonly<{
    revokeElement?: Readonly<{ operatorUid: string }> | null
  }> | null
}>

export type RawMessage = Readonly<{
  msgId: string
  msgSeq: string
  msgTime: string
  chatType: number
  peerUid: string
  guildId: string
  senderUid: string
  senderUin: string
  sendNickName: string
  sendMemberName: string
  sendStatus: number
  elements: readonly RawElement[]
}>

export type SendElement =
  | Readonly<{ elementType: 1, textElement: Text }>
  | Readonly<{ elementType: 7, replyElement: Reply }>
  | Readonly<{
    elementType: 2
    elementId: string
    picElement: Readonly<{
      md5HexStr: string
      fileSize: string
      fileName: string
      sourcePath: string
      picWidth: number
      picHeight: number
      original: boolean
      picType: number
      picSubType: number
      fileUuid: string
      fileSubId: string
      thumbFileSize: number
      summary: string
    }>
  }>

type MediaDownload = Readonly<{
  msgId: string
  peerUid: string
  chatType: number
  elementId: string
  downloadType: number
  thumbSize: number
}>

export interface Messages {
  addKernelMsgListener(listener: object): number
  removeKernelMsgListener(id: number): void
  generateMsgUniqueId(type: number, time: string): string
  sendMsg(
    id: string,
    peer: Peer,
    elements: readonly SendElement[],
    options: Map<number, unknown>,
  ): Promise<Result>
  recallMsg(peer: Peer, ids: readonly string[]): Promise<Result>
  getMsgsByMsgId(
    peer: Peer,
    ids: readonly string[],
  ): Promise<Result & { msgList: readonly RawMessage[] }>
  getRichMediaFilePathForGuild(options: object): string
  downloadRichMedia(options: MediaDownload): void
}

export type NativeGroup = Readonly<{
  groupCode: string
  groupName: string
}>

export type NativeMember = Readonly<{
  uid: string
  uin: string
  nick: string
  cardName: string
  joinTime: number
}>

export interface Groups {
  addKernelGroupListener(listener: object): number
  removeKernelGroupListener(id: number): void
  getGroupList(force: boolean): Promise<Result>
  getAllMemberList(group: string, force: boolean): Promise<{
    errCode: number
    errMsg: string
    result: { infos: Map<string, NativeMember> }
  }>
}

export interface Identities {
  getUid(uins: ReadonlySet<string>): Promise<{
    uidInfo: Map<string, string>
  }>
  getUin(uids: ReadonlySet<string>): Promise<{
    uinInfo: Map<string, string>
  }>
}

export interface Buddies {
  getBuddyListFromCache(caller: string, category: number): readonly {
    buddyUids: readonly string[]
  }[]
  getBuddyNick(uids: readonly string[]): Map<string, string> | null
}

export interface NativeSession {
  init(
    config: object,
    depends: object,
    dispatcher: object,
    listener: object,
  ): void
  getMsgService(): Messages | null
  getGroupService(): Groups | null
  getBuddyService(): Buddies | null
  getUixConvertService(): Identities | null
}

export type LoginEntry = Readonly<{
  uin: string
  uid: string
  nickName: string
  isQuickLogin: boolean
}>

export type QrCode = Readonly<{
  pngBase64QrcodeData: string
  qrcodeUrl: string
}>

export interface Login {
  addKernelLoginListener(listener: object): number
  removeKernelLoginListener(id: number): void
  initConfig(config: object): void
  setRemerberPwd(remember: boolean): void
  connect(): void
  getLoginList(): Promise<{
    result: number
    LocalLoginInfoList: readonly LoginEntry[]
  }>
  quickLoginWithUin(uin: string): Promise<{
    result: string
    loginErrorInfo: { errMsg: string }
  }>
  getQRCodePicture(): boolean
  getMachineGuid(): string
}

export interface Native {
  NodeIO3MiscService: {
    get(): { addO3MiscListener(listener: object): number }
  }
  NodeIQQNTStartupSessionWrapper: {
    create(): { start(): number, stop(): void }
  }
  NodeIQQNTWrapperSession: {
    getNTWrapperSession(name: string): NativeSession
  }
  NodeIQQNTWrapperEngine: {
    get(): { initWithDeskTopConfig(config: object, adapter: object): void }
  }
  NodeIKernelLoginService: { get(): Login }
  NodeQQNTWrapperUtil: {
    copyFile(source: string, target: string): Promise<boolean>
  }
}

export function loadQqNative(wrapperPath: string): Native {
  const module = { exports: {} as Record<string, unknown> }
  const stub = new URL('../saury.so', import.meta.url)
  process.dlopen(module, fileURLToPath(stub))
  process.dlopen(module, wrapperPath)
  const factories = {
    NodeIO3MiscService: 'get',
    NodeIQQNTStartupSessionWrapper: 'create',
    NodeIQQNTWrapperSession: 'getNTWrapperSession',
    NodeIQQNTWrapperEngine: 'get',
    NodeIKernelLoginService: 'get',
    NodeQQNTWrapperUtil: 'copyFile',
  }

  for (const [name, method] of Object.entries(factories)) {
    const factory = module.exports[name]
    const members = factory as Record<string, unknown> | undefined
    if (typeof members?.[method] === 'function') continue
    throw new Error(`QQ module does not provide ${name}.${method}`)
  }

  return module.exports as unknown as Native
}
