import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as RPointerEvent } from 'react'
import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'
import { api } from '../api'
import { fmtAperture, fmtIso, fmtShutter } from '../format'
import { RatingBadge, RatingButtons, keyRating, maxKey, useRatingSystem } from '../rating'
import { FlagButtons } from './FlagButtons'
import { Icon } from './Icon'
import { InspectDialog } from './InspectDialog'
import { dims, useViewport, ZoomImage } from './Viewport'
import './Compare.css'

interface Props {
  shots: Shot[]
  burst: boolean // the frames are one burst the app picked for you, not frames you chose
  cull: Map<number, Cull>
  onPick: (id: number) => void
  onReject: (id: number) => void
  onUnflag: (id: number) => void
  onRate: (id: number, n: number) => void
  onClear: () => void
  /** Narrow the comparison to these frames (remove one, drop rejects, keep picks). */
  onKeep: (ids: number[]) => void
  /** Back to the grid to choose more frames, keeping these chosen. */
  onAdd: () => void
  onClose: () => void
  /** Ask to delete a frame from the library (the app confirms first). */
  onDelete?: (shot: Shot) => void
  mobile?: boolean
}

type Mode = 'slider' | 'sbs' | 'grid'
type Side = 'L' | 'R'
const MODES: [Mode, string, string][] = [['slider', 'Slider', 'slider'], ['sbs', 'Side by side', 'sidebyside'], ['grid', 'Grid', 'grid']]
const NEXT: Record<Mode, Mode> = { slider: 'sbs', sbs: 'grid', grid: 'slider' }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const exif = (s: Shot, maxSharp: number): Record<'shutter' | 'aperture' | 'iso' | 'sharp', string | null> => ({
  shutter: fmtShutter(s.shutter),
  aperture: fmtAperture(s.aperture),
  iso: fmtIso(s.iso),
  sharp: s.sharpness != null ? `sharp ${(s.sharpness / maxSharp).toFixed(2)}` : null
})
const EXIF_KEYS = ['shutter', 'aperture', 'iso', 'sharp'] as const

function Hist({ bins, className }: { bins: number[] | null; className: string }) {
  if (!bins) return null
  const max = Math.max(1, ...bins)
  return (
    <svg className={`cmp-hist ${className}`} viewBox="0 0 64 24" preserveAspectRatio="none" aria-label="Histogram">
      {bins.map((v, i) => <rect key={i} x={i} y={24 - (v / max) * 24} width="1" height={(v / max) * 24} />)}
    </svg>
  )
}

/** Name and settings of one side; settings that differ from the other side are highlighted. Tap it to make that side active. */
function Label({ shot, other, side, active, best, maxSharp, onSide, mobile }: { shot: Shot; other: Shot; side: Side; active: boolean; best: boolean; maxSharp: number; onSide: (s: Side) => void; mobile: boolean }) {
  const mine = exif(shot, maxSharp), theirs = exif(other, maxSharp)
  return (
    <button className={`cmp-lab ${side === 'L' ? 'one' : 'two'} ${active ? 'act' : ''}`} aria-pressed={active} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onSide(side) }}>
      <b><span className="cmp-side">{side === 'L' ? 'LEFT' : 'RIGHT'}</span>{shot.name}{best && <span className="badge best" title="Best of its burst">{mobile ? 'B' : 'best'}</span>}<RatingBadge rating={shot.rating} />{shot.flag === 1 && <span className="badge pick">picked</span>}{shot.flag === -1 && <span className="badge rej">rejected</span>}</b>
      <span className="mono">{EXIF_KEYS.map((k) => mine[k] && <span key={k} className={mine[k] !== theirs[k] ? 'diff' : ''}>{mine[k]}</span>)}</span>
    </button>
  )
}

interface PairProps {
  a: Shot // left
  b: Shot // right
  side: Side
  onSide: (s: Side) => void
  cull: Map<number, Cull>
  maxSharp: number
  zoomRef: MutableRefObject<(() => void) | null>
  hist: boolean
  mobile: boolean
}

function ZoomBtn({ vp }: { vp: ReturnType<typeof useViewport> }) {
  return <button className="cmp-zoom" aria-pressed={vp.zoomed} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); vp.toggle100() }}>{vp.zoomed ? `${vp.percent}%` : '100%'} <span className="key desk">Z</span></button>
}

/** One image with a divider you sweep. Not zoomed: drag anywhere. Zoomed: drag pans, and only the round handle moves the divider. */
function SliderView({ a, b, side, onSide, cull, maxSharp, zoomRef, hist, mobile, p, setP }: PairProps & { p: number; setP: (p: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  const { w, h } = dims(a)
  const vp = useViewport(box, w, h, true)
  zoomRef.current = () => vp.toggle100()
  useEffect(() => () => { zoomRef.current = null }, [zoomRef])

  const at = (e: { clientX: number }): number => {
    const r = box.current!.getBoundingClientRect()
    return clamp(((e.clientX - r.left) / r.width) * 100, 0, 100)
  }
  const divider = {
    onPointerDown: (e: RPointerEvent<HTMLElement>): void => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag(true)
      setP(at(e))
    },
    onPointerMove: (e: RPointerEvent<HTMLElement>): void => { if (drag) setP(at(e)) },
    onPointerUp: (): void => setDrag(false),
    onPointerCancel: (): void => setDrag(false)
  }
  const d2 = dims(b)
  return (
    <div ref={box} className={`cmp-stage cmp-slider ${drag ? 'drag' : ''} ${vp.zoomed ? 'pan' : ''}`} style={{ ['--p' as string]: `${p}%` }} {...(vp.zoomed ? vp.pointer : divider)}>
      <div className="cmp-layer"><ZoomImage shot={a} style={vp.imgStyle()} zoomed={vp.zoomed} className="cmp-zimg" /></div>
      <div className="cmp-layer top"><ZoomImage shot={b} style={vp.imgStyle(d2.w, d2.h)} zoomed={vp.zoomed} className="cmp-zimg" /></div>
      <Label shot={a} other={b} side="L" active={side === 'L'} best={!!cull.get(a.id)?.best} maxSharp={maxSharp} onSide={onSide} mobile={mobile} />
      <Label shot={b} other={a} side="R" active={side === 'R'} best={!!cull.get(b.id)?.best} maxSharp={maxSharp} onSide={onSide} mobile={mobile} />
      {hist && <><Hist bins={a.histogram} className="one" /><Hist bins={b.histogram} className="two" /></>}
      <div className="cmp-handle" aria-hidden><div className="cmp-knob" {...divider} onClick={(e) => e.stopPropagation()}>‹›</div></div>
      <ZoomBtn vp={vp} />
    </div>
  )
}

/** Two frames next to each other (stacked on a phone) sharing one zoom and pan. */
function SbsView({ a, b, side, onSide, cull, maxSharp, zoomRef, hist, mobile }: PairProps) {
  const left = useRef<HTMLDivElement>(null)
  const right = useRef<HTMLDivElement>(null)
  const { w, h } = dims(a)
  const vp = useViewport(left, w, h, true)
  zoomRef.current = () => vp.toggle100()
  useEffect(() => () => { zoomRef.current = null }, [zoomRef])
  // The viewport listens for the wheel on the left pane only; hand the right pane's wheel over to it.
  useEffect(() => {
    const r = right.current, l = left.current
    if (!r || !l) return
    const fwd = (e: WheelEvent): void => {
      e.preventDefault()
      const rr = r.getBoundingClientRect(), lr = l.getBoundingClientRect()
      l.dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY, ctrlKey: e.ctrlKey, clientX: e.clientX - (rr.left - lr.left), clientY: e.clientY - (rr.top - lr.top), cancelable: true, bubbles: true }))
    }
    r.addEventListener('wheel', fwd, { passive: false })
    return () => r.removeEventListener('wheel', fwd)
  }, [])

  const pane = (s: Shot, o: Shot, sd: Side, ref: typeof left) => {
    const d = dims(s)
    return (
      <div ref={ref} className={`cmp-sbp ${side === sd ? 'act' : ''} ${s.flag === -1 ? 'rej' : ''}`} {...vp.pointer} onClick={(e) => { onSide(sd); vp.pointer.onClick(e) }}>
        <ZoomImage shot={s} style={vp.imgStyle(d.w, d.h)} zoomed={vp.zoomed} className="cmp-zimg" />
        <Label shot={s} other={o} side={sd} active={side === sd} best={!!cull.get(s.id)?.best} maxSharp={maxSharp} onSide={onSide} mobile={mobile} />
        {hist && <Hist bins={s.histogram} className="one" />}
      </div>
    )
  }
  return (
    <div className="cmp-stage cmp-sbs">
      {pane(a, b, 'L', left)}
      {pane(b, a, 'R', right)}
      <ZoomBtn vp={vp} />
    </div>
  )
}

/** Every frame as an equal card; tap one to make it the active frame. */
function GridView({ list, cull, maxSharp, cur, onCur, onInspect, hist }: { list: Shot[]; cull: Map<number, Cull>; maxSharp: number; cur: number; onCur: (i: number) => void; onInspect: () => void; hist: boolean }) {
  return (
    <div className="cmp-stage cmp-cards">
      {list.map((s, i) => {
        const c = cull.get(s.id)
        const sharp = s.sharpness != null ? (s.sharpness / maxSharp).toFixed(2) : null
        return (
          <button key={s.id} className={`cmp-card ${i === cur ? 'act' : ''} ${s.flag === -1 ? 'rej' : ''}`} aria-pressed={i === cur} onClick={() => onCur(i)} onDoubleClick={onInspect}>
            <img src={api.previewUrl(s)} alt={s.name} draggable={false} />
            <span className="cmp-tl">
              {c?.best && c.size > 1 && <span className="badge best">best</span>}
              {c?.soft && <span className="badge bad">soft</span>}
              {c?.blink && <span className="badge bad">eyes closed</span>}
              {sharp && <span className="badge">sharp {sharp}</span>}
            </span>
            <span className="cmp-tr"><RatingBadge rating={s.rating} />{s.flag === 1 && <span className="badge pick">✓</span>}</span>
            <span className="cmp-nm">{s.name}</span>
            {hist && <Hist bins={s.histogram} className="two" />}
          </button>
        )
      })}
    </div>
  )
}

interface Ctl {
  onPick: (id: number) => void
  onReject: (id: number) => void
  onUnflag: (id: number) => void
  onRate: (id: number, n: number) => void
  onRemove: (id: number) => void
  onDelete?: (shot: Shot) => void
  onInspect: () => void
  onKeep: () => void
  canKeep: boolean
  mobile: boolean
}

/** One side of the comparison: its frame's controls, and a filmstrip of every frame to put on this side. */
function Panel({ title, shot, active, onActivate, ctl, strip }: { title: string; shot: Shot; active: boolean; onActivate: () => void; ctl: Ctl; strip?: { list: Shot[]; mine: number; other: number; onTap: (i: number) => void } }) {
  const m = ctl.mobile
  const stripEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    stripEl.current?.querySelector('.cmp-th.mine')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [strip?.mine])
  return (
    <section className={`cmp-panel ${active ? 'act' : ''}`} aria-label={title} onPointerDownCapture={onActivate}>
      <div className="cmp-ph">
        <span className="cmp-side">{title}</span>
        <b className="cmp-pn">{shot.name}</b>
        <span className="cmp-pc">
          <FlagButtons shot={shot} onPick={ctl.onPick} onReject={ctl.onReject} onUnflag={ctl.onUnflag} />
          <RatingButtons shot={shot} onPatch={(p) => { if (p.rating !== undefined) ctl.onRate(shot.id, p.rating) }} className="ins-rate" size={m ? 20 : 18} />
          <button className="tb" onClick={ctl.onInspect} title="Inspect larger (I)" aria-label={`Inspect ${shot.name}`}><Icon name="expand" size={15} />Inspect{!m && <span className="key">I</span>}</button>
          <button className="tb" onClick={() => ctl.onRemove(shot.id)} title="Take this frame out of the comparison (it stays in your library)" aria-label={`Remove ${shot.name} from compare`}><Icon name="minus" size={15} />Remove{!m && <span className="key">−</span>}</button>
          {ctl.onDelete && <button className="tb cmp-del" onClick={() => ctl.onDelete?.(shot)} title="Delete from library (Delete)" aria-label={`Delete ${shot.name}`}><Icon name="trash" size={15} />Delete</button>}
          {ctl.canKeep && <button className="tb primary" onClick={ctl.onKeep} title={`Pick ${shot.name}, reject the rest`}><Icon name="check" size={15} />Keep this{!m && <span className="key accent">⏎</span>}</button>}
        </span>
      </div>
      {strip && (
        <div className="cmp-strip" ref={stripEl} role="group" aria-label={`Frames for ${title.toLowerCase()}`}>
          {strip.list.map((s, i) => (
            <button key={s.id} className={`cmp-th ${i === strip.mine ? 'mine' : ''} ${i === strip.other ? 'other' : ''} ${s.flag === -1 ? 'rej' : ''} ${s.flag === 1 ? 'pk' : ''}`} title={i === strip.other ? `${s.name}: on the other side, tap to swap` : s.name} aria-pressed={i === strip.mine} aria-label={`${s.name}${i === strip.mine ? `, ${title.toLowerCase()}` : i === strip.other ? ', other side' : ''}`} onClick={() => strip.onTap(i)}>
              <img src={api.thumbUrl(s)} alt="" draggable={false} />
              {i < 9 && !m && <span className="key">{i + 1}</span>}
              {i === strip.other && <em>⇄</em>}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

export function Compare({ shots, burst, cull, onPick, onReject, onUnflag, onRate, onClear, onKeep, onAdd, onClose, onDelete, mobile = false }: Props) {
  const list = shots
  const n = list.length
  // Start on the burst's best frame (left) against its neighbour, so "Keep this" is one tap when the detector got it right.
  const best = Math.max(0, list.findIndex((s) => cull.get(s.id)?.best && (cull.get(s.id)?.size ?? 1) > 1))
  const [L, setL] = useState(best)
  const [R, setR] = useState(best === 0 ? 1 : 0)
  const [gi, setGi] = useState(best)
  const [side, setSide] = useState<Side>('R')
  const [mode, setMode] = useState<Mode>('slider')
  const [p, setP] = useState(50)
  const [hist, setHist] = useState(false)
  const [inspect, setInspect] = useState(false)
  const zoomRef = useRef<(() => void) | null>(null)
  const system = useRatingSystem()
  const maxSharp = useMemo(() => Math.max(1, ...list.map((s) => s.sharpness ?? 0)), [list])

  // Indices stay valid when frames are removed; the two sides never show the same frame.
  const li = clamp(L, 0, Math.max(0, n - 1))
  const r0 = clamp(R, 0, Math.max(0, n - 1))
  const ri = r0 !== li || n < 2 ? r0 : li + 1 < n ? li + 1 : li - 1
  const g = clamp(gi, 0, Math.max(0, n - 1))
  const eff: Mode = n < 2 ? 'grid' : mode
  const ai = eff === 'grid' ? g : side === 'L' ? li : ri // the active frame: keys and Inspect act on it
  const cur = list[ai]

  /** Put frame `i` on side `sd`. If it is already on the other side, the two swap places. */
  const put = (sd: Side, i: number): void => {
    if (eff === 'grid') { setGi(i); return }
    setSide(sd)
    if (sd === 'L') { setL(i); if (i === ri) setR(li) } else { setR(i); if (i === li) setL(ri) }
  }
  const keepOne = (i: number): void => {
    const s = list[i]
    if (!s || n < 2) return
    onPick(s.id)
    list.forEach((o, j) => j !== i && onReject(o.id))
  }
  const remove = (id: number): void => onKeep(list.filter((s) => s.id !== id).map((s) => s.id))
  const toggleFlag = (v: 1 | -1): void => { if (cur) (cur.flag === v ? onUnflag : v === 1 ? onPick : onReject)(cur.id) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return
      if (inspect || document.querySelector('[role="alertdialog"]')) return // a dialog owns the keys
      const stop = (): void => { e.preventDefault(); e.stopImmediatePropagation() }
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1]
      const rate = digit && e.shiftKey && Number(digit) >= 1 ? keyRating(system, Number(digit)) : null
      const step = e.shiftKey ? 10 : 2
      if (rate !== null && cur) { onRate(cur.id, rate); stop() } // Shift+1..5 rates (Shift+1..3 for thumbs)
      else if (digit && !e.shiftKey && Number(digit) >= 1 && Number(digit) <= n) { put(side, Number(digit) - 1); stop() } // 1..9 puts that frame on the active side
      else if (e.key === 'Tab' && eff !== 'grid') { setSide((s) => (s === 'L' ? 'R' : 'L')); stop() }
      else if ((e.key === 'l' || e.key === 'L') && eff !== 'grid') { setSide('L'); stop() }
      else if ((e.key === 'r' || e.key === 'R') && eff !== 'grid') { setSide('R'); stop() }
      else if ((e.key === 's' || e.key === 'S') && eff !== 'grid') { setL(ri); setR(li); stop() } // swap sides
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const d = e.key === 'ArrowLeft' ? -1 : 1
        if (eff === 'slider') setP((x) => clamp(x + d * step, 0, 100))
        else put(side, clamp(ai + d, 0, n - 1))
        stop()
      }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { put(side, clamp(ai + (e.key === 'ArrowUp' ? -1 : 1), 0, n - 1)); stop() }
      else if (e.key === 'Home' && eff === 'slider') { setP(0); stop() }
      else if (e.key === 'End' && eff === 'slider') { setP(100); stop() }
      else if ((e.key === 'p' || e.key === 'P') && cur) { toggleFlag(1); stop() }
      else if ((e.key === 'x' || e.key === 'X') && cur) { toggleFlag(-1); stop() }
      else if (e.key === '-' && cur) { remove(cur.id); stop() } // drop the active frame from the comparison
      else if (e.key === 'Delete' && cur && onDelete) { onDelete(cur); stop() }
      else if (e.key === 'z' || e.key === 'Z') { zoomRef.current?.(); stop() }
      else if (e.key === 'h' || e.key === 'H') { setHist((v) => !v); stop() }
      else if ((e.key === 'm' || e.key === 'M') && n > 1) { setMode((m) => NEXT[m]); stop() }
      else if ((e.key === 'b' || e.key === 'B') && n > 1) { setMode('slider'); stop() }
      else if ((e.key === 'i' || e.key === 'I' || e.key === ' ') && cur) { setInspect(true); stop() }
      else if (e.key === 'C') { onClear(); stop() }
      else if (e.key === 'Enter') { keepOne(ai); stop() }
      else if (e.key === 'Escape') { onClose(); stop() }
    }
    window.addEventListener('keydown', onKey, true) // capture: runs before App's culling keys
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!n) {
    return (
      <div className="grid-empty">
        <p>Choose frames to compare in the grid: tick the corner box, long-press, or right-click a photo. Or open a burst and press C.</p>
        <button className="tb primary" onClick={onClose}>Go to grid</button>
      </div>
    )
  }

  const a = list[li], b = list[ri]
  const rejects = list.filter((s) => s.flag === -1)
  const picks = list.filter((s) => s.flag === 1)
  const t = new Date(list[0].capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const cam = list[0].camera
  const pair: PairProps = { a, b, side, onSide: setSide, cull, maxSharp, zoomRef, hist, mobile }
  const ctl = (i: number, sd?: Side): Ctl => ({ onPick, onReject, onUnflag, onRate, onRemove: remove, onDelete, onInspect: () => { if (sd) setSide(sd); setInspect(true) }, onKeep: () => keepOne(i), canKeep: n > 1, mobile })

  return (
    <div className={`cmp ${mobile ? 'cmp-m' : ''} ${eff === 'grid' ? 'cmp-g' : ''}`}>
      <div className="cmp-bar" role="toolbar" aria-label="Compare">
        <span className="cmp-title" title="Follow mode pauses while comparing; it resumes when you leave.">
          <strong>Comparing {n}</strong>
          <span>{burst ? 'burst' : 'your choice'} · from {t}{cam ? ` · ${cam}` : ''}</span>
        </span>
        {n > 1 && (
          <span className="seg cmp-modes" role="group" aria-label="Compare mode">
            {MODES.map(([m, label, icon]) => <button key={m} className={eff === m ? 'on' : ''} aria-pressed={eff === m} onClick={() => { if (m === 'grid') setGi(ai); setMode(m) }}><Icon name={icon} size={15} />{label}</button>)}
          </span>
        )}
        <span className="cmp-end">
          <button className={`tb ${hist ? 'on' : ''}`} aria-pressed={hist} onClick={() => setHist((v) => !v)} title="Show each frame's histogram (H)"><Icon name="histogram" size={15} />Histogram {!mobile && <span className="key">H</span>}</button>
          <button className="tb on" onClick={onClose}>Done {!mobile && <span className="key">Esc</span>}</button>
        </span>
      </div>

      {eff === 'slider' && <SliderView {...pair} p={p} setP={setP} />}
      {eff === 'sbs' && <SbsView {...pair} />}
      {eff === 'grid' && <GridView list={list} cull={cull} maxSharp={maxSharp} cur={g} onCur={setGi} onInspect={() => setInspect(true)} hist={hist} />}

      <div className={`cmp-panels ${eff === 'grid' ? 'one' : ''}`}>
        {eff === 'grid' ? (
          <Panel title="SELECTED" shot={cur} active onActivate={() => undefined} ctl={ctl(g)} />
        ) : (
          <>
            <Panel title="LEFT" shot={a} active={side === 'L'} onActivate={() => setSide('L')} ctl={ctl(li, 'L')} strip={{ list, mine: li, other: ri, onTap: (i) => put('L', i) }} />
            <Panel title="RIGHT" shot={b} active={side === 'R'} onActivate={() => setSide('R')} ctl={ctl(ri, 'R')} strip={{ list, mine: ri, other: li, onTap: (i) => put('R', i) }} />
          </>
        )}
      </div>
      <div className="cmp-tools">
        {rejects.length > 0 && rejects.length < n && <button className="tb" onClick={() => onKeep(list.filter((s) => s.flag !== -1).map((s) => s.id))}>Hide {rejects.length} rejected</button>}
        {picks.length > 0 && picks.length < n && <button className="tb" onClick={() => onKeep(picks.map((s) => s.id))}>Only {picks.length} picked</button>}
        <button className="tb" onClick={onAdd} title="Back to the grid to choose more frames">+ Add frames</button>
        <button className="tb" onClick={onClear} title="Clear the chosen frames">Clear {!mobile && <span className="key">⇧C</span>}</button>
      </div>
      {!mobile && (
        <div className="cmp-help">
          <span className="key">1</span>–<span className="key">{Math.min(9, n)}</span> put a frame on the active side · <span className="key">Tab</span> switch side · <span className="key">←</span><span className="key">→</span> {eff === 'slider' ? 'nudge' : 'move'} · <span className="key">P</span> pick · <span className="key">X</span> reject · <span className="key">⇧1</span>–<span className="key">⇧{maxKey(system)}</span> rate · <span className="key">Z</span> zoom · <span className="key">H</span> histogram · <span className="key">M</span> next mode · <span className="key">S</span> swap
        </div>
      )}

      {inspect && (
        <InspectDialog
          shots={list} index={ai} cull={cull} maxSharp={maxSharp}
          onIndex={(i) => put(side, i)}
          onPick={onPick} onReject={onReject} onUnflag={onUnflag} onRate={onRate}
          onCompare={(other) => { setInspect(false); setMode('slider'); setSide('R'); setL(ai); setR(other) }}
          onClose={() => setInspect(false)}
        />
      )}
    </div>
  )
}
