import { useEffect, useState } from 'react'
import type { RemoteEntry } from '@shared/remote'
import { api } from '../api'

/** Confirms deleting files or folders on a destination. Names the destination, says where they go, and focuses Cancel. */
export function DeleteFromDest({ dest, targets, onClose, onDone }: { dest: { id: string; name: string }; targets: RemoteEntry[]; onClose: () => void; onDone: (deleted: number) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  const folders = targets.filter((t) => t.dir).length
  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      onDone((await api.deleteFrom(dest.id, { paths: targets.map((t) => t.path) })).deleted)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="bw-modal" onClick={onClose}>
      <div className="bw-modal-box" role="alertdialog" aria-modal="true" aria-labelledby="bw-del-h" onClick={(e) => e.stopPropagation()}>
        <h2 id="bw-del-h">Delete {targets.length === 1 ? targets[0]!.name : `${targets.length} items`} from {dest.name}?</h2>
        <p>
          {folders ? 'Folders are deleted with everything in them. ' : ''}They go to the destination's trash where it has one. Your copies on this PC are not touched, and anything not sent yet can be sent again.
        </p>
        {targets.length > 1 && (
          <ul>
            {targets.slice(0, 6).map((t) => <li key={t.path}>{t.dir ? '📁 ' : ''}{t.name}</li>)}
            {targets.length > 6 && <li>and {targets.length - 6} more</li>}
          </ul>
        )}
        {err && <p className="bw-modal-err" role="alert">{err}</p>}
        <div className="bw-modal-actions">
          <button className="tb" autoFocus onClick={onClose}>Cancel</button>
          <button className="tb danger" disabled={busy} onClick={() => void go()}>{busy ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  )
}
