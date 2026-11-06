import { useEffect, useRef } from 'react'
import type { Shot } from '@shared/types'
import { api } from '../api'
import { Badges } from './Badges'

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
        <button
          key={s.id}
          className={`frame ${s.id === selectedId ? 'selected' : ''} ${s.flag === -1 ? 'rejected' : ''} ${freshIds.has(s.id) ? 'fresh' : ''}`}
          onClick={() => onSelect(s.id)}
          title={s.name}
        >
          {s.hasPreview ? <img src={api.thumbUrl(s.id)} alt={s.name} loading="lazy" draggable={false} /> : <span className="frame-empty">{s.name}</span>}
          <span className="frame-badges">
            <Badges shot={s} />
          </span>
        </button>
      ))}
    </div>
  )
}
