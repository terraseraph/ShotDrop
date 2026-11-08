import type { Label, Shot, ShotPatch } from '@shared/types'
import { RatingButtons } from '../rating'

const LABELS: Exclude<Label, null>[] = ['red', 'yellow', 'green', 'blue', 'purple']
const LABEL_VAR: Record<Exclude<Label, null>, string> = { red: 'var(--l-red)', yellow: 'var(--l-yellow)', green: 'var(--l-green)', blue: 'var(--l-blue)', purple: 'var(--l-purple)' }

interface Props {
  shot: Shot | null
  onPatch: (p: ShotPatch) => void
  /** Jump to the best frame of this shot's burst; hidden when it is not in a burst. */
  onBurst?: (() => void) | null
  onShare: () => void
}

/** Phone culling: 44px rating row (stars or thumbs), then a thumb-reach bar (Pick, Reject, Label, Burst, Share). */
export function ActionBar({ shot, onPatch, onBurst, onShare }: Props) {
  if (!shot) return null
  const nextLabel = (): void => onPatch({ label: shot.label === null ? LABELS[0] : (LABELS[LABELS.indexOf(shot.label) + 1] ?? null) })
  return (
    <div className="action-bar">
      <RatingButtons shot={shot} onPatch={onPatch} className="m-stars" size={26} />
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
