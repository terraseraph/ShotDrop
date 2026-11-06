import { useMemo } from 'react'
import type { Shot, Status } from '@shared/types'
import { fmtDate } from '../format'
import { Icon } from './Icon'

export type Filter = 'all' | 'unrejected' | 'picks' | 'rated' | 'rejects'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unrejected', label: 'Hide rejects' },
  { id: 'picks', label: 'Picks' },
  { id: 'rated', label: 'Rated' },
  { id: 'rejects', label: 'Rejects' }
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
  onHelp: () => void
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

        <div className="seg" role="tablist" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={p.filter === f.id} className={p.filter === f.id ? 'on' : ''} onClick={() => p.onFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="count">{p.visibleCount}</span>
      </div>

      <div className="topbar-group right">
        {sync && (sync.pending + sync.running > 0 || sync.errors > 0) && (
          <span className={`chip ${sync.errors ? 'warn' : ''}`} title="Sync queue">
            <Icon name="cloud" />
            {sync.errors ? `${sync.errors} failed` : `${sync.pending + sync.running} syncing`}
          </span>
        )}

        <button className="chip ftp" onClick={p.onSettings} title="Camera connection">
          <span className={`tally ${live ? (receiving ? 'receiving' : 'live') : 'off'}`} />
          {!p.connected ? 'Disconnected' : ftp?.running ? `${ftp.addresses[0] ?? '…'}:${ftp.port}` : ftp?.error ? 'FTP error' : 'FTP off'}
        </button>

        <button className={`toggle ${p.follow ? 'on' : ''}`} onClick={() => p.onFollow(!p.follow)} title="Follow new shots (F)">
          <Icon name="follow" />
          Follow
        </button>

        <div className="seg icons" aria-label="View">
          <button className={p.view === 'loupe' ? 'on' : ''} onClick={() => p.onView('loupe')} title="Loupe (E)">
            <Icon name="loupe" />
          </button>
          <button className={p.view === 'grid' ? 'on' : ''} onClick={() => p.onView('grid')} title="Grid (G)">
            <Icon name="grid" />
          </button>
        </div>

        <button className="icon-btn" onClick={p.onHelp} title="Keyboard shortcuts (?)">
          <Icon name="keyboard" />
        </button>
        <button className="icon-btn" onClick={p.onSettings} title="Settings">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}
