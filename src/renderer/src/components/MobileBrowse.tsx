import { useState } from 'react'
import type { RemoteEntry } from '@shared/remote'
import { api } from '../api'
import { fmtSize } from '../format'
import { crumbsOf, hasThumb, RemoteThumb, useBrowse, type BrowseDest } from './Browse'

/** Phone version of Browse: same read-only listing, tap a file to see it and "Save to this phone". */
export function MobileBrowse({ dest, onClose }: { dest: BrowseDest; onClose: () => void }) {
  const b = useBrowse(dest.id)
  const [sel, setSel] = useState<RemoteEntry | null>(null)
  const entries = b.res?.entries ?? []
  const dirs = entries.filter((e) => e.dir)
  const files = entries.filter((e) => !e.dir)
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
            {dirs.map((d) => <button key={d.path} className="bw-dir" onClick={() => b.setPath(d.path)}><span aria-hidden>📁</span>{d.name}</button>)}
          </div>
        )}
        {files.length > 0 && (
          <div className="bw-grid">
            {files.map((f) => (
              <button key={f.path} className={`bw-tile ${f.inLibrary ? 'in' : ''}`} onClick={() => setSel(f)} aria-label={f.name}>
                <RemoteThumb destId={dest.id} e={f} />
                {f.inLibrary && <span className="bw-in">On PC</span>}
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
    </div>
  )
}
