import type { Shot } from '@shared/types'

export function Stars({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' }) {
  if (!rating) return null
  return (
    <span className={`stars ${size}`} aria-label={`${rating} stars`}>
      {'★'.repeat(rating)}
    </span>
  )
}

/** Rating, pick/reject flag and colour label in one compact cluster. */
export function Badges({ shot }: { shot: Shot }) {
  return (
    <span className="badges">
      {shot.files.some((f) => f.kind === 'video') && <span className="flag" aria-label="Video">▶</span>}
      {shot.label && <span className={`label-dot ${shot.label}`} aria-label={`${shot.label} label`} />}
      <Stars rating={shot.rating} />
      {shot.flag === 1 && <span className="flag pick" aria-label="Pick">●</span>}
      {shot.flag === -1 && <span className="flag reject" aria-label="Rejected">✕</span>}
    </span>
  )
}

/** One dot per sync destination: grey queued, amber pulsing running, green done, red error. */
export function SyncDots({ sync }: { sync: Shot['sync'] }) {
  const e = Object.entries(sync)
  if (!e.length) return null
  return (
    <span className="sync-dots" aria-hidden>
      {e.map(([id, st]) => <i key={id} className={st} />)}
    </span>
  )
}
