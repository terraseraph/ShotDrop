import { useState } from 'react'
import type { DestinationFilter } from '@shared/types'
import { isRemote } from '../api'
import { useRemoteSessions } from '../remoteSessions'
import { Browse } from './Browse'
import { MobileBrowse } from './MobileBrowse'
import './SessionDestChips.css'

export const FILTER_BADGE: Record<DestinationFilter, string> = { all: '', jpeg: 'JPEG', raw: 'RAW', picks: 'Picks' }

/** Phones (and any narrow window) get the phone Browse. */
export const useIsPhone = (): boolean => isRemote || (typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches)

/**
 * One chip per destination under a session in the rail: `sent/total`, a filter badge (none for All) and a bin when the
 * destination mirrors deletes. Tapping a chip opens Browse on that session folder in diff mode.
 */
export function SessionDestChips({ folder }: { folder: string }) {
  const { sessions, dests } = useRemoteSessions()
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null)
  const phone = useIsPhone()
  const row = sessions?.mine.find((m) => m.folder === folder)
  if (!row || !row.perDest.length) return null
  return (
    <div className="sdc" aria-label="Destinations">
      {row.perDest.map((p) => {
        const d = dests.find((x) => x.id === p.destId)
        if (!d) return null
        const badge = FILTER_BADGE[d.filter]
        const done = p.total > 0 && p.sent >= p.total
        return (
          <button key={p.destId} className={`sdc-chip ${done ? 'ok' : p.errors ? 'bad' : 'run'}`} title={`${d.name}: ${p.sent} of ${p.total} sent${p.errors ? `, ${p.errors} failed` : ''}. Open to compare.`} onClick={() => setOpen({ id: d.id, name: d.name })}>
            <span className="sdc-name">{d.name}</span>
            <span className="sdc-n mono">{p.sent}/{p.total}</span>
            {badge && <span className="sdc-badge">{badge}</span>}
            {d.mirrorDeletes && <span className="sdc-bin" title="Deletes here too" aria-label="Mirrors deletes">🗑</span>}
          </button>
        )
      })}
      {open && (phone ? <MobileBrowse dest={open} initialPath={folder} diff onClose={() => setOpen(null)} /> : <Browse dest={open} initialPath={folder} diff onClose={() => setOpen(null)} />)}
    </div>
  )
}
