import type { Shot, ShotPatch } from '@shared/types'
import { fmtAperture, fmtFocal, fmtIso, fmtShutter, fmtTime } from '../format'
import { RatingButtons } from '../rating'

/** Slim culling strip under the photo: rating (stars or thumbs), pick state, key hints, EXIF. Keys do the work; the rating is clickable for mouse users. */
export function HintStrip({ shot, onPatch, picksDest }: { shot: Shot; onPatch: (p: ShotPatch) => void; picksDest: string | null }) {
  const exif = [fmtShutter(shot.shutter), fmtAperture(shot.aperture), fmtIso(shot.iso), fmtFocal(shot.focalLength)].filter(Boolean) as string[]
  return (
    <div className="hint">
      <RatingButtons shot={shot} onPatch={onPatch} className="hint-stars" keys />
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
