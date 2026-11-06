import type { Shot, ShotPatch } from '@shared/types'
import { fmtAperture, fmtFocal, fmtIso, fmtShutter, fmtTime } from '../format'

const STAR = 'm12 2 3 6.6 7 .9-5.1 4.9 1.3 7.1L12 18l-6.2 3.5 1.3-7.1L2 9.5l7-.9z'

/** Slim culling strip under the photo: stars, pick state, key hints, EXIF. Keys do the work; the stars are clickable for mouse users. */
export function HintStrip({ shot, onPatch, picksDest }: { shot: Shot; onPatch: (p: ShotPatch) => void; picksDest: string | null }) {
  const exif = [fmtShutter(shot.shutter), fmtAperture(shot.aperture), fmtIso(shot.iso), fmtFocal(shot.focalLength)].filter(Boolean) as string[]
  return (
    <div className="hint">
      <div className="hint-stars" role="radiogroup" aria-label={`Rating ${shot.rating} of 5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="radio" aria-checked={shot.rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onPatch({ rating: shot.rating === n ? 0 : n })}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill={n <= shot.rating ? 'var(--star)' : 'none'} stroke={n <= shot.rating ? 'none' : '#555'} strokeWidth="2" aria-hidden>
              <path d={STAR} />
            </svg>
          </button>
        ))}
        <span className="hint-keys"><span className="key">1</span>–<span className="key">5</span></span>
      </div>
      {shot.flag === 1 ? (
        <span className="badge pick hint-state">Picked{picksDest ? ` · sent to ${picksDest}` : ''}</span>
      ) : shot.flag === -1 ? (
        <span className="badge rej hint-state">Rejected</span>
      ) : null}
      <span className="hint-keys">
        <span className="key">P</span> pick <i>·</i><span className="key">X</span> reject <i>·</i><span className="key">U</span> clear <i>·</i>
        <span className="key">6</span>–<span className="key">9</span> label <i>·</i><span className="key">⇧</span> + key = rate and next
      </span>
      <div className="hint-exif mono">
        {exif.map((e) => <span key={e}>{e}</span>)}
        <span style={{ color: 'var(--faint)' }}>{fmtTime(shot.capturedAt)}</span>
      </div>
    </div>
  )
}
