import { useEffect, useState } from 'react'
import type { DeletePreview, Shot } from '@shared/types'
import { api } from '../api'
import './DeleteConfirm.css'

/**
 * Confirms a delete and says where it reaches: the destinations that will delete their copies too (mirror deletes)
 * are named, and so are the ones that keep theirs.
 */
export function DeleteConfirm({ shots, onConfirm, onClose }: { shots: Shot[]; onConfirm: () => void; onClose: () => void }) {
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [failed, setFailed] = useState(false)
  const ids = shots.map((s) => s.id).join(',')

  useEffect(() => {
    let live = true
    api.deletePreview(shots.map((s) => s.id)).then(
      (p) => live && setPreview(p),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [ids]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!preview || failed
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter' && ready) onConfirm()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ready, onConfirm, onClose])

  const one = shots.length === 1
  const what = one ? shots[0].files.map((f) => f.name).join(' + ') : `${shots.length} photos`
  const mirrored = preview?.mirrored ?? []
  const kept = preview?.kept ?? []

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal dc" role="alertdialog" aria-label={`Delete ${what}?`} onClick={(e) => e.stopPropagation()}>
        <h2>Delete {one ? 'this photo' : `${shots.length} photos`}?</h2>
        <p className="muted small">
          {one ? <span className="mono">{what}</span> : what} {one && shots[0].files.length === 1 ? 'goes' : 'go'} to the recycle bin on this computer.
        </p>
        {!ready && <p className="muted small">Checking synced copies…</p>}
        {failed && <p className="muted small">Couldn't check where copies were synced. Destinations set to mirror deletes will still delete theirs.</p>}
        {mirrored.length > 0 && (
          <div className="dc-group dc-del">
            <div className="dc-lbl">Also deleted from</div>
            <ul>
              {mirrored.map((d) => (
                <li key={d.id}>
                  <strong>{d.name}</strong>
                  <span className="muted small">{d.files} {d.files === 1 ? 'file' : 'files'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {kept.length > 0 && (
          <div className="dc-group">
            <div className="dc-lbl">Copies stay in</div>
            <ul>
              {kept.map((d) => (
                <li key={d.id}>
                  <strong>{d.name}</strong>
                  <span className="muted small">{d.files} {d.files === 1 ? 'file' : 'files'}</span>
                </li>
              ))}
            </ul>
            <div className="muted small">Each destination can be set to delete too, in Sync ⋯.</div>
          </div>
        )}
        <div className="dc-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm} disabled={!ready} autoFocus>
            {mirrored.length ? `Delete from ${mirrored.length + 1} places` : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
