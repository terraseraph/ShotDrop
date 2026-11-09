import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Shot, Status } from '@shared/types'
import { api, isRemote } from '../api'
import { popIn } from '../motion'
import { fmtDay, type SessionNames } from '../sessions'
import { Icon } from './Icon'
import { NewSessionSheet, useCurrentSession } from './NewSessionSheet'

export type Filter = 'all' | 'unrejected' | 'picks' | 'rated' | 'rejects' | 'best' | 'soft' | 'blink'
export type View = 'loupe' | 'grid' | 'compare'

const VIEWS: { id: View; label: string; key: string; icon: string }[] = [
  { id: 'loupe', label: 'Loupe', key: 'L', icon: 'loupe' },
  { id: 'grid', label: 'Grid', key: 'G', icon: 'grid' },
  { id: 'compare', label: 'Compare', key: 'C', icon: 'compare' }
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
        <svg width="18" height="18" viewBox="41 46 430 430" strokeWidth="16" strokeLinejoin="round" aria-hidden>
          <path d="M256 56 L377 221.5 A150 150 0 1 1 135 221.5 Z" fill="var(--accent)" stroke="var(--accent)" />
          <circle cx="256" cy="316" r="96" fill="var(--bg)" />
          <path d="M256 266 L299 291 L299 341 L256 366 L213 341 L213 291 Z" fill="var(--live)" stroke="var(--live)" />
        </svg>
        <span className="brand-name">ShotDrop</span>
      </div>

      <SessionChooser {...p} />

      <div className="seg views" role="tablist" aria-label="View">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={p.view === v.id} className={p.view === v.id ? 'on' : ''} onClick={() => p.onView(v.id)}>
            <Icon name={v.icon} size={15} />{v.label} <span className="key">{v.key}</span>
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
  const [rowEdit, setRowEdit] = useState<string | null>(null)
  const [rowDraft, setRowDraft] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState('')
  const current = useCurrentSession()
  const root = useRef<HTMLDivElement>(null)

  const sessions = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of p.shots) m.set(s.session, (m.get(s.session) ?? 0) + 1)
    for (const f of Object.keys(p.sessionNames.all)) if (!m.has(f)) m.set(f, 0) // named sessions with no photos yet (e.g. just created)
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [p.shots, p.sessionNames.all])

  useEffect(() => {
    if (!open) { setRowEdit(null); return }
    const down = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (rowEdit !== null) setRowEdit(null)
        else setOpen(false)
      }
    }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open, rowEdit])

  const commitRow = (): void => {
    if (rowEdit) p.sessionNames.rename(rowEdit, rowDraft)
    setRowEdit(null)
  }

  const startRename = (): void => {
    if (!p.session) return
    setDraft(p.sessionNames.custom(p.session))
    setOpen(false)
    setEditing(true)
  }
  const commit = (): void => {
    if (draft.trim() !== p.sessionNames.custom(p.session)) p.sessionNames.rename(p.session, draft)
    setEditing(false)
  }
  /** One click: the server picks a free "Session N" for today, it becomes current, and its name opens for editing. */
  const quickNew = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    setCreateErr('')
    try {
      const row = await api.createSession({ makeCurrent: true })
      p.sessionNames.reload()
      p.onSession(row.folder)
      setOpen(false)
      setDraft(row.meta?.name ?? '')
      setEditing(true)
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : 'Could not create a session')
    } finally {
      setCreating(false)
    }
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
      <div className="sess-acts">
        <button className="tb icon" onClick={startRename} disabled={!p.session || editing} aria-label="Rename this session" title={p.session ? 'Rename this session' : 'Pick a session to rename it'}>
          <Icon name="edit" />
        </button>
        <button className={`tb icon ${createErr ? 'err' : ''}`} onClick={() => void quickNew()} disabled={creating} aria-label="New session" title={createErr || 'New session: named automatically, becomes the current session'}>
          <Icon name="plus" />
        </button>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div className="sess-pop sheet" role="listbox" aria-label="Sessions" {...popIn}>
            {[['', p.shots.length] as [string, number], ...sessions].map(([s, n]) =>
              rowEdit === s && s ? (
                <div key={s} className="sess-row editing">
                  <input
                    className="sess-input"
                    autoFocus
                    value={rowDraft}
                    placeholder={fmtDay(s)}
                    maxLength={40}
                    aria-label={`Name for ${fmtDay(s)}`}
                    onChange={(e) => setRowDraft(e.target.value)}
                    onBlur={commitRow}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitRow(); if (e.key === 'Escape') setRowEdit(null) }}
                  />
                </div>
              ) : (
                <div key={s || 'all'} className={`sess-row ${p.session === s ? 'on' : ''}`}>
                  <button role="option" aria-selected={p.session === s} className="sess-pick" onClick={() => { p.onSession(s); setOpen(false) }}>
                    {current.folder && current.folder === s && <span className="dot live" title="New photos are filed into this session" />}
                    <span className="sess-name">{p.sessionNames.title(s)}</span>
                    <span className="mono">{n}</span>
                  </button>
                  {s && (
                    <button className="sess-edit" aria-label={`Rename ${p.sessionNames.title(s)}`} title="Rename" onClick={() => { setRowDraft(p.sessionNames.custom(s)); setRowEdit(s) }}>
                      <Icon name="edit" />
                    </button>
                  )}
                </div>
              )
            )}
            <button className="sess-new" onClick={() => { setOpen(false); setNewOpen(true) }}>
              <Icon name="plus" /> New session
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {newOpen && <NewSessionSheet onClose={() => setNewOpen(false)} onCreated={(f) => { p.sessionNames.reload(); p.onSession(f) }} />}
    </div>
  )
}
