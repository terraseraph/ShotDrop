import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import type { CloudAccount, CloudFolder, CloudProvider, CloudQuota, CloudState, Destination, DestinationFilter, LibraryCounts, Settings, Status } from '@shared/types'
import { api } from '../api'
import { fmtSize } from '../format'
import { fade, slideIn } from '../motion'
import { Icon } from './Icon'
import { FolderPicker } from './FolderPicker'
import { dropProps, join, lastPart, useChips } from './fsApi'
import './FolderPicker.css'
import './AddDestinationSheet.css'

export type Kind = CloudProvider | 'folder' | 'custom'

export const KIND_LABEL: Record<Kind, string> = { drive: 'Google Drive', dropbox: 'Dropbox', folder: 'Folder / NAS', custom: 'rclone remote' }
export const KIND_ICON: Record<Kind, string> = { drive: 'drive', dropbox: 'dropbox', folder: 'folder', custom: 'terminal' }
/** Tile and card tints from the boards: Drive green, Dropbox purple, folders blue, rclone grey. */
export const KIND_TINT: Record<Kind, { fg: string; bg: string }> = {
  drive: { fg: '#3dd68c', bg: '#1f2a1f' },
  dropbox: { fg: '#c9a0f0', bg: '#2a1f30' },
  folder: { fg: '#5ba7f7', bg: '#1b2330' },
  custom: { fg: '#a3a3a3', bg: '#242424' }
}

export const FILTERS: { id: DestinationFilter; label: string; icon: string; title: string; body: string }[] = [
  { id: 'all', label: 'Everything', icon: 'layers', title: 'Everything', body: 'Every photo, JPEG and RAW, as it arrives.' },
  { id: 'picks', label: 'Picks only', icon: 'star', title: 'Picks only', body: 'Only shots you pick' },
  { id: 'raw', label: 'RAW only', icon: 'raw', title: 'RAW only', body: 'Only the RAW files.' },
  { id: 'jpeg', label: 'JPEGs only', icon: 'image', title: 'JPEGs only', body: "Just the camera's JPEG or HEIF files." }
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
  /** For chips (known NAS shares, library drive). Optional: the sheet loads them itself when missing. */
  s?: Settings | null
  /** Change folder of an existing destination instead of adding one. */
  editing?: Destination
  /** Start on this provider (the Add menu's quick picks). */
  initialKind?: Kind
  onClose: () => void
  onDone: (message: string) => void
  toast: (t: string, tone?: 'info' | 'error') => void
}

const isField = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SUMMARY')

/** Add destination as one right-hand sheet. Everything is pre-filled, so "Add and start" works the moment it opens. */
/** Where a mirrored delete ends up, per destination kind. */
export const WHERE_DELETES_GO: Record<Kind, string> = {
  drive: "Goes to Drive's trash, restorable for 30 days.",
  dropbox: 'Dropbox keeps deleted files restorable for 30 days.',
  folder: 'Goes to the recycle bin. On a network share it is deleted outright.',
  custom: 'Deleted on the remote. Whether it can be restored depends on the service.'
}

export function AddDestinationSheet({ status, s: sIn, editing, initialKind, onClose, onDone, toast }: Props) {
  const [s, setS] = useState<Settings | null>(sIn ?? null)
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null)
  const [info, setInfo] = useState<Record<string, { email: string | null; quota: CloudQuota | null }>>({})
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [kind, setKind] = useState<Kind>(initialKind ?? 'folder')
  const [account, setAccount] = useState<CloudAccount | null>(null)
  const [fullAccess, setFullAccess] = useState(false)
  const [own, setOwn] = useState({ clientId: '', clientSecret: '' })
  const [linking, setLinking] = useState<CloudState['linking']>(null)
  const [path, setPath] = useState<string[]>(['ShotDrop']) // cloud folder
  const [browsing, setBrowsing] = useState(false)
  const [local, setLocal] = useState('') // folder / NAS path, or custom rclone target
  const [filter, setFilter] = useState<DestinationFilter>('all')
  const [mirror, setMirror] = useState(false)
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const cloud = kind === 'drive' || kind === 'dropbox'
  const chips = useChips(s, status)

  useEffect(() => {
    if (!sIn) void api.settings().then(setS, () => undefined)
  }, [sIn])

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
      setName(editing.name)
      setNameEdited(true)
      if (k.account) setPath(k.path.split('/').filter(Boolean))
      else setLocal(k.path)
    })
    api.libraryCounts().then(setCounts, () => undefined)
  }, [loadAccounts, editing])

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

  // A sensible folder is already chosen: another drive if there is one, else Documents.
  useEffect(() => {
    if (editing || local || kind !== 'folder' || !chips.ready) return
    const lib = (s?.libraryDir ?? status?.library.dir ?? '').slice(0, 2).toUpperCase()
    const other = chips.drives.find((d) => d.path.slice(0, 2).toUpperCase() !== lib)
    const docs = chips.places.find((p) => p.id === 'documents') ?? chips.places[0]
    if (other) setLocal(join(other.path, 'ShotDrop'))
    else if (docs) setLocal(join(docs.path, 'ShotDrop backup'))
  }, [editing, local, kind, chips, s, status])

  // While the browser sign-in is open, poll so the fallback sign-in link appears if no browser opened.
  useEffect(() => {
    if (!linking) return
    const t = setInterval(() => void api.cloudAccounts().then((r) => r.linking && setLinking(r.linking), () => undefined), 1500)
    return () => clearInterval(t)
  }, [linking])

  const connect = async (provider: CloudProvider, wantFull: boolean): Promise<void> => {
    setLinking({ provider, startedAt: Date.now() })
    try {
      const ownClient = own.clientId.trim() && own.clientSecret.trim() ? { clientId: own.clientId.trim(), clientSecret: own.clientSecret.trim() } : {}
      const a = await api.cloudLink(provider, { fullAccess: provider === 'drive' && wantFull, ...ownClient })
      await loadAccounts()
      setAccount(a)
      setBrowsing(true) // Create folder is first thing they see
    } catch (e) {
      const m = (e as Error).message
      if (m !== 'Cancelled') toast(`Sign-in didn't finish: ${m}`, 'error')
    } finally {
      setLinking(null)
    }
  }

  const mine = (accounts ?? []).filter((a) => a.provider === kind)
  const target = cloud ? (account ? `${account.name}:${path.join('/')}` : '') : local.trim()
  const autoName = useMemo(() => {
    if (cloud) return `${KIND_LABEL[kind]}${path.length ? ` · ${path[path.length - 1]}` : ''}`
    if (kind === 'custom') return 'Custom remote'
    const m = /^([A-Za-z]:)\\[^\\]*$/.exec(local)
    const d = m && chips.drives.find((x) => x.path.toUpperCase().startsWith(m[1].toUpperCase()))
    return d && d.label && d.label !== d.path.slice(0, 2) ? `${d.label} (${m![1].toUpperCase()})` : local ? lastPart(local) : 'Folder'
  }, [cloud, kind, path, local, chips.drives])
  const finalName = (nameEdited ? name : autoName).trim() || autoName
  const needsSignIn = cloud && !account
  const ready = !linking && (needsSignIn || !!target)

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    if (needsSignIn) return void connect(kind as CloudProvider, fullAccess)
    setBusy(true)
    try {
      if (editing) {
        await api.patchDestination(editing.id, { target, name: finalName })
        await api.resync(editing.id)
        onDone(`${finalName} now syncs into ${cloud ? [KIND_LABEL[kind], ...path].join(' › ') : target}`)
      } else {
        await api.addDestination({ name: finalName, type: kind === 'folder' ? 'folder' : 'rclone', target, filter, enabled: true, mirrorDeletes: mirror })
        onDone(`Added ${finalName}. Today's shoot is copying now.`)
      }
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !linking) onClose()
      else if (e.key === 'Enter' && !isField(e.target) && !e.shiftKey) {
        e.preventDefault()
        void submit()
      } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.dataset.submit) {
        e.preventDefault()
        void submit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pick = (k: Kind): void => {
    if (editing || linking) return
    setKind(k)
    setBrowsing(false)
    if (k === 'custom') setLocal('')
  }
  const dayHint = <>A folder per shoot day is made for you. Drop any folder from Explorer onto this sheet to use it.</>

  return (
    <>
      <motion.div className="ad-scrim scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} onClick={() => !linking && onClose()} />
      <motion.aside className="ad-sheet sheet" role="dialog" aria-label={editing ? 'Change folder' : 'Add destination'} {...slideIn} {...dropProps((p) => !cloud && kind !== 'custom' && setLocal(p))}>
        <header className="ad-head">
          <h2>{editing ? `Change folder · ${editing.name}` : 'Add destination'}</h2>
          <button className="tb ad-cancel" onClick={onClose} disabled={!!linking}>Cancel <span className="key">Esc</span></button>
        </header>

        <div className="ad-body">
          {!editing && (
            <div className="ad-types" role="tablist" aria-label="Where to send photos">
              {(['drive', 'dropbox', 'folder', 'custom'] as Kind[]).map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} className={`ad-type ${kind === k ? 'on' : ''}`} onClick={() => pick(k)} disabled={!!linking && kind !== k}>
                  <span className="ad-type-i" style={kind === k && k === 'folder' ? { color: 'var(--accent)', background: 'var(--warn-dim)' } : { color: KIND_TINT[k].fg }}><Icon name={KIND_ICON[k]} size={18} /></span>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}

          <section className="ad-sec">
            <div className="lbl">WHERE</div>
            {cloud ? (
              linking ? (
                <div className="ad-wait">
                  <span className="ad-spin" aria-hidden />
                  <div>
                    <strong>Finish signing in in your browser…</strong>
                    <p>
                      A {KIND_LABEL[linking.provider]} page opened. Approve ShotDrop there, then come back.
                      {linking.authUrl && <> Didn't open? <a href={linking.authUrl} target="_blank" rel="noreferrer">Open the sign-in page</a>.</>}
                    </p>
                  </div>
                  <button className="fp-btn" onClick={() => void api.cloudCancel().catch(() => undefined)}>Cancel</button>
                </div>
              ) : (
                <>
                  {mine.map((a) => (
                    <button key={a.name} className={`ad-acct ${account?.name === a.name ? 'on' : ''}`} onClick={() => !editing && setAccount(a)} disabled={!!editing && account?.name !== a.name}>
                      <span className="ad-acct-i" style={{ color: KIND_TINT[kind].fg, background: KIND_TINT[kind].bg }}><Icon name={KIND_ICON[kind]} /></span>
                      <span className="ad-acct-main">
                        <strong>{info[a.name]?.email ?? KIND_LABEL[a.provider]}</strong>
                        <span>{info[a.name]?.quota?.free != null ? `${fmtSize(info[a.name]!.quota!.free!)} free · ` : ''}{a.provider === 'drive' ? (a.fullAccess ? 'all folders' : 'safe mode') : 'Dropbox account'}</span>
                      </span>
                      {account?.name === a.name && <span className="pill ok">Connected</span>}
                    </button>
                  ))}
                  {account && (
                    browsing ? (
                      <FolderBrowser
                        account={account}
                        start={path}
                        toast={toast}
                        onUse={(p) => {
                          setPath(p)
                          setBrowsing(false)
                        }}
                        onFullAccess={account.provider === 'drive' && !account.fullAccess && !editing ? () => void connect('drive', true) : undefined}
                      />
                    ) : (
                      <div className="fp-path">
                        <Icon name="folder" />
                        <span className="mono fp-val">{[KIND_LABEL[kind], ...path].join(' › ')}<span className="fp-day"> › {'{shoot day}'}</span></span>
                        <button className="fp-btn primary" onClick={() => setBrowsing(true)}>Choose folder…</button>
                      </div>
                    )
                  )}
                  {!editing && (!account || !mine.length) && (
                    <div className="ad-connect">
                      {kind === 'drive' && (
                        <div className="ad-access" role="radiogroup" aria-label="What ShotDrop can see in your Drive">
                          <label className={!fullAccess ? 'on' : ''}><input type="radio" checked={!fullAccess} onChange={() => setFullAccess(false)} /><span><strong>Only folders ShotDrop makes</strong> Recommended. Your other files stay private.</span></label>
                          <label className={fullAccess ? 'on' : ''}><input type="radio" checked={fullAccess} onChange={() => setFullAccess(true)} /><span><strong>All my folders</strong> Pick a folder you already made.</span></label>
                        </div>
                      )}
                      <details className="ad-own">
                        <summary>Sign-in failing or rate limited? Use your own app credentials</summary>
                        <p>See docs/cloud-linking.md, then paste your client ID and secret before signing in.</p>
                        <div className="ad-own-row">
                          <input className="ad-input mono" placeholder="Client ID" value={own.clientId} onChange={(e) => setOwn({ ...own, clientId: e.target.value })} />
                          <input className="ad-input mono" placeholder="Client secret" type="password" value={own.clientSecret} onChange={(e) => setOwn({ ...own, clientSecret: e.target.value })} />
                        </div>
                      </details>
                    </div>
                  )}
                  {!editing && mine.length > 0 && <button className="fp-btn plain ad-another" onClick={() => void connect(kind as CloudProvider, fullAccess)}>Connect another {KIND_LABEL[kind]} account</button>}
                </>
              )
            ) : kind === 'folder' ? (
              <FolderPicker value={local} onChange={setLocal} s={s} status={status} dayFolder needBytes={counts?.[filter].bytes} hint={dayHint} />
            ) : (
              <>
                <div className="fp-path">
                  <Icon name="terminal" />
                  <input className="ad-input mono ad-bare" data-submit="1" value={local} placeholder="myremote:Photos/ShotDrop (from rclone config)" onChange={(e) => setLocal(e.target.value)} aria-label="rclone remote path" />
                </div>
                <div className="fp-hint">Any remote you set up with <code>rclone config</code>: S3, B2, SFTP, OneDrive…</div>
              </>
            )}
            {kind !== 'folder' && status && !status.sync.rcloneAvailable && <p className="ad-warn">rclone wasn't found, so cloud uploads can't run. The portable build includes it; in a dev checkout run <code>npm run fetch-binaries</code>.</p>}
          </section>

          {!editing && (
            <section className="ad-sec">
              <div className="lbl">WHAT GOES THERE</div>
              <div className="ad-opts" role="radiogroup" aria-label="What to send">
                {FILTERS.map((f) => {
                  const c = counts?.[f.id]
                  return (
                    <button key={f.id} role="radio" aria-checked={filter === f.id} className={`ad-opt ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
                      <span className="ad-radio" />
                      <span className="ad-opt-t">
                        <span className="ad-opt-n">{f.title}</span>
                        <span className="ad-opt-s">
                          {c ? `${c.files} files · ${fmtSize(c.bytes)}${f.id === 'picks' ? '' : ' right now'}` : '…'}
                          {f.id === 'picks' && <> · sent on <span className="key">P</span></>}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {!editing && (
            <section className="ad-sec">
              <div className="lbl">WHEN YOU DELETE A PHOTO</div>
              <div className="ad-opts" role="radiogroup" aria-label="When you delete a photo in ShotDrop">
                {[
                  { on: false, title: 'Keep the copy here', sub: 'This destination stays a backup of everything it was sent.' },
                  { on: true, title: 'Delete it here too', sub: WHERE_DELETES_GO[kind] }
                ].map((o) => (
                  <button key={String(o.on)} role="radio" aria-checked={mirror === o.on} className={`ad-opt ${mirror === o.on ? 'on' : ''}`} onClick={() => setMirror(o.on)}>
                    <span className="ad-radio" />
                    <span className="ad-opt-t">
                      <span className="ad-opt-n">{o.title}</span>
                      <span className="ad-opt-s">{o.sub}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="fp-hint">One way only: deleting something there never touches this computer.</div>
            </section>
          )}

          <section className="ad-sec">
            <div className="lbl">NAME</div>
            <div className="ad-name">
              <label htmlFor="dname">{nameEdited ? 'Yours' : 'Auto'}</label>
              <input id="dname" data-submit="1" value={nameEdited ? name : autoName} onChange={(e) => { setName(e.target.value); setNameEdited(true) }} />
            </div>
          </section>

          {cloud && account && (
            <div className="fp-check ok" role="status"><Icon name="check" size={14} />Signed in{info[account.name]?.quota?.free != null ? ` · ${fmtSize(info[account.name]!.quota!.free!)} free` : ''}{counts ? ` · today's ${fmtSize(counts[filter].bytes)} fits` : ''}</div>
          )}
        </div>

        <footer className="ad-foot">
          <span>{editing ? 'Copies everything again into the new folder.' : "Starts copying today's shoot right away."}</span>
          <button className="tb primary ad-go" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : needsSignIn ? `Sign in to ${KIND_LABEL[kind]}` : editing ? 'Save' : 'Add and start'} <span className="key accent">⏎</span>
          </button>
        </footer>
      </motion.aside>
    </>
  )
}

/** Cloud folder browser: Create folder comes first (Drive's safe mode can only see folders ShotDrop made). */
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
      () => live && setFolders([]) // a folder that doesn't exist yet is fine: it's made on first upload
    )
    return () => {
      live = false
    }
  }, [account.name, joined])

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
  const crumbs = [account.provider === 'drive' ? 'Google Drive' : 'Dropbox', ...path]

  return (
    <div className="ad-fb">
      <div className="ad-fb-new">
        <input className="ad-input" placeholder="New folder, e.g. Harlow & Finn" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void create() } }} />
        <button className="fp-btn" disabled={!name.trim()} onClick={() => void create()}>+ Create folder</button>
      </div>
      {onFullAccess && (
        <p className="ad-note"><Icon name="shield" size={14} /><span>Safe mode: ShotDrop only sees folders it made. <button className="ad-link" onClick={onFullAccess}>Show all my folders</button> (one more sign-in).</span></p>
      )}
      <nav className="ad-crumbs" aria-label="Folder path">
        {crumbs.map((c, i) => (
          <span key={i}>{i > 0 && ' / '}{i === crumbs.length - 1 ? <strong>{c}</strong> : <button className="ad-link" onClick={() => setPath(path.slice(0, i))}>{c}</button>}</span>
        ))}
      </nav>
      <div className="ad-flist">
        {folders === null && <span className="ad-empty">Loading…</span>}
        {folders?.length === 0 && <span className="ad-empty">{path.length ? 'No folders inside this one.' : 'No folders yet. Create one above.'}</span>}
        {folders?.map((f) => (
          <button key={f.name} onClick={() => setPath([...path, f.name])}><Icon name="folder" /><span>{f.name}</span><Icon name="next" size={14} /></button>
        ))}
      </div>
      <div className="ad-fb-foot">
        <span>Photos copy into {path.length ? 'this folder' : 'the top level'}, one folder per shoot day.</span>
        <button className="fp-btn primary" onClick={() => onUse(path)}>Use this folder</button>
      </div>
    </div>
  )
}
