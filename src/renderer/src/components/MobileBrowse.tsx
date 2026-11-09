import { useEffect, useRef, useState } from 'react'
import type { RemoteEntry } from '@shared/remote'
import { api } from '../api'
import { fmtSize } from '../format'
import { crumbsOf, hasThumb, parentOf, RemoteThumb, useBrowse, type BrowseDest } from './Browse'
import { BrowseActions } from './BrowseActions'
import { BrowseBody, isMedia, StateChips, useBrowseView, useShowAll, viewsFor, VIEW_LABEL, type StateFilter } from './BrowseViews'
import { useBrowseMenu } from './useBrowseMenu'

/**
 * Phone version of Browse: same listing and views. Tap a file to see it and "Save to this phone"; Select turns taps into a
 * selection for Import and Copy; press and hold (or ⋯ in Details) for the file menu.
 */
export function MobileBrowse({ dest, onClose, initialPath = '', diff = false }: { dest: BrowseDest; onClose: () => void; initialPath?: string; diff?: boolean }) {
  const b = useBrowse(dest.id, initialPath, diff)
  const [view, setView] = useBrowseView(diff)
  const [showAll, setShowAll] = useShowAll()
  const [sel, setSel] = useState<RemoteEntry | null>(null)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState<StateFilter>('all')
  const [copyReq, setCopyReq] = useState({ n: 0 })
  const crumbs = useRef<HTMLElement>(null)
  useEffect(() => { setPicked(new Set()); setFilter('all') }, [b.path])
  useEffect(() => { if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth }, [b.path])

  const all = b.res?.entries ?? []
  const entries = all.filter((e) => showAll || isMedia(e))
  const hidden = all.length - entries.length
  const files = entries.filter((e) => !e.dir)
  const toggle = (path: string): void => setPicked((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n })
  const go = (p: string): void => { setSel(null); b.setPath(p) }
  const back = (): void => {
    if (sel) return setSel(null)
    if (b.path) return go(parentOf(b.path))
    onClose()
  }

  const menu = useBrowseMenu({
    dest, diff, path: b.path, views: viewsFor(diff), view, setView, showAll, setShowAll: (v) => void setShowAll(v), selected: picked,
    onOpen: (e) => (e.dir ? go(e.path) : setSel(e)),
    onSelectOnly: (p) => { setPicking(true); setPicked(new Set([p])) },
    onToggle: toggle,
    onSelectAll: () => { setPicking(true); setPicked(new Set(files.filter((f) => f.state !== 'waiting').map((f) => f.path))) },
    onCopy: () => setCopyReq((r) => ({ n: r.n + 1 })), onRefresh: () => void b.reload(), onNote: setNote,
    entries: all
  })

  return (
    <div className="bw mobile" role="dialog" aria-label={`Browse ${dest.name}`}>
      <div className="bw-head">
        <button className="tb" onClick={back} aria-label={b.path || sel ? 'Back' : 'Close'}>{b.path || sel ? '← Back' : '✕ Close'}</button>
        <span className="bw-meta" style={{ flex: 1, textAlign: 'right' }}>{b.res?.meta?.name ?? ''}{b.res && !b.res.fresh ? ' updating…' : ''}</span>
        <button className="tb" aria-haspopup="menu" aria-label="View" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); menu.openView(r.right - 230, r.bottom + 4) }}>{VIEW_LABEL[view].glyph} ▾</button>
        <button className="tb" aria-pressed={picking} onClick={() => { setPicking(!picking); setPicked(new Set()) }}>{picking ? 'Done' : 'Select'}</button>
        <nav className="bw-crumbs" aria-label="Path" ref={crumbs}>
          <button onClick={() => go('')} aria-current={b.path ? undefined : 'page'} className={b.path ? '' : 'on'}>{dest.name}</button>
          {crumbsOf(b.path).map((c, i, a) => <span key={c.path}><i aria-hidden>›</i><button onClick={() => go(c.path)} aria-current={i === a.length - 1 ? 'page' : undefined} className={i === a.length - 1 ? 'on' : ''}>{c.name}</button></span>)}
        </nav>
      </div>
      {b.error && <div className="bw-banner">{b.error.offline ? `Can't reach ${dest.name} right now.${b.res ? ' Showing what was there last time.' : ''}` : b.error.message}</div>}
      {diff && files.some((f) => f.state) && view !== 'groups' && <StateChips files={files} value={filter} onChange={setFilter} />}
      <div className="bw-body">
        {b.loading && !b.res && <div className="bw-empty">Loading…</div>}
        {!b.loading && !b.res && b.error && <div className="bw-empty">{b.error.offline ? 'Offline, and nothing was saved from before.' : 'Could not list this folder.'}</div>}
        {b.res && !entries.length && <div className="bw-empty">{hidden ? 'No photos or videos here. Show all files to see the rest.' : 'This folder is empty.'}</div>}
        {entries.length > 0 && (
          <BrowseBody destName={dest.name} entries={entries} view={view} filter={filter} sel={picked} thumb={(e) => <RemoteThumb destId={dest.id} e={e} />}
            onFile={(f) => { if (f.state === 'waiting') return; if (picking) toggle(f.path); else setSel(f) }}
            onDir={(d) => (picking ? toggle(d.path) : go(d.path))} onSelect={(d) => { setPicking(true); toggle(d.path) }} onMenu={menu.openAt} />
        )}
      </div>
      {!sel && (hidden > 0 || showAll) && (
        <div className="bw-foot">
          <span>{showAll ? 'Showing all files' : `${hidden} other file${hidden === 1 ? '' : 's'} hidden`} · <button className="bw-lnk" onClick={() => void setShowAll(!showAll)}>{showAll ? 'Media only' : 'Show all'}</button></span>
        </div>
      )}
      {sel && (
        <div className="bw-sheet">
          {sel.kind === 'jpeg' || hasThumb(sel) ? <img src={sel.kind === 'jpeg' ? api.remoteFileUrl(dest.id, sel.path) : api.remoteThumbUrl(dest.id, sel)} alt={sel.name} style={{ maxHeight: '45vh', objectFit: 'contain', borderRadius: 8 }} /> : null}
          {sel.kind === 'video' && <video src={api.remoteFileUrl(dest.id, sel.path)} controls playsInline style={{ maxHeight: '45vh', borderRadius: 8 }} />}
          <div className="sx-sub">{sel.name} · {fmtSize(sel.size)}</div>
          <a href={api.remoteFileUrl(dest.id, sel.path, true)} download={sel.name}>Save to this phone</a>
        </div>
      )}
      {note && <div className="bw-note-bar">{note}</div>}
      {!sel && <BrowseActions dest={dest} path={b.path} picked={all.filter((e) => picked.has(e.path))} entries={all} meta={b.res?.meta} diff={diff} mobile panelRequest={copyReq} onNote={setNote} onReload={() => void b.reload()} />}
      {menu.node}
    </div>
  )
}
