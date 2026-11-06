import { useEffect, useMemo, useState } from 'react'
import type { Shot } from '@shared/types'

interface Props {
  shots: Shot[] // everything in the current session, before filters
  source: string
  onSource: (s: string) => void
}

const LIVE_MS = 2 * 60_000

/** One chip per camera, only when there is more than one: tap to see just that camera's frames. */
export function SessionHeader({ shots, source, onSource }: Props) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const cams = useMemo(() => {
    const m = new Map<string, { last: number; n: number }>()
    for (const s of shots) if (s.source) m.set(s.source, { last: Math.max(m.get(s.source)?.last ?? 0, s.importedAt), n: (m.get(s.source)?.n ?? 0) + 1 })
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [shots])

  if (cams.length < 2) return null
  return (
    <div className="camchips" role="group" aria-label="Cameras">
      {cams.map(([name, c]) => (
        <button key={name} className={`chip ${source === name ? 'on' : ''}`} aria-pressed={source === name} onClick={() => onSource(source === name ? '' : name)} title={`Only ${name}`}>
          <span className={`dot ${now - c.last < LIVE_MS ? 'live' : ''}`} style={now - c.last < LIVE_MS ? undefined : { background: '#555' }} />
          {name} <span className="n">{c.n}</span>
        </button>
      ))}
    </div>
  )
}
