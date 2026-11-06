import { useEffect, useRef, useState } from 'react'
import type { Shot, ShotSource, ShotSources } from '@shared/types'
import { api, isRemote } from '../api'
import { fmtAperture, fmtFocal, fmtIso, fmtShutter, fmtTime } from '../format'
import { motion } from 'motion/react'
import { Icon } from './Icon'
import { Badges } from './Badges'
import { OpenExternal } from './OpenExternal'

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
  // Video the browser can't decode (HEVC, ProRes, 10-bit...) falls back to a server-made H.264 copy.
  const [fallback, setFallback] = useState<'off' | 'working' | 'ready' | 'failed'>('off')
  const box = useRef<HTMLDivElement>(null)

  // Which rendition is on screen: 'auto' = the quick 2560px preview of the best file; otherwise a full-size source.
  const [src, setSrc] = useState<'auto' | ShotSource['key']>('auto')
  const [sources, setSources] = useState<ShotSources | null>(null)
  const [developing, setDeveloping] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const idRef = useRef<number | null>(null)
  idRef.current = shot?.id ?? null

  useEffect(() => {
    setZoom(false)
    setLoaded(false)
    setFallback('off')
    setSrc('auto')
    setErr(null)
    setDeveloping(false)
    setSources(null)
    if (!shot) return
    let live = true
    api.sources(shot.id).then((s) => live && setSources(s)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [shot?.id, shot?.files.length])

  useEffect(() => setLoaded(false), [src])

  const shotId = shot?.id
  useEffect(() => {
    if (fallback !== 'working' || shotId === undefined) return
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const r = await api.proxy(shotId)
        if (stop) return
        if (r.ready) setFallback('ready')
        else if (r.error) setFallback('failed')
        else timer = setTimeout(() => void poll(), 2000)
      } catch {
        if (!stop) setFallback('failed')
      }
    }
    void poll()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [fallback, shotId])

  // `z` toggles 100% zoom at the centre.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'z' || e.key === 'Z' || e.key === ' ') && !(e.target as HTMLElement).closest('input, textarea, select, video')) {
        e.preventDefault()
        setOrigin({ x: 50, y: 50 })
        setZoom((z) => !z)
      } else if ((e.key === 'h' || e.key === 'H') && !(e.target as HTMLElement).closest('input, textarea, select')) setShowHist((h) => !h)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!shot) return <div className="loupe" />

  const video = shot.files.find((f) => f.kind === 'video')
  const jpeg = shot.files.find((f) => f.kind === 'jpeg')
  const list = sources?.sources ?? []
  const byKey = (k: ShotSource['key']): ShotSource | undefined => list.find((s) => s.key === k)
  const autoKey = byKey('jpeg') ? 'jpeg' : byKey('embedded') ? 'embedded' : null
  const active = src === 'auto' ? autoKey : src
  const info = active ? byKey(active) : undefined
  const sourceName = (s: ShotSource): string => (s.key === 'embedded' && byKey('jpeg') ? 'RAW preview' : s.label)

  // Full-res zoom: the chosen source; else the camera JPEG, else the RAW's full-size embedded preview, else the 2560px preview.
  const zoomSrc =
    src !== 'auto' ? api.fullUrl(shot, src) : jpeg ? api.originalUrl(shot, jpeg.id) : byKey('embedded') ? api.fullUrl(shot, 'embedded') : api.previewUrl(shot)
  const fitSrc = src === 'auto' ? api.previewUrl(shot) : api.fullUrl(shot, src)

  const choose = async (s: ShotSource): Promise<void> => {
    if (s.key !== 'raw' || s.ready) return setSrc(s.key === autoKey ? 'auto' : s.key)
    const id = shot.id
    setDeveloping(true)
    setErr(null)
    try {
      const done = await api.develop(id)
      if (idRef.current !== id) return
      setSources((cur) => cur && { ...cur, sources: cur.sources.map((x) => (x.key === 'raw' ? done : x)) })
      setSrc('raw')
    } catch (e) {
      if (idRef.current === id) setErr((e as Error).message)
    } finally {
      if (idRef.current === id) setDeveloping(false)
    }
  }

  const track = (e: React.MouseEvent): void => {
    const r = box.current!.getBoundingClientRect()
    setOrigin({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 })
  }

  const exif = [fmtShutter(shot.shutter), fmtAperture(shot.aperture), fmtIso(shot.iso), fmtFocal(shot.focalLength)].filter(Boolean)

  return (
    <div className="loupe">
      <div
        ref={box}
        className={`loupe-canvas ${zoom && !video ? 'zoomed' : ''} ${fresh ? 'fresh' : ''}`}
        onClick={
          video
            ? undefined
            : (e) => {
                track(e)
                setZoom((z) => !z)
              }
        }
        onMouseMove={zoom && !video ? track : undefined}
      >
        {video ? (
          <>
            <video
              key={`${shot.id}-${fallback === 'ready'}`}
              className="loupe-video"
              src={fallback === 'ready' ? api.proxyUrl(shot) : api.originalUrl(shot, video.id)}
              poster={shot.hasPreview ? api.previewUrl(shot) : undefined}
              controls
              preload="metadata"
              onError={() => setFallback((f) => (f === 'off' ? 'working' : f))}
            />
            {(fallback === 'working' || fallback === 'failed') && (
              <div className="video-note">
                <span>{fallback === 'working' ? 'Preparing a playable copy…' : "Can't play this format here."}</span>
                <OpenExternal shot={shot} file={video} />
              </div>
            )}
          </>
        ) : shot.hasPreview ? (
          zoom ? (
            <div className="zoom-layer" style={{ backgroundImage: `url("${zoomSrc}")`, backgroundPosition: `${origin.x}% ${origin.y}%` }} />
          ) : (
            <>
              <img className="loupe-thumb" src={api.thumbUrl(shot)} alt="" aria-hidden />
              <img
                key={`${shot.id}-${src}`}
                className={`loupe-img ${loaded ? 'ready' : ''}`}
                src={fitSrc}
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

      {shot.hasPreview && (
        <div className="loupe-src" onClick={(e) => e.stopPropagation()}>
          {list.length > 1 && (
            <div className="seg" role="radiogroup" aria-label="Image source">
              {list.map((s) => {
                const needsDevelop = s.key === 'raw' && !s.ready
                return (
                  <button
                    key={s.key}
                    role="radio"
                    aria-checked={active === s.key}
                    className={active === s.key ? 'on' : ''}
                    disabled={developing || (needsDevelop && (!sources?.canDevelop || isRemote))}
                    title={needsDevelop ? 'Decode the RAW file at full resolution (takes a few seconds)' : s.detail}
                    onClick={() => void choose(s)}
                  >
                    {needsDevelop ? 'Develop RAW' : sourceName(s)}
                  </button>
                )
              })}
            </div>
          )}
          {developing ? (
            <span className="pill warn">Developing RAW…</span>
          ) : info && info.width && info.height ? (
            <span className="pill" title={info.detail}>
              {sourceName(info)} {info.width}×{info.height}
            </span>
          ) : null}
          {err && <span className="pill warn">{err}</span>}
        </div>
      )}

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
