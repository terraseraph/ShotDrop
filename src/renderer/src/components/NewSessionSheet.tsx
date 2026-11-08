import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import './NewSessionSheet.css'

// ---- current session: one shared copy for the rail, the phone list and anything else that shows it ----
export interface CurrentSession { folder: string | null; endsAt: number | null }
const NONE: CurrentSession = { folder: null, endsAt: null }
let cur: CurrentSession = NONE
let started = false
let timer: ReturnType<typeof setTimeout> | undefined
const subs = new Set<() => void>()

async function refresh(): Promise<void> {
  try {
    const next = await api.currentSession()
    if (next.folder !== cur.folder || next.endsAt !== cur.endsAt) {
      cur = next
      subs.forEach((f) => f())
    }
  } catch {
    /* offline or not signed in yet: keep what we have */
  }
  clearTimeout(timer)
  if (cur.endsAt) timer = setTimeout(() => void refresh(), Math.max(1000, cur.endsAt - Date.now() + 500))
}

/** The session new photos are filed into (null = the shoot-date folders), kept fresh through SSE `session:changed`. */
export function useCurrentSession(): CurrentSession & { set: (folder: string | null, endAfterMin?: number) => Promise<void> } {
  const state = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => cur)
  useEffect(() => {
    if (started) return
    started = true
    void refresh()
    api.onSessionChanged(() => void refresh())
  }, [])
  const set = useCallback(async (folder: string | null, endAfterMin?: number) => {
    cur = { folder, endsAt: folder && endAfterMin ? Date.now() + endAfterMin * 60_000 : null } // optimistic; the server's answer replaces it
    subs.forEach((f) => f())
    try {
      await api.setCurrentSession(folder, endAfterMin)
    } finally {
      await refresh()
    }
  }, [])
  return { ...state, set }
}

const today = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const ENDS: [string, number][] = [['Never (until I end it)', 0], ['4 hours', 240], ['8 hours', 480], ['12 hours', 720], ['24 hours', 1440]]

/** Name a new session and say whether new photos should start going into it. */
export function NewSessionSheet({ onClose, onCreated }: { onClose: () => void; onCreated?: (folder: string) => void }) {
  const [name, setName] = useState('')
  const [client, setClient] = useState('')
  const [date, setDate] = useState(today())
  const [makeCurrent, setMakeCurrent] = useState(true)
  const [endAfter, setEndAfter] = useState(720)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const row = await api.createSession({
        name: name.trim(),
        client: client.trim() || undefined,
        date: date || undefined,
        makeCurrent,
        endAfterMin: makeCurrent && endAfter ? endAfter : undefined
      })
      onCreated?.(row.folder)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the session')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-backdrop scrim" onClick={onClose}>
      <form className="modal nss" role="dialog" aria-label="New session" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <h2>New session</h2>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Smith wedding" maxLength={80} autoFocus />
        </label>
        <div className="row">
          <label className="field">
            <span className="field-label">Client (optional)</span>
            <input className="input" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Smith" maxLength={200} />
          </label>
          <label className="field">
            <span className="field-label">Date</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <label className="nss-check">
          <input type="checkbox" checked={makeCurrent} onChange={(e) => setMakeCurrent(e.target.checked)} />
          <span>Make it the current session<span className="field-hint"> New photos from cameras go into it, whatever their date.</span></span>
        </label>
        {makeCurrent && (
          <label className="field">
            <span className="field-label">End automatically after</span>
            <select className="select" value={endAfter} onChange={(e) => setEndAfter(Number(e.target.value))}>
              {ENDS.map(([label, min]) => <option key={min} value={min}>{label}</option>)}
            </select>
          </label>
        )}
        {error && <p className="small" style={{ color: 'var(--reject-text)' }}>{error}</p>}
        <div className="nss-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create session'}</button>
        </div>
      </form>
    </div>,
    document.body
  )
}
