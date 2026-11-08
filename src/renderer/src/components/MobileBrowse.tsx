import { useEffect, useState } from 'react'
import type { RemoteEntry } from '@shared/remote'
import { api } from '../api'
import { fmtSize } from '../format'
import { crumbsOf, hasThumb, RemoteThumb, useBrowse, type BrowseDest } from './Browse'
import { BrowseActions, STATE_LABEL } from './BrowseActions'

/** Phone version of Browse: same listing, tap a file to see it and "Save to this phone"; Select turns taps into a selection for Import and Copy. */
export function MobileBrowse({ dest, onClose, initialPath = '', diff = false }: { dest: BrowseDest; onClose: () => void; initialPath?: string; diff?: boolean }) {
  const b = useBrowse(dest.id, initialPath, diff)
  const [sel, setSel] = useState<RemoteEntry | null>(null)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  useEffect(() => setPicked(new Set()), [b.path])
  const entries = b.res?.entries ?? []
  const dirs = entries.filter((e) => e.dir)
  const files = entries.filter((e) => !e.dir)
  const toggle = (e: RemoteEntry): void => setPicked((s) => { const n = new Set(s); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n })
  const back = (): void => {
    if (sel) return setSel(null)
    if (b.path) return b.setPath(crumbsOf(b.path).slice(0, -1).pop()?.path ?? '')
    onClose()
  }
  return (
    <div className="bw mobile" role="dialog" aria-label={`Browse ${dest.name}`}>
      <div className="bw-head">
        <button className="tb" onClick={back}>← {b.path || sel ? 'Back' : 'Sync'}</button>
        <span className="bw-meta" style={{ flex: 1, textAlign: 'right' }}>{b.res?.meta?.name ?? ''}{b.res && !b.res.fresh ? ' updating…' : ''}</span>
        <button className="tb" aria-pressed={picking} onClick={() => { setPicking(!picking); setPicked(new Set()) }}>{picking ? 'Done' : 'Select'}</button>
        <nav className="bw-crumbs" aria-label="Path">
          <button onClick={() => { setSel(null); b.setPath('') }} className={b.path ? '' : 'on'}>{dest.name}</button>
          {crumbsOf(b.path).map((c) => <span key={c.path}>/<button onClick={() => { setSel(null); b.setPath(c.path) }}>{c.name}</button></span>)}
        </nav>
      </div>
      {b.error && <div className="bw-banner">{b.error.offline ? `Can't reach ${dest.name} right now.${b.res ? ' Showing what was there last time.' : ''}` : b.error.message}</div>}
      <div className="bw-body">
        {b.loading && !b.res && <div className="bw-empty">Loading…</div>}
        {!b.loading && !b.res && b.error && <div className="bw-empty">{b.error.offline ? 'Offline, and nothing was saved from before.' : 'Could not list this folder.'}</div>}
        {b.res && !entries.length && <div className="bw-empty">This folder is empty.</div>}
        {dirs.length > 0 && (
          <div className="bw-dirs">
            {dirs.map((d) => (
              <span key={d.path} className={`bw-dir-wrap ${picked.has(d.path) ? 'sel' : ''}`}>
                {picking && <input type="checkbox" aria-label={`Select ${d.name}`} checked={picked.has(d.path)} onChange={() => toggle(d)} />}
                <button className="bw-dir" onClick={() => b.setPath(d.path)}><span aria-hidden>📁</span>{d.name}</button>
              </span>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="bw-grid">
            {files.map((f) => (
              <button key={f.path} className={`bw-tile ${f.inLibrary ? 'in' : ''} ${picked.has(f.path) ? 'sel' : ''}`} onClick={() => (picking ? f.state !== 'waiting' && toggle(f) : f.state !== 'waiting' && setSel(f))} aria-label={f.name}>
                <RemoteThumb destId={dest.id} e={f} />
                {f.state ? <span className={`bw-st ${f.state}`}>{STATE_LABEL[f.state]}</span> : f.inLibrary && <span className="bw-in">On PC</span>}
                {picked.has(f.path) && <span className="bw-check" aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {sel && (
        <div className="bw-sheet">
          {sel.kind === 'jpeg' || hasThumb(sel) ? <img src={sel.kind === 'jpeg' ? api.remoteFileUrl(dest.id, sel.path) : api.remoteThumbUrl(dest.id, sel)} alt={sel.name} style={{ maxHeight: '45vh', objectFit: 'contain', borderRadius: 8 }} /> : null}
          {sel.kind === 'video' && <video src={api.remoteFileUrl(dest.id, sel.path)} controls playsInline style={{ maxHeight: '45vh', borderRadius: 8 }} />}
          <div className="sx-sub">{sel.name} · {fmtSize(sel.size)}</div>
          <a href={api.remoteFileUrl(dest.id, sel.path, true)} download={sel.name}>Save to this phone</a>
        </div>
      )}
      {note && <div className="bw-note-bar">{note}</div>}
      {!sel && <BrowseActions dest={dest} path={b.path} picked={entries.filter((e) => picked.has(e.path))} entries={entries} meta={b.res?.meta} diff={diff} mobile onNote={setNote} onReload={() => void b.reload()} />}
    </div>
  )
}
