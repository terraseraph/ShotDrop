import FtpSrv from 'ftp-srv'
import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Settings } from '@shared/types'
import type { LoginAttempt } from '@shared/diagnostics'
import { addressFacing } from './net'

// ftp-srv logs through bunyan. Everything (commands, replies, errors) goes to ftp.log so a flaky
// camera session can be read afterwards; errors also hit the console.
let logPath: string | null = null
export function setFtpLogFile(path: string): void {
  logPath = path
}
export function ftpLog(level: string, ...a: unknown[]): void {
  if (!logPath) return
  const text = a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' ')
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${level} ${text}\n`)
  } catch {
    /* logging must never break an upload */
  }
}
const quietLog: Record<string, unknown> = {}
for (const lvl of ['trace', 'debug', 'info', 'warn']) quietLog[lvl] = (...a: unknown[]) => ftpLog(lvl, ...a)
quietLog.error = (...a: unknown[]) => {
  console.error('[ftp]', ...a)
  ftpLog('error', ...a)
}
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
  /** username -> open connections */
  private conns = new Map<string, number>()
  state: FtpState = { running: false, error: null, activeConnections: 0 }
  /** Recent logins (good and bad), newest last. A refused login is the commonest camera setup mistake. */
  attempts: LoginAttempt[] = []
  /** Kept current by Core so changing it never restarts the server. */
  preferredAddress: string | null = null

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
      pasv_url: (clientIp: string) => addressFacing(clientIp, this.preferredAddress),
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
      this.attempts.push({ at: Date.now(), ip: String(connection.ip ?? ''), username, ok: !!user })
      if (this.attempts.length > 50) this.attempts.shift()
      if (!user) return reject(new Error('Invalid username or password'))
      const root = join(this.incomingDir(), user.username)
      mkdirSync(root, { recursive: true })
      this.conns.set(user.username, (this.conns.get(user.username) ?? 0) + 1)
      ;(connection as unknown as { commandSocket: NodeJS.EventEmitter }).commandSocket.on('close', () => {
        this.conns.set(user.username, Math.max(0, (this.conns.get(user.username) ?? 1) - 1))
        this.onState()
      })
      connection.on('STOR', (err: Error | null, filePath: string) => {
        ftpLog('STOR', filePath, err ? `ERR ${err.message}` : 'ok')
        if (err || !filePath) return
        this.onUploaded(isAbsolute(filePath) ? filePath : join(root, filePath), user.username)
      })
      this.onState()
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
    ev.on('client-error', ({ error, context }: { error: Error; context?: string }) => ftpLog('client-error', context ?? '', error))
    ev.on('server-error', ({ error }: { error: Error }) => {
      ftpLog('server-error', error)
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

  isConnected(username: string): boolean {
    return (this.conns.get(username) ?? 0) > 0
  }

  async stop(): Promise<void> {
    this.conns.clear()
    if (!this.server) return
    const s = this.server
    this.server = null
    await s.close().catch(() => undefined)
    this.state = { running: false, error: null, activeConnections: 0 }
    this.onState()
  }
}
