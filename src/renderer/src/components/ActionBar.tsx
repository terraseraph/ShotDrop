import type { Label, Shot, ShotPatch } from '@shared/types'
import { Icon } from './Icon'

const LABELS: Exclude<Label, null>[] = ['red', 'yellow', 'green', 'blue', 'purple']

/** Thumb-reach culling controls for phones: reject, rating, pick, colour label, info. */
export function ActionBar({ shot, onPatch, onInfo }: { shot: Shot | null; onPatch: (p: ShotPatch) => void; onInfo: () => void }) {
  if (!shot) return null
  return (
    <div className="action-bar">
      <div className="ab-row">
        <button className={`ab-btn reject ${shot.flag === -1 ? 'on' : ''}`} onClick={() => onPatch({ flag: shot.flag === -1 ? 0 : -1 })} aria-label="Reject" aria-pressed={shot.flag === -1}>
          <Icon name="close" size={22} />
        </button>
        <div className="ab-stars" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} role="radio" aria-checked={shot.rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={n <= shot.rating ? 'on' : ''} onClick={() => onPatch({ rating: shot.rating === n ? 0 : n })}>
              ★
            </button>
          ))}
        </div>
        <button className={`ab-btn pick ${shot.flag === 1 ? 'on' : ''}`} onClick={() => onPatch({ flag: shot.flag === 1 ? 0 : 1 })} aria-label="Pick" aria-pressed={shot.flag === 1}>
          <Icon name="check" size={22} />
        </button>
      </div>
      <div className="ab-row">
        <div className="ab-labels" aria-label="Colour label">
          {LABELS.map((l) => (
            <button key={l} className={`ab-label ${l} ${shot.label === l ? 'on' : ''}`} onClick={() => onPatch({ label: shot.label === l ? null : l })} aria-label={l} aria-pressed={shot.label === l}>
              <span className={`label-dot ${l}`} />
            </button>
          ))}
        </div>
        <button className="ab-btn info" onClick={onInfo} aria-label="Info">
          <b>i</b>
        </button>
      </div>
    </div>
  )
}
