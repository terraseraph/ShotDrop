import { useEffect, useMemo, useState } from 'react'
import type { Shot, ShotMetadata } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'

/** Maker-note highlights + GPS (always shown) and the full grouped tag dump (expandable, searchable, copyable). */
export function MetadataPanel({ shot }: { shot: Shot }) {
  const [meta, setMeta] = useState<ShotMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    setMeta(null)
    setError(null)
    let live = true
    api.metadata(shot.id).then((m) => live && setMeta(m)).catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [shot.id, shot.files.length])

  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => {
    if (!meta) return []
    if (!needle) return meta.groups
    return meta.groups
      .map((g) => ({ ...g, items: g.items.filter((i) => `${i.group} ${i.tag} ${i.value}`.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length)
  }, [meta, needle])
  const count = groups.reduce((n, g) => n + g.items.length, 0)

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
    } catch {
      setError('Clipboard unavailable')
    }
  }

  const dump = (): string => groups.flatMap((g) => g.items.map((i) => `${i.group}:${i.tag}: ${i.value}`)).join('\n')

  return (
    <>
      {meta && meta.summary.length > 0 && (
        <section>
          <h3>
            Camera data <span className="muted hint">· from {meta.fileName}</span>
          </h3>
          <dl>
            {meta.summary.map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {meta?.gps && (
        <section>
          <h3>Location</h3>
          <dl>
            <div>
              <dt>GPS</dt>
              <dd className="mono">
                {meta.gps.lat.toFixed(5)}, {meta.gps.lon.toFixed(5)}
              </dd>
            </div>
            {meta.gps.alt != null && (
              <div>
                <dt>Altitude</dt>
                <dd>{Math.round(meta.gps.alt)} m</dd>
              </div>
            )}
          </dl>
          <div className="row-actions">
            <a className="btn small" href={meta.gps.mapUrl} target="_blank" rel="noreferrer">
              Open in maps
            </a>
            <button className="btn small" onClick={() => void copy(`${meta.gps!.lat}, ${meta.gps!.lon}`, 'gps')}>
              {copied === 'gps' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>
      )}

      <section>
        <button className="disclose" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className={`caret ${open ? 'open' : ''}`}>
            <Icon name="next" size={12} />
          </span>
          All metadata{meta ? <span className="muted"> · {meta.groups.reduce((n, g) => n + g.items.length, 0)} tags</span> : null}
        </button>
        {error && <span className="muted">{error}</span>}
        {open && !meta && !error && <span className="muted">Reading…</span>}
        {open && meta && (
          <>
            <div className="row-actions">
              <input className="input" placeholder="Filter tags and values" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter metadata" />
              <button className="btn small" onClick={() => void copy(dump(), 'all')} title="Copy the listed tags as text">
                {copied === 'all' ? 'Copied' : `Copy ${needle ? count : 'all'}`}
              </button>
            </div>
            <div className="meta-groups">
              {groups.map((g) => (
                <details key={g.name} open={!!needle || g.name === 'EXIF'}>
                  <summary>
                    {g.name} <span className="muted">{g.items.length}</span>
                  </summary>
                  <dl>
                    {g.items.map((i, n) => (
                      <div key={n} title={`${i.group}:${i.tag} (click to copy)`} onClick={() => void copy(i.value, `${g.name}${n}`)}>
                        <dt>{i.tag}</dt>
                        <dd>{i.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
              {groups.length === 0 && <span className="muted">No tags match.</span>}
            </div>
          </>
        )}
      </section>
    </>
  )
}
