import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TunnelState } from '@shared/types'

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'

/** Official single-file cloudflared builds. macOS ships as .tgz, so it's installed with brew instead. */
function assetName(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null
  if (!arch) return null
  if (process.platform === 'win32') return arch === 'amd64' ? 'cloudflared-windows-amd64.exe' : null
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`
  return null
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/**
 * One-click public HTTPS link to the remote gallery via a Cloudflare quick tunnel.
 * No Cloudflare account and no router changes; the URL is random and changes each start.
 * Requests arriving through it carry cf-connecting-ip, so the API demands the PIN.
 */
export class TunnelService {
  private proc: ChildProcess | null = null
  private stopping = false
  state: TunnelState = { status: 'off', url: null, error: null, installed: false, installable: !!assetName() }

  constructor(
    private binDir: string,
    private configuredPath: () => string,
    private onState: () => void
  ) {
    this.state.installed = !!this.resolveBinary()
  }

  private get bundledPath(): string {
    return join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  }

  /** Settings path wins, then our downloaded copy, then whatever is on PATH. */
  private resolveBinary(): string | null {
    const configured = this.configuredPath().trim()
    if (configured && configured !== 'cloudflared') return existsSync(configured) ? configured : null
    if (existsSync(this.bundledPath)) return this.bundledPath
    return onPath() ? 'cloudflared' : null
  }

  async refreshInstalled(): Promise<void> {
    await probePath()
    this.set({ installed: !!this.resolveBinary() })
  }

  async install(): Promise<void> {
    const asset = assetName()
    if (!asset) throw new Error('Automatic install is not available on this platform. Install cloudflared yourself (e.g. brew install cloudflared).')
    this.set({ status: 'installing', error: null })
    try {
      const res = await fetch(RELEASES + asset, { redirect: 'follow' })
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 5_000_000) throw new Error('Download looks incomplete')
      mkdirSync(this.binDir, { recursive: true })
      const tmp = this.bundledPath + '.download'
      await writeFile(tmp, buf)
      if (process.platform !== 'win32') chmodSync(tmp, 0o755)
      rmSync(this.bundledPath, { force: true })
      renameSync(tmp, this.bundledPath)
      this.set({ status: 'off', installed: true })
    } catch (e) {
      this.set({ status: 'error', error: (e as Error).message })
      throw e
    }
  }

  async start(localPort: number): Promise<void> {
    if (this.proc) return
    await probePath()
    const bin = this.resolveBinary()
    if (!bin) {
      this.set({ status: 'error', error: 'cloudflared is not installed', installed: false })
      throw new Error('cloudflared is not installed')
    }
    this.stopping = false
    this.set({ status: 'starting', url: null, error: null, installed: true })

    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`], { windowsHide: true })
    this.proc = proc
    let log = ''

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => fail(new Error('Timed out waiting for Cloudflare to assign a URL')), 45_000)
      const fail = (e: Error): void => {
        clearTimeout(timeout)
        this.kill()
        this.set({ status: 'error', url: null, error: e.message })
        reject(e)
      }
      const onData = (d: Buffer): void => {
        const text = d.toString()
        log = (log + text).slice(-4000)
        const m = text.match(URL_RE)
        if (m && this.state.status === 'starting') {
          // The URL is printed before the edge connection is up; wait for "Registered tunnel connection".
          this.state.url = m[0]
        }
        if (this.state.url && /Registered tunnel connection|Connection [a-f0-9-]+ registered/i.test(text) && this.state.status === 'starting') {
          clearTimeout(timeout)
          this.set({ status: 'running' })
          resolve()
        }
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      proc.on('error', (e) => fail(e))
      proc.on('exit', (code) => {
        this.proc = null
        if (this.stopping) return
        const last = log.trim().split('\n').filter((l) => /ERR|error|failed/i.test(l)).pop()
        const err = new Error(last?.replace(/^\S+\s+ERR\s+/, '') || `cloudflared exited (${code})`)
        if (this.state.status === 'starting') fail(err)
        else this.set({ status: 'error', url: null, error: err.message })
      })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.kill()
    this.set({ status: 'off', url: null, error: null })
  }

  private kill(): void {
    if (!this.proc) return
    this.proc.kill()
    this.proc = null
  }

  private set(patch: Partial<TunnelState>): void {
    this.state = { ...this.state, ...patch }
    this.onState()
  }
}

let onPathCache: boolean | null = null
const onPath = (): boolean => onPathCache === true

/** Checks once whether `cloudflared` runs from PATH. */
function probePath(): Promise<void> {
  if (onPathCache !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const p = spawn('cloudflared', ['--version'], { windowsHide: true })
    p.on('error', () => {
      onPathCache = false
      resolve()
    })
    p.on('exit', (code) => {
      onPathCache = code === 0
      resolve()
    })
  })
}
