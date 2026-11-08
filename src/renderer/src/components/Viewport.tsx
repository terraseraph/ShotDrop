import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { Shot } from '@shared/types'
import { api } from '../api'

/** Zoom as a multiple of "fit", plus where the image centre sits relative to the box centre (px). */
export interface View { z: number; x: number; y: number }
export const FIT: View = { z: 1, x: 0, y: 0 }

const MAX_SCALE = 8 // 800%

/** Pixel size a frame is laid out at; falls back to 3:2 when the library has no dimensions for it. */
export const dims = (s: Shot): { w: number; h: number } => ({ w: s.width || 1500, h: s.height || 1000 })

/**
 * Shared zoom and pan for one or two images in a box: wheel / pinch zooms about the cursor, click toggles
 * fit and 100%, drag pans (when `panOn`). Every image drawn with `imgStyle(view)` stays aligned with the others.
 */
export function useViewport(box: RefObject<HTMLDivElement | null>, w: number, h: number, panOn = true) {
  const [view, setView] = useState<View>(FIT)
  const [size, setSize] = useState({ w: 1, h: 1 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [box])

  const fitK = Math.min(size.w / w, size.h / h)
  const z100 = Math.max(1, 1 / fitK)
  const zMax = Math.max(z100, MAX_SCALE / fitK)

  const clamp = useCallback((v: View): View => {
    const z = Math.min(zMax, Math.max(1, v.z))
    const k = fitK * z
    const mx = Math.max(0, (w * k - size.w) / 2), my = Math.max(0, (h * k - size.h) / 2)
    return { z, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) }
  }, [fitK, zMax, w, h, size.w, size.h])

  /** Zoom to `z`, keeping the image point under (px, py) — measured from the box centre — where it is. */
  const zoomAt = useCallback((z: number, px = 0, py = 0): void => {
    setView((v) => {
      const nz = Math.min(zMax, Math.max(1, z))
      const r = nz / v.z
      return clamp({ z: nz, x: px - (px - v.x) * r, y: py - (py - v.y) * r })
    })
  }, [clamp, zMax])

  const reset = useCallback(() => setView(FIT), [])
  const toggle100 = useCallback((px = 0, py = 0) => zoomAt(view.z > 1.01 ? 1 : z100, px, py), [view.z, z100, zoomAt])
  // Keep the pan legal when the box or frame changes size.
  useEffect(() => { setView((v) => clamp(v)) }, [clamp])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)) // ctrl = trackpad pinch
      setView((v) => {
        const nz = Math.min(zMax, Math.max(1, v.z * factor))
        const px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2
        const k = nz / v.z
        return clamp({ z: nz, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [box, clamp, zMax])

  const pointer = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>): void => {
      if (!panOn || e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { x: e.clientX, y: e.clientY, moved: false }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>): void => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      d.x = e.clientX
      d.y = e.clientY
      setView((v) => clamp({ ...v, x: v.x + dx, y: v.y + dy }))
    },
    onPointerUp: (): void => { setTimeout(() => { drag.current = null }) },
    onPointerCancel: (): void => { drag.current = null },
    /** A click that wasn't the end of a pan toggles fit / 100% at the pointer. */
    onClick: (e: React.MouseEvent<HTMLElement>): void => {
      if (!panOn || drag.current?.moved) return
      const r = e.currentTarget.getBoundingClientRect()
      toggle100(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2)
    }
  }

  const k = fitK * view.z
  return {
    view, size, fitK, k, z100, pointer, reset, toggle100, zoomAt,
    /** Percent of the original pixels shown, for the label. */
    percent: Math.round(k * 100),
    zoomed: view.z > 1.01,
    /** Style for a frame drawn through this viewport. Pass another frame's size to fit that one in the same box at the same zoom. */
    imgStyle: (iw = w, ih = h): CSSProperties => ({
      position: 'absolute', left: '50%', top: '50%', width: iw, height: ih, maxWidth: 'none',
      marginLeft: -iw / 2, marginTop: -ih / 2,
      transform: `translate(${view.x}px, ${view.y}px) scale(${Math.min(size.w / iw, size.h / ih) * view.z})`, transformOrigin: 'center'
    })
  }
}

/** One frame drawn through a shared viewport: the 2560px preview when fitted, the full JPEG once zoomed in. */
export function ZoomImage({ shot, style, zoomed, className }: { shot: Shot; style: CSSProperties; zoomed: boolean; className?: string }) {
  const [fullReady, setFullReady] = useState(false)
  useEffect(() => { setFullReady(false) }, [shot.id])
  const full = api.fullUrl(shot, 'jpeg')
  return (
    <>
      <img className={className} src={api.previewUrl(shot)} alt={shot.name} draggable={false} style={style} />
      {zoomed && <img className={className} src={full} alt="" aria-hidden draggable={false} style={{ ...style, opacity: fullReady ? 1 : 0 }} onLoad={() => setFullReady(true)} />}
    </>
  )
}
