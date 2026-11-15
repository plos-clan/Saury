import { hostname, release, version } from 'node:os'
import { join } from 'node:path'
import type { Identity } from './native.js'
import type { Metadata } from './metadata.js'

export function sessionSettings(
  metadata: Metadata,
  self: Identity,
  directory: string,
  guid: string,
) {
  const deviceInfo = {
    guid,
    buildVer: metadata.version,
    localId: 2052,
    devName: hostname(),
    devType: 'Linux',
    vendorName: '',
    osVer: version(),
    vendorOsName: 'Linux',
    setMute: false,
    vendorType: 0,
  }
  const rdeliveryConfig = {
    appKey: '',
    systemId: 0,
    appId: '',
    logicEnvironment: '',
    platform: 5,
    language: '',
    sdkVersion: '',
    userId: '',
    appVersion: '',
    osVersion: '',
    bundleId: '',
    serverUrl: '',
    fixedAfterHitKeys: [''],
  }

  return {
    selfUin: self.uin,
    selfUid: self.uid,
    desktopPathConfig: { account_path: directory },
    clientVer: metadata.version,
    a2: '',
    d2: '',
    d2Key: '',
    machineId: '',
    platform: 5,
    platVer: `Linux ${release()}`,
    appid: metadata.appid,
    rdeliveryConfig,
    defaultFileDownloadPath: join(directory, 'nt_temp'),
    deviceInfo,
    deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
  }
}
