import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowseResult, RemoteEntry } from '@shared/remote'
import { api } from '../api'
import { fmtSize } from '../format'
import { BrowseActions, STATE_LABEL } from './BrowseActions'
import './Browse.css'

export interface BrowseDest { id: string; name: string }

/** Cached listing first, then the live one: `browse:updated` (or a short re-ask while the answer is cached) swaps it in. */
export function useBrowse(destId: string, initialPath = '', diff = false) {
  const [path, setPath] = useState(initialPath)
  const [res, setRes] = useState<BrowseResult | null>(null)
  const [error, setError] = useState<{ message: string; offline: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const pathRef = useRef(path)
  pathRef.current = path

  const load = useCallback(
    async (p: string, quiet = false): Promise<void> => {
      if (!quiet) setLoading(true)
      try {
        const r = await api.browse(destId, p, diff)
        if (pathRef.current !== p) return
        setRes(r)
        setError(null)
      } catch (e) {
        if (pathRef.current !== p) return
        const message = (e as Error).message
        setError({ message, offline: /reach|offline|timeout|timed out|connection|dial|network/i.test(message) })
        if (!quiet) setRes(null)
      } finally {
        if (!quiet && pathRef.current === p) setLoading(false)
      }
    },
    [destId, diff]
  )

  useEffect(() => {
    void load(path)
  }, [load, path])

  useEffect(() => api.onBrowseUpdated((id, p) => { if (id === destId && p === pathRef.current) void load(p, true) }), [destId, load])

  // Tunnels don't carry SSE; a cached answer is asked again once the live list has had time to finish.
  useEffect(() => {
    if (!res || res.fresh) return
    const t = setTimeout(() => void load(pathRef.current, true), 4000)
    return () => clearTimeout(t)
  }, [res, load])

  return { path, setPath, res, error, loading, reload: () => load(path) }
}

export const crumbsOf = (path: string): { name: string; path: string }[] => {
  const parts = path.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
}

export const hasThumb = (e: RemoteEntry): boolean => e.kind === 'jpeg' || e.kind === 'raw' || e.kind === 'heif'

/** A thumbnail that falls back to a generic tile while loading, on 204 (no preview) and on errors. */
export function RemoteThumb({ destId, e }: { destId: string; e: RemoteEntry }) {
  const [state, setState] = useState<'loading' | 'ok' | 'none'>(hasThumb(e) ? 'loading' : 'none')
  return (
    <>
      {state !== 'ok' && <div className="bw-ph">{state === 'loading' ? '—' : e.kind === 'video' ? '▶' : (e.name.split('.').pop() ?? '').toUpperCase().slice(0, 4)}</div>}
      {hasThumb(e) && state !== 'none' && (
        <img src={api.remoteThumbUrl(destId, e)} alt="" loading="lazy" onLoad={() => setState('ok')} onError={() => setState('none')} style={state === 'ok' ? undefined : { opacity: 0 }} />
      )}
    </>
  )
}

export function Viewer({ destId, e, onClose }: { destId: string; e: RemoteEntry; onClose: () => void }) {
  useEffect(() => {
    const k = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="bw-viewer" onClick={onClose}>
      <div className="bw-v-bar" onClick={(ev) => ev.stopPropagation()}>
        <strong>{e.name}</strong>
        <span>{fmtSize(e.size)}</span>
        <a className="tb" href={api.remoteFileUrl(destId, e.path, true)} download={e.name}>Save a copy</a>
        <button className="tb" onClick={onClose}>Close</button>
      </div>
      <div className="bw-v-stage" onClick={(ev) => ev.stopPropagation()}>
        {e.kind === 'jpeg' ? <img src={api.remoteFileUrl(destId, e.path)} alt={e.name} />
          : e.kind === 'video' ? <video src={api.remoteFileUrl(destId, e.path)} controls autoPlay />
          : hasThumb(e) ? <><img src={api.remoteThumbUrl(destId, e)} alt={e.name} /><p className="bw-note">Preview only. Use Save a copy for the original.</p></>
          : <p className="bw-note">No preview for this file type.</p>}
      </div>
    </div>
  )
}

/** Look inside a destination. Browsing never changes what is stored there; the action bar does only what you click. */
export function Browse({ dest, onClose, initialPath = '', diff = false }: { dest: BrowseDest; onClose: () => void; initialPath?: string; diff?: boolean }) {
  const b = useBrowse(dest.id, initialPath, diff)
  const [open, setOpen] = useState<RemoteEntry | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  useEffect(() => {
    const k = (ev: KeyboardEvent): void => { if (ev.key === 'Escape' && !open) onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose, open])
  useEffect(() => setSel(new Set()), [b.path])
  const entries = b.res?.entries ?? []
  const dirs = entries.filter((e) => e.dir)
  const files = entries.filter((e) => !e.dir)
  const toggle = (e: RemoteEntry): void => setSel((s) => { const n = new Set(s); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n })
  const picked = entries.filter((e) => sel.has(e.path))
  return (
    <div className="bw" role="dialog" aria-label={`Browse ${dest.name}`}>
      <div className="bw-head">
        <button className="tb" onClick={onClose}>← Back</button>
        <nav className="bw-crumbs" aria-label="Path">
          <button onClick={() => b.setPath('')} className={b.path ? '' : 'on'}>{dest.name}</button>
          {crumbsOf(b.path).map((c) => <span key={c.path}>/<button onClick={() => b.setPath(c.path)}>{c.name}</button></span>)}
        </nav>
        <span className="bw-meta">{b.res?.meta ? b.res.meta.name : ''}{b.res && !b.res.fresh ? ' · updating…' : ''}</span>
        <button className="tb" onClick={() => void b.reload()}>Refresh</button>
      </div>
      {b.error && <div className="bw-banner">{b.error.offline ? `Can't reach ${dest.name} right now.${b.res ? ' Showing what was there last time.' : ''}` : b.error.message}</div>}
      <div className="bw-body">
        {b.loading && !b.res && <div className="bw-empty">Loading…</div>}
        {!b.loading && !b.res && b.error && <div className="bw-empty">{b.error.offline ? 'Offline, and nothing was saved from before.' : 'Could not list this folder.'}</div>}
        {b.res && !entries.length && <div className="bw-empty">This folder is empty.</div>}
        {dirs.length > 0 && (
          <div className="bw-dirs">
            {dirs.map((d) => (
              <span key={d.path} className={`bw-dir-wrap ${sel.has(d.path) ? 'sel' : ''}`}>
                <input type="checkbox" aria-label={`Select ${d.name}`} checked={sel.has(d.path)} onChange={() => toggle(d)} />
                <button className="bw-dir" onClick={() => b.setPath(d.path)}><span aria-hidden>📁</span>{d.name}</button>
              </span>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="bw-grid">
            {files.map((f) => (
              <button key={f.path} className={`bw-tile ${f.inLibrary ? 'in' : ''} ${sel.has(f.path) ? 'sel' : ''}`} title={`${f.name} · ${fmtSize(f.size)}`} onClick={() => f.state !== 'waiting' && toggle(f)} onDoubleClick={() => f.state !== 'waiting' && setOpen(f)} onKeyDown={(ev) => ev.key === 'Enter' && f.state !== 'waiting' && setOpen(f)}>
                <RemoteThumb destId={dest.id} e={f} />
                <span className="bw-cap">{f.name}</span>
                {f.state ? <span className={`bw-st ${f.state}`}>{STATE_LABEL[f.state]}</span> : f.inLibrary && <span className="bw-in">On this PC</span>}
                {sel.has(f.path) && <span className="bw-check" aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {note && <div className="bw-note-bar">{note}</div>}
      <BrowseActions dest={dest} path={b.path} picked={picked} entries={entries} meta={b.res?.meta} diff={diff} onNote={setNote} onReload={() => void b.reload()} />
      {open && <Viewer destId={dest.id} e={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
