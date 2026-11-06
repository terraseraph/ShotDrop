import { useEffect, useRef, type ReactElement } from 'react'
import type { Shot, ShotPatch } from '@shared/types'
import type { Cull } from '@shared/cull'
import { api, dragProps } from '../api'
import { fmtTime } from '../format'
import { Badges, SyncDots } from './Badges'

interface Props {
  shots: Shot[]
  cull: Map<number, Cull>
  selectedId: number | null
  freshIds: Set<number>
  onSelect: (id: number) => void
  onOpen: (id: number) => void
  onPatch: (ids: number[], p: ShotPatch) => void
  tapOpens?: boolean // touch: no double-click, a tap opens the loupe
}

/** Splits the visible list into runs of consecutive frames from the same burst. */
function runs(shots: Shot[], cull: Map<number, Cull>): Shot[][] {
  const out: Shot[][] = []
  for (const s of shots) {
    const last = out[out.length - 1]
    const g = cull.get(s.id)?.group
    if (last && g != null && cull.get(last[0].id)?.group === g) last.push(s)
    else out.push([s])
  }
  return out
}

export function Grid({ shots, cull, selectedId, freshIds, onSelect, onOpen, onPatch, tapOpens }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector('.cell.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  if (!shots.length) return <div className="grid-empty">Nothing matches this filter.</div>

  const cell = (s: Shot, inBurst: boolean): ReactElement => {
    const c = cull.get(s.id)
    return (
      <button
        key={s.id}
        className={`cell ${s.id === selectedId ? 'selected' : ''} ${s.flag === -1 ? 'rejected' : ''} ${freshIds.has(s.id) ? 'fresh' : ''} ${inBurst && c?.best ? 'best' : ''}`}
        onClick={() => (tapOpens ? onOpen(s.id) : onSelect(s.id))}
        onDoubleClick={() => onOpen(s.id)}
      >
        <span className="cell-img">
          {s.hasPreview ? <img src={api.thumbUrl(s)} alt={s.name} loading="lazy" {...dragProps(s.id)} /> : <span className="frame-empty">{s.name}</span>}
          <SyncDots sync={s.sync} />
          {c?.soft && <span className="cull-tag soft">soft</span>}
          {c?.blink && <span className="cull-tag soft cull-blink">eyes closed</span>}
          {c?.best && (c.size ?? 1) > 1 && <span className="cull-tag best">best of {c.size}</span>}
        </span>
        <span className="cell-meta">
          <span className="cell-name">{s.name}</span>
          <span className="muted mono">{fmtTime(s.capturedAt)}</span>
          <Badges shot={s} />
        </span>
      </button>
    )
  }

  return (
    <div className="grid-scroll" ref={ref}>
      <div className="grid">
        {runs(shots, cull).map((run) => {
          if (run.length < 2) return cell(run[0], false)
          const ids = run.map((s) => s.id)
          const best = run.find((s) => cull.get(s.id)?.best)
          const flagged = run.filter((s) => cull.get(s.id)?.soft || cull.get(s.id)?.blink).map((s) => s.id)
          const soft = run.filter((s) => cull.get(s.id)?.soft).length
          const blink = run.filter((s) => cull.get(s.id)?.blink).length
          return (
            <section key={`b${run[0].id}`} className="burst" aria-label={`Burst of ${run.length} frames`}>
              <header className="burst-head">
                <strong>Burst · {run.length} frames</strong>
                {soft > 0 && <span className="burst-note">{soft} soft</span>}
                {blink > 0 && <span className="burst-note">{blink} eyes closed</span>}
                <span className="burst-actions">
                  {best && (
                    <button className="btn small" title="Pick the best frame and reject the rest" onClick={() => { onPatch([best.id], { flag: 1 }); onPatch(ids.filter((id) => id !== best.id), { flag: -1 }) }}>
                      Keep best
                    </button>
                  )}
                  {flagged.length > 0 && (
                    <button className="btn small" title="Reject soft and eyes-closed frames" onClick={() => onPatch(flagged, { flag: -1 })}>
                      Reject flagged
                    </button>
                  )}
                  <button className="btn small" onClick={() => onPatch(ids, { flag: -1 })}>Reject all</button>
                  <button className="btn small" title="Clear pick/reject on every frame in this burst" onClick={() => onPatch(ids, { flag: 0 })}>Reset</button>
                </span>
              </header>
              <div className="burst-cells">{run.map((s) => cell(s, true))}</div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
