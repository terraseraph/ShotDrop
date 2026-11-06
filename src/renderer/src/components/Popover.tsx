import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { popIn } from '../motion'
import './Popover.css'

interface Props {
  /** The button it hangs from. Without one the popover sits top-right under the top bar. */
  anchor?: HTMLElement | null
  width: number
  label: string
  onClose: () => void
  children: ReactNode
  /** Enter runs this (Export, Add and start). Ignored while a button or field has focus. */
  onEnter?: () => void
}

/** A popover anchored to its button: opens above or below depending on room, clamps to the window, closes on Esc or an outside click. */
export function Popover({ anchor, width, label, onClose, children, onEnter }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  useLayoutEffect(() => {
    const place = (): void => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = Math.min(width, vw - 16)
      if (!anchor) return setPos({ left: Math.max(8, vw - w - 140), top: 52 })
      const r = anchor.getBoundingClientRect()
      const left = Math.min(Math.max(8, r.right - w), vw - w - 8)
      const below = vh - r.bottom
      setPos(below > r.top ? { left, top: r.bottom + 8 } : { left, bottom: vh - r.top + 8 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, width])

  useEffect(() => {
    const down = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!box.current?.contains(t) && !anchor?.contains(t)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter' && onEnter && !(e.target instanceof HTMLElement && /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(e.target.tagName))) {
        e.preventDefault()
        onEnter()
      }
    }
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose, onEnter])

  return createPortal(
    <motion.div ref={box} role="dialog" aria-label={label} className="pop" style={{ width: Math.min(width, window.innerWidth - 16), ...(pos ?? { left: -9999, top: 0 }) }} {...popIn}>
      {children}
    </motion.div>,
    document.body
  )
}
