import { useState, type ReactNode } from 'react'
import type { RemoteEntry } from '@shared/remote'
import { api } from '../api'
import { topOf } from './BrowseActions'
import { RemoteMenu, type MenuItem } from './RemoteMenu'
import { VIEW_LABEL, type BrowseView } from './BrowseViews'

interface Opts {
  dest: { id: string; name: string }
  diff: boolean
  path: string
  views: BrowseView[]
  view: BrowseView
  setView: (v: BrowseView) => void
  showAll: boolean
  setShowAll: (v: boolean) => void
  selected: Set<string>
  onOpen: (e: RemoteEntry) => void
  onSelectOnly: (path: string) => void
  onToggle: (path: string) => void
  onSelectAll: () => void
  onCopy: () => void
  onRefresh: () => void
  /** Only the PC may delete on a destination; leave undefined elsewhere and the item is not offered. */
  onDelete?: (targets: RemoteEntry[]) => void
  /** Every listed entry, to resolve a multi-selection into entries. */
  entries: RemoteEntry[]
  onNote: (m: string) => void
}

type Open = { x: number; y: number; target: RemoteEntry | null | 'view'; label: string }

/**
 * One menu for right-click, long-press, a row's ⋯ and the View button. Items are grouped: what you most likely want first,
 * then selection, then Advanced. Delete is offered only where the caller passes onDelete (the PC).
 */
export function useBrowseMenu(o: Opts): { openAt: (e: RemoteEntry | null, x: number, y: number) => void; openView: (x: number, y: number) => void; node: ReactNode } {
  const [m, setM] = useState<Open | null>(null)
  const top = topOf(o.path)

  const viewItems = (): MenuItem[] => [{ head: 'View' }, ...o.views.map((v) => ({ id: `view:${v}`, label: VIEW_LABEL[v].label, checked: o.view === v }))]
  const advanced = (): MenuItem[] => [{ head: 'Advanced' }, { id: 'showAll', label: 'Show all files', switch: o.showAll }]

  /** Delete is last, set apart, and names the destination. With several items selected it applies to all of them. */
  const targetsOf = (t: RemoteEntry): RemoteEntry[] => (o.selected.has(t.path) && o.selected.size > 1 ? o.entries.filter((e) => o.selected.has(e.path)) : [t])
  const del = (t: RemoteEntry): MenuItem[] => {
    if (!o.onDelete || t.state === 'waiting') return []
    const n = targetsOf(t).length
    return [{ sep: true }, { head: 'Advanced' }, { id: 'delete', label: n > 1 ? `Delete ${n} from ${o.dest.name}…` : `Delete from ${o.dest.name}…`, tone: 'danger' }]
  }

  const items = (): MenuItem[] => {
    if (!m) return []
    if (m.target === 'view') return [...viewItems(), { sep: true }, ...advanced()]
    const t = m.target
    if (!t) return [{ id: 'refresh', label: 'Refresh', hint: 'F5' }, { id: 'selectAll', label: 'Select all', hint: 'Ctrl+A' }, { sep: true }, ...viewItems(), { sep: true }, ...advanced()]
    const here = !!t.state && t.state !== 'waiting' || !t.state // a "waiting" file is not at the destination yet, so there is nothing to open or import
    if (t.dir) return [
      { id: 'open', label: 'Open' },
      { id: 'import', label: 'Import folder to library', tone: 'pri' },
      { id: 'copy', label: 'Copy to another destination…' },
      { sep: true },
      { id: 'toggle', label: o.selected.has(t.path) ? 'Deselect' : 'Select' },
      ...del(t)
    ]
    const resend = o.diff && !!top && (t.state === 'waiting' || t.state === 'differs')
    return [
      ...(here ? [{ id: 'open', label: 'Open', hint: 'Dbl-click' }] : []),
      ...(resend ? [{ id: 'send', label: t.state === 'differs' ? 'Re-send different files' : 'Send missing files now', tone: 'pri' as const }] : []),
      ...(here ? [{ id: 'import', label: 'Import to library', tone: resend ? undefined : ('pri' as const) }, { id: 'save', label: 'Save a copy…' }] : []),
      { id: 'copy', label: 'Copy to another destination…', disabled: !here },
      { sep: true },
      { id: 'toggle', label: o.selected.has(t.path) ? 'Deselect' : 'Select', hint: 'Space', disabled: !here },
      ...del(t)
    ]
  }

  const note = (p: Promise<string>): void => { p.then(o.onNote, (e: Error) => o.onNote(e.message)) }

  const pick = (id: string): void => {
    const t = m?.target
    setM(null)
    if (id.startsWith('view:')) return o.setView(id.slice(5) as BrowseView)
    if (id === 'showAll') return o.setShowAll(!o.showAll)
    if (id === 'refresh') return o.onRefresh()
    if (id === 'selectAll') return o.onSelectAll()
    if (!t || t === 'view') return
    if (id === 'delete') o.onDelete?.(targetsOf(t))
    else if (id === 'open') o.onOpen(t)
    else if (id === 'toggle') o.onToggle(t.path)
    else if (id === 'import') note(api.importFrom(o.dest.id, { paths: [t.path], recursive: true }).then(() => `Importing ${t.name} to the library`))
    else if (id === 'send') note(api.sendSession(o.dest.id, { session: top, ...(t.state === 'differs' ? { resendDiffers: true } : { onlyMissing: true }) }).then((r) => `Queued ${r.queued} for ${o.dest.name}`))
    else if (id === 'copy') { o.onSelectOnly(t.path); o.onCopy() }
    else if (id === 'save') {
      const a = document.createElement('a')
      a.href = api.remoteFileUrl(o.dest.id, t.path, true)
      a.download = t.name
      a.click()
    }
  }

  return {
    openAt: (e, x, y) => setM({ x, y, target: e, label: e ? e.name : 'Folder actions' }),
    openView: (x, y) => setM({ x, y, target: 'view', label: 'View' }),
    node: m ? <RemoteMenu x={m.x} y={m.y} label={m.label} items={items()} onClose={() => setM(null)} onPick={pick} /> : null
  }
}
