import { useEffect, useRef } from 'react'
import type { Shot } from '@shared/types'
import { api } from '../api'
import { fmtTime } from '../format'
import { Badges } from './Badges'

interface Props {
  shots: Shot[]
  selectedId: number | null
  freshIds: Set<number>
  onSelect: (id: number) => void
  onOpen: (id: number) => void
}

export function Grid({ shots, selectedId, freshIds, onSelect, onOpen }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector('.cell.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  if (!shots.length) return <div className="grid-empty">Nothing matches this filter.</div>

  return (
    <div className="grid-scroll" ref={ref}>
      <div className="grid">
        {shots.map((s) => (
          <button
            key={s.id}
            className={`cell ${s.id === selectedId ? 'selected' : ''} ${s.flag === -1 ? 'rejected' : ''} ${freshIds.has(s.id) ? 'fresh' : ''}`}
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => onOpen(s.id)}
          >
            <span className="cell-img">
              {s.hasPreview ? <img src={api.thumbUrl(s.id)} alt={s.name} loading="lazy" draggable={false} /> : <span className="frame-empty">{s.name}</span>}
            </span>
            <span className="cell-meta">
              <span className="cell-name">{s.name}</span>
              <span className="muted mono">{fmtTime(s.capturedAt)}</span>
              <Badges shot={s} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
