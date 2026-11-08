import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LibraryMeta } from '@shared/remote'
import type { CloudAccount, CloudFolder, CloudLinkOptions, CloudProvider, CloudQuota, CloudState } from '@shared/types'

const TYPES: Record<CloudProvider, string> = { drive: 'drive', dropbox: 'dropbox' }
const LINK_TIMEOUT_MS = 5 * 60_000

/**
 * ShotDrop's own Google client, so Drive sign-in doesn't depend on rclone's shared client_id (being retired in 2026).
 * Set in .env as MAIN_VITE_GOOGLE_CLIENT_ID / MAIN_VITE_GOOGLE_CLIENT_SECRET. A desktop client's secret is not
 * confidential per Google, but it stays out of git anyway. Unset = fall back to rclone's shared client.
 */
const GOOGLE = {
  clientId: import.meta.env?.MAIN_VITE_GOOGLE_CLIENT_ID ?? process.env.SHOTDROP_GOOGLE_CLIENT_ID ?? '',
  clientSecret: import.meta.env?.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? process.env.SHOTDROP_GOOGLE_CLIENT_SECRET ?? ''
}

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
 * The token JSON from `rclone authorize` output. Older rclone printed it as-is; v1.7x prints base64url of
 * {"client_id","client_secret","token":"<token JSON>"}.
 */
export function readAuthorizeToken(pasted: string): string {
  const raw = pasted.trim()
  if (raw.startsWith('{')) return raw
  try {
    const wrapped = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { token?: unknown }
    if (typeof wrapped.token === 'string') return wrapped.token
  } catch {
    /* fall through */
  }
  throw new Error("Couldn't read the sign-in token from rclone")
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

  /** Called after the config gains or loses a remote, so a running rclone daemon drops what it cached. */
  onConfigChanged?: () => void

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
        ownClient: !!v.client_id && v.client_id !== GOOGLE.clientId
      }))
  }

  /** Opens the system browser via `rclone authorize`, waits for the token, then stores the remote. */
  async link(provider: CloudProvider, opts: CloudLinkOptions = {}): Promise<CloudAccount> {
    if (this.linking) throw new Error('Another sign-in is already in progress')
    const type = TYPES[provider]
    if (!type) throw new Error('Unknown provider')
    const scope = provider === 'drive' ? (opts.fullAccess ? 'drive' : 'drive.file') : undefined
    const builtIn = provider === 'drive' && GOOGLE.clientId && GOOGLE.clientSecret ? { client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret } : {}
    const client = opts.clientId && opts.clientSecret ? { client_id: opts.clientId, client_secret: opts.clientSecret } : builtIn
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
          if (!m) return
          try {
            resolve(readAuthorizeToken(m[1]))
          } catch (e) {
            reject(e)
          }
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
      this.onConfigChanged?.()
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
    this.onConfigChanged?.()
  }
}

// ---- <destination root>/.shotdrop/library.json ----

const LIBRARY_FILE = '.shotdrop/library.json'
export const newLibraryId = (): string => `lib_${randomBytes(4).toString('hex')}`

export interface LibraryDest { type: 'folder' | 'rclone'; target: string }
/** How to reach rclone for a destination: binary plus `--config` only when the remote is one ShotDrop linked itself. */
export interface LibraryRc { bin: string; cfg: string[] }

function parseLibrary(raw: string): LibraryMeta | null {
  try {
    const j = JSON.parse(raw) as Partial<LibraryMeta>
    if (j.schema !== 1 || typeof j.libraryId !== 'string' || !j.libraryId) return null
    const writers = Array.isArray(j.writers) ? j.writers.filter((w) => w && typeof w.host === 'string' && typeof w.lastSync === 'number') : []
    return { ...j, schema: 1, libraryId: j.libraryId, name: typeof j.name === 'string' ? j.name : '', writers }
  } catch {
    return null
  }
}

const remoteLibraryPath = (target: string): string => {
  if (target.startsWith('-')) throw new Error('Invalid destination')
  return `${target.replace(/\/+$/, '')}/${LIBRARY_FILE}`
}

/**
 * Read library.json. Resolves null when the destination is reachable but has none (or an unreadable one);
 * rejects when the destination itself can't be reached.
 */
export async function readLibraryMeta(dest: LibraryDest, rc: LibraryRc): Promise<LibraryMeta | null> {
  if (dest.type === 'folder') {
    await stat(dest.target) // throws when the drive or share is gone
    return parseLibrary(await readFile(join(dest.target, '.shotdrop', 'library.json'), 'utf8').catch(() => ''))
  }
  try {
    return parseLibrary(await rclone(rc.bin, ['cat', remoteLibraryPath(dest.target), ...rc.cfg], 30_000))
  } catch (e) {
    if (/not found|doesn't exist|directory not found|object not found/i.test((e as Error).message)) return null
    throw e
  }
}

export async function writeLibraryMeta(dest: LibraryDest, rc: LibraryRc, meta: LibraryMeta): Promise<void> {
  const body = JSON.stringify(meta, null, 2)
  if (dest.type === 'folder') {
    await stat(dest.target) // never recreate a missing root on the wrong disk
    const dir = join(dest.target, '.shotdrop')
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, 'library.json.shotdrop-part')
    writeFileSync(tmp, body)
    renameSync(tmp, join(dir, 'library.json'))
    return
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'shotdrop-lib-'))
  try {
    const tmp = join(tmpDir, 'library.json')
    writeFileSync(tmp, body)
    await rclone(rc.bin, ['copyto', tmp, remoteLibraryPath(dest.target), ...rc.cfg], 60_000)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Make sure the destination carries our library.json and that this host is listed in writers[].
 * Another library's file is left alone (the caller warns, never blocks). `touched` limits the writers[] update to
 * once per app start per destination. Returns what is on the destination afterwards.
 */
export async function ensureLibraryMeta(
  dest: LibraryDest & { id: string },
  rc: LibraryRc,
  opts: { libraryId: string; host: string; touched: Set<string> }
): Promise<LibraryMeta | null> {
  const existing = await readLibraryMeta(dest, rc)
  if (existing && existing.libraryId !== opts.libraryId) return existing
  if (existing && opts.touched.has(dest.id)) return existing
  const writers = [...(existing?.writers ?? []).filter((w) => w.host !== opts.host), { host: opts.host, lastSync: Date.now() }]
  const meta: LibraryMeta = { ...(existing ?? {}), schema: 1, libraryId: opts.libraryId, name: existing?.name || `${opts.host} library`, writers }
  await writeLibraryMeta(dest, rc, meta)
  opts.touched.add(dest.id)
  return meta
}
