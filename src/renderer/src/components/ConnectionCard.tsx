import { useEffect, useState } from 'react'
import { ftpLoginName, type NetInterface, type Settings, type Status } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'

export function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="conn-field">
      <span className="conn-label">{label}</span>
      <span className={`conn-value ${mono ? 'mono' : ''}`}>{value}</span>
      <button
        className="icon-btn small"
        title={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  )
}

const KIND: Record<NetInterface['kind'], string> = { wifi: 'Wi-Fi', ethernet: 'Ethernet', 'vpn-virtual': 'VPN / virtual', other: 'Other' }

/** Every address on this PC with its adapter; the first is what cameras are told to use. */
export function AddressPicker({ ftp }: { ftp: Status['ftp'] }) {
  const [saving, setSaving] = useState(false)
  const choose = (address: string | null): void => {
    setSaving(true)
    // The server merges `ftp` shallowly, so the partial patch is safe.
    api.patchSettings({ ftp: { preferredAddress: address } } as Partial<Settings>).finally(() => setSaving(false))
  }
  const missing = ftp.preferredMissing
  if (!ftp.interfaces.length && !missing) return null
  return (
    <div className="addr-picker">
      {missing && (
        <p className="addr-notice">
          Your chosen address {missing} isn't on this PC any more (the network probably changed), so ShotDrop is using {ftp.addresses[0] ?? 'another address'}. Pick a new one below
          <button className="link-btn" disabled={saving} onClick={() => choose(null)}> or go back to automatic</button>.
        </p>
      )}
      {ftp.interfaces.length > 1 && <p className="muted small">This PC has {ftp.interfaces.length} network addresses. Choose the one on the same network as the camera.</p>}
      <ul>
        {ftp.interfaces.map((i, idx) => (
          <li key={i.address} className={idx === 0 ? 'active' : ''}>
            <span className="mono">{i.address}</span>
            <span className="muted small">{i.adapter} · {KIND[i.kind]}</span>
            {i.kind === 'vpn-virtual' && <span className="addr-badge">{/tailscale|wireguard|^wg|zerotier/i.test(i.adapter) ? 'VPN' : 'Virtual'}</span>}
            {i.preferred ? <span className="addr-badge ok">Your choice</span> : (
              <button className="link-btn" disabled={saving} onClick={() => choose(i.address)}>Use this one</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The details a photographer types into the camera's FTP menu, in big readable text. */
export function ConnectionCard({ status }: { status: Status | null }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    api.settings().then(setSettings).catch(() => undefined)
  }, [status?.ftp.port])

  const ftp = status?.ftp
  const user = settings?.ftp.users[0]

  if (!ftp?.running) {
    return (
      <div className="conn-card off">
        <p>{ftp?.error ? `FTP server error: ${ftp.error}` : 'The FTP server is off. Turn it on in Settings → Camera.'}</p>
      </div>
    )
  }

  return (
    <div className="conn-card">
      <CopyField label="Server / Host" value={ftp.addresses[0] ?? 'No network found'} />
      <CopyField label="Port" value={String(ftp.port)} />
      {user && <CopyField label="User" value={ftpLoginName(user)} />}
      {user && (user.username && user.password
        ? <CopyField label="Password" value={user.password} />
        : <div className="conn-field"><span className="conn-label">Password</span><span className="conn-value">{user.username ? 'Any (none set)' : 'None · anonymous login'}</span></div>)}
      <div className="conn-field">
        <span className="conn-label">Mode</span>
        <span className="conn-value">FTP · Passive on · Folder: /</span>
      </div>
      <AddressPicker ftp={ftp} />
    </div>
  )
}
