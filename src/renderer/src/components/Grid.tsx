import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Shot, ShotPatch } from '@shared/types'
import type { Cull } from '@shared/cull'
import { api, dragProps } from '../api'
import { landIn } from '../motion'
import { FilterChips, type GridFilter } from './FilterChips'
import { TabBar } from './TabBar'
import { SessionRail, dayName, useNames } from './SessionRail'
import { CullPanel, DetectorChips, FlagBadges, flaggedBy, type CullUI } from './CullPanel'
import { GridPreview } from './GridPreview'
import './Grid.css'

interface Props {
  shots: Shot[] // what is visible after every filter, in order
  cull: Map<number, Cull>
  selectedId: number | null
  freshIds: Set<number>
  onSelect: (id: number) => void
  onOpen: (id: number) => void
  onPatch: (ids: number[], p: ShotPatch) => void
  tapOpens?: boolean // touch: no double-click, a tap opens the loupe
  // Optional: the redesigned chrome. Without them the grid is just the cells.
  allShots?: Shot[] // the whole library (rail counts); with it the rail and chip row appear
  filter?: string
  onFilter?: (f: GridFilter) => void
  session?: string
  onSession?: (s: string) => void
  source?: string
  onSource?: (s: string) => void
  /** Called with the ids of every reject in view after the user confirms. */
  onDeleteRejects?: (ids: number[]) => void
  mobile?: boolean
  cullUI?: CullUI // desktop: detector chips in the toolbar and the culling side panel
  chosen?: number[] // frames chosen for Compare (Ctrl/Shift-click)
  onChosen?: (ids: number[]) => void
  onCompare?: () => void
}

type Size = 'S' | 'M' | 'L'
const COLS: Record<Size, number> = { S: 8, M: 6, L: 4 }

const hm = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** Splits the visible list into runs of consecutive frames from the same burst. */
function runs(shots: Shot[], cull: Map<number, Cull>): Shot[][] {
  const out: Shot[][] = []
  for (const s of shots) {
    const last = out[out.length - 1]
    const g = cull.get(s.id)?.group
    if (last && g != null && cull.get(last[0].id)?.group === g) last.push(s)
    else out.push([s])
  }
  return out
}

/** Minute sections; a burst never splits across them. */
function sections(shots: Shot[], cull: Map<number, Cull>): { label: string; runs: Shot[][] }[] {
  const out: { label: string; runs: Shot[][] }[] = []
  for (const r of runs(shots, cull)) {
    const label = hm(r[0].capturedAt)
    const last = out[out.length - 1]
    if (last?.label === label) last.runs.push(r)
    else out.push({ label, runs: [r] })
  }
  return out
}

export function Grid(p: Props) {
  const { shots, cull, selectedId, freshIds, onSelect, onOpen, onPatch, tapOpens, mobile } = p
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>(() => {
    try {
      return (localStorage.getItem('shotdrop.gridsize') as Size) in COLS ? (localStorage.getItem('shotdrop.gridsize') as Size) : 'M'
    } catch {
      return 'M'
    }
  })
  const [daysOpen, setDaysOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null)
  const [names] = useNames()
  const chosen = p.chosen ?? []
  const choosing = chosen.length > 0
  const chrome = !!p.allShots && !!p.onFilter

  // Choosing frames for Compare: tick the corner box, long-press, Ctrl/Shift-click, or right-click.
  // Pressing a box (or long-pressing) and sliding over other frames "paints" them all to the same state.
  const live = useRef({ chosen, onChosen: p.onChosen })
  live.current = { chosen, onChosen: p.onChosen }
  const press = useRef<{ id: number; x: number; y: number; timer: number } | null>(null)
  const paint = useRef<{ on: boolean; ids: number[]; seen: Set<number> } | null>(null)
  const swallowClick = useRef(false)
  const lastPointer = useRef('mouse')

  const toggle = (id: number): void => {
    const { chosen: c, onChosen } = live.current
    onChosen?.(c.includes(id) ? c.filter((x) => x !== id) : [...c, id])
  }
  const startPaint = (id: number): void => {
    const { chosen: c, onChosen } = live.current
    if (!onChosen) return
    const on = !c.includes(id)
    const ids = on ? [...c, id] : c.filter((x) => x !== id)
    paint.current = { on, ids, seen: new Set([id]) }
    swallowClick.current = true
    onChosen(ids)
  }
  const endPress = (): void => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const pr = press.current
      if (pr && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 8) endPress()
      const pt = paint.current
      if (!pt) return
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.gx-cell[data-id]')
      const id = el ? Number(el.dataset.id) : NaN
      if (Number.isNaN(id) || pt.seen.has(id)) return
      pt.seen.add(id)
      pt.ids = pt.on ? (pt.ids.includes(id) ? pt.ids : [...pt.ids, id]) : pt.ids.filter((x) => x !== id)
      live.current.onChosen?.(pt.ids)
    }
    const up = (): void => {
      endPress()
      paint.current = null
    }
    // While painting on a touch screen the finger drags across frames instead of scrolling the grid.
    const touch = (e: TouchEvent): void => {
      if (paint.current && e.cancelable) e.preventDefault()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('touchmove', touch, { passive: false })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('touchmove', touch)
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (e?: Event): void => {
      if ((e?.target as HTMLElement | null)?.closest?.('.gx-menu')) return
      setMenu(null)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', close)
    ref.current?.addEventListener('scroll', close)
    const sc = ref.current
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', close)
      sc?.removeEventListener('scroll', close)
    }
  }, [menu])

  useEffect(() => {
    ref.current?.querySelector('.gx-cell.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  const scoped = useMemo(
    () => (p.allShots ?? []).filter((s) => (!p.session || s.session === p.session) && (!p.source || s.source === p.source)),
    [p.allShots, p.session, p.source]
  )
  const rejects = useMemo(() => scoped.filter((s) => s.flag === -1), [scoped])
  const flagged = useMemo(() => flaggedBy(scoped, cull), [scoped, cull])
  const secs = useMemo(() => sections(shots, cull), [shots, cull])
  const selected = shots.find((s) => s.id === selectedId)

  // Full-size preview of the selected frame over the grid: Space, double-click, or the right-click menu.
  const [peek, setPeek] = useState(false)
  const canPeek = !tapOpens
  const peekRef = useRef({ peek, canPeek, has: !!selected })
  peekRef.current = { peek, canPeek, has: !!selected }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const r = peekRef.current
      if (e.key !== ' ' || r.peek || !r.canPeek || !r.has || e.ctrlKey || e.metaKey || e.altKey) return
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      setPeek(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const selIndex = selected ? shots.indexOf(selected) : -1
  const previewEl = (
    <AnimatePresence>
      {peek && selected && (
        <GridPreview
          key="gp"
          shot={selected}
          index={selIndex}
          total={shots.length}
          chosen={p.onChosen ? chosen.includes(selected.id) : null}
          onPrev={() => selIndex > 0 && onSelect(shots[selIndex - 1].id)}
          onNext={() => selIndex < shots.length - 1 && onSelect(shots[selIndex + 1].id)}
          onPatch={(patch) => onPatch([selected.id], patch)}
          onToggleChosen={() => toggle(selected.id)}
          onLoupe={() => { setPeek(false); onOpen(selected.id) }}
          onClose={() => setPeek(false)}
        />
      )}
    </AnimatePresence>
  )

  const setSz = (s: Size): void => {
    setSize(s)
    try { localStorage.setItem('shotdrop.gridsize', s) } catch { /* not remembered */ }
  }

  const cell = (s: Shot, inBurst: boolean): ReactElement => {
    const c = cull.get(s.id)
    const fresh = freshIds.has(s.id)
    const dim = !!(c?.soft || c?.blink || c?.exposure)
    const best = inBurst && !!c?.best
    const video = s.files.some((f) => f.kind === 'video')
    return (
      <motion.button
        key={s.id}
        data-id={s.id}
        className={`gx-cell ${s.id === selectedId ? 'selected' : ''} ${chosen.includes(s.id) ? 'chosen' : ''} ${s.flag === -1 ? 'rejected' : ''} ${dim ? 'dim' : ''} ${best ? 'best' : ''}`}
        {...(fresh ? { initial: landIn.initial, animate: landIn.animate, transition: landIn.transition } : {})}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType
          swallowClick.current = false
          if (e.button !== 0 || !p.onChosen || e.ctrlKey || e.metaKey || e.shiftKey) return
          if ((e.target as HTMLElement).closest('.gx-check')) {
            e.preventDefault() // no text selection or native drag while painting
            startPaint(s.id)
            return
          }
          endPress()
          const id = s.id
          press.current = {
            id,
            x: e.clientX,
            y: e.clientY,
            timer: window.setTimeout(() => {
              press.current = null
              navigator.vibrate?.(15)
              startPaint(id)
            }, 450)
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          // A touch long-press already chose the frame; the menu is for mouse and keyboard.
          if (lastPointer.current === 'touch' || swallowClick.current || !p.onChosen) return
          setMenu({ x: e.clientX, y: e.clientY, id: s.id })
        }}
        onClick={(e) => {
          if (swallowClick.current) {
            swallowClick.current = false
            return
          }
          if (p.onChosen && (e.ctrlKey || e.metaKey)) toggle(s.id)
          else if (p.onChosen && tapOpens && choosing) toggle(s.id) // phone: once choosing, taps add and remove
          else if (p.onChosen && e.shiftKey) {
            // Range from the selected frame to this one, in grid order.
            const a = shots.findIndex((x) => x.id === selectedId), b = shots.findIndex((x) => x.id === s.id)
            const [lo, hi] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)]
            p.onChosen(shots.slice(lo, hi + 1).map((x) => x.id))
          } else if (tapOpens) onOpen(s.id)
          else onSelect(s.id)
        }}
        onDoubleClick={() => { if (canPeek) { onSelect(s.id); setPeek(true) } else onOpen(s.id) }}
        aria-label={s.name}
        aria-pressed={s.id === selectedId}
      >
        {s.hasPreview ? <img src={api.thumbUrl(s)} alt="" loading="lazy" {...dragProps(s.id)} /> : <span className="gx-empty">{s.name}</span>}
        {p.onChosen && (
          <span className={`gx-check ${chosen.includes(s.id) ? 'on' : ''}`} title={chosen.includes(s.id) ? 'Remove from compare' : 'Choose to compare'} aria-hidden>
            {chosen.includes(s.id) ? chosen.indexOf(s.id) + 1 : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
            )}
          </span>
        )}
        <span className="gx-t">
          {fresh && <span className="badge new">new</span>}
          {best && <span className="badge best">best</span>}
          {video && <span className="badge">VIDEO</span>}
        </span>
        <span className="gx-b">
          {s.rating > 0 && <span className="badge">★{s.rating}</span>}
          {s.flag === 1 && <span className="badge pick">P</span>}
          {s.flag === -1 && <span className="badge rej">X</span>}
          {s.label && <span className="badge" style={{ background: `var(--l-${s.label})`, color: '#111' }}>{s.label[0].toUpperCase()}</span>}
          <FlagBadges c={c} />
        </span>
      </motion.button>
    )
  }

  const burst = (run: Shot[]): ReactElement => {
    const ids = run.map((s) => s.id)
    const best = run.find((s) => cull.get(s.id)?.best)
    const span = Math.min(run.length, 3)
    const secs = (run[run.length - 1].capturedAt - run[0].capturedAt) / 1000
    return (
      <section key={`b${run[0].id}`} className="gx-burst" style={{ ['--span' as string]: span }} aria-label={`Burst of ${run.length} frames`}>
        <header>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="7" width="12" height="12" rx="2" /><path d="M8 3h11a2 2 0 0 1 2 2v11" /></svg>
          Burst · {run.length} frames · {secs.toFixed(1)} s
          {p.onChosen && p.onCompare ? (
            <button className="tb" title="Compare this burst side by side, then pick the keeper" onClick={() => { p.onChosen?.(ids); p.onCompare?.() }}>
              Compare {run.length}
            </button>
          ) : best && (
            <button className="tb" title="Pick the best frame and reject the rest" onClick={() => { onPatch([best.id], { flag: 1 }); onPatch(ids.filter((id) => id !== best.id), { flag: -1 }) }}>
              Keep best, reject rest
            </button>
          )}
        </header>
        <div className="gx-grid grid inner" style={{ ['--cols' as string]: span }}>{run.map((s) => cell(s, true))}</div>
      </section>
    )
  }

  const body = !shots.length ? (
    <div className="grid-empty">Nothing matches this filter.</div>
  ) : (
    <div className="gx-scroll grid-scroll" ref={ref}>
      {secs.map((sec) => (
        <div key={sec.label + sec.runs[0][0].id}>
          <div className="gx-minute">{sec.label}<span /></div>
          <div className="gx-grid grid" style={{ ['--cols' as string]: mobile ? 3 : COLS[size] }}>
            {sec.runs.map((r) => (r.length < 2 || mobile ? r.map((s) => cell(s, r.length > 1)) : burst(r)))}
          </div>
        </div>
      ))}
    </div>
  )

  const menuEl = (() => {
    if (!menu || !p.onChosen) return null
    const id = menu.id
    const s = shots.find((x) => x.id === id)
    if (!s) return null
    const isIn = chosen.includes(id)
    const g = cull.get(id)?.group
    const burstIds = g == null ? [] : shots.filter((x) => cull.get(x.id)?.group === g).map((x) => x.id)
    const run = (f: () => void) => (): void => {
      f()
      setMenu(null)
    }
    const withThis = isIn ? chosen : [...chosen, id]
    const items: (false | { label: string; key?: string; act: () => void; primary?: boolean })[] = [
      { label: isIn ? 'Remove from compare' : 'Add to compare', key: 'Ctrl-click', act: () => toggle(id) },
      withThis.length >= 2 && { label: isIn ? `Compare ${chosen.length} chosen` : `Compare with ${chosen.length} chosen`, key: 'C', primary: true, act: () => { p.onChosen?.(withThis); p.onCompare?.() } },
      burstIds.length > 1 && { label: `Choose whole burst (${burstIds.length})`, act: () => p.onChosen?.([...chosen, ...burstIds.filter((x) => !chosen.includes(x))]) },
      burstIds.length > 1 && { label: `Compare this burst`, act: () => { p.onChosen?.(burstIds); p.onCompare?.() } },
    ]
    const after: (false | { label: string; key?: string; act: () => void })[] = [
      canPeek && { label: 'Preview full size', key: 'Space', act: () => { onSelect(id); setPeek(true) } },
      { label: 'Open in Loupe', key: 'Enter', act: () => onOpen(id) },
      { label: s.flag === 1 ? 'Unpick' : 'Pick', key: 'P', act: () => onPatch([id], { flag: s.flag === 1 ? 0 : 1 }) },
      { label: s.flag === -1 ? 'Unreject' : 'Reject', key: 'X', act: () => onPatch([id], { flag: s.flag === -1 ? 0 : -1 }) },
      choosing && { label: 'Clear chosen frames', key: 'Esc', act: () => p.onChosen?.([]) },
    ]
    const x = Math.min(menu.x, window.innerWidth - 248)
    const y = Math.min(menu.y, window.innerHeight - 330)
    const row = (it: { label: string; key?: string; act: () => void; primary?: boolean }) => (
      <button key={it.label} role="menuitem" className={it.primary ? 'primary' : ''} onClick={run(it.act)}>
        <span>{it.label}</span>
        {it.key && <span className="key">{it.key}</span>}
      </button>
    )
    return (
      <div className="gx-menu sheet" role="menu" aria-label={s.name} style={{ left: Math.max(8, x), top: Math.max(8, y) }} onContextMenu={(e) => e.preventDefault()}>
        <div className="gx-menu-h">{s.name}</div>
        {items.filter((it) => !!it).map((it) => row(it))}
        <div className="gx-menu-sep" />
        {after.filter((it) => !!it).map((it) => row(it))}
      </div>
    )
  })()

  const plain = !chrome
  if (plain) return <div className={`gx ${mobile ? 'gx-m' : ''} ${choosing ? 'choosing' : ''}`}><div className="gx-main">{body}</div>{menuEl}{previewEl}</div>

  const counts = <span>{scoped.length} frames</span>
  const del = (): void => {
    // The caller confirms (and names any destinations that will delete their copies too).
    if (rejects.length) p.onDeleteRejects?.(rejects.map((s) => s.id))
  }
  const bestOfBursts = (): void => {
    const ids = shots.filter((s) => (cull.get(s.id)?.size ?? 1) > 1 && cull.get(s.id)?.best && s.flag !== 1).map((s) => s.id)
    if (ids.length) onPatch(ids, { flag: 1 })
  }

  if (mobile) {
    const dayLabel = p.session ? (names[`day:${p.session}`] ?? dayName(p.session)) : 'All days'
    const cams = new Set(scoped.map((s) => s.source).filter(Boolean)).size
    return (
      <div className={`gx gx-m ${choosing ? 'choosing' : ''}`}>
        <div className="gx-mhead">
          <div>
            <div className="gx-mday">{dayLabel}</div>
            <div className="gx-msub">{scoped.length} frames · {cams} {cams === 1 ? 'camera' : 'cameras'}</div>
          </div>
          <button className="gx-mdays" aria-expanded={daysOpen} onClick={() => setDaysOpen((o) => !o)}>Days ▾</button>
        </div>
        {daysOpen && (
          <div className="gx-mdaylist" onClick={() => setDaysOpen(false)}>
            <SessionRail allShots={p.allShots!} session={p.session ?? ''} source={p.source ?? ''} onSession={(s) => p.onSession?.(s)} onSource={(s) => p.onSource?.(s)} />
          </div>
        )}
        <div className="gx-mchips"><FilterChips shots={scoped} cull={cull} filter={p.filter ?? 'all'} onFilter={p.onFilter!} only={['all', 'picks', 'stars4', 'best', 'soft']} /></div>
        <div className="gx-main">{body}</div>
        {choosing ? (
          <div className="gx-mchosen">
            <strong>{chosen.length} chosen</strong>
            <button className="tb" onClick={() => p.onChosen?.([])}>Clear</button>
            <button className="tb primary" disabled={chosen.length < 2} onClick={p.onCompare}>Compare {chosen.length}</button>
          </div>
        ) : p.onChosen && shots.length > 1 ? (
          <div className="gx-mhint">Long-press a photo to choose photos to compare</div>
        ) : null}
        {menuEl}
        <TabBar current="gallery" />
      </div>
    )
  }

  return (
    <div className={`gx ${choosing ? 'choosing' : ''}`}>
      {menuEl}
      {previewEl}
      <SessionRail allShots={p.allShots!} session={p.session ?? ''} source={p.source ?? ''} onSession={(s) => p.onSession?.(s)} onSource={(s) => p.onSource?.(s)} />
      <section className="gx-main">
        <div className="gx-filters">
          <FilterChips shots={scoped} cull={cull} filter={p.filter ?? 'all'} onFilter={p.onFilter!} only={p.cullUI ? ['all', 'picks', 'stars4', 'unrated', 'rejects'] : undefined} />
          {p.cullUI && <><span className="gx-divider" /><DetectorChips ui={p.cullUI} flagged={flagged} /></>}
          <div className="gx-right">
            {p.onDeleteRejects && rejects.length > 0 && <button className="tb" style={{ color: 'var(--reject)' }} onClick={del}>Delete {rejects.length} rejects</button>}
            {!p.cullUI && <button className="tb" onClick={bestOfBursts}>Select best of every burst</button>}
            <div className="seg" role="group" aria-label="Thumbnail size">
              {(['S', 'M', 'L'] as Size[]).map((z) => <button key={z} className={size === z ? 'on' : ''} aria-pressed={size === z} onClick={() => setSz(z)}>{z}</button>)}
            </div>
          </div>
        </div>
        {body}
        {chosen.length > 0 ? (
          <div className="gx-selbar gx-chosenbar">
            <strong>{chosen.length} chosen</strong>
            <span>{chosen.length < 2 ? 'Tick one more frame to compare' : 'Tick boxes, drag across them, or right-click to add and remove'}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {chosen.length < shots.length && <button className="tb" onClick={() => p.onChosen?.([...chosen, ...shots.map((s) => s.id).filter((id) => !chosen.includes(id))])}>Choose all {shots.length}</button>}
              <button className="tb" onClick={() => onPatch(chosen, { flag: 1 })}>Pick all</button>
              <button className="tb" style={{ color: 'var(--reject-text)' }} onClick={() => onPatch(chosen, { flag: -1 })}>Reject all</button>
              <button className="tb" onClick={() => p.onChosen?.([])}>Clear <span className="key">Esc</span></button>
              <button className="tb primary" disabled={chosen.length < 2} onClick={p.onCompare}>Compare {chosen.length} <span className="key accent">C</span></button>
            </span>
          </div>
        ) : (
          <div className="gx-selbar">
            <span>{selected ? `${selected.name} selected` : 'Nothing selected'}</span>
            <span><span className="key">1</span>–<span className="key">5</span> rate · <span className="key">P</span> pick · <span className="key">X</span> reject · tick the corner box, long-press or right-click to compare · <span className="key">Space</span> preview · <span className="key">Enter</span> loupe · <span className="key">⌫</span> delete</span>
            <span style={{ marginLeft: 'auto' }}>Grouped by minute · bursts grouped automatically · {counts}</span>
          </div>
        )}
      </section>
      {p.cullUI && <CullPanel ui={p.cullUI} flagged={flagged} filter={p.filter ?? 'all'} onFilter={p.onFilter!} onPatch={onPatch} onBestOfBursts={bestOfBursts} />}
    </div>
  )
}
