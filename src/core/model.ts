export type User = Readonly<{
  id: string
  name: string
  avatar?: string
}>

export type Channel =
  | Readonly<{ kind: 'direct', id: string }>
  | Readonly<{ kind: 'group', id: string }>

export type Group = Readonly<{
  id: string
  name: string
  avatar?: string
}>

export type Member = Readonly<{
  user: User
  name: string
  joinedAt?: number
}>

export type Segment =
  | Readonly<{ type: 'text', text: string }>
  | Readonly<{ type: 'mention', user: User }>
  | Readonly<{ type: 'mention-all' }>
  | Readonly<{ type: 'image', source: string }>
  | Readonly<{ type: 'quote', id: string }>

export type Message = Readonly<{
  id: string
  channel: Channel
  user: User
  content: readonly Segment[]
  timestamp: number
}>

export type Account =
  | Readonly<{ status: 'connecting' }>
  | Readonly<{ status: 'offline', user?: User }>
  | Readonly<{ status: 'online', user: User }>

export type BotEvent =
  | Readonly<{ type: 'account-added', account: Account }>
  | Readonly<{ type: 'account-updated', account: Account }>
  | Readonly<{ type: 'message', message: Message }>
  | Readonly<{
    type: 'delete'
    channel: Channel
    id: string
    timestamp: number
  }>

export interface Bot {
  readonly platform: string
  readonly account: Account
  subscribe(listener: (event: BotEvent) => void): () => void
  send(channel: Channel, content: readonly Segment[]): Promise<Message>
  message(channel: Channel, id: string): Promise<Message>
  remove(channel: Channel, id: string): Promise<void>
  user(id: string): Promise<User>
  friends(): Promise<readonly User[]>
  groups(): Promise<readonly Group[]>
  members(group: string): Promise<readonly Member[]>
}

export interface Resources {
  prepare(source: string, signal: AbortSignal): Promise<MediaFile>
  publish(load: () => Promise<string>): string
}

export interface MediaFile extends AsyncDisposable {
  readonly path: string
}

export interface AssetFile extends MediaFile {
  readonly size: number
  readonly type: string
}

export interface Assets {
  upload(
    body: ReadableStream<Uint8Array>,
    type: string,
    signal: AbortSignal,
  ): Promise<string>
  acquire(id: string): Promise<AssetFile>
}

export class Fault extends Error {
  constructor(
    readonly code: 'input' | 'offline' | 'missing' | 'unsupported'
      | 'timeout' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'Fault'
  }
}
