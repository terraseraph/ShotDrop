import { useEffect, useRef, useState } from 'react'
import type { Shot } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'

interface Props {
  shot: Shot | null
  onPrev: () => void
  onNext: () => void
}

interface View { s: number; x: number; y: number }
const MAX = 5

/** Touch loupe: swipe to change shot, pinch or double-tap to zoom, drag to pan while zoomed. */
export function MobileLoupe({ shot, onPrev, onNext }: Props) {
  const [v, setV] = useState<View>({ s: 1, x: 0, y: 0 })
  const [dx, setDx] = useState(0) // live swipe offset
  const box = useRef<HTMLDivElement>(null)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const g = useRef({ dist: 0, s0: 1, start: { x: 0, y: 0 }, v0: { s: 1, x: 0, y: 0 }, moved: false, lastTap: 0, tapX: 0, tapY: 0 })

  useEffect(() => {
    setV({ s: 1, x: 0, y: 0 })
    setDx(0)
  }, [shot?.id])

  // Keep the image from being panned off-screen.
  const clamp = (n: View): View => {
    const r = box.current?.getBoundingClientRect()
    if (!r || n.s <= 1) return { s: Math.max(1, n.s), x: 0, y: 0 }
    const mx = (r.width * (n.s - 1)) / 2
    const my = (r.height * (n.s - 1)) / 2
    return { s: Math.min(MAX, n.s), x: Math.max(-mx, Math.min(mx, n.x)), y: Math.max(-my, Math.min(my, n.y)) }
  }

  const down = (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const G = g.current
    G.moved = false
    G.start = { x: e.clientX, y: e.clientY }
    G.v0 = v
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()]
      G.dist = Math.hypot(a.x - b.x, a.y - b.y)
      G.s0 = v.s
    }
  }

  const move = (e: React.PointerEvent): void => {
    if (!pts.current.has(e.pointerId)) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const G = g.current
    if (pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()]
      G.moved = true
      setV((cur) => clamp({ ...cur, s: G.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / (G.dist || 1)) }))
      return
    }
    const ox = e.clientX - G.start.x
    const oy = e.clientY - G.start.y
    if (Math.abs(ox) + Math.abs(oy) > 8) G.moved = true
    if (G.v0.s > 1) setV(clamp({ s: G.v0.s, x: G.v0.x + ox, y: G.v0.y + oy }))
    else if (Math.abs(ox) > Math.abs(oy)) setDx(ox)
  }

  const up = (e: React.PointerEvent): void => {
    const G = g.current
    const wasPinch = pts.current.size >= 2
    pts.current.delete(e.pointerId)
    if (wasPinch || pts.current.size > 0) return
    const ox = e.clientX - G.start.x
    const oy = e.clientY - G.start.y
    setDx(0)
    if (G.v0.s === 1 && v.s === 1 && G.moved && Math.abs(ox) > 60 && Math.abs(ox) > Math.abs(oy) * 1.5) {
      ox < 0 ? onNext() : onPrev()
      return
    }
    if (!G.moved) {
      const now = Date.now()
      if (now - G.lastTap < 300 && Math.hypot(e.clientX - G.tapX, e.clientY - G.tapY) < 30) {
        G.lastTap = 0
        const r = box.current!.getBoundingClientRect()
        setV((cur) => {
          if (cur.s > 1) return { s: 1, x: 0, y: 0 }
          const s = 2.5
          // Zoom about the tapped point.
          return clamp({ s, x: (r.left + r.width / 2 - e.clientX) * (s - 1), y: (r.top + r.height / 2 - e.clientY) * (s - 1) })
        })
      } else {
        G.lastTap = now
        G.tapX = e.clientX
        G.tapY = e.clientY
      }
    }
  }

  if (!shot) return <div className="loupe" />
  const jpeg = shot.files.find((f) => f.kind === 'jpeg')
  // Sharper source once zoomed in (camera JPEG), the 2560px preview otherwise.
  const src = v.s > 1.5 && jpeg ? api.originalUrl(shot, jpeg.id) : api.previewUrl(shot)

  return (
    <div className="loupe m-loupe">
      <div
        ref={box}
        className="m-canvas"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {shot.hasPreview ? (
          <img
            key={shot.id}
            className="m-img"
            src={src}
            alt={shot.name}
            draggable={false}
            style={{ transform: `translate(${v.x + dx}px, ${v.y}px) scale(${v.s})`, transition: dx || pts.current.size ? 'none' : 'transform 0.2s' }}
          />
        ) : (
          <div className="no-preview">
            <Icon name="camera" size={32} />
            <span>No preview for {shot.files.map((f) => f.name).join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
