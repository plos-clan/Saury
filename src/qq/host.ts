import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { hostname, release, version } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Logger } from 'pino'
import { renderUnicodeCompact } from 'uqr'
import type { Config } from '../config.js'
import { bounded } from '../core/operation.js'
import { Fault } from '../core/model.js'
import type { Metadata } from './metadata.js'
import { identity, loadNative } from './native.js'
import type { Identity, Native, NativeSession, QrCode } from './native.js'
import { sessionSettings } from './settings.js'
import { provision } from './resource.js'

const ignore = () => {}

export class NativeHost {
  private readonly startup
  private readonly login
  private readonly connected = Promise.withResolvers<void>()
  private readonly authenticated = Promise.withResolvers<Identity>()
  private readonly listener: number
  private closed = false
  readonly session: NativeSession

  private constructor(
    readonly native: Native,
    private readonly metadata: Metadata,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly signal: AbortSignal,
    private readonly disconnected: () => void,
    private readonly reconnected: () => void,
  ) {
    const misc = native.NodeIO3MiscService.get()
    misc.addO3MiscListener({ getOnAmgomDataPiece: ignore })
    this.startup = native.NodeIQQNTStartupSessionWrapper.create()
    this.session = native.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1')
    this.initialize()
    this.login = native.NodeIKernelLoginService.get()
    this.listener = this.login.addKernelLoginListener(this.callbacks())
    this.authenticated.promise.catch(ignore)
  }

  static async open(
    config: Config,
    logger: Logger,
    signal: AbortSignal,
    disconnected: () => void,
    reconnected: () => void,
  ): Promise<NativeHost> {
    if (process.platform !== 'linux') {
      throw new Error('Saury requires Linux')
    }

    const resource = await provision(config.data, logger, signal)
    const home = join(config.session, 'home')
    const global = join(config.session, 'nt_qq', 'global')
    const paths = [home, join(global, 'nt_temp')]
    await Promise.all(paths.map(path => mkdir(path, { recursive: true })))
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, '.config')
    process.env.XDG_CACHE_HOME = join(home, '.cache')
    process.env.XDG_DATA_HOME = join(home, '.local', 'share')
    process.env.XDG_STATE_HOME = join(home, '.local', 'state')
    process.chdir(config.session)

    signal.throwIfAborted()
    const native = loadNative(join(resource.path, 'wrapper.node'))
    return new NativeHost(
      native, resource.metadata, config, logger, signal,
      disconnected, reconnected,
    )
  }

  async connect(): Promise<Identity> {
    const commonPath = join(this.config.session, 'nt_qq', 'global')
    const settings = {
      machineId: '',
      appid: this.metadata.appid,
      platVer: `Linux ${release()}`,
      commonPath,
      clientVer: this.metadata.version,
      hostName: hostname(),
      externalVersion: false,
    }
    this.login.initConfig(settings)
    this.login.setRemerberPwd(true)
    this.login.connect()
    await bounded(this.connected.promise, this.signal, this.config.timeout)
    await delay(3000, undefined, { signal: this.signal })
    const self = await this.authenticate()
    await this.activate(self, commonPath)
    const qr = join(this.config.session, 'qrcode.png')
    await unlink(qr).catch(ignore)
    return self
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.login.removeKernelLoginListener(this.listener)
    this.startup.stop()
  }

  private initialize(): void {
    const global = join(this.config.session, 'nt_qq', 'global')
    const settings = {
      base_path_prefix: this.config.session,
      platform_type: 5,
      app_type: 4,
      app_version: this.metadata.version,
      os_version: version(),
      use_xlog: true,
      qua: this.metadata.qua,
      global_path_config: { desktopGlobalPath: global },
      thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
    }
    const adapter = {
      onLog: ignore,
      onGetSrvCalTime: ignore,
      onShowErrUITips: ignore,
      fixPicImgType: ignore,
      getAppSetting: ignore,
      onInstallFinished: ignore,
      onUpdateGeneralFlag: ignore,
      onGetOfflineMsg: ignore,
    }
    const engine = this.native.NodeIQQNTWrapperEngine.get()
    engine.initWithDeskTopConfig(settings, adapter)
  }

  private callbacks() {
    return {
      onLoginConnected: () => {
        this.connected.resolve()
        this.reconnected()
      },
      onLoginDisConnected: this.disconnected,
      onLoginConnecting: ignore,
      onQRCodeLoginPollingStarted: ignore,
      onQRCodeSessionUserScaned: ignore,
      onQRCodeSessionQuickLoginFailed: ignore,
      onQRCodeGetPicture: (qr: QrCode) => {
        this.saveQr(qr).catch(error => {
          this.authenticated.reject(error)
        })
      },
      onQRCodeLoginSucceed: (value: unknown) => {
        const parsed = identity.safeParse(value)
        if (parsed.success) this.authenticated.resolve(parsed.data)
        else this.authenticated.reject(parsed.error)
      },
      onQRCodeSessionFailed: () => {
        if (this.closed || this.signal.aborted) return
        this.login.getQRCodePicture()
      },
      onLoginFailed: () => {
        this.authenticated.reject(new Error('QQ login failed'))
      },
      onLogoutSucceed: this.disconnected,
      onLogoutFailed: ignore,
      onUserLoggedIn: ignore,
      onPasswordLoginFailed: ignore,
      onQQLoginNumLimited: ignore,
      onLoginState: ignore,
    }
  }

  private async saveQr(qr: QrCode): Promise<void> {
    if (this.closed || this.signal.aborted) return
    const encoded = qr.pngBase64QrcodeData
    const base64 = encoded.replace(/^data:image\/\w+;base64,/, '')
    const png = Buffer.from(base64, 'base64')
    const path = join(this.config.session, 'qrcode.png')
    await writeFile(path, png, { mode: 0o600 })
    this.logger.info({ path }, 'Scan the QQ login QR code')
    const terminal = renderUnicodeCompact(qr.qrcodeUrl, { border: 4, ecc: 'M' })
    process.stdout.write(`\n\x1b[97;40m${terminal}\x1b[0m\n`)
  }

  private async authenticate(): Promise<Identity> {
    const operation = this.login.getLoginList()
    const list = await bounded(operation, this.signal, this.config.timeout)
    const target = list.LocalLoginInfoList.find(entry => {
      if (this.config.account) return entry.uin === this.config.account
      return entry.isQuickLogin
    })

    if (target) {
      const operation = this.login.quickLoginWithUin(target.uin)
      const result = await bounded(
        operation, this.signal, this.config.timeout,
      )
      if (!result.loginErrorInfo.errMsg) {
        return identity.parse({ ...target, nick: target.nickName })
      }
      const reason = result.loginErrorInfo.errMsg
      this.logger.warn({ reason }, 'QQ quick login failed; requesting QR login')
    }

    this.signal.throwIfAborted()
    this.login.getQRCodePicture()
    const self = await bounded(this.authenticated.promise, this.signal)
    if (this.config.account && self.uin !== this.config.account) {
      throw new Fault('input', 'Scanned account differs from SAURY_ACCOUNT')
    }
    return self
  }

  private async activate(self: Identity, directory: string): Promise<void> {
    const ready = Promise.withResolvers<void>()
    const guid = this.login.getMachineGuid()
    const settings = sessionSettings(this.metadata, self, directory, guid)
    const depends = {
      onMSFStatusChange: ignore,
      onMSFSsoError: ignore,
      getGroupCode: ignore,
    }
    const dispatcher = {
      dispatchRequest: ignore,
      dispatchCall: ignore,
      dispatchCallWithJson: ignore,
    }
    const listener = {
      onNTSessionCreate: ignore,
      onGProSessionCreate: ignore,
      onUserOnlineResult: ignore,
      onGetSelfTinyId: ignore,
      onSessionInitComplete: (result: number) => {
        if (result === 0) ready.resolve()
      },
      onOpentelemetryInit: (info: { is_init: boolean }) => {
        if (info.is_init) ready.resolve()
      },
    }
    this.session.init(settings, depends, dispatcher, listener)
    this.startup.start()
    await bounded(ready.promise, this.signal, this.config.timeout)
    const deadline = performance.now() + this.config.timeout
    while (!this.session.getMsgService()) {
      if (performance.now() >= deadline) {
        throw new Fault('timeout', 'QQ message service did not become ready')
      }
      await delay(50, undefined, { signal: this.signal })
    }
  }
}
