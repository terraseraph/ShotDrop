import { useEffect, useState } from 'react'
import type { Session } from '@shared/types'
import type { SessionRow } from '@shared/remote'
import { api } from '../api'
import { fmtDay } from '../sessions'
import { Dialog } from './Dialog'
import './MoveToSessionSheet.css'

type Row = Session & SessionRow

/** Pick the session the chosen photos move into (or make a new one). Remote copies are moved by the server's op queue. */
export function MoveToSessionSheet({ ids, fromSession, onClose, onMoved }: { ids: number[]; fromSession: string; onClose: () => void; onMoved: (moved: number, folder: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    api.sessions().then((r) => live && setRows(r), (e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [])

  const move = async (folder: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const { moved } = await api.moveToSession(folder, ids)
      onMoved(moved, folder)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    setError('')
    try {
      const made = await api.createSession({ name: name.trim() })
      await move(made.folder)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog title={`Move ${ids.length} photo${ids.length === 1 ? '' : 's'} to session`} onClose={onClose}>
      <div className="mv-body">
        <form
          className="mv-new"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <input className="mv-input" placeholder="+ New session name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={busy} aria-label="New session name" />
          <button className="tb primary" type="submit" disabled={busy || !name.trim()}>
            Create and move
          </button>
        </form>
        <div className="mv-list" role="list">
          {rows === null && !error && <div className="mv-empty">Loading sessions…</div>}
          {rows?.length === 0 && <div className="mv-empty">No sessions yet. Create one above.</div>}
          {rows?.map((r) => (
            <button key={r.folder} role="listitem" className="mv-row" disabled={busy || r.folder === fromSession} onClick={() => void move(r.folder)}>
              <span className="mv-name">{r.meta?.name ? `${fmtDay(r.folder)} · ${r.meta.name}` : fmtDay(r.folder)}</span>
              <span className="mv-count">{r.folder === fromSession ? 'current' : `${r.count}`}</span>
            </button>
          ))}
        </div>
        {error && <div className="mv-error" role="alert">{error}</div>}
        <p className="mv-note">Photos already sent to a destination are moved there too, not uploaded again.</p>
      </div>
    </Dialog>
  )
}
