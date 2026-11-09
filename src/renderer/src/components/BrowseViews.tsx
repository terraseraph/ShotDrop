import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RemoteEntry, RemoteRollup, RemoteState } from '@shared/remote'
import { api } from '../api'
import { fmtSize } from '../format'
import { STATE_LABEL } from './BrowseActions'

export type BrowseView = 'icons' | 'details' | 'compare' | 'groups'
export const VIEW_LABEL: Record<BrowseView, { glyph: string; label: string }> = {
  icons: { glyph: '▦', label: 'Large icons' },
  details: { glyph: '☰', label: 'Details' },
  compare: { glyph: '◫', label: 'Compare side by side' },
  groups: { glyph: '▤', label: 'Group by status' }
}
/** Compare and Group need the per-file sync state, which only diff mode returns. */
export const viewsFor = (diff: boolean): BrowseView[] => (diff ? ['icons', 'details', 'compare', 'groups'] : ['icons', 'details'])

const VIEW_KEY = 'sd-browse-view'
export function useBrowseView(diff: boolean): [BrowseView, (v: BrowseView) => void] {
  const [v, setV] = useState<BrowseView>(() => {
    try { return (localStorage.getItem(VIEW_KEY) as BrowseView) || 'icons' } catch { return 'icons' }
  })
  const set = (n: BrowseView): void => {
    setV(n)
    try { localStorage.setItem(VIEW_KEY, n) } catch { /* private mode: the choice just isn't remembered */ }
  }
  return [viewsFor(diff).includes(v) ? v : 'icons', set]
}

/** The "show all files" setting (Settings → Sync). Off by default: only photos, RAW and video are listed. */
export function useShowAll(): [boolean, (v: boolean) => Promise<void>] {
  const [on, setOn] = useState(false)
  useEffect(() => { void api.settings().then((s) => setOn(!!s.showAllRemoteFiles), () => undefined) }, [])
  const set = useCallback(async (v: boolean) => {
    setOn(v)
    try { await api.patchSettings({ showAllRemoteFiles: v }) } catch { /* a phone may not change settings: this window still follows the choice */ }
  }, [])
  return [on, set]
}

export const isMedia = (e: RemoteEntry): boolean => e.dir || e.kind === 'jpeg' || e.kind === 'raw' || e.kind === 'heif' || e.kind === 'video'

export type StateFilter = 'all' | RemoteState
const ORDER: RemoteState[] = ['waiting', 'differs', 'missingHere', 'synced']
const CHIPS: [StateFilter, string][] = [['all', 'All'], ['waiting', 'Not sent'], ['differs', 'Different'], ['missingHere', 'Not on PC'], ['synced', 'Synced']]

export function countStates(files: RemoteEntry[]): Record<StateFilter, number> {
  const c: Record<StateFilter, number> = { all: files.length, waiting: 0, differs: 0, missingHere: 0, synced: 0 }
  for (const f of files) if (f.state) c[f.state]++
  return c
}

export function StateChips({ files, value, onChange }: { files: RemoteEntry[]; value: StateFilter; onChange: (v: StateFilter) => void }) {
  const c = countStates(files)
  return (
    <div className="bw-chips" role="group" aria-label="Filter by status">
      {CHIPS.map(([k, t]) => <button key={k} className={`bw-chip ${value === k ? 'on' : ''}`} aria-pressed={value === k} onClick={() => onChange(k)}>{t} <span>{c[k]}</span></button>)}
    </div>
  )
}

interface BodyProps {
  destName: string
  entries: RemoteEntry[]
  view: BrowseView
  filter: StateFilter
  sel: Set<string>
  thumb: (e: RemoteEntry) => ReactNode
  onFile: (e: RemoteEntry, ev: React.MouseEvent) => void
  onFileOpen?: (e: RemoteEntry) => void
  /** Opens the folder; Ctrl/Cmd-click selects it instead. */
  onDir: (e: RemoteEntry, ev: React.MouseEvent) => void
  /** The folder's checkbox: select it without opening. */
  onSelect: (e: RemoteEntry) => void
  /** Right-click, long-press, the Menu key or a row's ⋯. `null` means empty space. */
  onMenu: (e: RemoteEntry | null, x: number, y: number) => void
}

export const rollBad = (r?: RemoteRollup): number => (r ? r.waiting + r.differs + r.missingHere : 0)
/** "3 to review" or a tick for a folder, from what the diff knows about everything inside it. Nothing for folders with no known files. */
function RollPill({ r }: { r?: RemoteRollup }) {
  if (!r || !r.total) return null
  const n = rollBad(r)
  return <span className={`bw-pill ${n ? 'warn' : 'ok'}`}>{n ? `${n} to review` : '✓ Synced'}</span>
}

const kindLabel =(e: RemoteEntry): string => (e.dir ? 'Folder' : e.kind === 'sidecar' ? 'Sidecar' : e.kind.toUpperCase())
const dot = (s?: RemoteState): ReactNode => (s ? <span className={`bw-dot ${s}`} aria-hidden /> : null)

/** Folders first, then files, in the chosen view. Owns only the pointer plumbing for menus; selection and navigation stay with the caller. */
export function BrowseBody(p: BodyProps) {
  const { entries, view, filter, sel } = p
  const dirs = entries.filter((e) => e.dir)
  const files = entries.filter((e) => !e.dir && (filter === 'all' || e.state === filter))
  const press = useRef<{ t: number; x: number; y: number; swallow: boolean }>({ t: 0, x: 0, y: 0, swallow: false })
  const find = (t: EventTarget | null): RemoteEntry | null => {
    const path = (t as HTMLElement | null)?.closest<HTMLElement>('[data-path]')?.dataset.path
    return path ? entries.find((e) => e.path === path) ?? null : null
  }
  const clear = (): void => window.clearTimeout(press.current.t)

  return (
    <div
      className="bw-content"
      onContextMenu={(ev) => { ev.preventDefault(); p.onMenu(find(ev.target), ev.clientX, ev.clientY) }}
      onPointerDown={(ev) => {
        if (ev.pointerType !== 'touch') return
        const { clientX: x, clientY: y, target } = ev
        press.current = { ...press.current, x, y, t: window.setTimeout(() => { press.current.swallow = true; p.onMenu(find(target), x, y) }, 500) }
      }}
      onPointerMove={(ev) => { if (Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 10) clear() }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onClickCapture={(ev) => { if (press.current.swallow) { press.current.swallow = false; ev.stopPropagation(); ev.preventDefault() } }}
      onKeyDown={(ev) => {
        if (ev.key !== 'ContextMenu' && !(ev.shiftKey && ev.key === 'F10')) return
        const e = find(ev.target)
        if (!e) return
        ev.preventDefault()
        const r = (ev.target as HTMLElement).getBoundingClientRect()
        p.onMenu(e, r.left + 16, r.bottom)
      }}
    >
      {view === 'icons' && <IconsView {...p} dirs={dirs} files={files} />}
      {view === 'details' && <DetailsView {...p} dirs={dirs} files={files} />}
      {view === 'compare' && <CompareView {...p} dirs={dirs} files={files} />}
      {view === 'groups' && <GroupsView {...p} dirs={dirs} files={files} />}
    </div>
  )
}

type ViewProps = BodyProps & { dirs: RemoteEntry[]; files: RemoteEntry[] }

function IconsView({ dirs, files, sel, thumb, onFile, onFileOpen, onDir, onSelect }: ViewProps) {
  return (
    <div className="bw-grid">
      {dirs.map((d) => (
        <div key={d.path} className={`bw-dtile ${sel.has(d.path) ? 'sel' : ''}`} data-path={d.path}>
          <button className="bw-dopen" onClick={(ev) => onDir(d, ev)} aria-label={`Folder ${d.name}`}>
            <span className="bw-fico" aria-hidden />
            <span className="bw-dn">{d.name}</span>
            <span className="bw-dsub"><RollPill r={d.rollup} /></span>
          </button>
          <button className="bw-dcheck" role="checkbox" aria-checked={sel.has(d.path)} aria-label={`Select folder ${d.name}`} onClick={() => onSelect(d)}>{sel.has(d.path) ? '✓' : ''}</button>
        </div>
      ))}
      {files.map((f) => (
        <button key={f.path} data-path={f.path} aria-pressed={sel.has(f.path)} aria-label={f.state ? `${f.name}, ${STATE_LABEL[f.state]}` : f.name} title={`${f.name} · ${fmtSize(f.size)}`}
          className={`bw-tile ${f.inLibrary ? 'in' : ''} ${sel.has(f.path) ? 'sel' : ''} ${f.state ? `s-${f.state}` : ''}`} onClick={(ev) => onFile(f, ev)} onDoubleClick={() => onFileOpen?.(f)}>
          {thumb(f)}
          <span className="bw-cap">{f.name}</span>
          {f.state ? <span className={`bw-st ${f.state}`}>{STATE_LABEL[f.state]}</span> : f.inLibrary && <span className="bw-in">On this PC</span>}
          {sel.has(f.path) && <span className="bw-check" aria-hidden>✓</span>}
        </button>
      ))}
    </div>
  )
}

function DetailsView({ dirs, files, sel, thumb, onFile, onFileOpen, onDir, onMenu }: ViewProps) {
  const more = (e: RemoteEntry) => (
    <span className="bw-more" role="button" tabIndex={0} aria-label={`Actions for ${e.name}`}
      onClick={(ev) => { ev.stopPropagation(); const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(e, r.left - 200, r.bottom) }}
      onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(e, r.left - 200, r.bottom) } }}>⋯</span>
  )
  return (
    <div className="bw-rows" role="table" aria-label="Files">
      <div className="bw-row bw-hd" role="row"><span>Name</span><span className="c2">Type</span><span className="c3">Size</span><span className="c4">Status</span><span /></div>
      {dirs.map((d) => (
        <button key={d.path} className={`bw-row ${sel.has(d.path) ? 'sel' : ''}`} data-path={d.path} role="row" aria-pressed={sel.has(d.path)} onClick={(ev) => onDir(d, ev)}>
          <span className="nm"><span className="bw-fico" aria-hidden /><span className="t">{d.name}</span></span>
          <span className="c2 num">Folder</span><span className="c3 num">{d.rollup?.total ? `${d.rollup.total} files` : ''}</span><span className="c4 s"><RollPill r={d.rollup} /></span>{more(d)}
        </button>
      ))}
      {files.map((f) => (
        <button key={f.path} className={`bw-row ${sel.has(f.path) ? 'sel' : ''}`} data-path={f.path} role="row" aria-pressed={sel.has(f.path)} onClick={(ev) => onFile(f, ev)} onDoubleClick={() => onFileOpen?.(f)}>
          <span className="nm"><span className="bw-rthumb">{thumb(f)}</span><span className="t">{f.name}</span></span>
          <span className="c2 num">{kindLabel(f)}</span><span className="c3 num">{fmtSize(f.size)}</span>
          <span className="c4 s">{dot(f.state)}<span className="lbl">{f.state ? STATE_LABEL[f.state] : f.inLibrary ? 'On this PC' : ''}</span></span>
          {more(f)}
        </button>
      ))}
    </div>
  )
}

/** Both sides from the state flags alone: "waiting" is only on this PC, "missingHere" is only at the destination. */
function CompareView({ destName, dirs, files, sel, thumb, onFile, onDir }: ViewProps) {
  const [diffOnly, setDiffOnly] = useState(false)
  const shown = diffOnly ? files.filter((f) => f.state !== 'synced') : files
  const cell = (f: RemoteEntry, side: 'pc' | 'dest'): ReactNode => {
    const gap = (side === 'pc' && f.state === 'missingHere') || (side === 'dest' && f.state === 'waiting')
    if (gap) return <div className={`bw-cell gap ${side === 'dest' ? 'send' : 'pull'}`}>{side === 'dest' ? '↑ not sent yet' : '↓ not on this PC'}</div>
    return (
      <div className={`bw-cell ${f.state === 'differs' ? 'diff' : ''}`}>
        <span className="bw-rthumb">{thumb(f)}</span>
        <span className="nm"><span className="t">{f.name}</span><small>{fmtSize(f.size)}{f.state === 'differs' && side === 'dest' ? ' · differs from PC' : ''}</small></span>
      </div>
    )
  }
  return (
    <div className="bw-cmp">
      <div className="bw-cmp-h"><div><b>This PC</b></div><div><b>{destName}</b></div></div>
      <button className="bw-toggle" aria-pressed={diffOnly} onClick={() => setDiffOnly(!diffOnly)}><span className={`bw-sw ${diffOnly ? 'on' : ''}`} aria-hidden />Differences only</button>
      {dirs.map((d) => <button key={d.path} className={`bw-cmp-dir ${sel.has(d.path) ? 'sel' : ''}`} data-path={d.path} aria-pressed={sel.has(d.path)} onClick={(ev) => onDir(d, ev)}><span className="bw-fico" aria-hidden />{d.name}<RollPill r={d.rollup} /></button>)}
      {shown.map((f) => (
        <button key={f.path} className={`bw-cmp-row ${sel.has(f.path) ? 'sel' : ''}`} data-path={f.path} aria-pressed={sel.has(f.path)} onClick={(ev) => onFile(f, ev)}>{cell(f, 'pc')}{cell(f, 'dest')}</button>
      ))}
      {!shown.length && !dirs.length && <div className="bw-empty">Nothing differs. Everything matches.</div>}
    </div>
  )
}

const GROUP_HELP: Record<RemoteState, string> = { waiting: 'On this PC, not at the destination', differs: 'Same name, different size or date', missingHere: 'At the destination only', synced: 'Identical on both sides' }

function GroupsView({ dirs, files, sel, thumb, onFile, onDir }: ViewProps) {
  const [closed, setClosed] = useState<Set<RemoteState>>(new Set(['synced']))
  const c = countStates(files)
  const bad = c.waiting + c.differs + c.missingHere
  return (
    <div className="bw-groups">
      {dirs.length > 0 && (
        <section className="bw-grp open">
          <div className="bw-gh"><span className="t">Folders</span><span className="d">{dirs.length} inside</span></div>
          {dirs.map((d) => <button key={d.path} className={`bw-item ${sel.has(d.path) ? 'sel' : ''}`} data-path={d.path} aria-pressed={sel.has(d.path)} onClick={(ev) => onDir(d, ev)}><span className="bw-fico" aria-hidden /><span className="nm">{d.name}</span><RollPill r={d.rollup} /></button>)}
        </section>
      )}
      {files.length > 0 && (
        <div className="bw-hero">
          <div className="big">{bad ? <>{c.synced} of {c.all} match <small>{bad} need attention</small></> : <>Everything matches <small>{c.all} files</small></>}</div>
          <div className="bw-meter">{(['synced', 'differs', 'waiting', 'missingHere'] as RemoteState[]).map((s) => <b key={s} className={s} style={{ width: `${(c[s] / (c.all || 1)) * 100}%` }} />)}</div>
        </div>
      )}
      {ORDER.filter((s) => c[s]).map((s) => {
        const open = !closed.has(s)
        return (
          <section key={s} className={`bw-grp ${open ? 'open' : ''}`}>
            <button className="bw-gh" aria-expanded={open} onClick={() => setClosed((x) => { const n = new Set(x); if (n.has(s)) n.delete(s); else n.add(s); return n })}>
              <span className={`bw-dot ${s}`} aria-hidden /><span className="t">{STATE_LABEL[s]}</span><span className="bw-n">{c[s]}</span><span className="d">{GROUP_HELP[s]}</span><span className="cv" aria-hidden>›</span>
            </button>
            {open && files.filter((f) => f.state === s).map((f) => (
              <button key={f.path} className={`bw-item ${sel.has(f.path) ? 'sel' : ''}`} data-path={f.path} aria-pressed={sel.has(f.path)} onClick={(ev) => onFile(f, ev)}>
                <span className="bw-rthumb">{thumb(f)}</span><span className="nm">{f.name}<small>{fmtSize(f.size)}</small></span>
              </button>
            ))}
          </section>
        )
      })}
      {!files.length && !dirs.length && <div className="bw-empty">This folder is empty.</div>}
    </div>
  )
}
