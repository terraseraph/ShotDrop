import type { Label, Shot, ShotPatch } from '@shared/types'

const LABELS: Exclude<Label, null>[] = ['red', 'yellow', 'green', 'blue', 'purple']
const STAR = 'm12 2 3 6.6 7 .9-5.1 4.9 1.3 7.1L12 18l-6.2 3.5 1.3-7.1L2 9.5l7-.9z'
const LABEL_VAR: Record<Exclude<Label, null>, string> = { red: 'var(--l-red)', yellow: 'var(--l-yellow)', green: 'var(--l-green)', blue: 'var(--l-blue)', purple: 'var(--l-purple)' }

interface Props {
  shot: Shot | null
  onPatch: (p: ShotPatch) => void
  /** Jump to the best frame of this shot's burst; hidden when it is not in a burst. */
  onBurst?: (() => void) | null
  onShare: () => void
}

/** Phone culling: 44px star row, then a thumb-reach bar (Pick, Reject, Label, Burst, Share). */
export function ActionBar({ shot, onPatch, onBurst, onShare }: Props) {
  if (!shot) return null
  const nextLabel = (): void => onPatch({ label: shot.label === null ? LABELS[0] : (LABELS[LABELS.indexOf(shot.label) + 1] ?? null) })
  return (
    <div className="action-bar">
      <div className="m-stars" role="radiogroup" aria-label={`Rating ${shot.rating} of 5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="radio" aria-checked={shot.rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onPatch({ rating: shot.rating === n ? 0 : n })}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill={n <= shot.rating ? 'var(--star)' : 'none'} stroke={n <= shot.rating ? 'none' : '#555'} strokeWidth="2" aria-hidden>
              <path d={STAR} />
            </svg>
          </button>
        ))}
      </div>
      <div className="m-cull">
        <button className={`cull ${shot.flag === 1 ? 'on' : ''}`} aria-pressed={shot.flag === 1} onClick={() => onPatch({ flag: shot.flag === 1 ? 0 : 1 })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="m5 12 5 5L20 7" /></svg>
          Pick
        </button>
        <button className={`cull rej ${shot.flag === -1 ? 'on' : ''}`} aria-pressed={shot.flag === -1} onClick={() => onPatch({ flag: shot.flag === -1 ? 0 : -1 })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
          Reject
        </button>
        <button className={`cull ${shot.label ? 'on' : ''}`} onClick={nextLabel} aria-label={`Label: ${shot.label ?? 'none'}. Tap to change`}>
          <svg viewBox="0 0 24 24" fill={shot.label ? LABEL_VAR[shot.label] : 'none'} stroke={shot.label ? LABEL_VAR[shot.label] : 'currentColor'} strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="8" /></svg>
          Label
        </button>
        <button className="cull" disabled={!onBurst} onClick={onBurst ?? undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="7" width="12" height="12" rx="2" /><path d="M8 3h11a2 2 0 0 1 2 2v11" /></svg>
          Burst
        </button>
        <button className="cull" onClick={onShare}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
          Share
        </button>
      </div>
    </div>
  )
}
