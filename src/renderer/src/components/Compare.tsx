import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { motion } from 'motion/react'
import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'
import { api } from '../api'
import { fmtAperture, fmtIso, fmtShutter } from '../format'
import { firm } from '../motion'
import './Compare.css'

interface Props {
  shots: Shot[]
  burst: boolean // the panes are one burst the app picked for you, not frames you chose
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
  mobile?: boolean
}

interface Pan { x: number; y: number }

function Hist({ bins }: { bins: number[] | null }) {
  if (!bins) return null
  const max = Math.max(1, ...bins)
  return (
    <svg className="cmp-hist" viewBox="0 0 64 24" preserveAspectRatio="none" aria-label="Histogram">
      {bins.map((v, i) => <rect key={i} x={i} y={24 - (v / max) * 24} width="1" height={(v / max) * 24} />)}
    </svg>
  )
}

/** Columns for n panes: as square a grid as fits, wider than tall. */
function columns(n: number, mobile: boolean): number {
  if (mobile) return n === 1 ? 1 : 2
  if (n <= 3) return n
  if (n === 4) return 2
  if (n <= 6 || n === 9) return 3
  if (n <= 12) return 4
  return 5
}

const X = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>

export function Compare({ shots, burst, cull, onPick, onReject, onUnflag, onRate, onClear, onKeep, onAdd, onClose, mobile = false }: Props) {
  const list = shots
  // Start on the burst's best frame, so "Pick this one, reject the rest" is one keypress when the detector got it right.
  const [hi, setHi] = useState(() => Math.max(0, shots.findIndex((s) => cull.get(s.id)?.best && (cull.get(s.id)?.size ?? 1) > 1)))
  const [zoom, setZoom] = useState(false)
  const [lock, setLock] = useState(false)
  const [hist, setHist] = useState(false)
  const [pan, setPan] = useState<Pan>({ x: 0.5, y: 0.5 })
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const panes = useRef<HTMLDivElement>(null)
  const h = Math.min(hi, Math.max(0, list.length - 1))
  const cur = list[h]

  const maxSharp = useMemo(() => Math.max(1, ...list.map((s) => s.sharpness ?? 0)), [list])
  const ids = list.map((s) => s.id)
  const remove = (id: number): void => onKeep(ids.filter((x) => x !== id))
  // Keep the ref fresh so the key handler never acts on a stale list.
  const st = useRef({ list, h, props: { onPick, onReject, onRate, onClear, onClose, remove } })
  st.current = { list, h, props: { onPick, onReject, onRate, onClear, onClose, remove } }

  const keepOne = (): void => {
    const { list: l, h: i, props } = st.current
    if (!l[i] || l.length < 2) return
    props.onPick(l[i].id)
    l.forEach((s, j) => j !== i && props.onReject(s.id))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return
      const { list: l, h: i, props } = st.current
      const stop = (): void => { e.preventDefault(); e.stopImmediatePropagation() }
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1]
      if (digit && e.shiftKey && l[i] && Number(digit) >= 1 && Number(digit) <= 5) { props.onRate(l[i].id, Number(digit)); stop() } // Shift+1..5 rates
      else if (digit && !e.shiftKey && Number(digit) >= 1 && Number(digit) <= l.length) { setHi(Number(digit) - 1); stop() } // 1..9 highlights a pane
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setHi((x) => Math.min(l.length - 1, x + 1)); stop() }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setHi((x) => Math.max(0, x - 1)); stop() }
      else if ((e.key === 'p' || e.key === 'P') && l[i]) { props.onPick(l[i].id); stop() }
      else if ((e.key === 'x' || e.key === 'X') && l[i]) { props.onReject(l[i].id); stop() }
      else if (e.key === '-' && l[i]) { props.remove(l[i].id); stop() } // drop the highlighted frame from the comparison
      else if (e.key === 'z' || e.key === 'Z') { setZoom((z) => !z); stop() }
      else if (e.key === 'C') { props.onClear(); stop() }
      else if (e.key === 'Enter') { keepOne(); stop() }
      else if (e.key === 'Escape') { props.onClose(); stop() }
    }
    window.addEventListener('keydown', onKey, true) // capture: runs before App's culling keys
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Keep the highlighted pane in view when the grid scrolls (many frames).
  useEffect(() => {
    panes.current?.querySelector('.cmp-pane.on')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [h])

  if (!list.length) {
    return (
      <div className="grid-empty">
        <p>Choose frames to compare in the grid: tick the corner box, long-press, or right-click a photo. Or open a burst and press C.</p>
        <button className="tb primary" onClick={onClose}>Go to grid</button>
      </div>
    )
  }

  const down = (e: RPointerEvent<HTMLDivElement>, s: Shot): void => {
    if (!zoom || lock) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, w: s.width ?? 1, h: s.height ?? 1 }
  }
  const move = (e: RPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    drag.current = { ...d, x: e.clientX, y: e.clientY }
    setPan((p) => ({ x: Math.min(1, Math.max(0, p.x - dx / d.w)), y: Math.min(1, Math.max(0, p.y - dy / d.h)) }))
  }

  const cam = list[0].camera
  const t = new Date(list[0].capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const cols = columns(list.length, mobile)
  const rows = Math.ceil(list.length / cols)
  const fits = rows <= (mobile ? 2 : 3)
  const rejects = list.filter((s) => s.flag === -1)
  const picks = list.filter((s) => s.flag === 1)

  return (
    <div className={`cmp ${mobile ? 'cmp-m' : ''}`}>
      <div className="cmp-bar" role="toolbar" aria-label="Compare">
        <span className="cmp-title" title="Follow mode pauses while comparing; it resumes when you leave.">
          <strong>Comparing {list.length}</strong>
          <span>{burst ? 'burst' : 'your choice'} · from {t}{cam ? ` · ${cam}` : ''}</span>
        </span>
        <span className="cmp-group" aria-label="Frames">
          <button className="tb" onClick={onAdd} title="Back to the grid to choose more frames">+ Add frames</button>
          <button className="tb" onClick={() => cur && remove(cur.id)} title="Take the highlighted frame out of the comparison (it stays in your library)">Remove {!mobile && <span className="key">−</span>}</button>
          {rejects.length > 0 && rejects.length < list.length && (
            <button className="tb" onClick={() => onKeep(list.filter((s) => s.flag !== -1).map((s) => s.id))}>Hide {rejects.length} rejected</button>
          )}
          {picks.length > 0 && picks.length < list.length && (
            <button className="tb" onClick={() => onKeep(picks.map((s) => s.id))}>Only {picks.length} picked</button>
          )}
        </span>
        <span className="cmp-group" aria-label="View">
          <button className={`tb ${zoom ? 'on' : ''}`} aria-pressed={zoom} onClick={() => setZoom((z) => !z)}>{mobile ? '100%' : 'Linked zoom 100%'} {!mobile && <span className="key">Z</span>}</button>
          {!mobile && <button className={`tb ${lock ? 'on' : ''}`} aria-pressed={lock} onClick={() => setLock((l) => !l)}>Lock pan</button>}
          <button className={`tb ${hist ? 'on' : ''}`} aria-pressed={hist} onClick={() => setHist((v) => !v)}>{mobile ? 'Histogram' : 'Sync histogram'}</button>
        </span>
        <span className="cmp-end">
          <button className="tb" onClick={onClear} title="Clear the chosen frames">Clear {!mobile && <span className="key">⇧C</span>}</button>
          <button className="tb on" onClick={onClose}>Done {!mobile && <span className="key">Esc</span>}</button>
        </span>
      </div>

      <div
        ref={panes}
        className={`cmp-panes ${fits ? '' : 'scroll'}`}
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, ...(fits ? { gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } : {}) }}
      >
        {list.map((s, i) => {
          const c = cull.get(s.id)
          const sharp = s.sharpness != null ? (s.sharpness / maxSharp).toFixed(2) : null
          const bad = c?.soft || c?.blink
          const w = s.width ?? 0, ht = s.height ?? 0
          return (
            <motion.div key={s.id} layout className={`cmp-pane ${i === h ? 'on' : ''} ${bad ? 'dim' : ''} ${s.flag === -1 ? 'rej' : ''}`} transition={firm} onClick={() => setHi(i)}>
              <div className={`cmp-img ${zoom && !lock ? 'grab' : ''}`} onPointerDown={(e) => down(e, s)} onPointerMove={move} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
                {zoom && w && ht ? (
                  <img src={api.fullUrl(s, 'jpeg')} alt={s.name} draggable={false} className="cmp-full" style={{ width: w, height: ht, left: `calc(50% - ${pan.x * w}px)`, top: `calc(50% - ${pan.y * ht}px)` }} />
                ) : (
                  <img src={api.previewUrl(s)} alt={s.name} draggable={false} className="cmp-fit" />
                )}
                <div className="cmp-tl">
                  {c?.best && c.size > 1 && <span className="badge best">best</span>}
                  {c?.soft && <span className="badge bad">soft{sharp ? ` ${sharp}` : ''}</span>}
                  {c?.blink && <span className="badge bad">eyes closed</span>}
                  {!bad && !(c?.best && c.size > 1) && sharp && <span className="badge">sharp {sharp}</span>}
                  {c?.best && c.size > 1 && sharp && <span className="badge">sharp {sharp}</span>}
                </div>
                <div className="cmp-tr">
                  {s.rating > 0 && <span className="badge">★{s.rating}</span>}
                  <button className="cmp-x" aria-label={`Remove ${s.name} from compare`} title="Remove from compare" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); remove(s.id) }}>{X}</button>
                </div>
                {hist && <Hist bins={s.histogram} />}
              </div>
              <div className="cmp-foot">
                <span className="cmp-name">{s.name}</span>
                {!mobile && <span className="mono">{[fmtShutter(s.shutter), fmtAperture(s.aperture), fmtIso(s.iso)].filter(Boolean).join(' · ')}</span>}
                <span className="cmp-flags">
                  <button className={`cmp-flag pick ${s.flag === 1 ? 'on' : ''}`} aria-pressed={s.flag === 1} title="Pick (P)" onClick={(e) => { e.stopPropagation(); setHi(i); s.flag === 1 ? onUnflag(s.id) : onPick(s.id) }}>P</button>
                  <button className={`cmp-flag rej ${s.flag === -1 ? 'on' : ''}`} aria-pressed={s.flag === -1} title="Reject (X)" onClick={(e) => { e.stopPropagation(); setHi(i); s.flag === -1 ? onUnflag(s.id) : onReject(s.id) }}>X</button>
                  {!mobile && i < 9 && <span className="key">{i + 1}</span>}
                </span>
              </div>
            </motion.div>
          )
        })}
      </div>

      <div className="cmp-act">
        {!mobile && <span>Highlight with <span className="key">1</span>–<span className="key">{Math.min(9, list.length)}</span> or arrows · <span className="key">⇧1</span>–<span className="key">⇧5</span> rate · <span className="key">P</span> pick · <span className="key">X</span> reject · <span className="key">−</span> remove</span>}
        {list.length > 1 && (
          <button className="tb primary" onClick={keepOne} title={cur ? `Pick ${cur.name}` : undefined}>
            Pick {mobile ? 'highlighted' : 'this one'}, reject the other {list.length - 1} {!mobile && <span className="key accent">⏎</span>}
          </button>
        )}
      </div>
    </div>
  )
}
