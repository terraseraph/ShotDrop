import type { Status } from '@shared/types'
import { fmtSize } from '../format'
import { destState } from './TransferStrip'

const COLOR = { ok: 'var(--live)', run: 'var(--sync)', bad: 'var(--reject)', off: '#555' }

interface Props {
  status: Status | null
  onSync: () => void
  onPhone: () => void
  mobile?: boolean
}

/** 34px status bar at the bottom: cameras, today's count, destinations, free space, public link, FTP address. */
export function Dock({ status, onSync, onPhone, mobile }: Props) {
  if (!status) return <footer className="dock" />
  const cams = status.cameras
  const online = cams.filter((c) => c.connected)
  const today = cams.reduce((n, c) => n + c.today, 0)
  const free = status.library.free
  const tunnelOn = status.tunnel.status === 'running'
  const addr = status.ftp.addresses[0]

  if (mobile) {
    const queued = status.destinations.reduce((n, d) => n + Math.max(d.total - d.done, 0), 0)
    return (
      <footer className="dock m">
        <span><span className="dot" style={{ background: online.length ? 'var(--live)' : '#555' }} />{online.length} cam{online.length === 1 ? '' : 's'}</span>
        <span>{today} today</span>
        {queued > 0 && <span><span className="dot" style={{ background: 'var(--sync)' }} />{queued} to sync</span>}
        {free !== null && <span style={{ marginLeft: 'auto' }}>{fmtSize(free)}</span>}
      </footer>
    )
  }

  return (
    <footer className="dock">
      <span>
        <span className={`dot ${online.length ? 'live' : ''}`} style={online.length ? undefined : { background: '#555' }} />
        {online.length} camera{online.length === 1 ? '' : 's'}
        {online.length > 0 && <span style={{ color: 'var(--faintest)' }}> {online.map((c) => c.label || c.username).join(' · ')}</span>}
      </span>
      <span>{today} frame{today === 1 ? '' : 's'} today</span>
      {status.destinations.map((d) => {
        const s = destState(d)
        return (
          <button key={d.id} className="dock-btn" onClick={onSync} title={d.target}>
            <span className="dot" style={{ background: COLOR[s.tone] }} />
            {d.name} {s.text}
          </button>
        )
      })}
      {free !== null && <span>{fmtSize(free)} free</span>}
      <button className="dock-btn" style={{ marginLeft: 'auto' }} onClick={onPhone}>
        Public link <span style={{ color: tunnelOn ? 'var(--live)' : 'var(--faintest)' }}>{tunnelOn ? 'on' : 'off'}</span>
      </button>
      <span>
        {status.ftp.running ? 'FTP' : 'FTP off'} {addr && status.ftp.running && <span className="mono" style={{ color: 'var(--text-2)' }}>{addr}:{status.ftp.port}</span>}
      </span>
    </footer>
  )
}
