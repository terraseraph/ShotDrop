import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CloudAccount, CloudFolder, CloudProvider, CloudQuota, CloudState, Destination, DestinationFilter, LibraryCounts, Status } from '@shared/types'
import { api, desktop } from '../api'
import { fmtSize } from '../format'
import { Icon } from './Icon'
import './SyncBoard.css'

export type Kind = CloudProvider | 'folder' | 'custom'

export const KIND_LABEL: Record<Kind, string> = { drive: 'Google Drive', dropbox: 'Dropbox', folder: 'Folder / NAS', custom: 'Custom' }
export const KIND_ICON: Record<Kind, string> = { drive: 'drive', dropbox: 'dropbox', folder: 'server', custom: 'terminal' }

export const FILTERS: { id: DestinationFilter; label: string; icon: string; title: string; body: string }[] = [
  { id: 'all', label: 'Everything', icon: 'layers', title: 'Everything', body: 'Every photo, JPEG and RAW, as it arrives. A full backup.' },
  { id: 'jpeg', label: 'JPEGs', icon: 'image', title: 'JPEGs only', body: "Just the camera's JPEG (or HEIF) files. Small and quick to share; RAWs stay on this PC." },
  { id: 'raw', label: 'RAW', icon: 'raw', title: 'RAW only', body: 'Only the RAW files, for editing elsewhere or an archive. JPEGs stay on this PC.' },
  { id: 'picks', label: 'Picks', icon: 'star', title: 'Picks only', body: 'Only shots you mark as a pick (P), sent the moment you pick them. Good for client previews.' }
]
export const FILTER_WORD: Record<DestinationFilter, string> = { all: 'everything', jpeg: 'JPEGs', raw: 'RAW files', picks: 'picks' }

/** Which kind of destination a saved target is, and for cloud ones which linked account it uses. */
export function kindOf(d: Pick<Destination, 'type' | 'target'>, accounts: CloudAccount[]): { kind: Kind; account: CloudAccount | null; path: string } {
  if (d.type === 'folder') return { kind: 'folder', account: null, path: d.target }
  const i = d.target.indexOf(':')
  const account = accounts.find((a) => a.name === d.target.slice(0, i)) ?? null
  return account ? { kind: account.provider, account, path: d.target.slice(i + 1) } : { kind: 'custom', account: null, path: d.target }
}

interface Props {
  status: Status | null
  /** Change folder of an existing destination instead of adding one. */
  editing?: Destination
  onClose: () => void
  onDone: (message: string) => void
  toast: (t: string, tone?: 'info' | 'error') => void
}

/** "Add destination" as one sheet: where (provider + account), which folder, and what to send, all visible at once. */
export function AddDestinationSheet({ status, editing, onClose, onDone, toast }: Props) {
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null)
  const [info, setInfo] = useState<Record<string, { email: string | null; quota: CloudQuota | null }>>({})
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [kind, setKind] = useState<Kind>('drive')
  const [account, setAccount] = useState<CloudAccount | null>(null)
  const [fullAccess, setFullAccess] = useState(false)
  const [own, setOwn] = useState({ clientId: '', clientSecret: '' })
  const [linking, setLinking] = useState<CloudState['linking']>(null)
  const [path, setPath] = useState<string[] | null>(null) // cloud folder, null = not chosen
  const [browsing, setBrowsing] = useState(false)
  const [local, setLocal] = useState('') // folder / NAS path, or custom rclone target
  const [filter, setFilter] = useState<DestinationFilter>('all')
  const [busy, setBusy] = useState(false)
  const cloud = kind === 'drive' || kind === 'dropbox'

  const loadAccounts = useCallback(async (): Promise<CloudAccount[]> => {
    try {
      const r = await api.cloudAccounts()
      setAccounts(r.accounts)
      return r.accounts
    } catch (e) {
      toast((e as Error).message, 'error')
      setAccounts([])
      return []
    }
  }, [toast])

  useEffect(() => {
    void loadAccounts().then((list) => {
      if (!editing) return
      const k = kindOf(editing, list)
      setKind(k.kind)
      setAccount(k.account)
      setFilter(editing.filter)
      if (k.account) {
        setPath(k.path ? k.path.split('/').filter(Boolean) : [])
        setBrowsing(true)
      } else setLocal(k.path)
    })
    api.libraryCounts().then(setCounts, () => undefined)
  }, [loadAccounts, editing])

  // Email + free space per account (from the provider, so fetched once each).
  useEffect(() => {
    for (const a of accounts ?? []) {
      if (!info[a.name]) void api.cloudInfo(a.name).then((i) => setInfo((cur) => ({ ...cur, [a.name]: i })), () => undefined)
    }
  }, [accounts, info])

  // Pick the provider's account automatically when there is exactly one.
  useEffect(() => {
    if (editing || !accounts || !cloud) return
    const mine = accounts.filter((a) => a.provider === kind)
    setAccount((cur) => (cur && cur.provider === kind ? cur : mine.length === 1 ? mine[0] : null))
  }, [accounts, kind, cloud, editing])

  // While the browser sign-in is open, poll so the fallback sign-in link appears if no browser opened.
  useEffect(() => {
    if (!linking) return
    const t = setInterval(() => void api.cloudAccounts().then((r) => r.linking && setLinking(r.linking), () => undefined), 1500)
    return () => clearInterval(t)
  }, [linking])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !linking) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, linking])

  const switchKind = (k: Kind): void => {
    if (editing || linking) return
    setKind(k)
    setPath(null)
    setBrowsing(false)
    setLocal('')
  }

  const connect = async (provider: CloudProvider, wantFull: boolean): Promise<void> => {
    setLinking({ provider, startedAt: Date.now() })
    try {
      const ownClient = own.clientId.trim() && own.clientSecret.trim() ? { clientId: own.clientId.trim(), clientSecret: own.clientSecret.trim() } : {}
      const a = await api.cloudLink(provider, { fullAccess: provider === 'drive' && wantFull, ...ownClient })
      await loadAccounts()
      setAccount(a)
      setPath([])
      setBrowsing(true)
    } catch (e) {
      const m = (e as Error).message
      if (m !== 'Cancelled') toast(`Sign-in didn't finish: ${m}`, 'error')
    } finally {
      setLinking(null)
    }
  }

  const mine = (accounts ?? []).filter((a) => a.provider === kind)
  const folderLabel = cloud ? (path ? [KIND_LABEL[kind], ...path].join(' › ') : null) : local.trim() || null
  const target = cloud ? (account && path ? `${account.name}:${path.join('/')}` : '') : local.trim()
  const ready = !!target && !linking
  const where = cloud ? (path && path.length ? path.slice(-2).join(' › ') : KIND_LABEL[kind]) : local.trim().split(/[\\/]/).filter(Boolean).pop() ?? local.trim()

  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    try {
      if (editing) {
        await api.patchDestination(editing.id, { target })
        await api.resync(editing.id)
        onDone(`${editing.name} now syncs into ${folderLabel}`)
      } else {
        const type = kind === 'folder' ? 'folder' : 'rclone'
        const name = cloud ? `${KIND_LABEL[kind]}${path?.length ? ` · ${path[path.length - 1]}` : ''}` : kind === 'folder' ? (where || 'Folder') : 'Custom remote'
        await api.addDestination({ name, type, target, filter, enabled: true })
        onDone(`Added ${name}. Existing photos are queued.`)
      }
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const step1Done = cloud ? !!account : true
  const step2Done = !!target

  return (
    <div className="sheet-scrim" onClick={() => !linking && onClose()}>
      <div className="dsheet" role="dialog" aria-label={editing ? 'Change folder' : 'Add destination'} onClick={(e) => e.stopPropagation()}>
        <header className="dsheet-head">
          <h2>{editing ? `Change folder · ${editing.name}` : 'Add destination'}</h2>
          <button className="icon-btn" onClick={onClose} disabled={!!linking} aria-label="Close"><Icon name="close" /></button>
        </header>

        <div className="dsheet-body">
          {!editing && (
            <div className="kind-tabs" role="tablist" aria-label="Where to send photos">
              {(['drive', 'dropbox', 'folder', 'custom'] as Kind[]).map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => switchKind(k)} disabled={!!linking && kind !== k}>
                  <Icon name={KIND_ICON[k]} /> {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}

          {cloud && (
            <section className="dstep">
              <StepHead n={1} done={step1Done} label="Account" />
              {linking ? (
                <div className="waiting">
                  <span className="spinner" aria-hidden />
                  <div>
                    <strong>Finish signing in in your browser…</strong>
                    <p className="muted small">
                      A {KIND_LABEL[linking.provider]} page opened. Approve ShotDrop there, then come back here.
                      {linking.authUrl && (
                        <> Didn't open? <a className="link" href={linking.authUrl} target="_blank" rel="noreferrer">Open the sign-in page</a>.</>
                      )}
                    </p>
                  </div>
                  <button className="btn" onClick={() => void api.cloudCancel().catch(() => undefined)}>Cancel</button>
                </div>
              ) : (
                <>
                  {mine.map((a) => (
                    <button key={a.name} className={`acct ${account?.name === a.name ? 'on' : ''}`} onClick={() => !editing && setAccount(a)} disabled={!!editing && account?.name !== a.name}>
                      <span className="acct-icon"><Icon name={KIND_ICON[kind]} /></span>
                      <span className="acct-main">
                        <strong>{info[a.name]?.email ?? KIND_LABEL[a.provider]}</strong>
                        <span className="muted small">
                          {info[a.name]?.quota?.free != null ? `${fmtSize(info[a.name]!.quota!.free!)} free · ` : ''}
                          {a.provider === 'drive' ? (a.fullAccess ? 'all folders' : 'safe mode') : 'Dropbox account'}
                        </span>
                      </span>
                      {account?.name === a.name && <span className="pill-ok">Connected</span>}
                    </button>
                  ))}
                  {!editing && (
                    <div className="connect">
                      {kind === 'drive' && (
                        <div className="access-q" role="radiogroup" aria-label="What ShotDrop can see in your Drive">
                          <span className="small muted">What can ShotDrop see in your Drive?</span>
                          <label className={!fullAccess ? 'on' : ''}>
                            <input type="radio" checked={!fullAccess} onChange={() => setFullAccess(false)} />
                            <span><strong>Only folders ShotDrop makes</strong> <span className="muted small">Recommended. Your other files stay private.</span></span>
                          </label>
                          <label className={fullAccess ? 'on' : ''}>
                            <input type="radio" checked={fullAccess} onChange={() => setFullAccess(true)} />
                            <span><strong>All my folders</strong> <span className="muted small">Pick a folder you already made.</span></span>
                          </label>
                        </div>
                      )}
                      <button className={`btn ${mine.length ? '' : 'primary'}`} onClick={() => void connect(kind as CloudProvider, fullAccess)} disabled={accounts === null}>
                        <Icon name={KIND_ICON[kind]} /> {mine.length ? `Connect another ${KIND_LABEL[kind]} account` : `Sign in to ${KIND_LABEL[kind]}`}
                      </button>
                      <details className="own-client small">
                        <summary className="muted">Sign-in failing or rate limited? Use your own app credentials</summary>
                        <p className="muted small">
                          {kind === 'drive' ? "Google is retiring rclone's shared Drive sign-in during 2026. " : ''}Create your own client ID (steps in
                          docs/cloud-linking.md) and paste it here before signing in.
                        </p>
                        <div className="row tight">
                          <input className="input mono" placeholder="Client ID" value={own.clientId} onChange={(e) => setOwn({ ...own, clientId: e.target.value })} />
                          <input className="input mono" placeholder="Client secret" type="password" value={own.clientSecret} onChange={(e) => setOwn({ ...own, clientSecret: e.target.value })} />
                        </div>
                      </details>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <section className={`dstep ${cloud && !account ? 'locked' : ''}`}>
            <StepHead n={cloud ? 2 : 1} done={step2Done} label="Folder" />
            {cloud ? (
              account ? (
                browsing ? (
                  <FolderBrowser
                    account={account}
                    start={path ?? []}
                    toast={toast}
                    onUse={(p) => {
                      setPath(p)
                      setBrowsing(false)
                    }}
                    onFullAccess={account.provider === 'drive' && !account.fullAccess && !editing ? () => void connect('drive', true) : undefined}
                  />
                ) : (
                  <button className="folder-pick" onClick={() => setBrowsing(true)}>
                    <Icon name="folder" /> <span>{folderLabel ?? 'Choose a folder'}</span> <span className="muted small">{folderLabel ? 'Change' : ''}</span>
                  </button>
                )
              ) : (
                <p className="muted small">Sign in first, then pick or create the folder photos go into.</p>
              )
            ) : (
              <div className="row tight">
                <input
                  className="input mono"
                  value={local}
                  placeholder={kind === 'folder' ? 'e.g. D:\\Backup or \\\\nas\\photos' : 'e.g. myremote:Photos/ShotDrop (from your own rclone.conf)'}
                  onChange={(e) => setLocal(e.target.value)}
                />
                {kind === 'folder' && desktop && (
                  <button className="btn" onClick={async () => {
                    const p = await desktop!.pickFolder()
                    if (p) setLocal(p)
                  }}>
                    <Icon name="folder" /> Browse
                  </button>
                )}
              </div>
            )}
            {kind === 'custom' && <p className="muted small">For any rclone remote you've set up yourself with <code>rclone config</code> (S3, B2, SFTP, OneDrive…).</p>}
            {kind !== 'folder' && status && !status.sync.rcloneAvailable && (
              <p className="warn-box small">rclone wasn't found, so cloud uploads can't run. The portable build includes it; in a dev checkout run <code>npm run fetch-binaries</code>.</p>
            )}
          </section>

          {!editing && (
            <section className={`dstep ${!step2Done ? 'dim' : ''}`}>
              <StepHead n={cloud ? 3 : 2} done={false} label="What to send" />
              <div className="filter-grid" role="radiogroup" aria-label="What to send">
                {FILTERS.map((f) => (
                  <button key={f.id} role="radio" aria-checked={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                    <Icon name={f.icon} />
                    <span>{f.label}</span>
                  </button>
                ))}
              </div>
              <FilterExplain filter={filter} counts={counts} />
            </section>
          )}
        </div>

        <footer className="dsheet-foot">
          <span className="sentence">
            {ready ? (
              editing ? (
                <>Sync <strong>{editing.name}</strong> into <strong>{folderLabel}</strong></>
              ) : (
                <>Send <strong>{FILTER_WORD[filter]}</strong> to <strong>{where}</strong></>
              )
            ) : (
              <span className="muted">Fill in the steps above</span>
            )}
          </span>
          <button className="btn" onClick={onClose} disabled={!!linking}>Cancel</button>
          <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add destination'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function StepHead({ n, done, label }: { n: number; done: boolean; label: string }) {
  return (
    <div className="dstep-head">
      <span className={`dstep-n ${done ? 'done' : ''}`}>{done ? <Icon name="check" size={12} /> : n}</span>
      {label}
    </div>
  )
}

function FilterExplain({ filter, counts }: { filter: DestinationFilter; counts: LibraryCounts | null }) {
  const f = FILTERS.find((x) => x.id === filter)!
  const c = counts?.[filter]
  return (
    <div className="filter-explain">
      <Icon name={f.icon} />
      <div>
        <strong>{f.title}</strong>
        <p className="muted small">{f.body}</p>
        {c && (
          <div className="chips">
            <span className="chip-s">{c.files} {c.files === 1 ? 'file' : 'files'} now</span>
            <span className="chip-s">≈ {fmtSize(c.bytes)}</span>
            {filter === 'picks' && <span className="chip-s">grows as you pick</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function FolderBrowser({ account, start, toast, onUse, onFullAccess }: {
  account: CloudAccount
  start: string[]
  toast: (t: string, tone?: 'info' | 'error') => void
  onUse: (path: string[]) => void
  onFullAccess?: () => void
}) {
  const [path, setPath] = useState<string[]>(start)
  const [folders, setFolders] = useState<CloudFolder[] | null>(null)
  const [name, setName] = useState('')
  const joined = path.join('/')

  useEffect(() => {
    let live = true
    setFolders(null)
    api.cloudFolders(account.name, joined).then(
      (f) => live && setFolders(f),
      (e: Error) => {
        if (!live) return
        toast(e.message, 'error')
        setFolders([])
      }
    )
    return () => {
      live = false
    }
  }, [account.name, joined, toast])

  const create = async (): Promise<void> => {
    const n = name.trim().replace(/[\\/]+/g, '-')
    if (!n) return
    try {
      await api.cloudMkdir(account.name, [...path, n].join('/'))
      setName('')
      setPath([...path, n])
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const crumbs = useMemo(() => [KIND_LABEL[account.provider], ...path], [account.provider, path])

  return (
    <div className="fbrowser">
      {onFullAccess && (
        <p className="safe-note small">
          <Icon name="shield" size={14} />
          <span>
            Safe mode: ShotDrop only sees folders it created, so folders you made yourself won't show.{' '}
            <button className="link" onClick={onFullAccess}>Show all my folders</button> (one more sign-in).
          </span>
        </p>
      )}
      <nav className="crumbs small" aria-label="Folder path">
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && <span className="muted"> / </span>}
            {i === crumbs.length - 1 ? <strong>{c}</strong> : <button className="link" onClick={() => setPath(path.slice(0, i))}>{c}</button>}
          </span>
        ))}
      </nav>
      <div className="flist">
        {folders === null && <span className="muted small pad">Loading…</span>}
        {folders?.length === 0 && <span className="muted small pad">{path.length ? 'No folders inside this one.' : 'No folders yet. Create one below.'}</span>}
        {folders?.map((f) => (
          <button key={f.name} onClick={() => setPath([...path, f.name])}>
            <Icon name="folder" /> <span>{f.name}</span> <Icon name="next" size={14} />
          </button>
        ))}
      </div>
      <div className="row tight">
        <input className="input" placeholder="New folder, e.g. Harlow & Finn" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        <button className="btn" disabled={!name.trim()} onClick={() => void create()}><Icon name="plus" /> Create</button>
      </div>
      <div className="row between">
        <span className="muted small">Photos copy into the folder you end on{path.length ? '' : ' (the top level)'}.</span>
        <button className="btn primary" onClick={() => onUse(path)}>Use this folder</button>
      </div>
    </div>
  )
}
