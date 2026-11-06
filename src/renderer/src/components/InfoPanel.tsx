import type { Shot, ShotPatch, Status, SyncStatus } from '@shared/types'
import { desktop } from '../api'
import { fmtAperture, fmtFocal, fmtShutter, fmtSize, fmtTime } from '../format'
import { MetadataPanel } from './MetadataPanel'
import { SharePanel } from './SharePanel'

const FILTER_WORD = { all: 'everything', jpeg: 'JPEG', raw: 'RAW', picks: 'picks' } as const
const DOT: Record<SyncStatus, string> = { done: 'var(--live)', running: 'var(--sync)', pending: 'var(--sync)', error: 'var(--reject)' }
const STATE: Record<SyncStatus, string> = { done: 'done', running: 'uploading', pending: 'queued', error: 'failed' }
const extOf = (n: string): string => (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toUpperCase() : '')

interface Props {
  shot: Shot | null
  status: Status | null
  /** Kept for the phone sheet; the desktop panel is read-only (keys do the culling). */
  onPatch?: (p: ShotPatch) => void
  compare?: Shot[]
  onSelect?: (id: number) => void
}

export function InfoPanel({ shot, status }: Props) {
  if (!shot) return <aside className="info" />

  const kinds = shot.files.filter((f) => f.kind !== 'sidecar')
  const kindLabel = [...new Set(shot.files.map((f) => (f.kind === 'jpeg' ? 'JPEG' : f.kind === 'raw' ? 'RAW' : f.kind === 'heif' ? 'HEIF' : f.kind === 'video' ? 'Video' : null)))].filter(Boolean).join(' + ')
  const exposure = [fmtShutter(shot.shutter), fmtAperture(shot.aperture)].filter(Boolean).join(' at ')
  const landed = Math.max(0, Math.round((shot.importedAt - shot.capturedAt) / 1000))
  const cams = status?.cameras ?? []
  const cam = cams.find((c) => c.username === shot.source)
  const rows: [string, React.ReactNode][] = [
    ['Camera', shot.camera ? <>{shot.camera}{shot.source && <> · <span style={{ color: 'var(--muted)' }}>{cam?.label || shot.source}</span></>}</> : null],
    ['Lens', shot.lens],
    ['Taken', fmtTime(shot.capturedAt)],
    ['Landed', landed < 600 ? <>{fmtTime(shot.importedAt)} · <span style={{ color: 'var(--live)' }}>{landed} s</span></> : fmtTime(shot.importedAt)],
    ['Exposure', exposure || null],
    ['ISO / focal', [shot.iso ? `ISO ${shot.iso}` : '', fmtFocal(shot.focalLength) ?? ''].filter(Boolean).join(' · ') || null],
    ['Size', shot.width && shot.height ? `${shot.width} × ${shot.height}` : null]
  ]
  const places = Object.entries(shot.sync).flatMap(([id, st]) => {
    const d = status?.destinations.find((x) => x.id === id)
    return d ? [{ id, name: d.name, filter: d.filter, st }] : []
  })

  return (
    <aside className="info">
      <div>
        <div className="info-name">{shot.name}</div>
        <div className="info-sub">
          {kindLabel || 'File'} · {kinds.map((f) => fmtSize(f.size)).join(' + ')}
        </div>
        <div className="info-badges">
          {shot.files.map((f) => (
            <span key={f.id} className="badge" style={{ background: 'var(--panel-3)' }}>{extOf(f.name)}</span>
          ))}
        </div>
      </div>

      <div className="info-grid">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k}>
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>

      <div className="info-sec">
        <div className="k">Where this shot is</div>
        <div className="where">
          <div><span className="dot" style={{ background: 'var(--live)' }} /><span className="nowrap">This PC ·</span> <span className="mono where-path" title={status?.library.dir}>{status?.library.dir ?? 'library'}</span></div>
          {places.map((p) => (
            <div key={p.id}>
              <span className="dot" style={{ background: DOT[p.st] }} />
              <span className="nowrap">{p.name} · {FILTER_WORD[p.filter]}</span>
              <span className="where-st">{STATE[p.st]}</span>
            </div>
          ))}
          {!places.length && <div className="k" style={{ margin: 0 }}>No destinations yet</div>}
        </div>
      </div>

      {desktop && <div className="info-sec"><SharePanel shot={shot} /></div>}
      <MetadataPanel shot={shot} />
      {desktop && <div className="info-hint">Drag the thumbnail into Explorer, email or any editor.</div>}
    </aside>
  )
}
