import { LRUCache } from 'lru-cache'
import { bounded } from '../core/operation.js'
import { Fault } from '../core/model.js'
import type { Group, Member, User } from '../core/model.js'
import type { Buddies, Groups, Identity, NativeGroup } from './native.js'
import { uid, uin } from './native.js'

const ignore = () => {}

export class Directory {
  private readonly uids: LRUCache<string, string>
  private readonly uins: LRUCache<string, string>
  private readonly groupList = new Map<string, Group>()
  private readonly initialized = Promise.withResolvers<void>()
  private readonly listener: number
  private refresh: Promise<readonly Group[]> | undefined

  constructor(
    private readonly service: Groups,
    private readonly buddies: Buddies,
    private readonly self: Identity,
    private readonly signal: AbortSignal,
    private readonly timeout: number,
    capacity: number,
  ) {
    this.uids = new LRUCache({ max: capacity })
    this.uins = new LRUCache({ max: capacity })
    this.uids.set(self.uin, self.uid)
    this.uins.set(self.uid, self.uin)
    const listener = {
      onGroupListUpdate: (type: number, groups: readonly NativeGroup[]) => {
        this.updateGroups(type, groups)
      },
      onGroupListInited: (empty: boolean) => {
        if (empty) this.updateGroups(0, [])
      },
      onGroupDetailInfoChange: ignore,
      onMemberListChange: ignore,
      onMemberInfoChange: ignore,
      onGroupNotifiesUpdated: ignore,
      onGroupSingleScreenNotifies: ignore,
      onShutUpMemberListChanged: ignore,
      onGroupEssenceListChange: ignore,
    }
    this.listener = service.addKernelGroupListener(listener)
  }

  async uid(id: string): Promise<string> {
    const cached = this.uids.get(id)
    if (cached) return cached
    const operation = this.service.getUidByUins([uin.parse(id)])
    const result = await bounded(operation, this.signal, this.timeout)
    const value = result.uids.get(id)
    if (result.errCode !== 0 || !value) {
      throw new Fault('missing', 'QQ user identity was not found')
    }
    this.uids.set(id, uid.parse(value))
    this.uins.set(value, id)
    return value
  }

  async resolveUin(value: string): Promise<string> {
    const cached = this.uins.get(value)
    if (cached) return cached
    const operation = this.service.getUinByUids([uid.parse(value)])
    const result = await bounded(operation, this.signal, this.timeout)
    const id = result.uins.get(value)
    if (result.errCode !== 0 || !id) {
      throw new Fault('missing', 'QQ user number was not found')
    }
    this.uins.set(value, uin.parse(id))
    this.uids.set(id, value)
    return id
  }

  async user(id: string): Promise<User> {
    uin.parse(id)
    if (id === this.self.uin) return portrait(id, this.self.nick)
    const native = await this.uid(id)
    const name = this.buddies.getBuddyNick(native) || id
    return portrait(id, name)
  }

  async friends(): Promise<readonly User[]> {
    const operation = this.buddies.getBuddyListFromCache(0)
    const categories = await bounded(operation, this.signal, this.timeout)
    const entries = categories.flatMap(category => category.buddyList)
    return Promise.all(entries.map(async entry => {
      const id = entry.uin || await this.resolveUin(entry.uid)
      this.uids.set(id, entry.uid)
      this.uins.set(entry.uid, id)
      return portrait(id, this.buddies.getBuddyNick(entry.uid) || id)
    }))
  }

  async groups(): Promise<readonly Group[]> {
    if (this.refresh) return this.refresh
    this.refresh = this.loadGroups()
    try {
      return await this.refresh
    } finally {
      this.refresh = undefined
    }
  }

  async members(group: string): Promise<readonly Member[]> {
    const operation = this.service.getAllMemberList(uin.parse(group), false)
    const result = await bounded(operation, this.signal, this.timeout)
    if (result.errCode !== 0) {
      throw new Fault('unavailable', 'QQ group member lookup failed')
    }
    return [...result.result.infos.values()].map(member => {
      const id = uin.parse(member.uin)
      this.uids.set(id, uid.parse(member.uid))
      this.uins.set(member.uid, id)
      const joinedAt = Number(member.joinTime) * 1000
      const user = portrait(id, member.nick || id)
      return { user, name: member.cardName || user.name, joinedAt }
    })
  }

  close(): void {
    this.service.removeKernelGroupListener(this.listener)
    this.uids.clear()
    this.uins.clear()
    this.groupList.clear()
  }

  private updateGroups(type: number, groups: readonly NativeGroup[]): void {
    if (type === 0) this.groupList.clear()
    for (const group of groups) {
      const entry = { id: group.groupCode, name: group.groupName }
      this.groupList.set(entry.id, entry)
    }
    this.initialized.resolve()
  }

  private async loadGroups(): Promise<readonly Group[]> {
    const operation = this.service.getGroupList(true)
    const result = await bounded(operation, this.signal, this.timeout)
    if (result.result !== 0) {
      throw new Fault('unavailable', 'QQ group lookup failed')
    }
    await bounded(this.initialized.promise, this.signal, this.timeout)
    return [...this.groupList.values()]
  }
}

export function portrait(id: string, name: string): User {
  const avatar = `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`
  return { id, name, avatar }
}
