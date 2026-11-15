import type { Login } from '@satorijs/protocol'
import { z } from 'zod'
import { Fault } from '../core/model.js'
import type { Bot } from '../core/model.js'
import {
  channelResource, decode, messageResource, parseChannel,
} from './codec.js'

const id = z.string().min(1)
const empty = z.object({})
const user = z.object({ user_id: id })
const guild = z.object({ guild_id: id })
const channel = z.object({ channel_id: id })
const message = channel.extend({ message_id: id })
const member = guild.extend({ user_id: id })
const create = channel.extend({ content: z.string().min(1) })
const page = z.object({ next: z.literal('').optional() })
const guildPage = guild.extend(page.shape)
const statuses = { online: 1, connecting: 2, offline: 0 } as const

type Action = (input: unknown) => Promise<unknown>

function action<S extends z.ZodType>(
  schema: S,
  handle: (input: z.output<S>) => unknown,
): Action {
  return async input => handle(schema.parse(input))
}

export class SatoriApi {
  readonly actions: ReadonlyMap<string, Action>
  private readonly features: string[]

  constructor(private readonly bot: Bot) {
    const actions = {
      'login.get': action(empty, () => this.login()),
      'message.create': action(create, input => this.create(input)),
      'message.get': action(message, input => this.message(input)),
      'message.delete': action(message, input => this.remove(input)),
      'user.get': action(user, input => bot.user(input.user_id)),
      'friend.list': action(page, () => this.friends()),
      'guild.get': action(guild, input => this.group(input.guild_id)),
      'guild.list': action(page, async () => ({ data: await bot.groups() })),
      'guild.member.get': action(member, input => this.member(input)),
      'guild.member.list': action(guildPage, input => this.members(input)),
      'channel.get': action(channel, input => this.channel(input.channel_id)),
      'channel.list': action(guildPage, input => this.channels(input)),
      'user.channel.create': action(user, input => this.direct(input.user_id)),
    }
    this.actions = new Map(Object.entries(actions))
    this.features = [...this.actions.keys(), 'upload.create']
  }

  login(): Login | undefined {
    const { account } = this.bot
    if (!('user' in account) || !account.user) return undefined
    const status = statuses[account.status]
    const login = {
      sn: 0,
      adapter: 'saury',
      platform: this.bot.platform,
      status,
      features: this.features,
      user: account.user,
    }
    return login
  }

  account(): string {
    const account = this.bot.account
    if (account.status !== 'online') {
      throw new Fault('offline', 'QQ account is not online')
    }
    return `${this.bot.platform}/${account.user.id}`
  }

  private async create(input: z.infer<typeof create>) {
    const account = this.account()
    const channel = parseChannel(input.channel_id)
    const content = decode(input.content, account)
    const message = await this.bot.send(channel, content)
    return [messageResource(message, account)]
  }

  private async message(input: z.infer<typeof message>) {
    const account = this.account()
    const channel = parseChannel(input.channel_id)
    const message = await this.bot.message(channel, input.message_id)
    return messageResource(message, account)
  }

  private async remove(input: z.infer<typeof message>) {
    await this.bot.remove(parseChannel(input.channel_id), input.message_id)
    return null
  }

  private async friends() {
    const friends = await this.bot.friends()
    return { data: friends.map(user => ({ user })) }
  }

  private async group(id: string) {
    const groups = await this.bot.groups()
    const group = groups.find(group => group.id === id)
    if (!group) throw new Fault('missing', 'Group was not found')
    return group
  }

  private async members(input: z.infer<typeof guildPage>) {
    const members = await this.bot.members(input.guild_id)
    const data = members.map(member => {
      const { user, name, joinedAt } = member
      return { user, name, joined_at: joinedAt }
    })
    return { data }
  }

  private async member(input: z.infer<typeof member>) {
    const members = await this.members({ guild_id: input.guild_id })
    const member = members.data.find(member => member.user.id === input.user_id)
    if (!member) throw new Fault('missing', 'Group member was not found')
    return member
  }

  private async channel(value: string) {
    const channel = parseChannel(value)
    const resource = channelResource(channel)
    if (channel.kind === 'group') {
      const group = await this.group(channel.id)
      return { ...resource, name: group.name }
    }
    const user = await this.bot.user(channel.id)
    return { ...resource, name: user.name }
  }

  private async channels(input: z.infer<typeof guildPage>) {
    const channel = await this.channel(`group:${input.guild_id}`)
    return { data: [channel] }
  }

  private async direct(id: string) {
    const user = await this.bot.user(id)
    const channel = channelResource({ kind: 'direct', id: user.id })
    return { ...channel, name: user.name }
  }
}
