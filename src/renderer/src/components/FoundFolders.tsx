import { useState } from 'react'
import { useRemoteSessions } from '../remoteSessions'
import { Browse } from './Browse'
import { MobileBrowse } from './MobileBrowse'
import { useIsPhone } from './SessionDestChips'
import './SessionDestChips.css'

/** "Found on destinations": folders that exist on a destination but not in this library. A chip opens Browse on it. */
export function FoundFolders() {
  const { sessions, dests } = useRemoteSessions()
  const [open, setOpen] = useState<{ dest: { id: string; name: string }; path: string } | null>(null)
  const phone = useIsPhone()
  const found = sessions?.found ?? []
  if (!found.length) return null
  return (
    <>
      <div className="gx-rail-h" style={{ paddingTop: 16 }}>FOUND ON DESTINATIONS</div>
      {found.map((g) => (
        <div key={g.key} className="ff-group">
          <div className="ff-name" title={g.folder}>{g.meta?.name || g.folder}</div>
          <div className="sdc">
            {g.perDest.map((p) => {
              const d = dests.find((x) => x.id === p.destId)
              if (!d) return null
              return (
                <button key={p.destId} className={`sdc-chip ${p.offline ? 'off' : 'run'}`} onClick={() => setOpen({ dest: { id: d.id, name: d.name }, path: g.folder })} title={p.offline ? `${d.name} is offline` : `Open ${g.folder} on ${d.name}`}>
                  <span className="sdc-name">{d.name}</span>
                  <span className="sdc-n mono">{p.offline ? 'offline' : p.count ?? '—'}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {open && (phone ? <MobileBrowse dest={open.dest} initialPath={open.path} onClose={() => setOpen(null)} /> : <Browse dest={open.dest} initialPath={open.path} onClose={() => setOpen(null)} />)}
    </>
  )
}
