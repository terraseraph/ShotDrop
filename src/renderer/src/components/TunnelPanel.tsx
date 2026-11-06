import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { Settings, Status } from '@shared/types'
import { api } from '../api'
import { CopyField } from './ConnectionCard'
import { Icon } from './Icon'

interface Props {
  s: Settings
  status: Status | null
  edit: (p: Partial<Settings>) => void
  toast: (t: string, tone?: 'info' | 'error') => void
}

/** One-click public HTTPS link to the remote gallery through a Cloudflare quick tunnel. */
export function TunnelPanel({ s, status, edit, toast }: Props) {
  const t = status?.tunnel
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState<string | null>(null)

  // QR holds the URL only. The PIN is never encoded, so a photographed QR alone doesn't grant access.
  useEffect(() => {
    if (!t?.url || t.status !== 'running') return setQr(null)
    QRCode.toDataURL(t.url, { margin: 1, width: 360, color: { dark: '#0b0b0d', light: '#ececef' } })
      .then(setQr)
      .catch(() => setQr(null))
  }, [t?.url, t?.status])

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const status_ = t?.status ?? 'off'
  const running = status_ === 'running'
  const working = busy || status_ === 'starting' || status_ === 'installing'

  return (
    <section className="panel">
      <div className="row between">
        <h3>Over the internet</h3>
        <span className={`tunnel-state ${status_}`}>
          <span className={`tally ${running ? 'live' : status_ === 'error' ? 'off' : ''}`} />
          {STATE_TEXT[status_]}
        </span>
      </div>
      <p className="muted small">
        Get a public HTTPS link to the gallery through Cloudflare. No account and no router changes. Anyone with the link still needs
        the PIN. The link changes every time the tunnel starts.
      </p>

      {t && !t.installed ? (
        t.installable ? (
          <div className="row tight">
            <button className="btn primary" disabled={working} onClick={() => void run(() => api.tunnelInstall(), 'cloudflared installed')}>
              {status_ === 'installing' ? 'Downloading cloudflared…' : 'Install cloudflared'}
            </button>
            <span className="muted small">About 60 MB, downloaded from Cloudflare's GitHub releases.</span>
          </div>
        ) : (
          <p className="warn-box small">Install cloudflared yourself (e.g. <code>brew install cloudflared</code>), then set its path below.</p>
        )
      ) : (
        <div className="row tight">
          {running || status_ === 'starting' ? (
            <button className="btn" disabled={busy} onClick={() => void run(() => api.tunnelStop())}>
              Stop link
            </button>
          ) : (
            <button className="btn primary" disabled={working} onClick={() => void run(() => api.tunnelStart())}>
              <Icon name="cloud" /> Create public link
            </button>
          )}
        </div>
      )}

      {t?.error && status_ === 'error' && <p className="warn-box small">{t.error}</p>}

      {running && t?.url && (
        <div className="tunnel-live">
          {qr && <img className="tunnel-qr" src={qr} alt="QR code for the public link" />}
          <div className="conn-card">
            <CopyField label="Link" value={t.url} />
            <CopyField label="PIN" value={s.remote.pin} />
            <p className="muted small">Scan with a phone, open the link and enter the PIN.</p>
          </div>
        </div>
      )}

      <div className="row between">
        <span className="small">Start the link when ShotDrop opens</span>
        <SwitchLite checked={s.tunnel.autoStart} onChange={(v) => edit({ tunnel: { ...s.tunnel, autoStart: v } })} />
      </div>
      <label className="field">
        <span className="field-label">cloudflared executable</span>
        <input className="input mono" value={s.tunnel.cloudflaredPath} onChange={(e) => edit({ tunnel: { ...s.tunnel, cloudflaredPath: e.target.value } })} />
        <span className="field-hint">Leave as 'cloudflared' to use the installed copy or the one on your PATH.</span>
      </label>
    </section>
  )
}

const STATE_TEXT: Record<string, string> = {
  off: 'Off',
  installing: 'Installing',
  starting: 'Connecting',
  running: 'Online',
  error: 'Error'
}

function SwitchLite({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  )
}
