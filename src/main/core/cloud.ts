import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { CloudAccount, CloudFolder, CloudLinkOptions, CloudProvider, CloudQuota, CloudState } from '@shared/types'

const TYPES: Record<CloudProvider, string> = { drive: 'drive', dropbox: 'dropbox' }
const LINK_TIMEOUT_MS = 5 * 60_000

/** Run rclone to completion and return stdout; the last stderr line becomes the error message. */
function rclone(bin: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => p.kill(), timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => (clearTimeout(timer), reject(e)))
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(out)
      const lines = err.trim().split('\n')
      reject(new Error(lines.filter((l) => /ERROR|Failed|error/.test(l)).pop() ?? lines.pop() ?? `rclone exit ${code}`))
    })
  })
}

/**
 * Cloud accounts (Google Drive, Dropbox) linked through rclone's OAuth. Everything lives in ShotDrop's own
 * rclone.conf, passed with --config, so the user's personal rclone setup is never read or modified.
 */
export class CloudAccounts {
  private linking: { provider: CloudProvider; authUrl?: string; startedAt: number; proc: ChildProcess; cancelled: boolean } | null = null

  constructor(
    private confPath: string,
    private bin: () => string,
    /** Tests pass true so no browser opens; the sign-in URL is still reported in state(). */
    private noOpenBrowser = false
  ) {}

  cfgArgs = (): string[] => ['--config', this.confPath]
  private cfg = (): string[] => this.cfgArgs()

  /** Is this remote name ours? Used by sync to decide whether to pass --config. */
  has(name: string): boolean {
    return existsSync(this.confPath) && new RegExp(`^\\[${name.replace(/[^\w-]/g, '')}\\]\\s*$`, 'm').test(readFileSync(this.confPath, 'utf8'))
  }

  state(): CloudState {
    const l = this.linking
    return { linking: l ? { provider: l.provider, authUrl: l.authUrl, startedAt: l.startedAt } : null }
  }

  async list(): Promise<CloudAccount[]> {
    if (!existsSync(this.confPath)) return []
    const dump = JSON.parse(await rclone(this.bin(), ['config', 'dump', ...this.cfg()])) as Record<string, Record<string, string>>
    return Object.entries(dump)
      .filter(([, v]) => v.type === 'drive' || v.type === 'dropbox')
      .map(([name, v]) => ({
        name,
        provider: v.type as CloudProvider,
        // Empty scope = full access (rclone's default).
        fullAccess: v.type === 'drive' ? v.scope !== 'drive.file' : true,
        ownClient: !!v.client_id
      }))
  }

  /** Opens the system browser via `rclone authorize`, waits for the token, then stores the remote. */
  async link(provider: CloudProvider, opts: CloudLinkOptions = {}): Promise<CloudAccount> {
    if (this.linking) throw new Error('Another sign-in is already in progress')
    const type = TYPES[provider]
    if (!type) throw new Error('Unknown provider')
    const scope = provider === 'drive' ? (opts.fullAccess ? 'drive' : 'drive.file') : undefined
    const client = opts.clientId && opts.clientSecret ? { client_id: opts.clientId, client_secret: opts.clientSecret } : {}
    const blob = Buffer.from(JSON.stringify({ ...(scope ? { scope } : {}), ...client })).toString('base64url')

    const args = ['authorize', type, ...(Object.keys(client).length || scope ? [blob] : []), ...this.cfg()]
    if (this.noOpenBrowser) args.push('--auth-no-open-browser')
    const proc = spawn(this.bin(), args, { windowsHide: true })
    const link = { provider, startedAt: Date.now(), proc, cancelled: false, authUrl: undefined as string | undefined }
    this.linking = link

    try {
      const token = await new Promise<string>((resolve, reject) => {
        let out = ''
        let err = ''
        const timer = setTimeout(() => (proc.kill(), reject(new Error('Sign-in timed out. Try again.'))), LINK_TIMEOUT_MS)
        proc.stdout.on('data', (d) => {
          out += d
          const m = out.match(/--->\s*([\s\S]*?)\s*<---End paste/)
          if (m) resolve(m[1])
        })
        proc.stderr.on('data', (d) => {
          err += d
          link.authUrl ??= err.match(/https?:\/\/127\.0\.0\.1:\d+\/auth\?state=\S+/)?.[0]
        })
        proc.on('error', (e) => reject(e))
        proc.on('close', () => {
          clearTimeout(timer)
          reject(new Error(link.cancelled ? 'Cancelled' : (err.trim().split('\n').pop() ?? 'Sign-in failed')))
        })
      })
      const parsed = JSON.parse(token) as { access_token?: string }
      if (!parsed.access_token) throw new Error('Sign-in returned no token')

      const name = `${provider === 'drive' ? 'gdrive' : provider}-${randomBytes(2).toString('hex')}`
      await rclone(this.bin(), [
        'config', 'create', name, type,
        ...(scope ? [`scope=${scope}`] : []),
        ...Object.entries(client).map(([k, v]) => `${k}=${v}`),
        `token=${token}`,
        '--non-interactive', // never fall into rclone's own OAuth wizard (hidden browser) if the token is unusable
        ...this.cfg()
      ])
      return { name, provider, fullAccess: scope !== 'drive.file', ownClient: !!opts.clientId }
    } finally {
      proc.kill()
      this.linking = null
    }
  }

  cancelLink(): boolean {
    if (!this.linking) return false
    this.linking.cancelled = true
    this.linking.proc.kill()
    return true
  }

  private async known(name: string): Promise<void> {
    if (!(await this.list()).some((a) => a.name === name)) throw new Error('Unknown account')
  }

  async folders(name: string, path = ''): Promise<CloudFolder[]> {
    await this.known(name)
    const out = await rclone(this.bin(), ['lsjson', '--dirs-only', '--no-modtime', '--no-mimetype', `${name}:${path}`, ...this.cfg()])
    return (JSON.parse(out) as { Name: string }[]).map((e) => ({ name: e.Name })).sort((a, b) => a.name.localeCompare(b.name))
  }

  async mkdir(name: string, path: string): Promise<void> {
    await this.known(name)
    await rclone(this.bin(), ['mkdir', `${name}:${path}`, ...this.cfg()])
  }

  async quota(name: string): Promise<CloudQuota> {
    await this.known(name)
    const out = await rclone(this.bin(), ['about', '--json', `${name}:`, ...this.cfg()])
    return JSON.parse(out) as CloudQuota
  }

  /** Best effort: not every backend/scope can tell us who is signed in. */
  async email(name: string): Promise<string | null> {
    await this.known(name)
    try {
      const info = JSON.parse(await rclone(this.bin(), ['config', 'userinfo', `${name}:`, ...this.cfg()], 20_000)) as Record<string, string>
      return info.Email ?? info.email ?? null
    } catch {
      return null
    }
  }

  async disconnect(name: string): Promise<void> {
    await this.known(name)
    await rclone(this.bin(), ['config', 'delete', name, ...this.cfg()])
  }
}
