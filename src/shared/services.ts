/**
 * Storage services the Add destination sheet can set up without the user touching `rclone config`.
 * Shared so the sheet renders the same fields the main process turns into an rclone remote.
 */

export type ServiceId = 's3' | 'b2' | 'r2' | 'wasabi' | 's3other' | 'sftp' | 'ftp' | 'webdav'
export type ServiceGroup = 'storage' | 'server'

export interface ServiceField {
  key: string
  label: string
  kind: 'text' | 'secret' | 'number' | 'select' | 'toggle'
  placeholder?: string
  default?: string
  options?: { value: string; label: string }[]
  optional?: boolean
  hint?: string
}

export interface ServiceDef {
  id: ServiceId
  label: string
  group: ServiceGroup
  blurb: string
  /** Two-letter badge and its colours for the picker and the Sync board tile. */
  badge: string
  fg: string
  bg: string
  /** rclone backend, for reading remotes back out of the config. */
  type: 's3' | 'b2' | 'sftp' | 'ftp' | 'webdav'
  /** For s3 remotes: the rclone provider value that marks this service. */
  s3Provider?: string
  fields: ServiceField[]
  /** Shown above the fields: where the user gets what they need. */
  help?: string
  /** Accepts a pasted key block (B2 "Add application key" text, AWS access key CSV). */
  paste?: boolean
}

const AWS_REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-south-1', 'sa-east-1']
const WASABI_REGIONS = ['us-east-1', 'us-east-2', 'us-central-1', 'us-west-1', 'ca-central-1', 'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2']
const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }))

const keyId: ServiceField = { key: 'accessKeyId', label: 'Access key ID', kind: 'text' }
const secret: ServiceField = { key: 'secretAccessKey', label: 'Secret access key', kind: 'secret' }

export const SERVICES: ServiceDef[] = [
  {
    id: 's3', label: 'Amazon S3', group: 'storage', blurb: 'Any region', badge: 'S3', fg: '#ff9900', bg: '#2b2111', type: 's3', s3Provider: 'AWS', paste: true,
    help: 'In the AWS console: IAM → Users → Security credentials → Create access key.',
    fields: [keyId, secret, { key: 'region', label: 'Region', kind: 'select', default: 'us-east-1', options: opts(AWS_REGIONS) }]
  },
  {
    id: 'b2', label: 'Backblaze B2', group: 'storage', blurb: 'Low-cost archive', badge: 'B2', fg: '#e5484d', bg: '#2b1414', type: 'b2', paste: true,
    help: 'In Backblaze: Application Keys → Add a New Application Key, then paste the text it shows.',
    fields: [{ key: 'keyId', label: 'keyID', kind: 'text' }, { key: 'applicationKey', label: 'applicationKey', kind: 'secret' }]
  },
  {
    id: 'r2', label: 'Cloudflare R2', group: 'storage', blurb: 'No egress fees', badge: 'R2', fg: '#f48120', bg: '#2b1d11', type: 's3', s3Provider: 'Cloudflare', paste: true,
    help: 'In Cloudflare: R2 → Manage API tokens → Create token. The account ID is on the R2 overview page.',
    fields: [{ key: 'accountId', label: 'Account ID', kind: 'text', placeholder: '32 hex characters' }, keyId, secret]
  },
  {
    id: 'wasabi', label: 'Wasabi', group: 'storage', blurb: 'Flat price', badge: 'W', fg: '#3bb3e0', bg: '#13242b', type: 's3', s3Provider: 'Wasabi', paste: true,
    help: 'In Wasabi: Access Keys → Create new access key.',
    fields: [keyId, secret, { key: 'region', label: 'Region', kind: 'select', default: 'us-east-1', options: opts(WASABI_REGIONS) }]
  },
  {
    id: 's3other', label: 'Other S3', group: 'storage', blurb: 'MinIO, Storj, IDrive…', badge: 'S3', fg: '#a3a3a3', bg: '#242424', type: 's3', s3Provider: 'Other', paste: true,
    fields: [
      { key: 'endpoint', label: 'Endpoint', kind: 'text', placeholder: 's3.example.com' },
      keyId, secret,
      { key: 'region', label: 'Region', kind: 'text', optional: true, placeholder: 'leave empty if unsure' }
    ]
  },
  {
    id: 'sftp', label: 'SFTP', group: 'server', blurb: 'NAS, VPS, Pi', badge: '⇅', fg: '#5ba7f7', bg: '#1b2330', type: 'sftp',
    fields: [
      { key: 'host', label: 'Host', kind: 'text', placeholder: 'nas.local or 10.0.0.20' },
      { key: 'port', label: 'Port', kind: 'number', default: '22' },
      { key: 'user', label: 'User', kind: 'text' },
      { key: 'auth', label: 'Sign in with', kind: 'select', default: 'password', options: [{ value: 'password', label: 'Password' }, { value: 'key', label: 'SSH key' }] },
      { key: 'pass', label: 'Password', kind: 'secret', optional: true },
      { key: 'keyFile', label: 'SSH key file', kind: 'text', optional: true, placeholder: '~/.ssh/id_ed25519' }
    ]
  },
  {
    id: 'ftp', label: 'FTP / FTPS', group: 'server', blurb: 'Hosting, routers', badge: 'FTP', fg: '#5ba7f7', bg: '#1b2330', type: 'ftp',
    fields: [
      { key: 'host', label: 'Host', kind: 'text', placeholder: 'ftp.example.com' },
      { key: 'port', label: 'Port', kind: 'number', default: '21' },
      { key: 'user', label: 'User', kind: 'text' },
      { key: 'pass', label: 'Password', kind: 'secret' },
      { key: 'tls', label: 'Encrypted (FTPS)', kind: 'toggle', default: 'true', hint: 'Turn off only for old servers that refuse encryption.' }
    ]
  },
  {
    id: 'webdav', label: 'WebDAV', group: 'server', blurb: 'Nextcloud, ownCloud', badge: '◎', fg: '#5ba7f7', bg: '#1b2330', type: 'webdav',
    fields: [
      { key: 'vendor', label: 'Server', kind: 'select', default: 'nextcloud', options: [{ value: 'nextcloud', label: 'Nextcloud' }, { value: 'owncloud', label: 'ownCloud' }, { value: 'other', label: 'Other' }] },
      { key: 'url', label: 'Address', kind: 'text', placeholder: 'https://cloud.example.com' },
      { key: 'user', label: 'User', kind: 'text' },
      { key: 'pass', label: 'App password', kind: 'secret', hint: 'Make one under Settings → Security, so your main password stays private.' }
    ]
  }
]

export const serviceById = (id: string): ServiceDef | undefined => SERVICES.find((s) => s.id === id)

/** Which service a remote in the config is, from its rclone type and provider. */
export function serviceOf(conf: Record<string, string>): ServiceDef | undefined {
  if (conf.type === 's3') return SERVICES.find((s) => s.type === 's3' && s.s3Provider === conf.provider) ?? serviceById('s3other')
  return SERVICES.find((s) => s.type === conf.type)
}

/** Field values with defaults filled in. */
export function withDefaults(def: ServiceDef, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of def.fields) out[f.key] = (values[f.key] ?? '').trim() || f.default || ''
  return out
}

/** Fields still missing before Connect can run. */
export function missing(def: ServiceDef, values: Record<string, string>): string[] {
  const v = withDefaults(def, values)
  return def.fields.filter((f) => {
    if (f.optional || f.kind === 'toggle') return false
    if (def.id === 'sftp' && f.key === 'pass') return false
    return !v[f.key]
  }).map((f) => f.label).concat(def.id === 'sftp' && v.auth === 'password' && !v.pass ? ['Password'] : [], def.id === 'sftp' && v.auth === 'key' && !v.keyFile ? ['SSH key file'] : [])
}

/**
 * Pull key ID and secret out of a pasted block: Backblaze's "keyID: … applicationKey: …" text, an AWS access key CSV,
 * or two bare tokens on separate lines. Returns only what it recognised.
 */
export function parseKeyBlock(def: ServiceDef, text: string): Record<string, string> {
  const t = text.trim()
  const pick = (re: RegExp): string | undefined => re.exec(t)?.[1]?.trim()
  const id = pick(/key\s*ID\s*[:=]\s*(\S+)/i) ?? pick(/access[_\s]*key[_\s]*id\s*[:=]\s*(\S+)/i)
  const key = pick(/application\s*Key\s*[:=]\s*(\S+)/i) ?? pick(/secret[_\s]*access[_\s]*key\s*[:=]\s*(\S+)/i)
  let pair: [string, string] | null = id && key ? [id, key] : null
  if (!pair) {
    // AWS CSV: header row then "AKIA…,secret"
    const csv = t.split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim())).find((c) => c.length >= 2 && /^[A-Z0-9]{16,}$/.test(c[c.length - 2]))
    if (csv) pair = [csv[csv.length - 2], csv[csv.length - 1]]
  }
  if (!pair) {
    const tokens = t.split(/\s+/).filter((x) => x.length >= 16 && !/[:=]$/.test(x))
    if (tokens.length === 2) pair = [tokens[0], tokens[1]]
  }
  if (!pair) return {}
  return def.id === 'b2' ? { keyId: pair[0], applicationKey: pair[1] } : { accessKeyId: pair[0], secretAccessKey: pair[1] }
}

/** Nextcloud and ownCloud want their DAV path; people type the address they see in the browser. */
export function webdavUrl(vendor: string, url: string, user: string): string {
  let base = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`
  if (/\/remote\.php\//i.test(base)) return base
  if (vendor === 'nextcloud') return `${base}/remote.php/dav/files/${encodeURIComponent(user)}`
  if (vendor === 'owncloud') return `${base}/remote.php/webdav`
  return base
}

/** Turn rclone's last error line into something a photographer can act on. */
export function friendlyRemoteError(raw: string): { title: string; fix: string } {
  const m = raw.toLowerCase()
  // Order matters: an SSH login failure also says "handshake failed", so logins are checked before encryption.
  if (/not for this server/.test(m)) return { title: "That server key doesn't belong to this server", fix: 'Test the connection again so ShotDrop can read the key from the server itself.' }
  if (/knownhosts|key mismatch|host key/.test(m)) return { title: "The server's identity changed", fix: 'If you reinstalled the server this is expected. Otherwise, check you are on the right network before trusting it again.' }
  if (/unable to authenticate|permission denied|login incorrect|\b530\b|\b401\b|unauthorized|invalidaccesskeyid|signaturedoesnotmatch|bad_auth|\b403\b|forbidden|accessdenied|access denied/.test(m)) {
    return { title: "The login didn't work", fix: 'Check the user name and password or key. Capital letters matter.' }
  }
  // FTP servers without TLS answer AUTH TLS with 5xx before any login happens.
  if (/failed to make ftp connection.*\b(500|502|504|534|550)\b/.test(m)) return { title: "This server doesn't offer encryption", fix: 'Turn off "Encrypted (FTPS)" if the server is on your own network. Over the internet, plain FTP sends your password unprotected.' }
  if (/x509|certificate|tls|ssl/.test(m)) return { title: "Encryption didn't match", fix: 'Turn encryption off only if the server is old and on your own network; otherwise check the address.' }
  if (/no such host|lookup .* on|name resolution|getaddrinfo/.test(m)) return { title: "Couldn't find that server", fix: 'Check the spelling of the address, or use its IP address.' }
  if (/connection refused|i\/o timeout|timed out|deadline|unreachable|no route|connectex/.test(m)) return { title: "Couldn't reach the server", fix: 'Check the server is switched on and on this network, and that the port is right.' }
  if (/no such bucket|nosuchbucket|bucket .* not found/.test(m)) return { title: "That bucket doesn't exist", fix: 'Pick one from the list, or create it first.' }
  if (/no such file|not found|directory not found/.test(m)) return { title: "That folder doesn't exist", fix: 'Pick a folder from the list, or create one.' }
  return { title: "Couldn't connect", fix: raw.replace(/^[\d/: ]*(?:ERROR|CRITICAL|NOTICE)\s*:\s*/, '').slice(0, 300) }
}

export interface RemoteAccount {
  name: string // rclone remote name in ShotDrop's rclone.conf, e.g. "sftp-a1b2"
  service: ServiceId
  /** Host, endpoint or account, for the account row and the Sync board. */
  where: string
  /** SFTP remote that connected without a pinned host key (ssh-keyscan unavailable). */
  unpinned?: boolean
}

export interface ExternalRemote {
  name: string // in the user's own rclone config
  type: string
}

export type ConnectResult =
  | { ok: true; account: RemoteAccount }
  | { ok: false; needsTrust: { fingerprint: string; keyType: string; hostKey: string } }
