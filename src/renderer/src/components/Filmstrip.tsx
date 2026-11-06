import { useEffect, useRef } from 'react'
import type { Shot } from '@shared/types'
import type { Cull } from '@shared/cull'
import { motion } from 'motion/react'
import { api, dragProps } from '../api'
import { landIn } from '../motion'
import { Badges, SyncDots } from './Badges'

interface Props {
  shots: Shot[]
  selectedId: number | null
  freshIds: Set<number>
  follow: boolean
  cull?: Map<number, Cull>
  onSelect: (id: number) => void
}

export function Filmstrip({ shots, selectedId, freshIds, follow, cull, onSelect }: Props) {
  const strip = useRef<HTMLDivElement>(null)

  const first = useRef(true)
  useEffect(() => {
    strip.current?.querySelector('.thumb.selected')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: first.current ? 'auto' : 'smooth' })
    first.current = false
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

  const index = shots.findIndex((s) => s.id === selectedId)
  const atEnd = index === shots.length - 1

  return (
    <div className="filmstrip">
      <div className="film-scroll" ref={strip}>
        {shots.map((s) => {
          const c = cull?.get(s.id)
          const fresh = freshIds.has(s.id)
          return (
            <motion.button
              key={s.id}
              initial={fresh ? landIn.initial : false}
              animate={landIn.animate}
              transition={landIn.transition}
              className={`thumb ${s.id === selectedId ? 'selected' : ''} ${s.flag === -1 || c?.soft || c?.blink ? 'dim' : ''}`}
              onClick={() => onSelect(s.id)}
              title={s.name}
              aria-label={s.name}
              aria-current={s.id === selectedId}
            >
              {s.hasPreview ? <img src={api.thumbUrl(s)} alt="" loading="lazy" {...dragProps(s.id)} /> : <span className="thumb-empty">{s.name}</span>}
              <SyncDots sync={s.sync} />
              <span className="b">
                <Badges shot={s} />
                {c?.soft && <span className="badge">soft</span>}
                {c?.blink && <span className="badge">eyes closed</span>}
                {c && c.size > 1 && c.best && <span className="badge best">best</span>}
                {fresh && <span className="badge new">new</span>}
              </span>
            </motion.button>
          )
        })}
      </div>
      <div className="film-read">
        <span>{index >= 0 ? index + 1 : shots.length} / {shots.length}</span>
        <span style={{ color: follow && atEnd ? 'var(--live)' : 'var(--faint)' }}>{follow ? 'following latest' : 'browsing'}</span>
      </div>
    </div>
  )
}
