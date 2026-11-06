import { useEffect, useMemo, useRef, useState } from 'react'
import type { Shot } from '@shared/types'

const KEY = 'shotdrop.names'
const LIVE_MS = 2 * 60_000

type Names = Record<string, string>
const load = (): Names => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Names
  } catch {
    return {}
  }
}

/** Custom names live in this browser only (no server field for them yet). */
export function useNames(): [Names, (k: string, v: string) => void] {
  const [names, setNames] = useState<Names>(load)
  const set = (k: string, v: string): void =>
    setNames((n) => {
      const next = { ...n }
      if (v.trim()) next[k] = v.trim()
      else delete next[k]
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage blocked: the name lasts until reload */
      }
      return next
    })
  return [names, set]
}

export const dayName = (session: string): string => {
  const [y, m, d] = session.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function Row({ id, auto, name, count, active, live, onClick, onRename }: { id: string; auto: string; name?: string; count: number; active: boolean; live?: boolean; onClick: () => void; onRename: (id: string, v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) ref.current?.select() }, [editing])
  const done = (v: string): void => { setEditing(false); onRename(id, v === auto ? '' : v) }
  return (
    <div className={`gx-rail-row ${active ? 'on' : ''}`} onClick={onClick} onDoubleClick={() => setEditing(true)} role="button" tabIndex={0} aria-pressed={active} onKeyDown={(e) => { if (e.key === 'Enter' && !editing) onClick() }} title="Double-click to rename">
      {live != null && <span className={`dot ${live ? 'live' : ''}`} style={live ? undefined : { background: 'var(--faintest)' }} />}
      {editing ? (
        <input ref={ref} className="gx-rename" defaultValue={name ?? auto} autoFocus onClick={(e) => e.stopPropagation()} onBlur={(e) => done(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') done(e.currentTarget.value); else if (e.key === 'Escape') setEditing(false) }} />
      ) : (
        <span className="gx-rail-name">{name ?? auto}</span>
      )}
      <span className="gx-rail-n">{count}</span>
    </div>
  )
}

interface Props {
  allShots: Shot[]
  session: string
  source: string
  onSession: (s: string) => void
  onSource: (s: string) => void
}

export function SessionRail({ allShots, session, source, onSession, onSource }: Props) {
  const [names, rename] = useNames()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])

  const days = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of allShots) m.set(s.session, (m.get(s.session) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [allShots])

  const cams = useMemo(() => {
    const m = new Map<string, { n: number; last: number; model: string | null }>()
    for (const s of allShots) {
      if (!s.source || (session && s.session !== session)) continue
      const c = m.get(s.source) ?? { n: 0, last: 0, model: null }
      c.n++
      if (s.importedAt >= c.last) { c.last = s.importedAt; c.model = s.camera ?? c.model }
      m.set(s.source, c)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [allShots, session])

  return (
    <nav className="gx-rail" aria-label="Shoot days and cameras">
      <div className="gx-rail-h">SHOOT DAYS</div>
      <Row id="" auto="All days" count={allShots.length} active={!session} onClick={() => onSession('')} onRename={() => {}} />
      {days.map(([d, n]) => (
        <Row key={d} id={`day:${d}`} auto={dayName(d)} name={names[`day:${d}`]} count={n} active={session === d} onClick={() => onSession(session === d ? '' : d)} onRename={rename} />
      ))}
      <div className="gx-rail-h" style={{ paddingTop: 16 }}>CAMERAS</div>
      {cams.map(([src, c]) => (
        <Row key={src} id={`cam:${src}`} auto={c.model ? `${c.model} · ${src}` : src} name={names[`cam:${src}`]} count={c.n} live={now - c.last < LIVE_MS} active={source === src} onClick={() => onSource(source === src ? '' : src)} onRename={rename} />
      ))}
      <div className="gx-rail-foot">Days and camera names are automatic. Double-click to rename.</div>
    </nav>
  )
}
