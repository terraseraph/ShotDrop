import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Shot, ShotPatch } from '@shared/types'
import { api } from '../api'
import { fmtAperture, fmtIso, fmtShutter } from '../format'
import { fade } from '../motion'
import './GridPreview.css'

interface Props {
  shot: Shot
  index: number
  total: number
  chosen: boolean | null // null: choosing for Compare isn't available here
  onPrev: () => void
  onNext: () => void
  onPatch: (p: ShotPatch) => void
  onToggleChosen: () => void
  onLoupe: () => void
  onClose: () => void
}

/**
 * Full-size look at a frame without leaving the grid (Space or double-click).
 * Arrows, 1-5, P and X still go to the app's culling keys, which act on the selected frame: this one.
 */
export function GridPreview({ shot, index, total, chosen, onPrev, onNext, onPatch, onToggleChosen, onLoupe, onClose }: Props) {
  const [full, setFull] = useState(false) // 100%: the real file, scrollable
  const stage = useRef<HTMLDivElement>(null)
  const st = useRef({ onClose, onToggleChosen })
  st.current = { onClose, onToggleChosen }

  useEffect(() => setFull(false), [shot.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const stop = (): void => { e.preventDefault(); e.stopImmediatePropagation() }
      if (e.key === 'Escape' || e.key === ' ') { st.current.onClose(); stop() }
      else if (e.key === 'z' || e.key === 'Z') { setFull((f) => !f); stop() }
      else if (e.key === 'c' && chosen !== null) { st.current.onToggleChosen(); stop() }
    }
    window.addEventListener('keydown', onKey, true) // capture: before the grid's Escape (clear chosen)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [chosen])

  // Zooming in on a spot: keep the point you clicked under the cursor.
  const zoomAt = (e: React.MouseEvent): void => {
    if (full) return setFull(false)
    const el = stage.current
    const r = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height
    setFull(true)
    requestAnimationFrame(() => {
      if (!el) return
      el.scrollLeft = fx * el.scrollWidth - el.clientWidth / 2
      el.scrollTop = fy * el.scrollHeight - el.clientHeight / 2
    })
  }

  const exif = [shot.camera, fmtShutter(shot.shutter), fmtAperture(shot.aperture), fmtIso(shot.iso)].filter(Boolean).join(' · ')
  const w = shot.width ?? 0, h = shot.height ?? 0

  return (
    <motion.div className="gp scrim" role="dialog" aria-modal="true" aria-label={`Preview ${shot.name}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} onClick={onClose}>
      <div className="gp-bar" onClick={(e) => e.stopPropagation()}>
        <span className="gp-title">
          <strong>{shot.name}</strong>
          <span>{index + 1} of {total}{exif ? ` · ${exif}` : ''}{w && h ? ` · ${w}×${h}` : ''}</span>
        </span>
        <span className="gp-tools">
          <span className="gp-stars" role="group" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={shot.rating >= n ? 'on' : ''} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onPatch({ rating: shot.rating === n ? 0 : n })}>★</button>
            ))}
          </span>
          <button className={`tb ${shot.flag === 1 ? 'gp-pick' : ''}`} aria-pressed={shot.flag === 1} onClick={() => onPatch({ flag: shot.flag === 1 ? 0 : 1 })}>Pick <span className="key">P</span></button>
          <button className={`tb ${shot.flag === -1 ? 'gp-rej' : ''}`} aria-pressed={shot.flag === -1} onClick={() => onPatch({ flag: shot.flag === -1 ? 0 : -1 })}>Reject <span className="key">X</span></button>
          {chosen !== null && (
            <button className={`tb ${chosen ? 'on' : ''}`} aria-pressed={chosen} onClick={onToggleChosen}>{chosen ? '✓ In compare' : '+ Compare'} <span className="key">C</span></button>
          )}
          <button className={`tb ${full ? 'on' : ''}`} aria-pressed={full} onClick={() => setFull((f) => !f)}>100% <span className="key">Z</span></button>
          <button className="tb" onClick={onLoupe}>Open in Loupe <span className="key">⏎</span></button>
          <button className="tb gp-close" aria-label="Close preview" onClick={onClose}>✕ <span className="key">Esc</span></button>
        </span>
      </div>

      <div ref={stage} className={`gp-stage ${full ? 'full' : ''}`}>
        {full && w && h ? (
          <img src={api.fullUrl(shot, 'jpeg')} alt={shot.name} draggable={false} style={{ width: w, height: h }} onClick={(e) => { e.stopPropagation(); zoomAt(e) }} />
        ) : (
          <img src={api.previewUrl(shot)} alt={shot.name} draggable={false} onClick={(e) => { e.stopPropagation(); zoomAt(e) }} />
        )}
        {index > 0 && <button className="gp-nav prev" aria-label="Previous frame" onClick={(e) => { e.stopPropagation(); onPrev() }}>‹</button>}
        {index < total - 1 && <button className="gp-nav next" aria-label="Next frame" onClick={(e) => { e.stopPropagation(); onNext() }}>›</button>}
      </div>

      <div className="gp-hint" onClick={(e) => e.stopPropagation()}>
        <span className="key">←</span> <span className="key">→</span> browse · <span className="key">1</span>–<span className="key">5</span> rate · click the photo to zoom to 100% · <span className="key">Space</span> close
      </div>
    </motion.div>
  )
}
