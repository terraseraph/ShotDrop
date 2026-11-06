import { useEffect, useRef } from 'react'
import type { Shot } from '@shared/types'
import { motion } from 'motion/react'
import { api } from '../api'
import { Badges, SyncDots } from './Badges'

interface Props {
  shots: Shot[]
  selectedId: number | null
  freshIds: Set<number>
  onSelect: (id: number) => void
}

export function Filmstrip({ shots, selectedId, freshIds, onSelect }: Props) {
  const strip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    strip.current?.querySelector('.frame.selected')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [selectedId])

  // Vertical wheel scrolls the strip sideways.
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div className="filmstrip" ref={strip}>
      {shots.map((s) => (
        <motion.button
          key={s.id}
          initial={freshIds.has(s.id) ? { opacity: 0, x: 18, scale: 0.9 } : false}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ type: 'spring', bounce: 0.3, visualDuration: 0.45 }}
          className={`frame ${s.id === selectedId ? 'selected' : ''} ${s.flag === -1 ? 'rejected' : ''} ${freshIds.has(s.id) ? 'fresh' : ''}`}
          onClick={() => onSelect(s.id)}
          title={s.name}
        >
          {s.hasPreview ? <img src={api.thumbUrl(s.id)} alt={s.name} loading="lazy" draggable={false} /> : <span className="frame-empty">{s.name}</span>}
          <SyncDots sync={s.sync} />
          <span className="frame-badges">
            <Badges shot={s} />
          </span>
        </motion.button>
      ))}
    </div>
  )
}
