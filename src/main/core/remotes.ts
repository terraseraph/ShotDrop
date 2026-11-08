import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { webdavUrl, type ServiceDef } from '@shared/services'

/** rclone backend and its options for one of the guided services. Values come in with defaults already applied. */
export function buildRemote(def: ServiceDef, v: Record<string, string>, knownHostsFile?: string): { type: string; params: Record<string, string> } {
  switch (def.id) {
    case 's3':
      return { type: 's3', params: { provider: 'AWS', env_auth: 'false', access_key_id: v.accessKeyId, secret_access_key: v.secretAccessKey, region: v.region } }
    case 'wasabi':
      return { type: 's3', params: { provider: 'Wasabi', env_auth: 'false', access_key_id: v.accessKeyId, secret_access_key: v.secretAccessKey, region: v.region, endpoint: `s3.${v.region}.wasabisys.com` } }
    case 'r2':
      // Tokens scoped to one bucket can't check or create buckets, so don't try.
      return { type: 's3', params: { provider: 'Cloudflare', env_auth: 'false', access_key_id: v.accessKeyId, secret_access_key: v.secretAccessKey, region: 'auto', endpoint: `https://${v.accountId.trim()}.r2.cloudflarestorage.com`, no_check_bucket: 'true' } }
    case 's3other':
      return { type: 's3', params: { provider: 'Other', env_auth: 'false', access_key_id: v.accessKeyId, secret_access_key: v.secretAccessKey, endpoint: v.endpoint, ...(v.region ? { region: v.region } : {}) } }
    case 'b2':
      return { type: 'b2', params: { account: v.keyId, key: v.applicationKey } }
    case 'sftp': {
      const auth: Record<string, string> = v.auth === 'key' ? { key_file: expandHome(v.keyFile) } : { pass: v.pass }
      return { type: 'sftp', params: { host: v.host, port: v.port || '22', user: v.user, ...auth, ...(knownHostsFile ? { known_hosts_file: knownHostsFile } : {}) } }
    }
    case 'ftp':
      return { type: 'ftp', params: { host: v.host, port: v.port || '21', user: v.user, pass: v.pass, explicit_tls: v.tls === 'false' ? 'false' : 'true' } }
    case 'webdav':
      return { type: 'webdav', params: { url: webdavUrl(v.vendor, v.url, v.user), vendor: v.vendor, user: v.user, pass: v.pass } }
  }
}

/** Short "where" for a remote's config section: host, endpoint or region. */
export function whereOf(conf: Record<string, string>): string {
  if (conf.host) return conf.user ? `${conf.user}@${conf.host}` : conf.host
  if (conf.url) return conf.url.replace(/^https?:\/\//, '').split('/')[0]
  if (conf.endpoint) return conf.endpoint.replace(/^https?:\/\//, '').split('/')[0]
  if (conf.type === 'b2') return 'Backblaze B2'
  return conf.region ? `AWS · ${conf.region}` : conf.type
}

export const expandHome = (p: string): string => p.trim().replace(/^~(?=$|[\\/])/, homedir())

/** Name for a new remote: service plus a short random suffix, like gdrive-a1b2. */
export const remoteName = (service: string, hex: string): string => `${service}-${hex}`

const KEY_PREFERENCE = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']

function keyscanBin(): string {
  const win = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keyscan.exe')
  return process.platform === 'win32' && existsSync(win) ? win : 'ssh-keyscan'
}

/** The host part of a known_hosts line for host:port, as OpenSSH writes it. */
export const knownHostName = (host: string, port: number): string => (port === 22 ? host : `[${host}]:${port}`)

/** Are these well-formed known_hosts lines, all for exactly this host? Guards what the client sends back on "Trust". */
export function validHostKey(lines: string, host: string, port: number): boolean {
  const rows = lines.trim().split(/\r?\n/)
  return rows.length > 0 && rows.length <= KEY_PREFERENCE.length && rows.every((line) => {
    const parts = line.trim().split(/\s+/)
    return parts.length === 3 && parts[0] === knownHostName(host, port) && KEY_PREFERENCE.includes(parts[1]) && /^[A-Za-z0-9+/]+=*$/.test(parts[2])
  })
}

export const fingerprint = (b64: string): string => `SHA256:${createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')}`

/**
 * Ask the server for its host key (ssh-keyscan), so the user can confirm it before we connect. Resolves null when keyscan
 * isn't available or the server didn't answer it; the connection test then reports the real problem.
 */
export function scanHostKey(host: string, port: number): Promise<{ fingerprint: string; keyType: string; hostKey: string } | null> {
  return new Promise((resolve) => {
    let out = ''
    let p: ChildProcess
    try {
      p = spawn(keyscanBin(), ['-T', '6', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host], { windowsHide: true })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => p.kill(), 10_000)
    p.stdout?.on('data', (d) => (out += d))
    p.on('error', () => (clearTimeout(timer), resolve(null)))
    p.on('close', () => {
      clearTimeout(timer)
      const lines = out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((x) => x.length === 3 && !x[0].startsWith('#'))
      lines.sort((a, b) => KEY_PREFERENCE.indexOf(a[1]) - KEY_PREFERENCE.indexOf(b[1]))
      const keys = lines.filter((x) => KEY_PREFERENCE.includes(x[1]))
      if (!keys.length) return resolve(null)
      // Pin every key the server offered: rclone's SSH client may negotiate a different type than the one we show.
      // Stored under the name rclone will look up, whatever keyscan printed.
      const hostKey = [...new Map(keys.map((k) => [k[1], `${knownHostName(host, port)} ${k[1]} ${k[2]}`])).values()].join('\n')
      resolve({ fingerprint: fingerprint(keys[0][2]), keyType: keys[0][1].replace(/^ssh-|-sha2-nistp\d+$/g, ''), hostKey })
    })
  })
}
