import { useCallback, useEffect, useState } from 'react'
import type { CloudAccount, CloudQuota, DestStatus, Destination, Settings, Status } from '@shared/types'
import { api } from '../api'
import { ago, fmtSize } from '../format'
import { Icon } from './Icon'
import { AddDestinationSheet, FILTERS, KIND_ICON, KIND_LABEL, kindOf } from './AddDestinationSheet'
import './SyncBoard.css'

interface Props {
  s: Settings
  status: Status | null
  reload: () => void
  toast: (t: string, tone?: 'info' | 'error') => void
}

type Health = 'paused' | 'expired' | 'failed' | 'offline' | 'syncing' | 'waiting' | 'ok'

const HEALTH_TEXT: Record<Health, string> = {
  paused: 'Paused',
  expired: 'Sign-in expired',
  failed: 'Failed',
  offline: "Can't reach",
  syncing: 'Syncing',
  waiting: 'Waiting for photos',
  ok: 'Up to date'
}

/** rclone/file-system errors in plain words. The raw text stays available under "Details". */
function friendlyError(raw: string, where: string, remote: string | null): string {
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

/**
 * Settings → Sync as a picture of where photos travel: camera → this PC → each destination,
 * with one card per destination for health, progress, space and actions. Adding is one sheet.
 */
export function SyncBoard({ s, status, reload, toast }: Props) {
  const [accounts, setAccounts] = useState<CloudAccount[]>([])
  const [info, setInfo] = useState<Record<string, { email: string | null; quota: CloudQuota | null }>>({})
  const [sheet, setSheet] = useState<{ editing?: Destination } | null>(null)
  const [relinking, setRelinking] = useState<string | null>(null) // destination id

  const loadAccounts = useCallback(() => {
    api.cloudAccounts().then((r) => setAccounts(r.accounts), () => undefined)
  }, [])
  useEffect(loadAccounts, [loadAccounts, s.destinations.length])
  useEffect(() => {
    for (const a of accounts) {
      if (!info[a.name]) void api.cloudInfo(a.name).then((i) => setInfo((cur) => ({ ...cur, [a.name]: i })), () => undefined)
    }
  }, [accounts, info])

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn()
      if (ok) toast(ok)
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const live = new Map((status?.destinations ?? []).map((d) => [d.id, d]))
  const cams = status?.cameras ?? []
  const camsOn = cams.filter((c) => c.connected).length
  const ftp = status?.ftp
  const sync = status?.sync
  const anyActive = (status?.destinations ?? []).some((d) => d.running > 0)
  const anyBad = s.destinations.some((d) => ['expired', 'failed', 'offline'].includes(healthOf(live.get(d.id), d.enabled)))

  /** New sign-in for an expired account; every destination on the old account moves to the new one. */
  const reconnect = async (d: Destination): Promise<void> => {
    const k = kindOf(d, accounts)
    if (!k.account) return
    const old = k.account
    setRelinking(d.id)
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

  const remove = async (d: Destination): Promise<void> => {
    const k = kindOf(d, accounts)
    const lastUser = k.account && !s.destinations.some((x) => x.id !== d.id && kindOf(x, accounts).account?.name === k.account!.name)
    const msg = lastUser
      ? `Disconnect ${d.name}? ShotDrop stops syncing there and forgets the ${KIND_LABEL[k.kind]} sign-in. Files already uploaded stay in your ${KIND_LABEL[k.kind]}.`
      : `Remove ${d.name}? ShotDrop stops syncing there. Files already copied stay where they are.`
    if (!confirm(msg)) return
    await run(async () => {
      await api.deleteDestination(d.id)
      if (lastUser) await api.cloudDisconnect(k.account!.name).catch(() => undefined)
      loadAccounts()
    }, `${d.name} removed`)
  }

  return (
    <div className="syncboard">
      <div className="sb-head">
        <div>
          <h3>Where your photos go</h3>
          <p className="muted small">Every shot lands on this PC first, then copies to each destination in the background.</p>
        </div>
        {sync && (sync.running + sync.pending > 0 || sync.errors > 0) && (
          <span className="muted small sb-counts">
            {sync.running} uploading · {sync.pending} queued
            {sync.errors > 0 && (
              <>
                {' · '}<span className="bad">{sync.errors} failed</span>{' '}
                <button className="link" onClick={() => void run(() => api.retrySync(), 'Retrying failed uploads')}>Retry</button>
              </>
            )}
          </span>
        )}
      </div>

      <div className={`route ${s.destinations.length ? '' : 'empty'}`}>
        <div className="node">
          <span className="node-icon"><Icon name="camera" /></span>
          <span className="node-text">
            <strong>{cams.length > 1 ? `${cams.length} cameras` : 'Camera'}</strong>
            <span className="muted small">{camsOn ? `${camsOn} connected` : ftp?.running ? `FTP · ${ftp.addresses[0] ?? '…'}` : 'FTP off'}</span>
          </span>
        </div>
        <span className={`wire ${camsOn ? 'live' : ''}`} aria-hidden />
        <div className="node">
          <span className="node-icon"><Icon name="folder" /></span>
          <span className="node-text">
            <strong>This PC</strong>
            <span className="muted small">{status?.library.shots ?? 0} shots · always kept</span>
          </span>
        </div>
        <span className={`wire ${anyActive ? 'live' : ''} ${anyBad ? 'bad' : ''}`} aria-hidden />
        <div className="dests">
          {s.destinations.map((d) => {
            const k = kindOf(d, accounts)
            const ds = live.get(d.id)
            const h = healthOf(ds, d.enabled)
            return (
              <a key={d.id} className={`dnode h-${h}`} href={`#dest-${d.id}`}>
                <span className="node-icon"><Icon name={KIND_ICON[k.kind]} /></span>
                <span className="node-text">
                  <strong>{d.name}</strong>
                  <span className="small">{h === 'syncing' && ds ? `${ds.done} / ${ds.total} sent` : HEALTH_TEXT[h]}</span>
                </span>
              </a>
            )
          })}
          <button className="dnode add" onClick={() => setSheet({})}>
            <Icon name="plus" />
            <span className="node-text">
              <strong>{s.destinations.length ? 'Add another destination' : 'Add a destination'}</strong>
              <span className="muted small">{s.destinations.length ? 'Different rules, different place' : 'Nothing leaves this PC yet'}</span>
            </span>
          </button>
        </div>
      </div>

      {!s.destinations.length && (
        <div className="sb-empty">
          <h3>Where should your photos go?</h3>
          <p className="muted small">Back up to Google Drive or Dropbox, copy to a NAS or another drive, or send just your picks to share. You can add more than one.</p>
          <button className="btn primary" onClick={() => setSheet({})}><Icon name="plus" /> Add a destination</button>
        </div>
      )}

      <div className="cards">
        {s.destinations.map((d) => {
          const k = kindOf(d, accounts)
          const ds = live.get(d.id)
          const h = healthOf(ds, d.enabled)
          const acct = k.account ? info[k.account.name] : undefined
          const quota = acct?.quota
          const filter = FILTERS.find((f) => f.id === d.filter)!
          const pct = ds && ds.total ? Math.round((ds.done / ds.total) * 100) : h === 'ok' ? 100 : 0
          const crumbs = k.account ? [KIND_LABEL[k.kind], ...k.path.split('/').filter(Boolean)] : [k.path]
          return (
            <article key={d.id} id={`dest-${d.id}`} className={`dcard h-${h}`}>
              <header>
                <span className="node-icon big"><Icon name={KIND_ICON[k.kind]} /></span>
                <div className="dcard-title">
                  <strong>{d.name}</strong>
                  <span className="muted small">
                    {k.account ? acct?.email ?? `${KIND_LABEL[k.kind]} account` : k.kind === 'folder' ? 'Folder on this PC or your network' : 'Custom rclone remote'}
                  </span>
                </div>
                <span className={`hpill h-${h}`}>{HEALTH_TEXT[h]}</span>
              </header>

              <div className="mono small crumbline" title={d.target}>{crumbs.join(' › ')}</div>
              <div className="chips">
                <span className="chip-s"><Icon name={filter.icon} size={12} /> {filter.title}</span>
                {k.account?.provider === 'drive' && <span className="chip-s"><Icon name="shield" size={12} /> {k.account.fullAccess ? 'All folders' : 'Safe mode'}</span>}
              </div>

              {(h === 'expired' || h === 'failed' || h === 'offline') && (
                <div className="dcard-error small">
                  <Icon name="alert" size={14} />
                  <span>
                    {h === 'expired'
                      ? `ShotDrop's access to ${KIND_LABEL[k.kind]} expired or was revoked. Uploads are on hold until you sign in again; nothing is lost.`
                      : ds?.lastError
                        ? friendlyError(ds.lastError, k.account ? KIND_LABEL[k.kind] : d.name, k.kind === 'custom' ? null : d.target.split(':')[0])
                        : 'Some uploads failed.'}
                    {ds?.lastError && (
                      <details className="err-raw">
                        <summary>Details</summary>
                        <code>{ds.lastError}</code>
                      </details>
                    )}
                  </span>
                </div>
              )}

              <div className="bar" aria-label={`${pct}% sent`}><i style={{ width: `${pct}%` }} /></div>
              <div className="row between small">
                <span>
                  {ds && ds.total ? (
                    <><strong>{ds.done}</strong> of {ds.total} files</>
                  ) : (
                    <span className="muted">Nothing to send yet</span>
                  )}
                  {h === 'ok' && ds?.lastDoneAt && <span className="muted"> · last upload {ago(ds.lastDoneAt)}</span>}
                </span>
                {h === 'syncing' && ds && ds.bps > 0 && <span className="mono">{fmtSize(ds.bps)}/s</span>}
              </div>

              {quota?.total != null && quota.used != null && (
                <>
                  <div className="bar quota"><i style={{ width: `${Math.min(100, Math.round((quota.used / quota.total) * 100))}%` }} /></div>
                  <div className="row between small">
                    <span className="muted">{fmtSize(quota.used)} of {fmtSize(quota.total)} used</span>
                    {quota.free != null && <strong>{fmtSize(quota.free)} free</strong>}
                  </div>
                </>
              )}

              <footer>
                {relinking === d.id ? (
                  <>
                    <span className="small"><span className="spinner" aria-hidden /> Finish signing in in your browser…</span>
                    <button className="btn" onClick={() => void api.cloudCancel().catch(() => undefined)}>Cancel</button>
                  </>
                ) : (
                  <>
                    {h === 'expired' ? (
                      <button className="btn primary" onClick={() => void reconnect(d)} disabled={!!relinking}>Reconnect</button>
                    ) : h === 'failed' ? (
                      <button className="btn primary" onClick={() => void run(() => api.retrySync(), 'Retrying failed uploads')}>Retry</button>
                    ) : (
                      <button className="btn" onClick={() => void run(() => api.patchDestination(d.id, { enabled: !d.enabled }), d.enabled ? `${d.name} paused` : `${d.name} resumed`)}>
                        <Icon name={d.enabled ? 'pause' : 'play'} /> {d.enabled ? 'Pause' : 'Resume'}
                      </button>
                    )}
                    <button className="btn ghost" onClick={() => void run(async () => toast(`Queued ${(await api.resync(d.id)).queued} files for ${d.name}`))}>
                      <Icon name="refresh" /> Resync
                    </button>
                    <button className="btn ghost" onClick={() => setSheet({ editing: d })}><Icon name="folder" /> Change folder</button>
                    <button className="btn ghost danger" onClick={() => void remove(d)}>{k.account ? 'Disconnect' : 'Remove'}</button>
                  </>
                )}
              </footer>
            </article>
          )
        })}
      </div>

      {sheet && (
        <AddDestinationSheet
          status={status}
          editing={sheet.editing}
          toast={toast}
          onClose={() => setSheet(null)}
          onDone={(m) => {
            setSheet(null)
            toast(m)
            loadAccounts()
            reload()
          }}
        />
      )}
    </div>
  )
}
