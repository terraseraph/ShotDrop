import { type ReactNode, useEffect, useState } from 'react'
import type { BrowseResult, RemoteEntry } from '@shared/remote'
import { api, isRemote } from '../api'
import { RemoteMenu, type MenuItem } from './RemoteMenu'

export interface ActionDest { id: string; name: string }

export const STATE_LABEL: Record<NonNullable<RemoteEntry['state']>, string> = { synced: 'Synced', waiting: 'Not sent yet', missingHere: 'Not on this PC', differs: 'Different' }

export const topOf = (path: string): string => path.split('/')[0] ?? ''

/**
 * Import / copy / adopt / send controls, shared by the desktop and phone Browse. `picked` are the selected entries (files
 * or folders); "Import whole folder" takes the folder being viewed. Import writes to this PC only.
 * One primary button says what is most useful right now; the rest are secondary, and rarer things sit under the ⋯ menu.
 */
export function BrowseActions({ dest, path, picked, entries, meta, diff, mobile, trailing, panelRequest, onNote, onReload }: {
  dest: ActionDest
  path: string
  picked: RemoteEntry[]
  entries: RemoteEntry[]
  meta: BrowseResult['meta'] | undefined
  diff?: boolean
  mobile?: boolean
  /** Sits at the end of the bar (the View menu). */
  trailing?: ReactNode
  /** Bump `n` to open the copy panel, e.g. from a context menu. */
  panelRequest?: { n: number }
  onNote: (m: string) => void
  onReload: () => void
}) {
  const [panel, setPanel] = useState<null | 'copy' | 'adopt'>(null)
  const [dests, setDests] = useState<ActionDest[]>([])
  const [toDest, setToDest] = useState('')
  const [toPath, setToPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    void api.status().then((s) => {
      const d = s.destinations.map((x) => ({ id: x.id, name: x.name }))
      setDests(d)
      setToDest((cur) => cur || d.find((x) => x.id !== dest.id)?.id || d[0]?.id || '')
    }).catch(() => undefined)
  }, [dest.id])
  useEffect(() => { if (panelRequest?.n) setPanel('copy') }, [panelRequest?.n])

  const run = async (label: string, f: () => Promise<string>): Promise<void> => {
    setBusy(true)
    try {
      onNote(await f())
    } catch (e) {
      onNote(`${label} failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const top = topOf(path)
  const waiting = entries.filter((e) => e.state === 'waiting').length
  const differs = entries.filter((e) => e.state === 'differs').length
  const canAdopt = !isRemote && !!path && !path.includes('/') && !meta
  const copyPaths = picked.length ? picked.map((p) => p.path) : [path]

  const send = (): void => void run('Send', async () => `Queued ${(await api.sendSession(dest.id, { session: top, onlyMissing: true })).queued} for ${dest.name}`)
  const resend = (): void => void run('Re-send', async () => `Queued ${(await api.sendSession(dest.id, { session: top, resendDiffers: true })).queued} for ${dest.name}`)
  const importPicked = (): void => void run('Import', async () => { await api.importFrom(dest.id, { paths: picked.map((p) => p.path), recursive: true }); return `Importing ${picked.length} item${picked.length === 1 ? '' : 's'} to the library` })
  const importFolder = (): void => void run('Import', async () => { await api.importFrom(dest.id, { paths: [path], recursive: true }); return 'Importing the whole folder to the library' })

  const canSend = !!(diff && top && waiting)
  const canResend = !!(diff && top && differs)
  const primary: { label: string; go?: () => void } = picked.length ? { label: `Import ${picked.length} to library`, go: importPicked }
    : canSend ? { label: `Send ${waiting} missing now`, go: send }
    : canResend ? { label: `Re-send ${differs} different`, go: resend }
    : diff && top ? { label: '✓ All synced' }
    : path ? { label: 'Import whole folder', go: importFolder }
    : { label: 'Select files to import' }

  const more: MenuItem[] = [
    { head: 'More' },
    { id: 'folder', label: 'Import whole folder', disabled: busy || !path },
    ...(canSend && primary.go !== send ? [{ id: 'send', label: `Send ${waiting} missing now` }] : []),
    ...(canResend && primary.go !== resend ? [{ id: 'resend', label: `Re-send ${differs} different` }] : []),
    ...(canAdopt ? [{ id: 'adopt', label: 'Adopt folder…' }] : [])
  ]
  const pick = (id: string): void => {
    setMenu(null)
    if (id === 'folder') importFolder()
    else if (id === 'adopt') setPanel('adopt')
    else if (id === 'send') send()
    else if (id === 'resend') resend()
  }

  return (
    <div className={`bw-actions ${mobile ? 'mobile' : ''}`}>
      <button className="tb pri" disabled={busy || !primary.go} onClick={primary.go}>{primary.label}</button>
      <button className="tb" disabled={busy || !(picked.length || path)} aria-expanded={panel === 'copy'} onClick={() => setPanel(panel === 'copy' ? null : 'copy')}>Copy to…</button>
      <button className="tb" aria-label="More actions" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }) }}>⋯</button>
      {trailing && <span className="bw-trailing">{trailing}</span>}
      {menu && <RemoteMenu x={menu.x} y={menu.y} label="More actions" items={more} onClose={() => setMenu(null)} onPick={pick} />}
      {panel === 'copy' && (
        <div className="bw-panel">
          <label>To <select value={toDest} onChange={(e) => setToDest(e.target.value)}>{dests.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>Folder <input value={toPath} placeholder="(top level)" onChange={(e) => setToPath(e.target.value)} /></label>
          <button className="tb pri" disabled={busy || !toDest} onClick={() => void run('Copy', async () => { await api.copyFrom(dest.id, { paths: copyPaths, toDestId: toDest, toPath: toPath.trim().replace(/^\/+|\/+$/g, '') }); setPanel(null); return 'Copying…' })}>Copy {picked.length ? `${picked.length} selected` : 'this folder'}</button>
        </div>
      )}
      {panel === 'adopt' && (
        <div className="bw-panel">
          <label>Name <input value={name} maxLength={80} placeholder="Smith wedding" onChange={(e) => setName(e.target.value)} /></label>
          <button className="tb pri" disabled={busy || !name.trim()} onClick={() => void run('Adopt', async () => { await api.adoptFolder(dest.id, { path, name: name.trim() }); setPanel(null); setName(''); onReload(); return `Wrote .shotdrop.json into ${dest.name}/${path}` })}>Write name to this folder</button>
          <span className="bw-note">This adds one small file to the destination.</span>
        </div>
      )}
    </div>
  )
}
