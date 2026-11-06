import { useEffect, useState } from 'react'
import type { Settings, Status } from '@shared/types'
import { api } from '../api'
import { PhoneLink } from './PhoneLink'

/** LAN address (first of ftp.addresses, the user's chosen one) + API port. Null when the machine has no network address. */
export const lanUrl = (status: Status | null): string | null =>
  status?.ftp.addresses[0] ? `http://${status.ftp.addresses[0]}:${status.api.port}` : null

export function ViewOnPhone({ status, onClose }: { status: Status | null; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [tab, setTab] = useState<'lan' | 'net'>('lan')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.settings().then(setS).catch((e: Error) => setErr(e.message))
  }, [])

  const tunnel = status?.tunnel.status === 'running' ? status.tunnel.url : null
  const lan = lanUrl(status)
  const remoteOn = !!status?.api.remote

  const enable = async (): Promise<void> => {
    if (!s) return
    setBusy(true)
    try {
      setS(await api.patchSettings({ remote: { ...s.remote, enabled: true } }))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal phone-modal" role="dialog" aria-label="View on phone" onClick={(e) => e.stopPropagation()}>
        <h2>View on phone</h2>
        {tunnel && (
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={tab === 'lan'} className={tab === 'lan' ? 'on' : ''} onClick={() => setTab('lan')}>Same Wi-Fi</button>
            <button role="tab" aria-selected={tab === 'net'} className={tab === 'net' ? 'on' : ''} onClick={() => setTab('net')}>Internet</button>
          </div>
        )}
        {err && <p className="warn-box small">{err}</p>}
        {tab === 'net' && tunnel && s ? (
          <PhoneLink url={tunnel} pin={s.remote.pin} />
        ) : !remoteOn ? (
          <>
            <p className="muted small">Remote access is off. Turn it on to open the gallery from a phone on this network.</p>
            <button className="btn primary" disabled={busy || !s} onClick={() => void enable()}>Turn on remote access</button>
          </>
        ) : !lan ? (
          <p className="muted small">No network address found. Connect this computer to Wi-Fi or Ethernet.</p>
        ) : s ? (
          <PhoneLink url={lan} />
        ) : null}
        <p className="muted small">Scan with the phone camera{tab === 'net' && tunnel ? ', enter the PIN,' : ''} then use Share → Add to Home Screen to install it.</p>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
