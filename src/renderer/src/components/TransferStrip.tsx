import { useEffect, useMemo, useState } from 'react'
import type { DestStatus, DestinationFilter, Shot, Status } from '@shared/types'
import { ago, fmtSize } from '../format'

const WORD: Record<DestinationFilter, string> = { all: 'everything', jpeg: 'JPEG', raw: 'RAW', picks: 'picks' }
const COLOR = { ok: 'var(--live)', run: 'var(--sync)', bad: 'var(--reject)', off: '#555' }

export function destState(d: DestStatus): { tone: keyof typeof COLOR; text: string } {
  if (d.authExpired) return { tone: 'bad', text: `${Math.max(d.total - d.done, 0)} waiting · sign in` }
  if (d.errors > 0) return { tone: 'bad', text: `${d.errors} failed` }
  if (!d.enabled) return { tone: 'off', text: 'paused' }
  if (d.running > 0) return { tone: 'run', text: 'uploading' }
  if (d.total > d.done) return { tone: 'run', text: `${d.total - d.done} queued` }
  return { tone: 'ok', text: d.total ? 'up to date' : 'ready' }
}

const pct = (d: DestStatus): number => (d.total ? Math.round((d.done / d.total) * 100) : 0)

interface Props {
  status: Status | null
  shots: Shot[]
  onSync: () => void
  mobile?: boolean
}

/** What is moving right now: IN = camera to PC, OUT = each destination. Wraps instead of truncating. */
export function TransferStrip({ status, shots, onSync, mobile }: Props) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(t)
  }, [])

  // The API has no per-file progress or download rate: estimate ↓ from files that landed in the last 10 s.
  const down = useMemo(() => {
    let b = 0
    for (let i = shots.length - 1, seen = 0; i >= 0 && seen < 60; i--, seen++) {
      if (now - shots[i].importedAt < 10_000) b += shots[i].files.reduce((n, f) => n + f.size, 0)
    }
    return b / 10
  }, [shots, now])

  if (!status) return <div className="tstrip" aria-label="Transfers" />
  const receiving = status.ftp.activeConnections > 0
  const camLabel = status.cameras.filter((c) => c.connected).map((c) => c.label || c.username).join(' · ') || 'camera'
  let latest: Shot | undefined
  for (const s of shots) if (!latest || s.importedAt > latest.importedAt) latest = s
  const dests = status.destinations
  const up = dests.reduce((n, d) => n + d.bps, 0)
  const running = dests.filter((d) => d.running > 0 && d.enabled)
  const inDot = <span className={`dot ${receiving ? 'live' : ''}`} style={receiving ? undefined : { background: '#555' }} />

  if (mobile) {
    const left = dests.reduce((n, d) => n + Math.max(d.total - d.done, 0), 0)
    return (
      <div className="tstrip m" aria-label="Transfers">
        <div className="tx">
          <span className="cap">IN</span>
          {inDot}
          <span className="mono tx-name">{receiving ? 'receiving…' : latest ? latest.name : 'idle'}</span>
          {receiving && <div className="bar"><i className="recv" /></div>}
          <span className="mono tx-note nowrap">{receiving ? `${status.ftp.activeConnections} open` : latest ? ago(latest.importedAt) : ''}</span>
        </div>
        <div className="tx" onClick={onSync} role="button" tabIndex={0}>
          <span className="cap">OUT</span>
          {dests.map((d) => {
            const s = destState(d)
            return (
              <span key={d.id} className="tx-dest">
                <span className="dot" style={{ background: COLOR[s.tone] }} />
                <span style={s.tone === 'bad' ? { color: 'var(--reject-text)' } : s.tone === 'off' ? { color: 'var(--faint)' } : undefined}>
                  {d.name}{s.tone === 'bad' && d.total > d.done ? ` ${d.total - d.done}` : ''}
                </span>
              </span>
            )
          })}
          {!dests.length && <span className="tx-note">No destinations</span>}
          {running.length > 0 && <div className="bar out"><i style={{ width: `${pct(running[0])}%` }} /></div>}
          {left > 0 && <span className="mono tx-note nowrap">{left} left</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="tstrip" aria-label="Transfers">
      <div className="tx tx-in">
        <span className="cap">IN</span>
        {inDot}
        {receiving ? (
          <>
            <span className="nowrap">{camLabel} → <span className="mono tx-name">receiving…</span></span>
            <div className="bar"><i className="recv" /></div>
            <span className="mono tx-note nowrap">{status.ftp.activeConnections} open</span>
          </>
        ) : (
          <span className="nowrap tx-note">
            {status.ftp.running ? (latest ? <>idle · last <span className="mono">{latest.name}</span> {ago(latest.importedAt)}</> : 'waiting for the first photo') : 'FTP is off'}
          </span>
        )}
      </div>
      <div className="tx tx-out">
        <span className="cap">OUT</span>
        {!dests.length && <span className="nowrap tx-note">No destinations · photos stay on this PC</span>}
        {dests.map((d) => {
          const s = destState(d)
          return (
            <span key={d.id} className="tx-dest">
              <span className="dot" style={{ background: COLOR[s.tone] }} />
              <span className="nowrap" style={s.tone === 'off' ? { color: 'var(--faint)' } : undefined}>
                {d.name}{' '}
                <span style={{ color: s.tone === 'bad' ? 'var(--reject-text)' : 'var(--faint)' }}>
                  {d.filter !== 'all' ? `${WORD[d.filter]} · ` : ''}{s.text}
                </span>
              </span>
              {running.includes(d) && (
                <>
                  <div className="bar out"><i style={{ width: `${pct(d)}%` }} /></div>
                  <span className="mono tx-note nowrap">{d.done}/{d.total}{d.bps > 0 ? ` · ${fmtSize(d.bps)}/s` : ''}</span>
                </>
              )}
            </span>
          )
        })}
      </div>
      <div className="tx tx-end">
        <span className="mono tx-note" title="Estimated from files landing in the last 10 s">↓ {fmtSize(down)}/s</span>
        <span className="mono tx-note">↑ {fmtSize(up)}/s</span>
        <button className="tb" style={{ height: 24, fontSize: 12, color: 'var(--accent)' }} onClick={onSync}>Sync</button>
      </div>
    </div>
  )
}
