import { desktop } from '../api'

interface Failed {
  name: string
  path: string
  error: string
}

/** Shown when a delete left files on disk. The shot stays in the gallery so the user can retry or remove it by hand. */
export function DeleteWarning({ failed, onClose }: { failed: Failed[]; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="alertdialog" aria-label="Couldn't delete from disk" onClick={(e) => e.stopPropagation()}>
        <h2>Couldn't delete from disk</h2>
        <p className="muted small">
          {failed.length === 1 ? 'This file is' : 'These files are'} still on your drive, so the photo stays in the gallery. Close
          whatever has {failed.length === 1 ? 'it' : 'them'} open (an editor, a viewer, antivirus scan) and press Delete again.
        </p>
        <ul className="files">
          {failed.map((f) => (
            <li key={f.path}>
              <span>
                <span className="mono">{f.name}</span>
                <span className="muted small"> · {f.error}</span>
              </span>
              {desktop && (
                <button className="link-btn" onClick={() => void desktop?.reveal(f.path)}>
                  Show in folder
                </button>
              )}
            </li>
          ))}
        </ul>
        <button className="btn primary" onClick={onClose} autoFocus>
          OK
        </button>
      </div>
    </div>
  )
}
