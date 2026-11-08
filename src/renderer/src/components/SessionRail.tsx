import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Shot } from '@shared/types'
import { fmtDay, useSessionNames } from '../sessions'
import { NewSessionSheet, useCurrentSession } from './NewSessionSheet'
import { FoundFolders } from './FoundFolders'
import { SessionDestChips } from './SessionDestChips'

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

/**
 * Row names by key. `day:<folder>` names come from the session's .shotdrop.json (through the API, shared with every device);
 * `cam:<user>` names stay in this browser.
 */
export function useNames(): [Names, (k: string, v: string) => void] {
  const sessions = useSessionNames()
  const [local, setLocal] = useState<Names>(() => Object.fromEntries(Object.entries(load()).filter(([k]) => !k.startsWith('day:'))))
  const names = useMemo(() => ({ ...local, ...Object.fromEntries(Object.entries(sessions.all).map(([f, n]) => [`day:${f}`, n])) }), [local, sessions.all])
  const set = (k: string, v: string): void => {
    if (k.startsWith('day:')) return sessions.rename(k.slice(4), v)
    setLocal((n) => {
      const next = { ...n }
      if (v.trim()) next[k] = v.trim()
      else delete next[k]
      try {
        // Day labels not yet migrated stay in the old store; sessions.ts moves them to the server.
        const pending = Object.fromEntries(Object.entries(load()).filter(([key]) => key.startsWith('day:')))
        localStorage.setItem(KEY, JSON.stringify({ ...pending, ...next }))
      } catch {
        /* storage blocked: the name lasts until reload */
      }
      return next
    })
  }
  return [names, set]
}

export const dayName = fmtDay

function Row({ id, auto, name, count, active, live, onClick, onRename, action }: { id: string; auto: string; name?: string; count: number; active: boolean; live?: boolean; onClick: () => void; onRename: (id: string, v: string) => void; action?: { label: string; onClick: () => void } }) {
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
      {action && <button className="gx-rail-act" onClick={(e) => { e.stopPropagation(); action.onClick() }} onDoubleClick={(e) => e.stopPropagation()}>{action.label}</button>}
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
  const { reload } = useSessionNames()
  const current = useCurrentSession()
  const [newOpen, setNewOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  // A change from this or another device (new session, ended, renamed) may carry new names too.
  useEffect(() => { void current.folder; reload() }, [current.folder, reload])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])

  const days = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of allShots) m.set(s.session, (m.get(s.session) ?? 0) + 1)
    if (current.folder && !m.has(current.folder)) m.set(current.folder, 0) // a new session has no photos yet
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [allShots, current.folder])

  // A new shoot day (or a folder another device created) may already carry a name in its .shotdrop.json.
  const dayKeys = days.map(([d]) => d).join('|')
  useEffect(reload, [dayKeys, reload])

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
      {current.folder && <div className="gx-rail-cur" title="New photos are filed into this session"><span className="dot live" />Filing into {names[`day:${current.folder}`] ?? dayName(current.folder)}{current.endsAt ? ` · until ${new Date(current.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</div>}
      <button className="gx-rail-new" onClick={(e) => { e.stopPropagation(); setNewOpen(true) }}>+ New session</button>
      <Row id="" auto="All days" count={allShots.length} active={!session} onClick={() => onSession('')} onRename={() => {}} />
      {days.map(([d, n]) => {
        const isCur = current.folder === d
        return (
          <Fragment key={d}>
          <Row id={`day:${d}`} auto={dayName(d)} name={names[`day:${d}`]} count={n} live={isCur ? true : undefined} active={session === d} onClick={() => onSession(session === d ? '' : d)} onRename={rename}
            action={isCur ? { label: 'End session', onClick: () => void current.set(null) } : { label: 'Make current', onClick: () => void current.set(d) }} />
          <SessionDestChips folder={d} />
          </Fragment>
        )
      })}
      <FoundFolders />
      {newOpen && <NewSessionSheet onClose={() => setNewOpen(false)} onCreated={(f) => onSession(f)} />}
      <div className="gx-rail-h" style={{ paddingTop: 16 }}>CAMERAS</div>
      {cams.map(([src, c]) => (
        <Row key={src} id={`cam:${src}`} auto={c.model ? `${c.model} · ${src}` : src} name={names[`cam:${src}`]} count={c.n} live={now - c.last < LIVE_MS} active={source === src} onClick={() => onSource(source === src ? '' : src)} onRename={rename} />
      ))}
      <div className="gx-rail-foot">Days and camera names are automatic. Double-click to rename.</div>
    </nav>
  )
}
