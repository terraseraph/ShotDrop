import FtpSrv from 'ftp-srv'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Settings } from '@shared/types'
import { addressFacing } from './net'

// ftp-srv logs through bunyan; keep it quiet and route errors to the console.
const quietLog: Record<string, unknown> = {}
for (const lvl of ['trace', 'debug', 'info', 'warn']) quietLog[lvl] = () => undefined
quietLog.error = (...a: unknown[]) => console.error('[ftp]', ...a)
quietLog.fatal = quietLog.error
quietLog.child = () => quietLog

export interface FtpState {
  running: boolean
  error: string | null
  activeConnections: number
}

/**
 * Embedded FTP server cameras upload to. Each FTP user gets its own folder under the incoming dir,
 * which the ingestor watches. Uploads are write-only from the camera's point of view.
 */
export class FtpService {
  private server: FtpSrv | null = null
  state: FtpState = { running: false, error: null, activeConnections: 0 }

  constructor(
    private incomingDir: () => string,
    private onUploaded: (absPath: string, username: string) => void,
    private onState: () => void
  ) {}

  async start(cfg: Settings['ftp']): Promise<void> {
    await this.stop()
    const signalsBefore = new Map(['SIGINT', 'SIGTERM', 'SIGQUIT'].map((s) => [s, process.listeners(s as NodeJS.Signals)]))

    const server = new FtpSrv({
      url: `ftp://0.0.0.0:${cfg.port}`,
      pasv_url: (clientIp: string) => addressFacing(clientIp),
      pasv_min: cfg.pasvMin,
      pasv_max: cfg.pasvMax,
      anonymous: false,
      greeting: 'ShotDrop ready',
      log: quietLog as never
    } as unknown as ConstructorParameters<typeof FtpSrv>[0])

    // ftp-srv installs process signal handlers that call process.exit(); Electron owns shutdown, so drop them.
    for (const [sig, before] of signalsBefore) {
      for (const l of process.listeners(sig as NodeJS.Signals)) {
        if (!before.includes(l)) process.off(sig as NodeJS.Signals, l)
      }
    }

    server.on('login', ({ connection, username, password }, resolve, reject) => {
      const user = cfg.users.find((u) => u.username === username && u.password === password)
      if (!user) return reject(new Error('Invalid username or password'))
      const root = join(this.incomingDir(), user.username)
      mkdirSync(root, { recursive: true })
      connection.on('STOR', (err: Error | null, filePath: string) => {
        if (err || !filePath) return
        this.onUploaded(isAbsolute(filePath) ? filePath : join(root, filePath), user.username)
      })
      resolve({ root })
    })
    // The bundled .d.ts lags the runtime: these events exist but aren't typed.
    const ev = server as unknown as NodeJS.EventEmitter
    ev.on('connect', ({ newConnectionCount }: { newConnectionCount: number }) => {
      this.state.activeConnections = newConnectionCount
      this.onState()
    })
    ev.on('disconnect', ({ newConnectionCount }: { newConnectionCount: number }) => {
      this.state.activeConnections = newConnectionCount
      this.onState()
    })
    ev.on('server-error', ({ error }: { error: Error }) => {
      this.state.error = String(error?.message ?? error)
      this.onState()
    })

    try {
      await server.listen()
      this.server = server
      this.state = { running: true, error: null, activeConnections: 0 }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      this.state = {
        running: false,
        error: err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use` : err.message,
        activeConnections: 0
      }
    }
    this.onState()
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const s = this.server
    this.server = null
    await s.close().catch(() => undefined)
    this.state = { running: false, error: null, activeConnections: 0 }
    this.onState()
  }
}
