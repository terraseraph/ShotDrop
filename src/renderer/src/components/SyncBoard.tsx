import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CloudAccount, CloudQuota, DestStatus, Destination, LibraryCounts, Settings, Status } from '@shared/types'
import { api, desktop } from '../api'
import { ago, fmtSize } from '../format'
import { fade, firm } from '../motion'
import { Icon } from './Icon'
import { AddDestinationSheet, FILTERS, KIND_ICON, KIND_LABEL, KIND_TINT, type Kind, kindOf, WHERE_DELETES_GO } from './AddDestinationSheet'
import { fetchPlaces, getJson, lastPart } from './fsApi'
import { TabBar } from './TabBar'
import { Dialog } from './Dialog'
import './SyncBoard.css'
import './Phone.css'

type Toast = (t: string, tone?: 'info' | 'error') => void
type Health = 'paused' | 'expired' | 'failed' | 'offline' | 'syncing' | 'waiting' | 'ok'

/** rclone/file-system errors in plain words. The raw text stays available under "Details". */
export function friendlyError(raw: string, where: string, remote: string | null): string {
  const e = raw.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+(CRITICAL|ERROR|NOTICE|INFO)?\s*:?\s*/i, '')
  if (/didn't find section in config file/i.test(e))
    return remote ? `The account "${remote}" isn't set up in ShotDrop any more. Change the folder to pick a connected account, or remove this destination.` : "That rclone remote doesn't exist. Check the name in your rclone config."
  if (/no such host|dial tcp|i\/o timeout|connection (refused|reset)|network is unreachable|Waiting for destination/i.test(e)) return `Can't reach ${where} right now. ShotDrop keeps retrying and catches up when it's back.`
  if (/quota|storageQuotaExceeded|insufficient_space|not enough space|ENOSPC/i.test(e)) return `${where} is full. Free up space there, then press Retry.`
  if (/EACCES|EPERM|permission|access (is )?denied|forbidden|403/i.test(e)) return `ShotDrop isn't allowed to write to ${where}. Check the folder's permissions or sharing.`
  if (/ENOENT|cannot find the path|no such file or directory|ENOTDIR/i.test(e)) return `The folder isn't there. Is the drive or NAS connected? Reconnect it, or use Change folder.`
  return e
}

function healthOf(d: DestStatus | undefined, enabled: boolean): Health {
  if (!enabled) return 'paused'
  if (!d) return 'waiting'
  if (d.authExpired) return 'expired'
  if (d.errors > 0) return 'failed'
  if (d.running === 0 && d.lastError?.startsWith('Waiting for destination')) return 'offline'
  if (d.running > 0 || d.done < d.total) return 'syncing'
  return d.total === 0 ? 'waiting' : 'ok'
}

interface Row {
  d: Destination
  kind: Kind
  account: CloudAccount | null
  path: string
  ds: DestStatus | undefined
  h: Health
  email: string | null
  quota: CloudQuota | null
  left: number
  etaSecs: number | null
}

/** Everything both the desktop page and the phone screen need: accounts, per-destination rows, and the actions. */
function useSyncModel(s: Settings | null, status: Status | null, reload: () => void, toast: Toast) {
  const [accounts, setAccounts] = useState<CloudAccount[]>([])
  const [info, setInfo] = useState<Record<string, { email: string | null; quota: CloudQuota | null }>>({})
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [relinking, setRelinking] = useState<string | null>(null)
  const nDest = s?.destinations.length ?? 0
  const picks = status?.sync // refresh counts when the queue moves
  const loadAccounts = useCallback(() => void api.cloudAccounts().then((r) => setAccounts(r.accounts), () => undefined), [])
  useEffect(() => { if (desktop) loadAccounts() }, [loadAccounts, nDest])
  useEffect(() => {
    for (const a of accounts) if (!info[a.name]) void api.cloudInfo(a.name).then((i) => setInfo((c) => ({ ...c, [a.name]: i })), () => undefined)
  }, [accounts, info])
  useEffect(() => { api.libraryCounts().then(setCounts, () => undefined) }, [picks?.pending === 0, nDest, status?.library.shots])
  useEffect(() => { void fetchPlaces().then((p) => setHost(p?.hostname ?? null)) }, [])

  const live = new Map((status?.destinations ?? []).map((d) => [d.id, d]))
  const avg = counts && counts.all.files ? counts.all.bytes / counts.all.files : 0
  const rows: Row[] = (s?.destinations ?? []).map((d) => {
    const k = kindOf(d, accounts)
    const ds = live.get(d.id)
    const acct = k.account ? info[k.account.name] : undefined
    const left = ds ? Math.max(0, ds.total - ds.done) : 0
    return { d, kind: k.kind, account: k.account, path: k.path, ds, h: healthOf(ds, d.enabled), email: acct?.email ?? null, quota: acct?.quota ?? null, left, etaSecs: ds && ds.bps > 0 && avg ? Math.round((left * avg) / ds.bps) : null }
  })

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn()
      if (ok) toast(ok)
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  /** New sign-in for an expired account; every destination on the old account moves to the new one. */
  const reconnect = async (r: Row): Promise<void> => {
    if (!r.account || !s) return
    const old = r.account
    setRelinking(r.d.id)
    try {
      const fresh = await api.cloudLink(old.provider, { fullAccess: old.fullAccess })
      for (const x of s.destinations) {
        const xk = kindOf(x, accounts)
        if (xk.account?.name === old.name) await api.patchDestination(x.id, { target: `${fresh.name}:${xk.path}` })
      }
      await api.cloudDisconnect(old.name).catch(() => undefined)
      await api.retrySync()
      toast(`${KIND_LABEL[old.provider]} reconnected. Uploads are resuming.`)
      loadAccounts()
      reload()
    } catch (e) {
      const m = (e as Error).message
      if (m !== 'Cancelled') toast(`Reconnect didn't finish: ${m}`, 'error')
    } finally {
      setRelinking(null)
    }
  }
  const remove = async (r: Row): Promise<void> => {
    if (!s) return
    const lastUser = r.account && !s.destinations.some((x) => x.id !== r.d.id && kindOf(x, accounts).account?.name === r.account!.name)
    const msg = lastUser
      ? `Disconnect ${r.d.name}? ShotDrop stops syncing there and forgets the ${KIND_LABEL[r.kind]} sign-in. Files already uploaded stay in your ${KIND_LABEL[r.kind]}.`
      : `Remove ${r.d.name}? ShotDrop stops syncing there. Files already copied stay where they are.`
    if (!confirm(msg)) return
    await run(async () => {
      await api.deleteDestination(r.d.id)
      if (lastUser) await api.cloudDisconnect(r.account!.name).catch(() => undefined)
      loadAccounts()
    }, `${r.d.name} removed`)
  }
  const toggle = (r: Row): Promise<void> => run(() => api.patchDestination(r.d.id, { enabled: !r.d.enabled }), r.d.enabled ? `${r.d.name} paused` : `${r.d.name} resumed`)
  const retry = (): Promise<void> => run(() => api.retrySync(), 'Retrying failed uploads')
  const mirror = (r: Row): Promise<void> | undefined => {
    const on = !r.d.mirrorDeletes
    if (!on && r.ds?.deletesWaiting && !confirm(`${r.ds.deletesWaiting} ${r.ds.deletesWaiting === 1 ? 'delete is' : 'deletes are'} still waiting for ${r.d.name}. Turning this off cancels them, so those copies stay there.`)) return
    if (on && !confirm(`Delete from ${r.d.name} too?

From now on, deleting a photo in ShotDrop also deletes the copy ShotDrop sent to ${r.d.name}. ${WHERE_DELETES_GO[r.kind]}

One way only: deleting something in ${r.d.name} never touches this computer. Photos deleted before now are not affected.`)) return
    return run(() => api.patchDestination(r.d.id, { mirrorDeletes: on }), on ? `Deleting in ShotDrop now deletes from ${r.d.name} too` : `${r.d.name} keeps its copies from now on`)
  }
  return { rows, counts, host, relinking, loadAccounts, run, reconnect, remove, toggle, retry, mirror }
}

const pillOf = (r: Row): { cls: string; text: string } => {
  switch (r.h) {
    case 'ok': return { cls: 'ok', text: 'Up to date' }
    case 'syncing': return { cls: 'run', text: `Syncing · ${r.left} left` }
    case 'expired': return { cls: 'bad', text: 'Sign-in expired' }
    case 'failed': return { cls: 'bad', text: `${r.ds?.errors ?? 'Some'} failed` }
    case 'offline': return r.kind === 'folder' ? { cls: 'off', text: 'Not plugged in' } : { cls: 'bad', text: "Can't reach" }
    case 'paused': return { cls: 'off', text: 'Paused' }
    default: return { cls: 'off', text: 'Waiting for photos' }
  }
}
const filterName = (r: Row): string => FILTERS.find((f) => f.id === r.d.filter)?.title ?? 'Everything'
const where = (r: Row): string => (r.account ? [KIND_LABEL[r.kind], ...r.path.split('/').filter(Boolean)].join('/').replace(`${KIND_LABEL[r.kind]}/`, '') || KIND_LABEL[r.kind] : r.path)
/** Long paths keep the drive/start and the last two folders; the full path is in the tooltip. */
const shortPath = (p: string): string => {
  if (p.length <= 44) return p
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return p
  const sep = p.includes('\\') ? '\\' : '/'
  return `${parts[0]}${sep}…${sep}${parts.slice(-2).join(sep)}`
}
const etaText = (secs: number): string => (secs < 5 ? 'a few seconds' : secs < 90 ? `about ${Math.round(secs / 5) * 5} s` : `about ${Math.round(secs / 60)} min`)
const errorLine = (r: Row): string | null => {
  if (r.h === 'expired') return `${KIND_LABEL[r.kind]} stopped accepting the saved sign-in. ${r.left} ${r.left === 1 ? 'file is' : 'files are'} waiting and will go as soon as you reconnect.`
  if ((r.h === 'failed' || r.h === 'offline') && r.ds?.lastError) return friendlyError(r.ds.lastError, r.account ? KIND_LABEL[r.kind] : r.d.name, r.kind === 'custom' ? null : r.d.target.split(':')[0])
  if (r.h === 'failed') return 'Some uploads failed.'
  if (r.ds?.deleteError) return `Couldn't delete a photo here that you deleted in ShotDrop: ${friendlyError(r.ds.deleteError, r.account ? KIND_LABEL[r.kind] : r.d.name, null)}`
  return null
}

function Tile({ kind, size = 28 }: { kind: Kind; size?: number }) {
  return <span className="sx-tile" style={{ width: size, height: size, color: KIND_TINT[kind].fg, background: KIND_TINT[kind].bg }}><Icon name={KIND_ICON[kind]} /></span>
}

// ================= desktop page =================

interface Props {
  s: Settings
  status: Status | null
  reload: () => void
  toast: Toast
}

/** The flow picture: cameras → this PC → destinations, with live cards. Used by the page below. */
export function SyncBoard({ s, status, reload, toast }: Props) {
  const m = useSyncModel(s, status, reload, toast)
  const [sheet, setSheet] = useState<{ editing?: Destination; kind?: Kind } | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [queue, setQueue] = useState<{ file: string; destId: string; status: string; error: string | null }[] | null>(null)
  const cams = status?.cameras ?? []
  const camsOn = cams.filter((c) => c.connected)
  const sync = status?.sync
  const anyRunning = (status?.destinations ?? []).some((d) => d.running > 0)
  const framesToday = cams.reduce((n, c) => n + c.today, 0)
  const watch = s.watchFolders
  const lib = status?.library
  const destName = (id: string): string => s.destinations.find((d) => d.id === id)?.name ?? id

  useEffect(() => {
    if (!menu) return
    const off = (): void => setMenu(null)
    window.addEventListener('pointerdown', off)
    return () => window.removeEventListener('pointerdown', off)
  }, [menu])
  useEffect(() => {
    if (queue) void getJson<typeof queue>('/api/sync/jobs').then((j) => j && setQueue(j))
  }, [queue === null, sync?.pending, sync?.running]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = (m: string): void => {
    setSheet(null)
    toast(m)
    m && reload()
  }

  return (
    <div className="sx">
      <div className="sx-head">
        <div>
          <h1>Where your photos travel</h1>
          <p>Camera → this PC → each destination. It keeps going when the app is closed and when drives come and go.</p>
        </div>
        <div className="sx-head-actions">
          <button className="tb sx-big" onClick={() => void m.retry()}>Retry failed{sync && sync.errors > 0 && <span className="badge rej">{sync.errors}</span>}</button>
          <div className="sx-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <div className="sx-split">
              <button onClick={() => setSheet({})}>+ Add destination</button>
              <button aria-label="Choose a provider" aria-haspopup="menu" aria-expanded={menu === 'add'} onClick={() => setMenu(menu === 'add' ? null : 'add')}><Icon name="chevron" /></button>
            </div>
            <AnimatePresence>
              {menu === 'add' && <AddMenu onPick={(kind) => { setMenu(null); setSheet({ kind }) }} />}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="sx-flow">
        <motion.div className="sx-src" {...rise(0)}>
          <div className="lbl">SOURCE</div>
          {cams.map((c) => (
            <div key={c.username} className="sx-cam">
              <span className={`dot ${c.connected ? 'live' : ''}`} style={c.connected ? undefined : { background: 'var(--faintest)' }} />
              <div className="sx-title">
                <div className="sx-strong">{c.label || c.username}{c.label && c.label !== c.username && <span className="sx-muted"> · {c.username}</span>}</div>
                <div className="sx-sub">{c.today} {c.today === 1 ? 'frame' : 'frames'} · {c.lastAt ? `last ${ago(c.lastAt)}` : 'nothing yet'}</div>
              </div>
            </div>
          ))}
          {!cams.length && <div className="sx-sub">No camera has connected yet{status?.ftp.running ? ` · FTP on ${status.ftp.addresses[0] ?? ''}:${status.ftp.port}` : ' · FTP is off'}</div>}
          <div className="sx-sub sx-faint">Watched folder · {watch.length ? watch.map(lastPart).join(', ') : 'none'}</div>
          <div className="sx-down"><Wire on={camsOn.length > 0 || (status?.ftp.activeConnections ?? 0) > 0} /></div>
          <div className="sx-pcbox">
            <div className="sx-line"><span className="sx-host">{m.host ?? 'This PC'}</span><span className={`pill ${status?.ftp.running ? 'ok' : 'off'}`} style={{ marginLeft: 'auto' }}>{status?.ftp.running ? 'Live' : 'FTP off'}</span></div>
            <MidPath p={lib?.dir ?? ''} mono />
            <div className="sx-stats">
              <Stat v={String(framesToday)} l="frames today" />
              <Stat v={m.counts ? fmtSize(m.counts.all.bytes) : '…'} l="in library" />
              <Stat v={lib?.free != null ? fmtSize(lib.free) : '…'} l="free" />
              <Stat v={m.counts ? String(m.counts.picks.files) : '…'} l="picks" />
            </div>
            <div className="sx-faintest">Originals never move.</div>
          </div>
        </motion.div>

        <div className="sx-wire-h"><Wire on={anyRunning} blue /></div>

        <div className="sx-col sx-dests">
          <AnimatePresence initial>
            {m.rows.map((r, i) => {
              const pill = pillOf(r)
              const err = errorLine(r)
              const pct = r.ds && r.ds.total ? Math.round((r.ds.done / r.ds.total) * 100) : r.h === 'ok' ? 100 : 0
              const bad = r.h === 'expired' || r.h === 'failed'
              return (
                <motion.div key={r.d.id} layout="position" id={`dest-${r.d.id}`} className={`node dest sx-dcard ${bad ? 'bad' : ''}`} style={{ opacity: r.h === 'paused' || r.h === 'offline' && r.kind === 'folder' ? 0.78 : 1 }} {...rise(i + 1)} exit={{ opacity: 0, scale: 0.97 }}>
                  <Tile kind={r.kind} size={34} />
                  <div className="sx-dmain">
                    <div className="sx-line">
                      <span className="sx-strong sx-dname">{r.d.name}</span>
                      <span className="sx-sub sx-dfilter"><span className={r.d.filter === 'picks' ? 'sx-accent' : ''}>{filterName(r).toLowerCase()}</span>{r.d.filter === 'picks' && <> · <span className="key">P</span></>}{r.email && <> · {r.email}</>}{r.d.mirrorDeletes && <> · <span className="sx-mirror" title="Deleting a photo in ShotDrop also deletes it here. One way only.">mirrors deletes</span></>}</span>
                      <span className={`pill ${pill.cls}`} style={{ marginLeft: 'auto' }}>{r.h === 'syncing' && <span className="dot" style={{ background: 'var(--sync)' }} />}{pill.text}</span>
                    </div>
                    <MidPath p={where(r)} mono={!r.account} />
                    {err && <div className="sx-err">{err}{r.ds?.lastError && r.h !== 'expired' && <details><summary>Details</summary><code>{r.ds.lastError}</code></details>}</div>}
                    <div className="sx-prog">
                      <div className={`bar thick ${r.h === 'syncing' ? 'out' : ''}`} aria-label={`${pct}% sent`}><i style={{ width: `${pct}%` }} /></div>
                      <span className="sx-sub sx-progtext">
                        {r.h === 'syncing' && r.ds && <>{r.ds.done}/{r.ds.total}{r.ds.bps > 0 && <> · {fmtSize(r.ds.bps)}/s</>}{r.etaSecs != null && <> · {etaText(r.etaSecs)}</>}</>}
                        {r.h === 'ok' && r.ds && <>{r.ds.done} {r.ds.done === 1 ? 'file' : 'files'}{r.ds.lastDoneAt && <> · {ago(r.ds.lastDoneAt)}</>}{r.quota?.free != null && <> · {fmtSize(r.quota.free)} free</>}</>}
                        {(r.h === 'expired' || r.h === 'offline' || r.h === 'failed') && <>{r.left} waiting</>}
                        {r.h === 'paused' && 'Paused'}
                        {r.h === 'waiting' && 'Nothing to send yet'}
                        {!!r.ds?.deletesWaiting && <> · {r.ds.deletesWaiting} {r.ds.deletesWaiting === 1 ? 'delete' : 'deletes'} waiting</>}
                      </span>
                    </div>
                  </div>
                  {m.relinking === r.d.id ? (
                    <button className="tb sx-act" onClick={() => void api.cloudCancel().catch(() => undefined)}>Cancel sign-in</button>
                  ) : r.h === 'expired' ? (
                    <button className="tb primary sx-act" onClick={() => void m.reconnect(r)} disabled={!!m.relinking}>Reconnect</button>
                  ) : r.h === 'failed' || r.ds?.deleteError ? (
                    <button className="tb primary sx-act" onClick={() => void m.retry()}>{r.h === 'failed' ? 'Retry' : 'Retry deletes'}</button>
                  ) : (
                    <button className="tb sx-act" onClick={() => void m.toggle(r)}>{r.d.enabled ? 'Pause' : 'Resume'}</button>
                  )}
                  <div className="sx-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
                    <button className="tb" aria-label="More" aria-haspopup="menu" aria-expanded={menu === r.d.id} onClick={() => setMenu(menu === r.d.id ? null : r.d.id)}>⋯</button>
                    <AnimatePresence>
                      {menu === r.d.id && (
                        <motion.div role="menu" className="sx-menu sheet" initial={{ opacity: 0, y: -4, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={firm}>
                          <button role="menuitem" onClick={() => { setMenu(null); void m.run(async () => toast(`Queued ${(await api.resync(r.d.id)).queued} files for ${r.d.name}`)) }}>Resync everything</button>
                          <button role="menuitem" onClick={() => { setMenu(null); setSheet({ editing: r.d }) }}>Change folder…</button>
                          <button role="menuitemcheckbox" aria-checked={!!r.d.mirrorDeletes} onClick={() => { setMenu(null); void m.mirror(r) }}>{r.d.mirrorDeletes ? '✓ ' : ''}Delete here when I delete in ShotDrop</button>
                          {r.kind === 'folder' && desktop && <button role="menuitem" onClick={() => { setMenu(null); void desktop!.openPath(r.path) }}>Show folder</button>}
                          <button role="menuitem" className="danger" onClick={() => { setMenu(null); void m.remove(r) }}>{r.account ? 'Disconnect' : 'Remove'}</button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
          <motion.button className="sx-addcard" onClick={() => setSheet({})} {...rise(m.rows.length + 1)}>
            <span className="sx-plus"><Icon name="plus" /></span>
            Add destination
            <span className="sx-addhint">Drive · Dropbox · Folder / NAS · detected drives</span>
          </motion.button>
        </div>

        <div className="sx-side">
          <div className="lbl">QUEUE</div>
          <div className="sx-qbox">
            <div><span className="sx-statv">{(sync?.pending ?? 0) + (sync?.running ?? 0)}</span> jobs</div>
            <div className="sx-qrow"><span>Running</span><span style={{ color: 'var(--sync)' }}>{sync?.running ?? 0}</span></div>
            {m.rows.filter((r) => r.h === 'expired' || r.h === 'offline').map((r) => <div key={r.d.id} className="sx-qrow"><span>Waiting on {r.d.name}</span><span style={{ color: 'var(--reject-text)' }}>{r.left}</span></div>)}
            {m.rows.filter((r) => r.ds?.deletesWaiting).map((r) => <div key={`del-${r.d.id}`} className="sx-qrow"><span>Deletes for {r.d.name}</span><span>{r.ds!.deletesWaiting}</span></div>)}
            <div className="sx-qrow"><span>Failed</span><span style={{ color: (sync?.errors ?? 0) > 0 ? 'var(--reject-text)' : 'var(--live)' }}>{sync?.errors ?? 0}</span></div>
            <button className="tb sx-qbtn" onClick={() => setQueue(queue ? null : [])}>{queue ? 'Hide queue' : 'Show queue'}</button>
            <div className="sx-faintest">Retries with backoff and resumes after restarts and offline periods.</div>
          </div>
          <AnimatePresence>
            {queue && (
              <motion.div className="sx-jobs" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fade}>
                {queue.length === 0 && <div className="sx-sub">Nothing queued.</div>}
                {queue.slice(0, 12).map((j, i) => (
                  <div key={i} className="sx-job"><span className="mono sx-jobfile">{j.file}</span><span className="sx-sub">{destName(j.destId)}</span><span className={`pill ${j.status === 'error' ? 'bad' : j.status === 'running' ? 'run' : j.status === 'done' ? 'ok' : 'off'}`}>{j.status}</span>{j.error && <span className="sx-err-s">{j.error}</span>}</div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {sheet && <AddDestinationSheet key="sheet" s={s} status={status} editing={sheet.editing} initialKind={sheet.kind} toast={toast} onClose={() => setSheet(null)} onDone={(msg) => { close(msg); m.loadAccounts() }} />}
      </AnimatePresence>
    </div>
  )
}

/** Long paths cut in the middle: the start and the last folder always show, the full path is the tooltip. */
function MidPath({ p, mono }: { p: string; mono?: boolean }) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const head = i > 0 ? p.slice(0, i) : p
  const tail = i > 0 ? p.slice(i) : ''
  return <div className={`sx-mid ${mono ? 'mono' : ''}`} title={p}><span className="sx-mid-h">{head}</span><span className="sx-mid-t">{tail}</span></div>
}

/** Provider quick picks under the Add button: one click starts the sheet on that provider. */
function AddMenu({ onPick }: { onPick: (k: Kind) => void }) {
  const items: { kind: Kind; hint: string }[] = [
    { kind: 'drive', hint: 'sign in' },
    { kind: 'dropbox', hint: 'sign in' },
    { kind: 'folder', hint: 'browse' },
    { kind: 'custom', hint: 'advanced' }
  ]
  return (
    <motion.div role="menu" className="sx-menu sx-addmenu sheet" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={firm}>
      {items.map((it) => (
        <button key={it.kind} role="menuitem" onClick={() => onPick(it.kind)}>
          <Tile kind={it.kind} size={26} />{KIND_LABEL[it.kind]}<span className="sx-addhint">{it.hint}</span>
        </button>
      ))}
    </motion.div>
  )
}

const rise = (i: number) => ({ initial: { y: 14, opacity: 0 }, animate: { y: 0, opacity: 1 }, transition: { ...firm, delay: Math.min(i, 8) * 0.07 } }) as const
const Stat = ({ v, l }: { v: string; l: string }) => <div><div className="sx-statv">{v}</div>{l}</div>
/** A wire with amber (or blue) dots travelling left to right while data moves; still when idle. */
const Wire = ({ on, blue }: { on: boolean; blue?: boolean }) => <div className={`wire ${blue ? 'blue' : ''} ${on ? '' : 'still'}`}><i /></div>

/** Full view under the top bar. Loads settings itself; Esc goes back. */
export function SyncPage({ status, toast, onClose }: { status: Status | null; toast: Toast; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [tick, setTick] = useState(0)
  const nDest = status?.destinations.length
  useEffect(() => { void api.settings().then(setS, (e: Error) => toast(e.message, 'error')) }, [tick, nDest, toast])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The add sheet owns Esc while it is open.
      if (e.key === 'Escape' && !document.querySelector('.ad-sheet') && !(e.target instanceof HTMLInputElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <Dialog title="Sync" onClose={onClose} wide>
      <div className="sx-page">
        {s ? <SyncBoard s={s} status={status} reload={() => setTick((t) => t + 1)} toast={toast} /> : <p className="sx-sub" style={{ padding: 32 }}>Loading…</p>}
      </div>
    </Dialog>
  )
}

// ================= phone =================

/** MSync.dc.html: the same flow, vertical. Pause/resume and retry work from the phone; adding a destination needs the PC. */
export function MobileSync({ status, toast }: { status: Status | null; toast: Toast }) {
  const [s, setS] = useState<Settings | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => { void api.settings().then(setS, () => undefined) }, [tick, status?.destinations.length])
  const m = useSyncModel(s, status, () => setTick((t) => t + 1), toast)
  const cams = status?.cameras ?? []
  const camsOn = cams.filter((c) => c.connected).length
  const sync = status?.sync
  return (
    <div className="m-page">
      <div className="m-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1>Sync</h1>
          <div className="sx-sub">Camera → this PC → {m.rows.length} {m.rows.length === 1 ? 'destination' : 'destinations'}</div>
        </div>
        <button className="m-add" onClick={() => toast('Add destinations on the PC. The sheet opens in ShotDrop there.')}>+ Add</button>
      </div>
      <div className="m-scroll">
        <div className="node m-row">
          <span className={`dot ${camsOn ? 'live' : ''}`} style={camsOn ? undefined : { background: 'var(--faintest)' }} />
          <div style={{ flex: 1, minWidth: 0 }}><div className="sx-strong">{cams.length === 1 ? '1 camera' : `${cams.length} cameras`}</div><div className="sx-sub">{cams.map((c) => c.label || c.username).join(', ') || 'None connected yet'}</div></div>
          <span className="sx-sub">{cams.reduce((n, c) => n + c.today, 0)} today</span>
        </div>
        <div className="m-wire"><Wire on={camsOn > 0} /></div>
        <div className="node m-row" style={{ borderColor: '#3a3a3a' }}>
          <div style={{ flex: 1, minWidth: 0 }}><div className="sx-host" style={{ fontSize: 14 }}>{m.host ?? 'This PC'}</div><div className="mono sx-sub sx-ell">{status?.library.dir}{status?.library.free != null ? ` · ${fmtSize(status.library.free)} free` : ''}</div></div>
          <span className={`pill ${status?.ftp.running ? 'ok' : 'off'}`}>{status?.ftp.running ? 'Live' : 'FTP off'}</span>
        </div>
        <div className="m-wire"><Wire on={m.rows.some((r) => r.h === 'syncing')} blue /></div>
        <div className="m-dests">
          {m.rows.map((r) => {
            const pill = pillOf(r)
            const err = errorLine(r)
            const pct = r.ds && r.ds.total ? Math.round((r.ds.done / r.ds.total) * 100) : 0
            return (
              <div key={r.d.id} className="node m-card" style={{ borderColor: r.h === 'expired' || r.h === 'failed' ? '#4a2224' : undefined, opacity: r.h === 'paused' ? 0.7 : 1 }}>
                <div className="sx-line">
                  <div style={{ flex: 1, minWidth: 0 }}><div className="sx-strong sx-ell">{r.d.name}</div><div className="sx-sub sx-ell">{filterName(r)}{r.ds && r.ds.total ? ` · ${r.h === 'syncing' ? `${r.ds.done} of ${r.ds.total}` : `${r.ds.done} files`}` : ''}</div></div>
                  <span className={`pill ${pill.cls}`}>{r.h === 'syncing' ? `${r.left} left` : pill.text}</span>
                </div>
                {r.h === 'syncing' && <div className="bar thick out"><i style={{ width: `${pct}%` }} /></div>}
                {err && <div className="sx-err" style={{ margin: 0 }}>{r.h === 'expired' ? 'Reconnect on the PC. Files go as soon as you do.' : err}</div>}
                {(r.h === 'syncing' || r.h === 'paused' || r.h === 'ok' && !r.d.enabled) && (
                  <div className="sx-line sx-sub">{r.h === 'syncing' && <span>{m.counts && m.counts.all.files ? fmtSize(r.left * (m.counts.all.bytes / m.counts.all.files)) : ''}{r.etaSecs != null ? ` · ${etaText(r.etaSecs)}` : ''}</span>}<button className="m-act" onClick={() => void m.toggle(r)}>{r.d.enabled ? 'Pause' : 'Resume'}</button></div>
                )}
                {(r.h === 'failed') && <button className="m-act" onClick={() => void m.retry()}>Retry</button>}
              </div>
            )
          })}
        </div>
        <div className="sx-faintest" style={{ marginTop: 12 }}>Queue: {(sync?.pending ?? 0) + (sync?.running ?? 0)} jobs · {sync?.errors ?? 0} failed · resumes after restarts and offline periods.</div>
      </div>
      <TabBar current="sync" />
    </div>
  )
}
