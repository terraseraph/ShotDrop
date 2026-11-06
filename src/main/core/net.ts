import { networkInterfaces } from 'node:os'

const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|Loopback|Tailscale|ZeroTier|WireGuard|^wg-|^wg\d|vboxnet|utun|bridge)/i

/** VPN / VM / container adapters a camera can't reach. */
export const isVirtualAdapter = (name: string): boolean => VIRTUAL.test(name)

/** Private IPv4 addresses of this machine, real adapters first. Shown to the user as the camera's FTP host. */
export function lanAddresses(): string[] {
  const out: { addr: string; virtual: boolean }[] = []
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      out.push({ addr: i.address, virtual: VIRTUAL.test(name) })
    }
  }
  const isPrivate = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)
  return out
    .sort((a, b) => Number(a.virtual) - Number(b.virtual) || Number(isPrivate(b.addr)) - Number(isPrivate(a.addr)))
    .map((o) => o.addr)
}

/** Pick the local address on the same /24 as the client, so PASV replies work on multi-adapter machines. */
export function addressFacing(clientIp: string): string {
  const ip = clientIp.replace(/^::ffff:/, '')
  if (ip === '127.0.0.1' || ip === '::1') return '127.0.0.1'
  const addrs = lanAddresses()
  const prefix = ip.split('.').slice(0, 3).join('.')
  return addrs.find((a) => a.startsWith(prefix + '.')) ?? addrs[0] ?? '127.0.0.1'
}
