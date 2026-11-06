import { useEffect, useRef, useState } from 'react'
import type { Shot } from '@shared/types'
import { api } from '../api'
import { fmtAperture, fmtFocal, fmtIso, fmtShutter, fmtTime } from '../format'
import { motion } from 'motion/react'
import { Icon } from './Icon'
import { Badges } from './Badges'

interface Props {
  shot: Shot | null
  fresh: boolean
  follow: boolean
  onPrev: () => void
  onNext: () => void
}

export function Loupe({ shot, fresh, follow, onPrev, onNext }: Props) {
  const [zoom, setZoom] = useState(false)
  const [origin, setOrigin] = useState({ x: 50, y: 50 })
  const [loaded, setLoaded] = useState(false)
  const [showHist, setShowHist] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setZoom(false)
    setLoaded(false)
  }, [shot?.id])

  // `z` toggles 100% zoom at the centre.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'z' || e.key === 'Z' || e.key === ' ') && !(e.target as HTMLElement).closest('input, textarea, select')) {
        e.preventDefault()
        setOrigin({ x: 50, y: 50 })
        setZoom((z) => !z)
      } else if ((e.key === 'h' || e.key === 'H') && !(e.target as HTMLElement).closest('input, textarea, select')) setShowHist((h) => !h)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!shot) return <div className="loupe" />

  const jpeg = shot.files.find((f) => f.kind === 'jpeg')
  // Full-res zoom straight from the camera JPEG when there is one; otherwise the 2560px embedded preview.
  const zoomSrc = jpeg ? api.originalUrl(shot.id, jpeg.id) : api.previewUrl(shot.id)

  const track = (e: React.MouseEvent): void => {
    const r = box.current!.getBoundingClientRect()
    setOrigin({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 })
  }

  const exif = [fmtShutter(shot.shutter), fmtAperture(shot.aperture), fmtIso(shot.iso), fmtFocal(shot.focalLength)].filter(Boolean)

  return (
    <div className="loupe">
      <div
        ref={box}
        className={`loupe-canvas ${zoom ? 'zoomed' : ''} ${fresh ? 'fresh' : ''}`}
        onClick={(e) => {
          track(e)
          setZoom((z) => !z)
        }}
        onMouseMove={zoom ? track : undefined}
      >
        {shot.hasPreview ? (
          zoom ? (
            <div className="zoom-layer" style={{ backgroundImage: `url("${zoomSrc}")`, backgroundPosition: `${origin.x}% ${origin.y}%` }} />
          ) : (
            <>
              <img className="loupe-thumb" src={api.thumbUrl(shot.id)} alt="" aria-hidden />
              <img
                key={shot.id}
                className={`loupe-img ${loaded ? 'ready' : ''}`}
                src={api.previewUrl(shot.id)}
                alt={shot.name}
                onLoad={() => setLoaded(true)}
                draggable={false}
              />
            </>
          )
        ) : (
          <div className="no-preview">
            <Icon name="camera" size={32} />
            <span>No preview for {shot.files.map((f) => f.name).join(', ')}</span>
          </div>
        )}
      </div>

      {showHist && shot.histogram && !zoom && <Histogram bins={shot.histogram} clipped={shot.clipped} />}

      <button className="nav prev" onClick={onPrev} aria-label="Previous">
        <Icon name="prev" size={22} />
      </button>
      <button className="nav next" onClick={onNext} aria-label="Next">
        <Icon name="next" size={22} />
      </button>

      <div className="loupe-hud">
        <div className="hud-left">
          <strong>{shot.name}</strong>
          <span className="muted">{fmtTime(shot.capturedAt)}</span>
          {shot.files.length > 1 && <span className="pill">{shot.files.map((f) => f.kind.toUpperCase()).join('+')}</span>}
          {fresh && (
            <motion.span className="pill new" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', bounce: 0.3, visualDuration: 0.45 }}>
              New
            </motion.span>
          )}
        </div>
        <div className="hud-exif mono">{exif.join('  ·  ')}</div>
        <div className="hud-right">
          <Badges shot={shot} />
          {zoom && <span className="pill">100%</span>}
          {follow && <span className="pill live">Following</span>}
        </div>
      </div>
    </div>
  )
}

function Histogram({ bins, clipped }: { bins: number[]; clipped: number | null }) {
  const d = `M0 100 ${bins.map((v, i) => `L${i} ${100 - v}`).join(' ')} L63 100Z`
  return (
    <motion.div className="hist" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      {clipped != null && clipped > 1 && <span className="pill warn">▲ {Math.round(clipped)}% highlights clipped</span>}
      <svg viewBox="0 0 63 100" preserveAspectRatio="none" aria-hidden>
        <path d={d} fill="rgba(255,255,255,.45)" />
      </svg>
    </motion.div>
  )
}
