import { useEffect, useMemo, useState } from 'react'
import type { Shot } from '@shared/types'
import { fmtDate } from '../format'

interface Props {
  shots: Shot[] // everything in the current session, before filters
  session: string
  source: string
  onSource: (s: string) => void
}

const LIVE_MS = 2 * 60_000

export function SessionHeader({ shots, session, source, onSource }: Props) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const cams = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of shots) if (s.source) m.set(s.source, Math.max(m.get(s.source) ?? 0, s.importedAt))
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [shots])

  const picks = shots.filter((s) => s.flag === 1).length
  const rejects = shots.filter((s) => s.flag === -1).length

  return (
    <div className="sesshead">
      <h2>{session ? fmtDate(session) : 'All sessions'}</h2>
      <div className="cams">
        {cams.map(([name, last]) => (
          <button key={name} className={`cam ${now - last < LIVE_MS ? '' : 'idle'} ${source === name ? 'on' : ''}`} aria-pressed={source === name} onClick={() => onSource(source === name ? '' : name)} title={`Only ${name}`}>
            <i />
            {name}
          </button>
        ))}
      </div>
      <span className="muted count-line">
        {shots.length} shots · {picks} picks · {rejects} rejects
      </span>
    </div>
  )
}
