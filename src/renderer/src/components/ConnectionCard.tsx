import { useEffect, useState } from 'react'
import type { Settings, Status } from '@shared/types'
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
      {user && <CopyField label="User" value={user.username} />}
      {user && <CopyField label="Password" value={user.password} />}
      <div className="conn-field">
        <span className="conn-label">Mode</span>
        <span className="conn-value">FTP · Passive on · Folder: /</span>
      </div>
      {ftp.addresses.length > 1 && (
        <p className="muted small">Other addresses on this PC: {ftp.addresses.slice(1).join(', ')}. Use the one on the same Wi-Fi as the camera.</p>
      )}
    </div>
  )
}
