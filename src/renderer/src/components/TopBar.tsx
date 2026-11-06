import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Shot, Status } from '@shared/types'
import { isRemote } from '../api'
import { popIn } from '../motion'
import { fmtDay, type SessionNames } from '../sessions'
import { Icon } from './Icon'

export type Filter = 'all' | 'unrejected' | 'picks' | 'rated' | 'rejects' | 'best' | 'soft' | 'blink'
export type View = 'loupe' | 'grid' | 'compare'

const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'loupe', label: 'Loupe', key: 'L' },
  { id: 'grid', label: 'Grid', key: 'G' },
  { id: 'compare', label: 'Compare', key: 'C' }
]

interface Props {
  status: Status | null
  connected: boolean
  shots: Shot[]
  session: string
  onSession: (s: string) => void
  sessionNames: SessionNames
  visibleCount: number
  follow: boolean
  onFollow: (f: boolean) => void
  view: View
  onView: (v: View) => void
  onSettings: () => void
  onSync: () => void
  syncOpen?: boolean
  onHelp: () => void
  onPhone: () => void
  onLive: () => void
}

export function TopBar(p: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span className="brand-name">ShotDrop</span>
      </div>

      <SessionChooser {...p} />

      <div className="seg views" role="tablist" aria-label="View">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={p.view === v.id} className={p.view === v.id ? 'on' : ''} onClick={() => p.onView(v.id)}>
            {v.label} <span className="key">{v.key}</span>
          </button>
        ))}
      </div>

      <div className="topbar-right">
        <button className={`tb follow ${p.follow ? 'on' : ''}`} aria-pressed={p.follow} onClick={() => p.onFollow(!p.follow)} title="Jump to each new photo (F)">
          <span className={`dot ${p.follow ? 'live' : ''}`} style={{ width: 8, height: 8, background: p.follow ? 'var(--live)' : '#555' }} />
          Follow <span className="key">F</span>
        </button>
        {!isRemote && p.status && p.status.ptp.status !== 'off' && (
          <button className="tb" onClick={p.onLive} aria-label="Live view" title="Live view (Wi-Fi camera)">
            <Icon name="camera" />
          </button>
        )}
        {!isRemote && (
          <button className="tb" onClick={p.onPhone} aria-label="Phone and public link">
            <Icon name="phone" />
            <span className="tb-label">Phone</span>
          </button>
        )}
        {!isRemote && (
          <button className={`tb ${p.syncOpen ? 'on' : ''}`} aria-pressed={!!p.syncOpen} onClick={p.onSync} aria-label="Sync">
            <Icon name="refresh" />
            <span className="tb-label">Sync</span>
          </button>
        )}
        <button className="tb" onClick={p.onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          <Icon name="keyboard" />
        </button>
        {!isRemote && (
          <button className="tb" onClick={p.onSettings} aria-label="Settings">
            <Icon name="settings" />
          </button>
        )}
      </div>
    </header>
  )
}

/** "Thu 6 Nov · Studio · 148 frames". Click for the list, double-click the name to rename it. */
export type ChooserProps = Pick<Props, 'shots' | 'session' | 'onSession' | 'sessionNames' | 'visibleCount'> & { /** Phone: second line under the title, instead of the inline frame count. */ sub?: string }

export function SessionChooser(p: ChooserProps) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const root = useRef<HTMLDivElement>(null)

  const sessions = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of p.shots) m.set(s.session, (m.get(s.session) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [p.shots])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  const startRename = (): void => {
    if (!p.session) return
    setDraft(p.sessionNames.custom(p.session))
    setOpen(false)
    setEditing(true)
  }
  const commit = (): void => {
    p.sessionNames.rename(p.session, draft)
    setEditing(false)
  }

  return (
    <div className={`sess ${p.sub !== undefined ? "two" : ""}`} ref={root}>
      <div className="tb sess-btn" role="button" tabIndex={0} aria-label="Choose session" aria-expanded={open} onClick={() => !editing && setOpen((o) => !o)} onKeyDown={(e) => e.key === 'Enter' && !editing && setOpen((o) => !o)} onDoubleClick={startRename} title={p.session ? 'Double-click to rename' : undefined}>
        {editing ? (
          <>
            <span className="sess-day">{fmtDay(p.session)} ·</span>
            <input
              className="sess-input"
              autoFocus
              value={draft}
              placeholder="Name this session"
              maxLength={40}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          </>
        ) : (
          <span className="sess-title">{p.sessionNames.title(p.session)}</span>
        )}
        {p.sub !== undefined && <span className="sess-sub">{p.sub}</span>}
        {p.sub === undefined && <span className="sess-count">· {p.visibleCount} frames</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div className="sess-pop sheet" role="listbox" aria-label="Sessions" {...popIn}>
            {[['', p.shots.length] as [string, number], ...sessions].map(([s, n]) => (
              <button key={s || 'all'} role="option" aria-selected={p.session === s} className={p.session === s ? 'on' : ''} onClick={() => { p.onSession(s); setOpen(false) }}>
                <span>{p.sessionNames.title(s)}</span>
                <span className="mono">{n}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
