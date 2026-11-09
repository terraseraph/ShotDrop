import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { motion } from 'motion/react'
import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'
import { api } from '../api'
import { fmtAperture, fmtFocal, fmtIso, fmtShutter, fmtTime } from '../format'
import { fade, popIn } from '../motion'
import { RatingButtons, keyRating, useRatingSystem } from '../rating'
import { FramePicker } from './BeforeAfter'
import { FlagButtons } from './FlagButtons'
import { dims, useViewport, ZoomImage } from './Viewport'

interface Props {
  shots: Shot[]
  index: number
  cull: Map<number, Cull>
  maxSharp: number
  onIndex: (i: number) => void
  onPick: (id: number) => void
  onReject: (id: number) => void
  onUnflag: (id: number) => void
  onRate: (id: number, n: number) => void
  /** Start the before/after slider with the open frame and the frame at this index. */
  onCompare: (other: number) => void
  onClose: () => void
}

/** 64 luminance bins as a filled curve; a red bar on the right when highlights clip. */
function Histogram({ bins, clipped }: { bins: number[]; clipped: number | null }) {
  const n = bins.length - 1 || 1
  const d = `M0 48 ${bins.map((v, i) => `L${((i / n) * 148).toFixed(1)} ${(48 - (Math.min(v, 100) / 100) * 46).toFixed(1)}`).join(' ')} L148 48Z`
  return (
    <svg className="ins-hist" viewBox="0 0 148 48" preserveAspectRatio="none" role="img" aria-label="Histogram">
      <path d={d} fill="rgba(255,255,255,.55)" />
      {(clipped ?? 0) > 0.05 && <rect x="143" y="0" width="5" height="48" fill="rgba(229,72,77,.8)" />}
    </svg>
  )
}

/** Red where the preview is blown to white, blue where it is crushed to black. Drawn in the image's own coordinates so it zooms with it. */
function ClipOverlay({ shot, style }: { shot: Shot; style: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setFailed(false)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const c = ref.current
      if (!live || !c) return
      try {
        const sc = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc))
        c.width = w
        c.height = h
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(img, 0, 0, w, h)
        const data = ctx.getImageData(0, 0, w, h)
        const px = data.data
        for (let i = 0; i < px.length; i += 4) {
          const hi = px[i] >= 250 && px[i + 1] >= 250 && px[i + 2] >= 250
          const lo = px[i] <= 4 && px[i + 1] <= 4 && px[i + 2] <= 4
          const stripe = ((i / 4) % w + Math.floor(i / 4 / w)) % 6 < 3
          px[i] = hi ? 229 : 91
          px[i + 1] = hi ? 72 : 167
          px[i + 2] = hi ? 77 : 247
          px[i + 3] = (hi || lo) && stripe ? 200 : 0
        }
        ctx.putImageData(data, 0, 0)
      } catch { setFailed(true) }
    }
    img.onerror = () => { if (live) setFailed(true) }
    img.src = api.previewUrl(shot)
    return () => { live = false }
  }, [shot])
  if (failed) return null
  return <canvas ref={ref} className="ins-clip" style={{ ...style, imageRendering: 'pixelated' }} aria-hidden />
}

const row = (k: string, v: string | null | undefined) => (v ? <div className="ins-row" key={k}><span>{k}</span><span>{v}</span></div> : null)

export function InspectDialog({ shots, index, cull, maxSharp, onIndex, onPick, onReject, onUnflag, onRate, onCompare, onClose }: Props) {
  const i = Math.min(index, shots.length - 1)
  const shot = shots[i]
  const c = cull.get(shot.id)
  const box = useRef<HTMLDivElement>(null)
  const { w, h } = dims(shot)
  const vp = useViewport(box, w, h)
  const [linked, setLinked] = useState(false)
  const [hist, setHist] = useState(true)
  const [clip, setClip] = useState(false)
  const [picking, setPicking] = useState(false)
  const system = useRatingSystem()

  // Stepping starts the next frame fitted, unless zoom is linked.
  useEffect(() => { if (!linked) vp.reset() }, [shot.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const compareWith = (other: number): void => { if (other !== i && shots[other]) onCompare(other) }
  const startCompare = (): void => {
    if (shots.length < 2) return
    if (shots.length === 2) compareWith(1 - i)
    else setPicking(true)
  }

  const st = useRef({ i, shots, picking, system, vp, props: { onIndex, onPick, onReject, onRate, onClose, compareWith, startCompare } })
  st.current = { i, shots, picking, system, vp, props: { onIndex, onPick, onReject, onRate, onClose, compareWith, startCompare } }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return
      const { i: cur, shots: l, picking: pk, system: sys, vp: v, props } = st.current
      const stop = (): void => { e.preventDefault(); e.stopImmediatePropagation() }
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1]
      if (e.key === 'Escape') { if (pk) setPicking(false); else props.onClose(); stop(); return }
      if (pk) { // the frame picker owns the number keys
        if (digit && !e.shiftKey && Number(digit) >= 1 && Number(digit) <= l.length) { setPicking(false); props.compareWith(Number(digit) - 1) }
        stop()
        return
      }
      const rate = digit && e.shiftKey && Number(digit) >= 1 ? keyRating(sys, Number(digit)) : null
      if (rate !== null) { props.onRate(l[cur].id, rate); stop() }
      else if (digit && !e.shiftKey && Number(digit) >= 1 && Number(digit) <= l.length) { props.onIndex(Number(digit) - 1); stop() }
      else if (digit === '0' && !e.shiftKey) { v.reset(); stop() }
      else if (e.key === 'ArrowRight') { props.onIndex(Math.min(l.length - 1, cur + 1)); stop() }
      else if (e.key === 'ArrowLeft') { props.onIndex(Math.max(0, cur - 1)); stop() }
      else if (e.key === 'z' || e.key === 'Z') { v.toggle100(); stop() }
      else if (e.key === 'h' || e.key === 'H') { setHist((x) => !x); stop() }
      else if (e.key === 'j' || e.key === 'J') { setClip((x) => !x); stop() }
      else if (e.key === 'b' || e.key === 'B') { props.startCompare(); stop() }
      else if (e.key === 'p' || e.key === 'P') { props.onPick(l[cur].id); stop() }
      else if (e.key === 'x' || e.key === 'X') { props.onReject(l[cur].id); stop() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const sharp = shot.sharpness != null ? shot.sharpness / maxSharp : null
  const clipPct = shot.clipped ?? 0
  const style = vp.imgStyle()

  return (
    <div className="ins-root">
      <motion.div className="ins-scrim scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade} />
      <motion.div className="ins sheet" role="dialog" aria-modal="true" aria-label={`Inspect ${shot.name}`} {...popIn}>
        <header className="ins-head">
          <span className="ins-name">{shot.name}</span>
          <span className="mono">{i + 1} of {shots.length}{shot.width && shot.height ? ` · ${shot.width}×${shot.height}` : ''}</span>
          <span className="ins-group">
            <button className={`tb ${!vp.zoomed ? 'on' : ''}`} onClick={vp.reset} aria-pressed={!vp.zoomed}>Fit <span className="key">0</span></button>
            <button className={`tb ${vp.zoomed ? 'on' : ''}`} onClick={() => vp.toggle100()} aria-pressed={vp.zoomed} title="Toggle fit and 100%. Wheel or pinch zooms, drag pans.">{vp.zoomed ? `${vp.percent}%` : '100%'} <span className="key">Z</span></button>
            <button className={`tb ${linked ? 'on' : ''}`} onClick={() => setLinked((l) => !l)} aria-pressed={linked} title="Keep the zoom and position when stepping to the next frame">Linked zoom</button>
          </span>
          <span className="ins-group">
            <button className={`tb ${clip ? 'on' : ''}`} onClick={() => setClip((x) => !x)} aria-pressed={clip} title="Red = blown highlights, blue = crushed shadows">Clipping <span className="key">J</span></button>
            <button className={`tb ${hist ? 'on' : ''}`} onClick={() => setHist((x) => !x)} aria-pressed={hist}>Histogram <span className="key">H</span></button>
          </span>
          <span className="ins-end">
            {shots.length > 1 && <button className="tb primary" onClick={startCompare}>◐ Compare with… <span className="key accent">B</span></button>}
            <button className="tb on" onClick={onClose}>Close <span className="key">Esc</span></button>
          </span>
        </header>

        <div className="ins-body">
          <div ref={box} className={`ins-canvas ${vp.zoomed ? 'grab' : ''}`} {...vp.pointer}>
            <ZoomImage key={shot.id} shot={shot} style={style} zoomed={vp.zoomed} className="ins-img" />
            {clip && <ClipOverlay shot={shot} style={style} />}
            <div className="ins-tl">
              {c?.best && c.size > 1 && <span className="badge best">best</span>}
              {c?.soft && <span className="badge bad">soft</span>}
              {c?.blink && <span className="badge bad">eyes closed</span>}
              {sharp != null && <span className="badge">sharp {sharp.toFixed(2)}</span>}
            </div>
            {i > 0 && <button className="ins-nav prev" aria-label="Previous frame" onClick={(e) => { e.stopPropagation(); onIndex(i - 1) }} onPointerDown={(e) => e.stopPropagation()}>‹</button>}
            {i < shots.length - 1 && <button className="ins-nav next" aria-label="Next frame" onClick={(e) => { e.stopPropagation(); onIndex(i + 1) }} onPointerDown={(e) => e.stopPropagation()}>›</button>}
            {clip && <div className="ins-legend"><span className="sw hi" /> highlights <span className="sw lo" /> shadows</div>}
          </div>

          <aside className="ins-side">
            {hist && shot.histogram && (
              <section>
                <h4>Histogram</h4>
                <Histogram bins={shot.histogram} clipped={shot.clipped} />
                <div className="ins-row"><span>Highlights clipped</span><span className={clipPct > 1 ? 'warn' : ''}>{clipPct < 10 ? clipPct.toFixed(1) : Math.round(clipPct)}%</span></div>
                {shot.dark != null && <div className="ins-row"><span>Shadows crushed</span><span>{shot.dark < 10 ? shot.dark.toFixed(1) : Math.round(shot.dark)}%</span></div>}
              </section>
            )}
            <section>
              <h4>Focus</h4>
              {sharp != null ? (
                <>
                  <div className="ins-row"><span>Sharpness (vs compared)</span><span>{sharp.toFixed(2)}</span></div>
                  <div className="ins-meter"><i style={{ width: `${Math.round(sharp * 100)}%` }} /></div>
                </>
              ) : <div className="ins-row"><span>Sharpness</span><span>not measured</span></div>}
              <div className="ins-row"><span>Faces / eyes</span><span>{shot.faces == null ? 'not scanned' : `${shot.faces}${shot.blink != null ? (shot.blink > 0.5 ? ' · closed' : ' · open') : ''}`}</span></div>
            </section>
            <section>
              <h4>Exposure</h4>
              {row('Shutter', fmtShutter(shot.shutter))}
              {row('Aperture', fmtAperture(shot.aperture))}
              {row('ISO', shot.iso ? String(shot.iso) : null)}
              {row('Focal length', fmtFocal(shot.focalLength))}
            </section>
            <section>
              <h4>Camera</h4>
              {row('Body', shot.camera)}
              {row('Lens', shot.lens)}
              {row('Captured', fmtTime(shot.capturedAt))}
              {row('Files', shot.files.map((f) => f.name.split('.').pop()?.toUpperCase()).join(' + '))}
            </section>
            <section>
              <h4>Cull</h4>
              <div className="ins-cull">
                <FlagButtons shot={shot} onPick={onPick} onReject={onReject} onUnflag={onUnflag} />
                <RatingButtons shot={shot} onPatch={(p) => { if (p.rating !== undefined) onRate(shot.id, p.rating) }} className="ins-rate" size={16} />
              </div>
              <p className="ins-hint"><span className="key">P</span> <span className="key">X</span> <span className="key">⇧1</span>–<span className="key">⇧{system === 'stars' ? 5 : 3}</span></p>
            </section>
          </aside>
        </div>

        <div className="ins-strip" role="tablist" aria-label="Compared frames">
          {shots.map((s, n) => (
            <button key={s.id} role="tab" aria-selected={n === i} className={`ins-th ${n === i ? 'on' : ''} ${s.flag === -1 ? 'rej' : ''}`} title={s.name} onClick={() => onIndex(n)}>
              <img src={api.thumbUrl(s)} alt={s.name} draggable={false} />
              {n < 9 && <span className="key">{n + 1}</span>}
            </button>
          ))}
          <span className="ins-keys"><span className="key">←</span> <span className="key">→</span> previous / next · <span className="key">Z</span> zoom · <span className="key">B</span> before / after · <span className="key">Esc</span> close</span>
        </div>

        {picking && (
          <FramePicker shots={shots} exclude={i} title={`Compare ${shot.name} with…`} onPick={(n) => { setPicking(false); compareWith(n) }} onCancel={() => setPicking(false)} />
        )}
      </motion.div>
    </div>
  )
}
