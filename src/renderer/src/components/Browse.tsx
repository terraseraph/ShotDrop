import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowseResult, RemoteEntry } from '@shared/remote'
import { api, isRemote } from '../api'
import { fmtSize } from '../format'
import { BrowseActions } from './BrowseActions'
import { BrowseBody, isMedia, StateChips, useBrowseView, useShowAll, viewsFor, VIEW_LABEL, type StateFilter } from './BrowseViews'
import { DeleteFromDest } from './DeleteFromDest'
import { FolderTree } from './FolderTree'
import { useBrowseMenu } from './useBrowseMenu'
import './Browse.css'
import './BrowseViews.css'

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

export const parentOf = (path: string): string => path.split('/').filter(Boolean).slice(0, -1).join('/')

/** Back / forward / up over the folders you have visited, like a file manager. `go` is for every deliberate move; back and forward replay. */
export function useNav(path: string, setPath: (p: string) => void) {
  const [past, setPast] = useState<string[]>([])
  const [future, setFuture] = useState<string[]>([])
  const go = (p: string): void => {
    if (p === path) return
    setPast((h) => [...h, path])
    setFuture([])
    setPath(p)
  }
  const back = (): void => {
    const p = past[past.length - 1]
    if (p === undefined) return
    setPast(past.slice(0, -1))
    setFuture([path, ...future])
    setPath(p)
  }
  const forward = (): void => {
    const p = future[0]
    if (p === undefined) return
    setFuture(future.slice(1))
    setPast([...past, path])
    setPath(p)
  }
  return { go, back, forward, up: () => path && go(parentOf(path)), canBack: past.length > 0, canForward: future.length > 0, canUp: !!path }
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
  const nav = useNav(b.path, b.setPath)
  const [view, setView] = useBrowseView(diff)
  const [showAll, setShowAll] = useShowAll()
  const [open, setOpen] = useState<RemoteEntry | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState<StateFilter>('all')
  const [copyReq, setCopyReq] = useState({ n: 0 })
  const [treeKey, setTreeKey] = useState(0)
  const [deleting, setDeleting] = useState<RemoteEntry[] | null>(null)
  const anchor = useRef<string | null>(null)

  useEffect(() => { setSel(new Set()); setFilter('all'); anchor.current = null }, [b.path])

  const all = b.res?.entries ?? []
  const entries = all.filter((e) => showAll || isMedia(e))
  const hidden = all.length - entries.length
  const files = entries.filter((e) => !e.dir)
  const shown = files.filter((f) => filter === 'all' || f.state === filter)
  const picked = all.filter((e) => sel.has(e.path))
  const nDirs = entries.length - files.length

  const toggle = (path: string): void => { anchor.current = path; setSel((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n }) }
  const onFile = (f: RemoteEntry, ev: React.MouseEvent): void => {
    if (f.state === 'waiting') return // it is only on this PC; there is nothing at the destination to pick
    if (ev.shiftKey && anchor.current) {
      const ps = shown.map((x) => x.path)
      const a = ps.indexOf(anchor.current)
      const z = ps.indexOf(f.path)
      if (a >= 0 && z >= 0) return setSel((s) => new Set([...s, ...ps.slice(Math.min(a, z), Math.max(a, z) + 1)]))
    }
    toggle(f.path)
  }
  const selectAll = (): void => setSel(new Set(shown.filter((f) => f.state !== 'waiting').map((f) => f.path)))

  const menu = useBrowseMenu({
    dest, diff, path: b.path, views: viewsFor(diff), view, setView, showAll, setShowAll: (v) => void setShowAll(v), selected: sel,
    onOpen: (e) => (e.dir ? nav.go(e.path) : setOpen(e)),
    onSelectOnly: (p) => { anchor.current = p; setSel(new Set([p])) },
    onToggle: toggle, onSelectAll: selectAll, onCopy: () => setCopyReq((r) => ({ n: r.n + 1 })), onRefresh: () => void b.reload(), onNote: setNote,
    entries: all, onDelete: isRemote ? undefined : setDeleting
  })

  useEffect(() => {
    const k = (ev: KeyboardEvent): void => {
      const typing = /INPUT|SELECT|TEXTAREA/.test((ev.target as HTMLElement).tagName)
      if (ev.key === 'Escape') { if (!open) onClose() }
      else if (typing || open) return
      else if (ev.altKey && ev.key === 'ArrowLeft') nav.back()
      else if (ev.altKey && ev.key === 'ArrowRight') nav.forward()
      else if ((ev.altKey && ev.key === 'ArrowUp') || ev.key === 'Backspace') nav.up()
      else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); selectAll() }
      else if (ev.key === 'F5') { ev.preventDefault(); void b.reload() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const thumb = (e: RemoteEntry) => <RemoteThumb destId={dest.id} e={e} />
  const viewButton = (
    <button className="tb" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); menu.openView(r.right - 230, r.bottom + 4) }}>
      <span aria-hidden>{VIEW_LABEL[view].glyph}</span> View: {VIEW_LABEL[view].label.split(' ')[0]} ▾
    </button>
  )

  return (
    <div className="bw" role="dialog" aria-label={`Browse ${dest.name}`}>
      <div className="bw-head">
        <span className="bw-nav">
          <button className="bw-ib" aria-label="Back" title="Back (Alt+←)" disabled={!nav.canBack} onClick={nav.back}>←</button>
          <button className="bw-ib" aria-label="Forward" title="Forward (Alt+→)" disabled={!nav.canForward} onClick={nav.forward}>→</button>
          <button className="bw-ib" aria-label="Up one folder" title="Up (Alt+↑)" disabled={!nav.canUp} onClick={nav.up}>↑</button>
        </span>
        <nav className="bw-crumbs" aria-label="Path">
          <button onClick={() => nav.go('')} aria-current={b.path ? undefined : 'page'} className={b.path ? '' : 'on'}>{dest.name}</button>
          {crumbsOf(b.path).map((c, i, a) => <span key={c.path}><i aria-hidden>›</i><button onClick={() => nav.go(c.path)} aria-current={i === a.length - 1 ? 'page' : undefined} className={i === a.length - 1 ? 'on' : ''}>{c.name}</button></span>)}
        </nav>
        <span className="bw-meta">{b.res?.meta ? b.res.meta.name : ''}{b.res && !b.res.fresh ? ' · updating…' : ''}</span>
        <button className="tb" onClick={() => void b.reload()} title="Refresh (F5)">Refresh</button>
        <button className="tb" onClick={onClose}>Close</button>
      </div>
      {b.error && <div className="bw-banner">{b.error.offline ? `Can't reach ${dest.name} right now.${b.res ? ' Showing what was there last time.' : ''}` : b.error.message}</div>}
      <BrowseActions dest={dest} path={b.path} picked={picked} entries={all} meta={b.res?.meta} diff={diff} trailing={viewButton} panelRequest={copyReq} onNote={setNote} onReload={() => void b.reload()} />
      {diff && files.some((f) => f.state) && view !== 'groups' && <StateChips files={files} value={filter} onChange={setFilter} />}
      {note && <div className="bw-note-bar">{note}</div>}
      <div className="bw-split">
        <aside className="bw-side"><FolderTree key={treeKey} destId={dest.id} rootName={dest.name} current={b.path} diff={diff} onGo={nav.go} /></aside>
        <div className="bw-body">
          {b.loading && !b.res && <div className="bw-empty">Loading…</div>}
          {!b.loading && !b.res && b.error && <div className="bw-empty">{b.error.offline ? 'Offline, and nothing was saved from before.' : 'Could not list this folder.'}</div>}
          {b.res && !entries.length && <div className="bw-empty">{hidden ? 'No photos or videos here. Show all files to see the rest.' : 'This folder is empty.'}</div>}
          {entries.length > 0 && <BrowseBody destName={dest.name} entries={entries} view={view} filter={filter} sel={sel} thumb={thumb} onFile={onFile} onFileOpen={setOpen} onDir={(d, ev) => (ev.ctrlKey || ev.metaKey ? toggle(d.path) : nav.go(d.path))} onSelect={(d) => toggle(d.path)} onMenu={menu.openAt} />}
        </div>
      </div>
      <div className="bw-foot">
        <span>{hidden > 0 ? <>{hidden} other file{hidden === 1 ? '' : 's'} hidden · <button className="bw-lnk" onClick={() => void setShowAll(true)}>Show all</button></> : showAll ? <>Showing all files · <button className="bw-lnk" onClick={() => void setShowAll(false)}>Media only</button></> : null}</span>
        <span>{nDirs ? `${nDirs} folder${nDirs === 1 ? '' : 's'} · ` : ''}{files.length} {showAll ? 'files' : 'media files'}{sel.size ? ` · ${sel.size} selected` : ''}</span>
      </div>
      {menu.node}
      {deleting && <DeleteFromDest dest={dest} targets={deleting} onClose={() => setDeleting(null)} onDone={(n) => { setDeleting(null); setSel(new Set()); setTreeKey((k) => k + 1); setNote(`Deleted ${n} item${n === 1 ? '' : 's'} from ${dest.name}`); void b.reload() }} />}
      {open && <Viewer destId={dest.id} e={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
