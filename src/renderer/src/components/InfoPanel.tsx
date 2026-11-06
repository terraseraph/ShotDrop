import { useEffect, useState } from 'react'
import type { Label, Shot, ShotPatch, Status, SyncStatus } from '@shared/types'
import { api } from '../api'
import { fmtAperture, fmtFocal, fmtShutter, fmtSize, fmtTime, fmtDate } from '../format'
import { Icon } from './Icon'

const LABELS: Exclude<Label, null>[] = ['red', 'yellow', 'green', 'blue', 'purple']
const SYNC_TEXT: Record<SyncStatus, string> = { pending: 'Queued', running: 'Uploading', done: 'Synced', error: 'Failed' }

interface Props {
  shot: Shot | null
  status: Status | null
  onPatch: (p: ShotPatch) => void
}

export function InfoPanel({ shot, onPatch }: Props) {
  const [destNames, setDestNames] = useState<Record<string, string>>({})
  const syncKeys = shot ? Object.keys(shot.sync).join() : ''
  useEffect(() => {
    if (!syncKeys) return
    api.settings().then((s) => setDestNames(Object.fromEntries(s.destinations.map((d) => [d.id, d.name])))).catch(() => undefined)
  }, [syncKeys])

  if (!shot) return <aside className="info" />

  const rows: [string, string | null][] = [
    ['Captured', `${fmtDate(shot.session)}, ${fmtTime(shot.capturedAt)}`],
    ['Camera', shot.camera],
    ['Lens', shot.lens],
    ['Exposure', [fmtShutter(shot.shutter), fmtAperture(shot.aperture)].filter(Boolean).join(' at ') || null],
    ['ISO', shot.iso ? String(shot.iso) : null],
    ['Focal length', fmtFocal(shot.focalLength)],
    ['Size', shot.width && shot.height ? `${shot.width} × ${shot.height}` : null],
    ['From', shot.source]
  ]

  return (
    <aside className="info">
      <section>
        <h3>Cull</h3>
        <div className="stars-input" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={shot.rating === n}
              className={n <= shot.rating ? 'on' : ''}
              onClick={() => onPatch({ rating: shot.rating === n ? 0 : n })}
              title={`${n} (key ${n})`}
            >
              ★
            </button>
          ))}
        </div>
        <div className="flag-input">
          <button className={shot.flag === 1 ? 'on pick' : ''} onClick={() => onPatch({ flag: shot.flag === 1 ? 0 : 1 })} title="Pick (P)">
            <Icon name="check" /> Pick
          </button>
          <button className={shot.flag === -1 ? 'on reject' : ''} onClick={() => onPatch({ flag: shot.flag === -1 ? 0 : -1 })} title="Reject (X)">
            <Icon name="close" /> Reject
          </button>
        </div>
        <div className="label-input" aria-label="Colour label">
          {LABELS.map((l) => (
            <button key={l} className={`label-dot ${l} ${shot.label === l ? 'on' : ''}`} onClick={() => onPatch({ label: shot.label === l ? null : l })} aria-label={l} title={l} />
          ))}
        </div>
      </section>

      <section>
        <h3>Details</h3>
        <dl>
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
      </section>

      <section>
        <h3>Files</h3>
        <ul className="files">
          {shot.files.map((f) => (
            <li key={f.id}>
              <a href={api.originalUrl(shot.id, f.id)} target="_blank" rel="noreferrer" className="mono">
                {f.name}
              </a>
              <span className="muted">{fmtSize(f.size)}</span>
            </li>
          ))}
        </ul>
      </section>

      {Object.keys(shot.sync).length > 0 && (
        <section>
          <h3>Sync</h3>
          <ul className="files">
            {Object.entries(shot.sync).map(([dest, st]) => (
              <li key={dest}>
                <span>{destNames[dest] ?? dest}</span>
                <span className={`sync-state ${st}`}>{SYNC_TEXT[st]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}
