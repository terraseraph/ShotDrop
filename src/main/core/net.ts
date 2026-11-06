import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import type { NetInterface } from '@shared/types'

const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|Loopback|Tailscale|ZeroTier|WireGuard|^wg-|^wg\d|vboxnet|utun|bridge)/i
const WIFI = /(wi-?fi|wlan|wireless|802\.11|^wl)/i

/** VPN / VM / container adapters a camera can't reach. */
export const isVirtualAdapter = (name: string): boolean => VIRTUAL.test(name)

/** Windows-only extra text per adapter (InterfaceDescription + media type) so "Ethernet 2" can be told from a Wi-Fi dongle. */
let details = new Map<string, string>()
let detailsAt = 0

/** Refresh the adapter descriptions in the background; classification uses the last result. */
export function refreshAdapterDetails(): void {
  if (process.platform !== 'win32' || Date.now() - detailsAt < 30_000) return
  detailsAt = Date.now()
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapter | ForEach-Object { $_.Name + "|" + $_.InterfaceDescription + " " + $_.PhysicalMediaType }'],
    { timeout: 8000, windowsHide: true },
    (err, out) => {
      if (err) return
      details = new Map(out.split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf('|')), l.slice(l.indexOf('|') + 1)]))
    }
  )
}

function kindOf(name: string): NetInterface['kind'] {
  const text = `${name} ${details.get(name) ?? ''}`
  if (VIRTUAL.test(text)) return 'vpn-virtual'
  if (WIFI.test(text)) return 'wifi'
  if (/(ethernet|^eth|^en\d|^eno|^enp)/i.test(text)) return 'ethernet'
  return 'other'
}

const isPrivate = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)

/**
 * Every non-internal IPv4 address with its adapter. The preferred one (if still present) comes first;
 * otherwise real adapters beat VPN/virtual ones and private ranges beat public.
 */
export function listInterfaces(preferred: string | null = null): NetInterface[] {
  refreshAdapterDetails()
  const out: NetInterface[] = []
  for (const [adapter, infos] of Object.entries(networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ address: i.address, adapter, kind: kindOf(adapter), preferred: i.address === preferred })
    }
  }
  const rank = (o: NetInterface): number => Number(o.kind === 'vpn-virtual') * 2 + Number(!isPrivate(o.address))
  return out.sort((a, b) => Number(b.preferred) - Number(a.preferred) || rank(a) - rank(b))
}

/** Addresses in display order (preferred first). */
export const lanAddresses = (preferred: string | null = null): string[] => listInterfaces(preferred).map((o) => o.address)

/** Pick the local address on the same /24 as the client, so PASV replies work on multi-adapter machines; else the preferred one. */
export function addressFacing(clientIp: string, preferred: string | null = null): string {
  const ip = clientIp.replace(/^::ffff:/, '')
  if (ip === '127.0.0.1' || ip === '::1') return '127.0.0.1'
  const addrs = lanAddresses(preferred)
  const prefix = ip.split('.').slice(0, 3).join('.')
  return addrs.find((a) => a.startsWith(prefix + '.')) ?? addrs[0] ?? '127.0.0.1'
}
