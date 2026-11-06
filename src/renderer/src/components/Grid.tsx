import { useEffect, useRef } from 'react'
import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'
import { api } from '../api'
import { fmtTime } from '../format'
import { Badges, SyncDots } from './Badges'

interface Props {
  shots: Shot[]
  cull: Map<number, Cull>
  selectedId: number | null
  freshIds: Set<number>
  onSelect: (id: number) => void
  onOpen: (id: number) => void
}

export function Grid({ shots, cull, selectedId, freshIds, onSelect, onOpen }: Props) {
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
              {s.hasPreview ? <img src={api.thumbUrl(s)} alt={s.name} loading="lazy" draggable={false} /> : <span className="frame-empty">{s.name}</span>}
            <SyncDots sync={s.sync} />
              {cull.get(s.id)?.soft && <span className="cull-tag soft">soft</span>}
              {cull.get(s.id)?.blink && <span className="cull-tag soft cull-blink">eyes closed</span>}
              {cull.get(s.id)?.best && (cull.get(s.id)?.size ?? 1) > 1 && <span className="cull-tag best">best of {cull.get(s.id)?.size}</span>}
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
