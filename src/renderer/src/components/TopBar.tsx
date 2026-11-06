import { useMemo } from 'react'
import type { Shot, Status } from '@shared/types'
import { fmtDate } from '../format'
import { isRemote } from '../api'
import { Icon } from './Icon'

export type Filter = 'all' | 'unrejected' | 'picks' | 'rated' | 'rejects' | 'best' | 'soft' | 'blink'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unrejected', label: 'Hide rejects' },
  { id: 'picks', label: 'Picks' },
  { id: 'rated', label: 'Rated' },
  { id: 'rejects', label: 'Rejects' },
  { id: 'best', label: 'Best of burst' },
  { id: 'soft', label: 'Soft' },
  { id: 'blink', label: 'Eyes closed' }
]

interface Props {
  status: Status | null
  connected: boolean
  shots: Shot[]
  session: string
  onSession: (s: string) => void
  filter: Filter
  onFilter: (f: Filter) => void
  follow: boolean
  onFollow: (f: boolean) => void
  view: 'loupe' | 'grid'
  onView: (v: 'loupe' | 'grid') => void
  onSettings: () => void
  dockOpen: boolean
  onDock: () => void
  onHelp: () => void
  onPhone: () => void
  mobile: boolean
  visibleCount: number
}

export function TopBar(p: Props) {
  const sessions = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of p.shots) m.set(s.session, (m.get(s.session) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [p.shots])

  const ftp = p.status?.ftp
  const live = ftp?.running && p.connected
  const receiving = (ftp?.activeConnections ?? 0) > 0
  const sync = p.status?.sync
  const cams = p.status?.cameras.filter((c) => c.connected).length ?? 0

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        ShotDrop
      </div>

      <div className="topbar-group">
        <select className="select" value={p.session} onChange={(e) => p.onSession(e.target.value)} aria-label="Session">
          <option value="">All sessions · {p.shots.length}</option>
          {sessions.map(([s, n]) => (
            <option key={s} value={s}>
              {fmtDate(s)} · {n}
            </option>
          ))}
        </select>

        {p.mobile ? (
          <select className="select" value={p.filter} onChange={(e) => p.onFilter(e.target.value as Filter)} aria-label="Filter">
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        ) : (
        <div className="seg" role="tablist" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={p.filter === f.id} className={p.filter === f.id ? 'on' : ''} onClick={() => p.onFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        )}
        <span className="count">{p.visibleCount}</span>
      </div>

      <div className="topbar-group right">
        {p.status?.tunnel.status === 'running' && (
          <button className="chip online" onClick={p.onSettings} title={p.status.tunnel.url ?? 'Public link is on'}>
            <Icon name="cloud" />
            Online
          </button>
        )}

        <button className={`chip ftp ${sync?.errors ? 'warn' : ''}`} onClick={p.onDock} title={sync?.errors ? `${sync.errors} uploads failed` : 'Status dock (,)'}>
          <span className={`tally ${live ? (receiving ? 'receiving' : 'live') : 'off'}`} />
          {!p.connected ? 'Disconnected' : ftp?.error ? 'FTP error' : !ftp?.running ? 'FTP off' : `${cams} camera${cams === 1 ? '' : 's'}`}
        </button>

        <button className={`toggle ${p.follow ? 'on' : ''}`} onClick={() => p.onFollow(!p.follow)} title="Follow new shots (F)">
          <Icon name="follow" />
          <span className="lbl">Follow</span>
        </button>

        <div className="seg icons" aria-label="View">
          <button className={p.view === 'loupe' ? 'on' : ''} onClick={() => p.onView('loupe')} title="Loupe (E)">
            <Icon name="loupe" />
          </button>
          <button className={p.view === 'grid' ? 'on' : ''} onClick={() => p.onView('grid')} title="Grid (G)">
            <Icon name="grid" />
          </button>
        </div>

        {!isRemote && (
          <button className="icon-btn" onClick={p.onPhone} title="View on phone" aria-label="View on phone">
            <Icon name="phone" />
          </button>
        )}
        {!isRemote && (
          <button className={`icon-btn ${p.dockOpen ? 'on' : ''}`} onClick={p.onDock} title="Status dock (,)" aria-pressed={p.dockOpen}>
            <Icon name="dock" />
          </button>
        )}
        <button className="icon-btn help" onClick={p.onHelp} title="Keyboard shortcuts (?)">
          <Icon name="keyboard" />
        </button>
        {!isRemote && (
          <button className="icon-btn" onClick={p.onSettings} title="Settings">
            <Icon name="settings" />
          </button>
        )}
      </div>
    </header>
  )
}
