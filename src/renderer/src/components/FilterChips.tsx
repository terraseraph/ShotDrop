import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'
import { useRatingSystem } from '../rating'

/** Grid filter ids. App's own `Filter` should accept all of these (see matchFilter). */
export type GridFilter = 'all' | 'picks' | 'stars4' | 'liked' | 'loved' | 'best' | 'unrated' | 'soft' | 'blink' | 'exposure' | 'similar' | 'rejects'

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

/** With thumbs, the ★4+ chip becomes Liked (thumbs up or love) and Loved. */
const THUMB_CHIPS: typeof GRID_FILTERS = [{ id: 'liked', label: 'Liked' }, { id: 'loved', label: 'Loved' }]
const forSystem = <T extends { id: GridFilter }>(list: T[], thumbs: boolean, chips: T[]): T[] => (thumbs ? list.flatMap((f) => (f.id === 'stars4' ? chips : [f])) : list)

/** The rating chip that means the same thing in the other system, so switching keeps the grid on a matching filter. */
export const filterForSystem = (f: string, thumbs: boolean): string => (thumbs ? (f === 'stars4' ? 'liked' : f) : f === 'liked' || f === 'loved' ? 'stars4' : f)

/** The one definition of each chip, shared by the counts here and by App's visible list. */
export function matchFilter(s: Shot, f: string, cull: Map<number, Cull>): boolean {
  switch (f) {
    case 'picks': return s.flag === 1
    case 'stars4': return s.rating >= 4
    case 'liked': return s.rating >= 3 // thumbs up or love (3-4 reads as up)
    case 'loved': return s.rating >= 5
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
  const thumbs = useRatingSystem() === 'thumbs'
  const ids = only && forSystem(only.map((id) => ({ id })), thumbs, THUMB_CHIPS).map((f) => f.id)
  return (
    <>
      {forSystem(GRID_FILTERS, thumbs, THUMB_CHIPS).filter((f) => !ids || ids.includes(f.id)).map((f) => {
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
