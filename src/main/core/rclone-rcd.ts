import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { CloudAccounts } from './cloud'
import { toolPath } from './bundled'

/** The daemon is gone or never answered: the caller should fall back to spawning rclone for this call. */
export class DaemonDown extends Error {}

/** rclone answered with an error body ({ error, status }). */
export class RcError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface RcdState {
  running: boolean
  port: number | null
  pid: number | null
  /** Times the daemon was started again after having run (or failed) before. */
  restarts: number
  lastError: string | null
  /** Set once the daemon is judged unusable (no rclone binary, repeated start failures); calls spawn instead. */
  disabled: boolean
}

export interface RcdOptions {
  cloud: CloudAccounts
  /** The configured rclone path setting ('rclone' = bundled copy, else PATH). */
  rclonePath: () => string
  /** Test hook: run this command (with these leading args) instead of rclone. */
  exec?: { cmd: string; args: string[] }
  idleMs?: number
  log?: (msg: string) => void
}

const OP_TIMEOUT = 120_000
const START_TIMEOUT = 20_000
const IDLE_MS = 10 * 60_000
const BACKOFF_MIN = 1000
const BACKOFF_MAX = 60_000

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * One long-lived `rclone rcd` for ShotDrop's own rclone.conf. Started on first use, bound to 127.0.0.1 on a random port with
 * random per-start credentials, stopped after 10 idle minutes or on app quit. Remotes in the user's own config are never routed
 * here (the daemon only knows ShotDrop's config), so callers keep spawning for those.
 */
export class RcloneDaemon {
  private proc: ChildProcess | null = null
  private port = 0
  private auth = ''
  private starting: Promise<boolean> | null = null
  private known = new Set<string>()
  private everStarted = false
  private failures = 0
  private retryAt = 0
  private lastUsed = 0
  private inflight = 0
  private idleTimer: NodeJS.Timeout | null = null
  private stopping = false
  private warned = false
  private s: RcdState = { running: false, port: null, pid: null, restarts: 0, lastError: null, disabled: false }

  constructor(private o: RcdOptions) {}

  state(): RcdState {
    return { ...this.s }
  }

  private log(msg: string): void {
    this.o.log?.(msg)
  }

  /** True when calls can go through the daemon, starting it if needed. `remote` is a name in ShotDrop's rclone.conf. */
  async ensure(remote?: string): Promise<boolean> {
    if (this.s.disabled || this.stopping) return false
    if (!(await this.up())) return false
    if (remote && !this.known.has(remote)) {
      // A remote linked after the daemon started: it only reads the config at start, so restart to pick it up.
      let has = false
      try {
        const r = (await this.call('config/listremotes', {}, 10_000)) as { remotes?: string[] }
        has = !!r.remotes?.includes(remote)
      } catch {
        return false
      }
      if (!has) {
        await this.kill()
        if (!(await this.up())) return false
      }
      this.known.add(remote)
    }
    return true
  }

  private up(): Promise<boolean> {
    if (this.proc && this.s.running) return Promise.resolve(true)
    if (this.starting) return this.starting
    if (Date.now() < this.retryAt) return Promise.resolve(false)
    this.lastUsed = Date.now() // a stale timestamp would let the idle timer kill the daemon while it is still starting
    this.starting = this.start().finally(() => (this.starting = null))
    return this.starting
  }

  private async start(): Promise<boolean> {
    const cfg = this.o.cloud.cfgArgs()
    const bin = this.o.exec?.cmd ?? toolPath(this.o.rclonePath(), 'rclone')
    try {
      this.port = await freePort()
      const user = 'shotdrop'
      const pass = randomBytes(24).toString('hex')
      this.auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
      const args = [
        ...(this.o.exec?.args ?? []),
        'rcd',
        ...cfg,
        '--rc-addr',
        `127.0.0.1:${this.port}`,
        '--rc-user',
        user,
        '--rc-pass',
        pass,
        '--contimeout',
        '20s',
        '--timeout',
        '2m',
        '--retries',
        '1',
        '--low-level-retries',
        '3'
      ]
      if (this.everStarted) this.s.restarts++
      this.everStarted = true
      const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      this.proc = p
      let tail = ''
      p.stderr?.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)))
      p.once('exit', (code) => {
        if (this.proc === p) {
          this.proc = null
          this.s.running = false
          this.s.port = null
          this.s.pid = null
          this.known.clear()
          if (!this.stopping) {
            this.s.lastError = tail.trim().split('\n').pop() || `rclone rcd exited (${code})`
            this.fail(this.s.lastError)
          }
        }
      })
      p.once('error', (e) => {
        tail = e.message
        if (this.proc === p) this.proc = null
      })
      const deadline = Date.now() + START_TIMEOUT
      for (;;) {
        if (this.proc !== p) throw new Error(tail.trim().split('\n').pop() || 'rclone rcd exited at start')
        try {
          await this.call('rc/noop', {}, 2000, true)
          break
        } catch {
          if (Date.now() > deadline) throw new Error('rclone rcd did not become ready')
          await sleep(150)
        }
      }
      this.s.running = true
      this.s.port = this.port
      this.s.pid = p.pid ?? null
      this.s.lastError = null
      this.failures = 0
      this.known = new Set()
      this.armIdle()
      return true
    } catch (e) {
      this.fail((e as Error).message)
      await this.kill()
      return false
    }
  }

  private fail(msg: string): void {
    this.failures++
    this.s.lastError = msg
    this.retryAt = Date.now() + Math.min(BACKOFF_MIN * 2 ** (this.failures - 1), BACKOFF_MAX)
    if ((/ENOENT/.test(msg) || this.failures >= 5) && !this.s.disabled) {
      this.s.disabled = true
    }
    if (!this.warned) {
      this.warned = true
      this.log(`rclone rcd unavailable (${msg}); using one rclone process per call`)
    }
  }

  private armIdle(): void {
    if (this.idleTimer) return
    const idle = this.o.idleMs ?? IDLE_MS
    this.idleTimer = setInterval(() => {
      if (this.inflight === 0 && !this.starting && Date.now() - this.lastUsed >= idle) void this.kill()
    }, Math.max(50, Math.min(60_000, Math.floor(idle / 4))))
    this.idleTimer.unref()
  }

  /** Call an rc method. Throws DaemonDown if the daemon can't be reached, RcError if rclone reports an error. */
  async rc(method: string, params: Record<string, unknown> = {}, timeoutMs = OP_TIMEOUT): Promise<unknown> {
    this.inflight++
    this.lastUsed = Date.now()
    try {
      return await this.call(method, params, timeoutMs)
    } finally {
      this.inflight--
      this.lastUsed = Date.now()
    }
  }

  private async call(method: string, params: Record<string, unknown>, timeoutMs: number, starting = false): Promise<unknown> {
    if (!starting && !this.s.running) throw new DaemonDown('rclone rcd is not running')
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.auth },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      const err = e as Error & { name?: string; cause?: { code?: string } }
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw Object.assign(new Error(`rclone ${method} timed out`), { code: 'ETIMEDOUT' })
      throw new DaemonDown(err.cause?.code ?? err.message)
    }
    const text = await res.text()
    let body: { error?: string; status?: number } & Record<string, unknown> = {}
    try {
      body = text ? (JSON.parse(text) as typeof body) : {}
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      if (res.status === 401) throw new DaemonDown('rclone rcd rejected our credentials')
      throw new RcError(String(body.error ?? text.trim() ?? `HTTP ${res.status}`).split('\n')[0], res.status)
    }
    return body
  }

  private async kill(): Promise<void> {
    const p = this.proc
    this.proc = null
    this.s.running = false
    this.s.port = null
    this.s.pid = null
    this.known.clear()
    if (!p || p.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill()
        resolve()
      }, 2000)
      p.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      // Ask nicely first, with the port and credentials this process was started with.
      void fetch(`http://127.0.0.1:${this.port}/core/quit`, { method: 'POST', headers: { Authorization: this.auth, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500) }).catch(() => p.kill())
    })
  }

  /** App quit. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    await this.starting?.catch(() => undefined)
    await this.kill()
  }
}
