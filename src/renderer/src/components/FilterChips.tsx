import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'

/** Grid filter ids. App's own `Filter` should accept all of these (see matchFilter). */
export type GridFilter = 'all' | 'picks' | 'stars4' | 'best' | 'unrated' | 'soft' | 'blink' | 'exposure' | 'similar' | 'rejects'

export const GRID_FILTERS: { id: GridFilter; label: string; divider?: boolean }[] = [
  { id: 'all', label: 'All' },
  { id: 'picks', label: 'Picks' },
  { id: 'stars4', label: '★4+' },
  { id: 'best', label: 'Best of burst' },
  { id: 'unrated', label: 'Unrated' },
  { id: 'soft', label: 'Soft', divider: true },
  { id: 'blink', label: 'Eyes closed' },
  { id: 'rejects', label: 'Rejects' }
]

/** The one definition of each chip, shared by the counts here and by App's visible list. */
export function matchFilter(s: Shot, f: string, cull: Map<number, Cull>): boolean {
  switch (f) {
    case 'picks': return s.flag === 1
    case 'stars4': return s.rating >= 4
    case 'unrated': return s.rating === 0
    case 'rated': return s.rating > 0
    case 'rejects': return s.flag === -1
    case 'unrejected': return s.flag !== -1
    case 'best': return cull.get(s.id)?.best !== false
    case 'soft': return cull.get(s.id)?.soft === true
    case 'blink': return cull.get(s.id)?.blink === true
    case 'exposure': return cull.get(s.id)?.exposure === true
    case 'similar': { const c = cull.get(s.id); return !!c && c.size > 1 && !c.best }
    default: return true
  }
}

interface Props {
  shots: Shot[] // the session/camera-scoped list, before the chip filter
  cull: Map<number, Cull>
  filter: string
  onFilter: (f: GridFilter) => void
  only?: GridFilter[] // phone shows a subset
}

export function FilterChips({ shots, cull, filter, onFilter, only }: Props) {
  return (
    <>
      {GRID_FILTERS.filter((f) => !only || only.includes(f.id)).map((f) => {
        const n = f.id === 'all' ? shots.length : shots.filter((s) => matchFilter(s, f.id, cull)).length
        return (
          <span key={f.id} className="gx-chipwrap">
            {f.divider && !only && <span className="gx-divider" />}
            <button className={`chip ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}>
              {f.label} <span className="n">{n}</span>
            </button>
          </span>
        )
      })}
    </>
  )
}
