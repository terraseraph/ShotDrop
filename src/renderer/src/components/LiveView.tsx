import { useEffect, useState } from 'react'
import type { Settings, Status } from '@shared/types'
import { api } from '../api'

/** Live view from a Wi-Fi camera over PTP/IP. Shots taken while connected download into the gallery like FTP ones. */
export function LiveView({ status, onClose }: { status: Status | null; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [host, setHost] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    api.settings().then((v) => (setS(v), setHost(v.ptp.host))).catch((e: Error) => setErr(e.message))
  }, [])

  const ptp = status?.ptp
  const save = async (enabled: boolean): Promise<void> => {
    try {
      setS(await api.patchSettings({ ptp: { ...s!.ptp, host: host.trim(), enabled } }))
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal live-modal" role="dialog" aria-label="Live view" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Live view{ptp?.camera ? ` · ${ptp.camera}` : ''}</h2>
          <span className="muted small">{label(ptp?.status)}</span>
        </div>

        {ptp?.status === 'connected' ? (
          <img className="live-img" src={api.liveUrl()} alt="Live view from the camera" />
        ) : ptp?.status === 'pairing' && ptp.pairingCode ? (
          <div className="live-pair">
            <div className="live-code">{ptp.pairingCode}</div>
            <p className="muted small">Check the camera shows the same code, then confirm on the camera. You only do this once per network profile.</p>
          </div>
        ) : (
          <>
            <p className="muted small">
              On the camera, open Connect to computer and choose Camera control. Join the same Wi-Fi (or the camera's own
              network) and enter the address the camera shows.
            </p>
            <div className="row tight">
              <input className="input mono" value={host} placeholder="192.168.1.1" aria-label="Camera address" onChange={(e) => setHost(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && host.trim() && void save(true)} />
              <button className="btn primary" disabled={!s || !host.trim()} onClick={() => void save(true)}>Connect</button>
            </div>
          </>
        )}

        {(err || ptp?.error) && <p className="warn-box small">{err || ptp?.error}</p>}
        <div className="row between">
          {s?.ptp.enabled ? <button className="btn" onClick={() => void save(false)}>Disconnect</button> : <span />}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function label(status: string | undefined): string {
  switch (status) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting…'
    case 'pairing': return 'Pairing'
    case 'error': return 'Retrying…'
    default: return 'Not connected'
  }
}
