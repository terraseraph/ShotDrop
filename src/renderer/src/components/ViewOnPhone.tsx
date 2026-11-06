import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { Settings, Shot, Status } from '@shared/types'
import { api } from '../api'
import { Popover } from './Popover'

/** LAN address (first of ftp.addresses, the user's chosen one) + API port. Null when the machine has no network address. */
export const lanUrl = (status: Status | null): string | null =>
  status?.ftp.addresses[0] ? `http://${status.ftp.addresses[0]}:${status.api.port}` : null

interface Props {
  status: Status | null
  onClose: () => void
  /** The photo "Share this photo" copies a link to. */
  shot?: Shot | null
  /** The Phone button; the popover opens beside it. Without it, top-right under the top bar. */
  anchor?: HTMLElement | null
}

/** Phone popover (Share.dc.html): real QR of the remote URL, the PIN, the public link switch and a one-photo preview link. */
export function ViewOnPhone({ status, onClose, shot, anchor }: Props) {
  const [s, setS] = useState<Settings | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  useEffect(() => { api.settings().then(setS, (e: Error) => setNote({ text: e.message, bad: true })) }, [])

  const t = status?.tunnel
  const lan = lanUrl(status)
  const remoteOn = !!status?.api.remote
  const publicOn = t?.status === 'running' || t?.status === 'starting' || t?.status === 'installing'
  const url = lan && remoteOn ? lan : null

  useEffect(() => {
    if (!url) return setQr(null)
    // The QR holds the URL only. The PIN is shown beside it, never encoded.
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#111111', light: '#ffffff' } }).then(setQr, () => setQr(null))
  }, [url])

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true })
    } finally {
      setBusy(false)
    }
  }
  const enable = (): Promise<void> => guard(async () => s && setS(await api.patchSettings({ remote: { ...s.remote, enabled: true } })))
  const togglePublic = (): Promise<void> =>
    guard(async () => {
      if (publicOn) await api.tunnelStop()
      else {
        if (t && !t.installed) await api.tunnelInstall()
        await api.tunnelStart()
      }
    })
  const copyLink = (): Promise<void> =>
    guard(async () => {
      if (!shot) return
      const r = await api.shareLink(shot.id)
      if (!r.url) throw new Error(r.reason ?? 'No link available')
      await navigator.clipboard.writeText(r.url)
      setNote({ text: 'Link copied.' })
    })

  return (
    <Popover anchor={anchor} width={360} label="View on phone" onClose={onClose}>
      <div className="pop-head"><h3>View on phone</h3><button className="tb pop-x" aria-label="Close" onClick={onClose}>×</button></div>
      {url ? (
        <div className="pop-qr">
          {qr ? <img src={qr} alt={`QR code for ${url}`} /> : <div style={{ width: 120, height: 120 }} />}
          <div className="txt">
            <strong>Scan, enter the PIN, add to home screen.</strong>
            {s?.remote.pin && <>PIN <span className="mono pop-pin">{s.remote.pin}</span><br /></>}
            <span className="mono pop-url">{url}</span>
          </div>
        </div>
      ) : (
        <div className="pop-row">
          <div><div className="pop-t">Remote access is off</div><div className="pop-d">{lan ? 'Turn it on to open the gallery from a phone on this network.' : 'No network address found. Connect to Wi-Fi or Ethernet.'}</div></div>
          {lan && <button className="tb" disabled={busy || !s} onClick={() => void enable()}>Turn on</button>}
        </div>
      )}
      <div className="pop-sec">
        <div className="pop-row">
          <div style={{ minWidth: 0 }}>
            <div className="pop-t">Public link</div>
            <div className="pop-d">{t?.status === 'running' && t.url ? <span className="mono pop-url">{t.url}</span> : t?.status === 'error' ? t.error ?? 'Could not start' : t?.status === 'installing' ? 'Getting the helper…' : 'Works from anywhere, no account, no router changes.'}</div>
          </div>
          <button className="tb" disabled={busy || t?.status === 'starting' || t?.status === 'installing'} onClick={() => void togglePublic()}>{publicOn ? 'Turn off' : 'Turn on'}</button>
        </div>
        {shot && (
          <div className="pop-row">
            <div><div className="pop-t">Share this photo</div><div className="pop-d">Preview link, valid until the PIN changes.</div></div>
            <button className="tb" disabled={busy} onClick={() => void copyLink()}>Copy link</button>
          </div>
        )}
        {note && <div className={`pop-d ${note.bad ? 'pop-bad' : ''}`} role="status">{note.text}</div>}
      </div>
    </Popover>
  )
}
