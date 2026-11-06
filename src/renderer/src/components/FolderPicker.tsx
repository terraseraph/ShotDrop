import { useEffect, useState } from 'react'
import type { Settings, Status } from '@shared/types'
import { desktop } from '../api'
import { fmtSize } from '../format'
import { Icon } from './Icon'
import { type PathCheck, checkPath, dropProps, join, lastPart, pickOnPc, useChips } from './fsApi'
import './FolderPicker.css'

interface Props {
  value: string
  onChange: (path: string) => void
  /** For chip sources (library, watched folders, known NAS shares). */
  s?: Settings | null
  status?: Status | null
  /** Show `{shoot day}` after the path: a folder per day is made for you. */
  dayFolder?: boolean
  /** Chips add "\ShotDrop" under the place they point at (not for paths picked with Browse). */
  appendName?: string
  /** Bytes that must fit; the reachability line says whether they do. */
  needBytes?: number
  /** Skip the reachability line. */
  noCheck?: boolean
  /** Extra small button after Browse (e.g. Show). */
  extra?: React.ReactNode
  /** Phone: no native picker, "Browse on the PC…" asks the PC. */
  remote?: boolean
  hint?: React.ReactNode
}

/** Chips (places, drives, shares) + the current path + Browse… + drop target + reachability. Nothing is typed. */
export function FolderPicker({ value, onChange, s = null, status = null, dayFolder, appendName = 'ShotDrop', needBytes, noCheck, extra, remote, hint }: Props) {
  const { places, drives, shares } = useChips(s, status)
  const [check, setCheck] = useState<PathCheck | null | 'none'>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (noCheck || !value) return
    let live = true
    const t = setTimeout(() => void checkPath(value).then((c) => live && setCheck(c ?? 'none')), 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [value, noCheck])

  const chips = [
    ...places.map((p) => ({ key: p.id, label: p.label, base: p.path, path: join(p.path, appendName), note: '' })),
    ...drives.map((d) => ({ key: d.path, label: `${d.path.slice(0, 2)} ${d.label && d.label !== d.path.slice(0, 2) ? d.label : ''}`.trim(), base: d.path, path: join(d.path, appendName), note: d.free != null ? `${fmtSize(d.free)} free` : '' })),
    ...shares.map((p) => ({ key: p.id, label: p.label, base: p.path, path: p.path, note: '' }))
  ]
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  const isOn = (c: (typeof chips)[number]): boolean => !!value && (norm(value) === norm(c.path) || norm(value).startsWith(norm(c.base) + '\\') && !chips.some((o) => o !== c && norm(o.base).length > norm(c.base).length && norm(value).startsWith(norm(o.base))))

  const browse = async (): Promise<void> => {
    setBusy(true)
    try {
      const p = remote || !desktop ? await pickOnPc() : await desktop.pickFolder()
      if (p) onChange(p)
    } finally {
      setBusy(false)
    }
  }
  const drop = dropProps(onChange, !remote)

  const c = check && check !== 'none' ? check : null
  const bad = c && c.exists && !c.writable
  const tooBig = c && needBytes != null && c.free != null && needBytes > c.free
  const line = c
    ? !c.exists
      ? 'Will be created for you' + (c.free != null ? ` · ${fmtSize(c.free)} free` : '')
      : !c.writable
        ? "Can't write here. Pick another folder or check permissions."
        : ['Reachable', 'writable', c.free != null ? `${fmtSize(c.free)} free` : null, needBytes != null && c.free != null ? (tooBig ? `today's ${fmtSize(needBytes)} won't fit` : `today's ${fmtSize(needBytes)} fits`) : null].filter(Boolean).join(' · ')
    : null

  return (
    <div className={`fp ${over ? 'over' : ''}`} {...drop} onDragEnter={() => setOver(true)} onDragLeave={() => setOver(false)} onDropCapture={() => setOver(false)}>
      {chips.length > 0 && (
        <div className="fp-chips">
          {chips.map((ch) => (
            <button key={ch.key} type="button" className={`quick ${isOn(ch) ? 'on' : ''}`} onClick={() => onChange(ch.path)}>
              {ch.label}
              {ch.note && <span className="fp-note">· {ch.note}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="fp-path">
        <Icon name="folder" />
        <span className="mono fp-val" title={value}>
          {value || <span className="fp-ph">No folder chosen</span>}
          {value && dayFolder && <span className="fp-day">{value.includes('/') && !value.includes('\\') ? '/' : '\\'}{'{shoot day}'}</span>}
        </span>
        <button type="button" className="fp-btn primary" onClick={() => void browse()} disabled={busy}>{busy && remote ? 'Waiting for the PC…' : remote ? 'Browse on the PC…' : 'Browse…'}</button>
        {extra}
      </div>
      {hint && <div className="fp-hint">{hint}</div>}
      {line && <div className={`fp-check ${bad || tooBig ? 'bad' : 'ok'}`} role="status"><Icon name={bad || tooBig ? 'alert' : 'check'} size={14} />{line}</div>}
      {!c && value && !noCheck && check === 'none' && <div className="fp-hint">{lastPart(value)}</div>}
    </div>
  )
}
