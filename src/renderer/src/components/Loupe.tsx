import { useEffect, useRef, useState } from 'react'
import type { Shot, ShotPatch, ShotSource, ShotSources } from '@shared/types'
import { api, isRemote } from '../api'
import { motion } from 'motion/react'
import { fade, popIn } from '../motion'
import { Icon } from './Icon'
import { OpenExternal } from './OpenExternal'
import { HintStrip } from './HintStrip'
import { SourcePill } from './SourcePill'

export interface Burst {
  index: number
  size: number
  best: boolean
  soft: boolean
  blink: boolean
}

interface Props {
  shot: Shot | null
  fresh: boolean
  follow: boolean
  burst: Burst | null
  /** Name of the enabled picks-only destination, if any ("sent to Drive"). */
  picksDest: string | null
  onPatch: (p: ShotPatch) => void
  onPrev: () => void
  onNext: () => void
}

export function Loupe({ shot, fresh, follow, burst, picksDest, onPatch, onPrev, onNext }: Props) {
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

  if (!shot) return <div className="stage-col"><div className="canvas" /></div>

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
  const toggleZoom = (): void => {
    setOrigin({ x: 50, y: 50 })
    setZoom((z) => !z)
  }

  return (
    <div className="stage-col">
      <div
        ref={box}
        className={`canvas ${zoom && !video ? 'zoomed' : ''}`}
        onClick={video ? undefined : (e) => { track(e); setZoom((z) => !z) }}
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
              <img key={`${shot.id}-${src}`} className={`loupe-img ${loaded ? 'ready' : ''}`} src={fitSrc} alt={shot.name} onLoad={() => setLoaded(true)} draggable={false} />
            </>
          )
        ) : (
          <div className="no-preview">
            <Icon name="camera" size={32} />
            <span>No preview for {shot.files.map((f) => f.name).join(', ')}</span>
          </div>
        )}

        {/* Follow mode: a brief amber glow each time a new frame takes the stage. */}
        {fresh && follow && <div key={shot.id} className="glow-ring" aria-hidden />}

        {shot.hasPreview && !video && <SourcePill sources={sources} active={active} name={sourceName} developing={developing} error={err} onChoose={(s) => void choose(s)} />}

        {fresh && (
          <motion.span className="badge new stage-new" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={popIn.transition}>
            New
          </motion.span>
        )}

        {showHist && shot.histogram && !zoom && <Histogram bins={shot.histogram} clipped={shot.clipped} />}

        <div className="stage-bl">
          {burst && burst.size > 1 && (
            <span className="badge chipx">
              <Icon name="layers" size={12} />
              Burst {burst.index} of {burst.size}{burst.best ? ' · best' : ''}
            </span>
          )}
          {burst?.soft && <span className="badge chipx">Soft</span>}
          {burst?.blink && <span className="badge chipx">Eyes closed</span>}
        </div>
        <div className="stage-br" onClick={(e) => e.stopPropagation()}>
          <button className="badge chipx" onClick={toggleZoom} aria-pressed={zoom} title="Zoom to 100% (Z)">
            <span className="key">Z</span> {zoom ? 'Fit' : '100%'}
          </button>
          <button className={`badge chipx ${showHist ? 'lit' : ''}`} onClick={() => setShowHist((h) => !h)} aria-pressed={showHist} title="Histogram (H)">
            <span className="key">H</span> Histogram
          </button>
        </div>

        <button className="nav prev" onClick={(e) => { e.stopPropagation(); onPrev() }} aria-label="Previous">
          <Icon name="prev" size={22} />
        </button>
        <button className="nav next" onClick={(e) => { e.stopPropagation(); onNext() }} aria-label="Next">
          <Icon name="next" size={22} />
        </button>
      </div>

      <HintStrip shot={shot} onPatch={onPatch} picksDest={picksDest} />
    </div>
  )
}

/** 64 luminance bins, drawn as in the board: soft white fill, red bar at the right edge when highlights clip. */
function Histogram({ bins, clipped }: { bins: number[]; clipped: number | null }) {
  const n = bins.length - 1 || 1
  const d = `M0 48 ${bins.map((v, i) => `L${((i / n) * 148).toFixed(1)} ${(48 - (Math.min(v, 100) / 100) * 46).toFixed(1)}`).join(' ')} L148 48Z`
  const clip = clipped ?? 0
  return (
    <motion.div className="hist" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade}>
      <svg viewBox="0 0 148 48" width="148" height="48" role="img" aria-label={`Histogram, ${clip > 1 ? 'highlight clipping' : 'no clipping'}`}>
        <path d={d} fill="rgba(255,255,255,.55)" />
        {clip > 0.05 && <rect x="143" y="0" width="5" height="48" fill="rgba(229,72,77,.8)" />}
      </svg>
      <span className="hist-clip" style={{ color: clip > 1 ? '#f2a5a8' : 'var(--faint)' }}>CLIP {clip < 10 ? clip.toFixed(1) : Math.round(clip)}%</span>
    </motion.div>
  )
}
