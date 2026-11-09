import { useSyncExternalStore } from 'react'
import type { RatingSystem, Shot, ShotPatch } from '@shared/types'
import { THUMB_RATING, THUMB_WORD, thumbOf, type Thumb } from '@shared/rating'
import { api } from './api'

// Two ways to rate, one stored value: see @shared/rating for how thumbs map onto stars.
export { thumbOf, type Thumb }
export const THUMBS: { t: Thumb; rating: number; key: string; label: string }[] = [
  { t: 'down', rating: THUMB_RATING.down, key: '1', label: 'Thumbs down' },
  { t: 'up', rating: THUMB_RATING.up, key: '2', label: 'Thumbs up' },
  { t: 'love', rating: THUMB_RATING.love, key: '3', label: 'Love' }
]

/** The rating a number key sets (0 clears), or null when the key means nothing in this system. */
export function keyRating(system: RatingSystem, digit: number): number | null {
  if (digit === 0) return 0
  if (system === 'stars') return digit <= 5 ? digit : null
  return THUMBS[digit - 1]?.rating ?? null
}
export const maxKey = (system: RatingSystem): number => (system === 'stars' ? 5 : 3)

/** Plain words for a rating, e.g. "★4" or "Loved"; empty when unrated. */
export function ratingText(rating: number, system: RatingSystem): string {
  if (!rating) return ''
  if (system === 'stars') return `★${rating}`
  return THUMB_WORD[thumbOf(rating)!]
}

// ---- the active system: a PC setting, so the phone follows whatever the PC chose ----
let current: RatingSystem = 'thumbs'
let loaded = false
const listeners = new Set<() => void>()
export function setRatingSystem(s: RatingSystem): void {
  loaded = true
  if (s === current) return
  current = s
  listeners.forEach((l) => l())
}
function subscribe(l: () => void): () => void {
  listeners.add(l)
  // Remote viewers can't read settings until the PIN is in; a later subscriber tries again.
  if (!loaded) {
    loaded = true
    api.settings().then((s) => setRatingSystem(s.ratingSystem ?? 'thumbs'), () => { loaded = false })
  }
  return () => listeners.delete(l)
}
export const useRatingSystem = (): RatingSystem => useSyncExternalStore(subscribe, () => current)

// ---- icons ----
const STAR = 'm12 2 3 6.6 7 .9-5.1 4.9 1.3 7.1L12 18l-6.2 3.5 1.3-7.1L2 9.5l7-.9z'
const THUMB_PATH: Record<Thumb, string> = {
  up: 'M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-8a3 3 0 0 1 3 3v4h5.3a2 2 0 0 1 2 2.3l-1.4 8.5a2 2 0 0 1-2 1.7H7',
  down: 'M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3Zm0 0-4 8a3 3 0 0 1-3-3v-4H4.7a2 2 0 0 1-2-2.3l1.4-8.5a2 2 0 0 1 2-1.7H17',
  love: 'M12 20.5 4.2 12.8a4.9 4.9 0 0 1 6.9-6.9l.9.9.9-.9a4.9 4.9 0 0 1 6.9 6.9Z'
}
export const THUMB_COLOR: Record<Thumb, string> = { down: 'var(--thumb-down)', up: 'var(--thumb-up)', love: 'var(--love)' }

export function ThumbIcon({ t, size = 16, on = true }: { t: Thumb; size?: number; on?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? THUMB_COLOR[t] : 'none'} stroke={THUMB_COLOR[t]} strokeOpacity={on ? 1 : 0.7} strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d={THUMB_PATH[t]} />
    </svg>
  )
}

/**
 * The clickable rating row for the active system: five stars, or thumbs down / up / love.
 * Clicking the current value clears it.
 */
export function RatingButtons({ shot, onPatch, size = 16, className, keys = false }: { shot: Shot; onPatch: (p: ShotPatch) => void; size?: number; className: string; keys?: boolean }) {
  const system = useRatingSystem()
  if (system === 'thumbs') {
    const cur = thumbOf(shot.rating)
    return (
      <div className={`${className} thumbs`} role="radiogroup" aria-label={`Rating: ${cur ? THUMBS.find((x) => x.t === cur)!.label : 'none'}`}>
        {THUMBS.map(({ t, rating, label, key }) => (
          <button key={t} role="radio" aria-checked={cur === t} aria-label={label} title={`${label} (${key})`} className={cur === t ? 'on' : ''} onClick={() => onPatch({ rating: cur === t ? 0 : rating })}>
            <ThumbIcon t={t} size={size} on={cur === t} />
          </button>
        ))}
        {keys && <span className="hint-keys"><span className="key">1</span>–<span className="key">3</span></span>}
      </div>
    )
  }
  return (
    <div className={className} role="radiogroup" aria-label={`Rating ${shot.rating} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={shot.rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={n <= shot.rating ? 'on' : ''} onClick={() => onPatch({ rating: shot.rating === n ? 0 : n })}>
          <svg width={size} height={size} viewBox="0 0 24 24" fill={n <= shot.rating ? 'var(--star)' : 'none'} stroke={n <= shot.rating ? 'none' : 'var(--star)'} strokeOpacity={0.6} strokeWidth="2" aria-hidden>
            <path d={STAR} />
          </svg>
        </button>
      ))}
      {keys && <span className="hint-keys"><span className="key">1</span>–<span className="key">5</span></span>}
    </div>
  )
}

/** Thumbnail badge: "★4" in stars, the thumb or heart glyph in thumbs. Nothing when unrated. */
export function RatingBadge({ rating }: { rating: number }) {
  const system = useRatingSystem()
  if (!rating) return null
  if (system === 'stars') return <span className="badge" aria-label={`${rating} stars`}>★{rating}</span>
  const t = thumbOf(rating)!
  return <span className="badge rbadge" aria-label={ratingText(rating, system)}><ThumbIcon t={t} size={11} /></span>
}

/** "1–5" or "1–3" key caps for the active system's hint lines. */
export function RateKeys() {
  const system = useRatingSystem()
  return <><span className="key">1</span>–<span className="key">{maxKey(system)}</span></>
}
