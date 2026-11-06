import type { ShotSource, ShotSources } from '@shared/types'
import { isRemote } from '../api'

interface Props {
  sources: ShotSources | null
  active: ShotSource['key'] | null
  name: (s: ShotSource) => string
  developing: boolean
  error: string | null
  onChoose: (s: ShotSource) => void
}

/** Which rendition is on screen: Camera JPEG / RAW preview / Develop RAW, with the true pixel size of the active one. */
export function SourcePill({ sources, active, name, developing, error, onChoose }: Props) {
  const list = sources?.sources ?? []
  if (!list.length) return null
  const size = (s: ShotSource): string | null => (s.width && s.height ? `${s.width}×${s.height}` : null)
  return (
    <div className="srcpill" onClick={(e) => e.stopPropagation()}>
      <div className="srcpill-seg" role="radiogroup" aria-label="Image source">
        {list.map((s) => {
          const needsDevelop = s.key === 'raw' && !s.ready
          const on = active === s.key
          return (
            <button
              key={s.key}
              role="radio"
              aria-checked={on}
              className={on ? 'on' : ''}
              disabled={developing || list.length === 1 || (needsDevelop && (!sources?.canDevelop || isRemote))}
              title={needsDevelop ? 'Decode the RAW file at full resolution (takes a few seconds)' : s.detail}
              onClick={() => onChoose(s)}
            >
              {needsDevelop ? 'Develop RAW' : name(s)}
              {on && size(s) && <span className="mono">{size(s)}</span>}
            </button>
          )
        })}
      </div>
      {developing && <span className="badge warn">Developing RAW…</span>}
      {error && <span className="badge warn">{error}</span>}
    </div>
  )
}
