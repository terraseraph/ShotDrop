import { useEffect, useRef, useState } from 'react'
import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'
import { api } from '../api'
import { fmtAperture, fmtIso, fmtShutter } from '../format'
import { keyRating, useRatingSystem } from '../rating'
import { dims, useViewport, ZoomImage } from './Viewport'

/** A small "pick the other frame" sheet. Frames are numbered like the compare panes, so the number keys choose. */
export function FramePicker({ shots, exclude, title, onPick, onCancel }: { shots: Shot[]; exclude: number; title: string; onPick: (index: number) => void; onCancel: () => void }) {
  return (
    // Stop pointerdown here: in the slider the picker sits inside the stage, whose divider drag would capture the pointer and swallow the click.
    <div className="ba-pick" onClick={onCancel} onPointerDown={(e) => e.stopPropagation()}>
      <div className="ba-picker sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h5>{title}</h5>
        <p>Choose the second frame.</p>
        <div className="ba-pick-grid">
          {shots.map((s, n) => n !== exclude && (
            <button key={s.id} className="ins-th" title={s.name} onClick={() => onPick(n)}>
              <img src={api.thumbUrl(s)} alt={s.name} draggable={false} />
              {n < 9 && <span className="key">{n + 1}</span>}
            </button>
          ))}
        </div>
        <div className="ba-pick-foot"><button className="tb" onClick={onCancel}>Cancel <span className="key">Esc</span></button></div>
      </div>
    </div>
  )
}

interface Props {
  shots: Shot[] // every compared frame, for the picker
  a: number // index of the first frame (left / top)
  b: number // index of the second frame (right / bottom)
  cull: Map<number, Cull>
  maxSharp: number
  onChange: (a: number, b: number) => void
  onPick: (id: number) => void
  onReject: (id: number) => void
  onUnflag: (id: number) => void
  onRate: (id: number, n: number) => void
  onClose: () => void
}

type Orient = 'h' | 'v'

const exif = (s: Shot, maxSharp: number): { shutter: string | null; aperture: string | null; iso: string | null; sharp: string | null } => ({
  shutter: fmtShutter(s.shutter),
  aperture: fmtAperture(s.aperture),
  iso: fmtIso(s.iso),
  sharp: s.sharpness != null ? `sharp ${(s.sharpness / maxSharp).toFixed(2)}` : null
})

export function BeforeAfter({ shots, a, b, cull, maxSharp, onChange, onPick, onReject, onUnflag, onRate, onClose }: Props) {
  const [p, setP] = useState(50) // divider position, % of the box
  const [orient, setOrient] = useState<Orient>('h')
  const [flip, setFlip] = useState(false) // swap sides
  const [dragging, setDragging] = useState(false)
  const [space, setSpace] = useState(false) // hold Space to pan instead of moving the divider
  const [picking, setPicking] = useState<'a' | 'b' | null>(null)
  const side = useRef<'first' | 'second'>('first') // which half the pointer is over, for P / X
  const box = useRef<HTMLDivElement>(null)
  const system = useRatingSystem()

  const first = shots[flip ? b : a], second = shots[flip ? a : b]
  const { w, h } = dims(first)
  const vp = useViewport(box, w, h, true)

  const at = (e: { clientX: number; clientY: number }): number => {
    const r = box.current!.getBoundingClientRect()
    return orient === 'h' ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100
  }
  const clampP = (v: number): number => Math.min(100, Math.max(0, v))
  const divider = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>): void => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
      setP(clampP(at(e)))
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>): void => {
      side.current = at(e) < p ? 'first' : 'second'
      if (dragging) setP(clampP(at(e)))
    },
    onPointerUp: (): void => setDragging(false),
    onPointerCancel: (): void => setDragging(false)
  }
  const panning = space ? vp.pointer : divider

  const swap = (): void => setFlip((f) => !f)
  const spin = (): void => { setOrient((o) => (o === 'h' ? 'v' : 'h')); setP(50) }

  const st = useRef({ shots, a, b, flip, picking, system, vp, props: { onChange, onPick, onReject, onRate, onClose } })
  st.current = { shots, a, b, flip, picking, system, vp, props: { onChange, onPick, onReject, onRate, onClose } }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return
      const { shots: l, a: ia, b: ib, flip: fl, picking: pk, system: sys, vp: v, props } = st.current
      const stop = (): void => { e.preventDefault(); e.stopImmediatePropagation() }
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1]
      if (e.key === 'Escape') { if (pk) setPicking(null); else props.onClose(); stop(); return }
      if (pk) {
        if (digit && !e.shiftKey) {
          const n = Number(digit) - 1
          const other = pk === 'a' ? ib : ia
          if (n >= 0 && n < l.length && n !== other) { props.onChange(pk === 'a' ? n : ia, pk === 'a' ? ib : n); setPicking(null) }
        }
        stop()
        return
      }
      const step = e.shiftKey ? 10 : 1
      const target = l[(side.current === 'first') !== fl ? ia : ib]
      const rate = digit && e.shiftKey && Number(digit) >= 1 ? keyRating(sys, Number(digit)) : null
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setP((x) => clampP(x - step)); stop() }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setP((x) => clampP(x + step)); stop() }
      else if (e.key === 'Home') { setP(0); stop() }
      else if (e.key === 'End') { setP(100); stop() }
      else if (digit === '0' && !e.shiftKey) { setP(50); v.reset(); stop() }
      else if (e.key === 's' || e.key === 'S') { setFlip((f) => !f); stop() }
      else if (e.key === 'v' || e.key === 'V') { setOrient((o) => (o === 'h' ? 'v' : 'h')); setP(50); stop() }
      else if (e.key === 'z' || e.key === 'Z') { v.toggle100(); stop() }
      else if (e.key === ' ') { setSpace(true); stop() }
      else if (rate !== null && target) { props.onRate(target.id, rate); stop() }
      else if ((e.key === 'p' || e.key === 'P') && target) { props.onPick(target.id); stop() }
      else if ((e.key === 'x' || e.key === 'X') && target) { props.onReject(target.id); stop() }
    }
    const onUp = (e: KeyboardEvent): void => { if (e.key === ' ') setSpace(false) }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onUp, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onUp, true) }
  }, [])

  if (!first || !second) return null
  const fx = exif(first, maxSharp), sx = exif(second, maxSharp)
  const vertical = orient === 'v'
  const style = vp.imgStyle()
  const d2 = dims(second)
  const style2 = vp.imgStyle(d2.w, d2.h) // its own size, so a portrait frame isn't stretched to a landscape one

  const label = (s: Shot, mine: ReturnType<typeof exif>, other: ReturnType<typeof exif>, cls: string) => (
    <div className={`ba-lab ${cls}`}>
      <b><span className="ba-tag">{s === shots[a] ? 'A' : 'B'}</span>{s.name}{cull.get(s.id)?.best ? <span className="badge best">best</span> : null}</b>
      <span className="mono">
        {(['shutter', 'aperture', 'iso', 'sharp'] as const).map((k) => mine[k] && <span key={k} className={mine[k] !== other[k] ? 'diff' : ''}>{mine[k]}</span>)}
      </span>
      <span className="ba-flags">
        <button className={`cmp-flag pick ${s.flag === 1 ? 'on' : ''}`} aria-pressed={s.flag === 1} title="Pick (P)" onPointerDown={(e) => e.stopPropagation()} onClick={() => (s.flag === 1 ? onUnflag(s.id) : onPick(s.id))}>P</button>
        <button className={`cmp-flag rej ${s.flag === -1 ? 'on' : ''}`} aria-pressed={s.flag === -1} title="Reject (X)" onPointerDown={(e) => e.stopPropagation()} onClick={() => (s.flag === -1 ? onUnflag(s.id) : onReject(s.id))}>X</button>
      </span>
    </div>
  )

  return (
    <div className="cmp ba">
      <div className="cmp-bar" role="toolbar" aria-label="Before and after">
        <span className="cmp-title"><strong>Before / after</strong><span>{first.name} vs {second.name}</span></span>
        <span className="cmp-group">
          <span className="seg" role="group" aria-label="Split direction">
            <button className={!vertical ? 'on' : ''} onClick={() => { if (vertical) spin() }}>Left | Right</button>
            <button className={vertical ? 'on' : ''} onClick={() => { if (!vertical) spin() }}>Top / Bottom</button>
          </span>
          <button className="tb" onClick={swap}>⇄ Swap sides <span className="key">S</span></button>
        </span>
        <span className="cmp-group">
          <button className={`tb ${vp.zoomed ? 'on' : ''}`} aria-pressed={vp.zoomed} onClick={() => vp.toggle100()}>{vp.zoomed ? `${vp.percent}%` : '100%'} <span className="key">Z</span></button>
        </span>
        <span className="cmp-group">
          <button className="tb" onClick={() => setPicking('a')} title="Replace the first frame">Change {shots[a].name}…</button>
          <button className="tb" onClick={() => setPicking('b')} title="Replace the second frame">Change {shots[b].name}…</button>
        </span>
        <span className="cmp-end"><button className="tb on" onClick={onClose}>Back <span className="key">Esc</span></button></span>
      </div>

      <div
        ref={box}
        className={`ba-stage ${vertical ? 'v' : ''} ${dragging ? 'drag' : ''} ${space ? (vp.zoomed ? 'pan' : '') : 'split'}`}
        style={{ ['--p' as string]: `${p}%` }}
        {...panning}
      >
        <div className="ba-layer"><ZoomImage shot={first} style={style} zoomed={vp.zoomed} className="ba-img" /></div>
        <div className="ba-layer top"><ZoomImage shot={second} style={style2}zoomed={vp.zoomed} className="ba-img" /></div>
        {label(first, fx, sx, 'one')}
        {label(second, sx, fx, 'two')}
        <div className="ba-handle" aria-hidden><div className="ba-knob">‹›</div></div>
        {picking && (
          <FramePicker
            shots={shots}
            exclude={picking === 'a' ? b : a}
            title={`Replace ${picking === 'a' ? shots[a].name : shots[b].name} with…`}
            onPick={(n) => { onChange(picking === 'a' ? n : a, picking === 'a' ? b : n); setPicking(null) }}
            onCancel={() => setPicking(null)}
          />
        )}
      </div>

      <div className="cmp-act">
        <span><span className="key">←</span><span className="key">→</span> nudge · <span className="key">⇧</span> ×10 · <span className="key">S</span> swap · <span className="key">V</span> split direction · <span className="key">Z</span> zoom, wheel zooms, hold <span className="key">Space</span> and drag to pan · <span className="key">P</span> / <span className="key">X</span> the side under the pointer</span>
      </div>
    </div>
  )
}
