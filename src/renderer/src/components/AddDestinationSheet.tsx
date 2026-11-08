import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { CloudAccount, CloudFolder, CloudProvider, CloudQuota, CloudState, Destination, DestinationFilter, LibraryCounts, Settings, Status } from '@shared/types'
import type { LibraryMeta } from '@shared/remote'
import { api } from '../api'
import { fmtSize } from '../format'
import { fade, slideIn } from '../motion'
import { Icon } from './Icon'
import { FolderPicker } from './FolderPicker'
import { RemoteForm, ServiceBadge, ServicePicker } from './RemoteSetup'
import { serviceById, type ExternalRemote, type RemoteAccount, type ServiceId } from '@shared/services'
import './RemoteSetup.css'
import { dropProps, join, lastPart, useChips } from './fsApi'
import './FolderPicker.css'
import './AddDestinationSheet.css'

/** `remote` = a guided service (S3 family, SFTP, FTP, WebDAV) or a remote from the user's own rclone config; `custom` = typed remote:path. */
export type Kind = CloudProvider | 'folder' | 'remote' | 'custom'

export const KIND_LABEL: Record<Kind, string> = { drive: 'Google Drive', dropbox: 'Dropbox', folder: 'Folder / NAS', remote: 'More…', custom: 'rclone remote' }
export const KIND_ICON: Record<Kind, string> = { drive: 'drive', dropbox: 'dropbox', folder: 'folder', remote: 'server', custom: 'terminal' }
/** Tile and card tints from the boards: Drive green, Dropbox purple, folders blue, rclone grey. */
export const KIND_TINT: Record<Kind, { fg: string; bg: string }> = {
  drive: { fg: '#3dd68c', bg: '#1f2a1f' },
  dropbox: { fg: '#c9a0f0', bg: '#2a1f30' },
  folder: { fg: '#5ba7f7', bg: '#1b2330' },
  remote: { fg: '#f2b134', bg: '#2b2515' },
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
export function kindOf(d: Pick<Destination, 'type' | 'target'>, accounts: CloudAccount[], remotes: RemoteAccount[] = []): { kind: Kind; account: CloudAccount | null; remote?: RemoteAccount; path: string } {
  if (d.type === 'folder') return { kind: 'folder', account: null, path: d.target }
  const i = d.target.indexOf(':')
  const account = accounts.find((a) => a.name === d.target.slice(0, i)) ?? null
  if (account) return { kind: account.provider, account, path: d.target.slice(i + 1) }
  const remote = remotes.find((r) => r.name === d.target.slice(0, i))
  return remote ? { kind: 'remote', account: null, remote, path: d.target.slice(i + 1) } : { kind: 'custom', account: null, path: d.target }
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
  remote: 'Deleted on the server. Whether it can be restored depends on the service.',
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
  const [other, setOther] = useState<LibraryMeta | null>(null) // another library already lives at the chosen target
  // More…: the guided service being filled in, the remote it produced (or an existing one from the user's rclone config).
  const [service, setService] = useState<ServiceId | null>(null)
  const [remote, setRemote] = useState<RemoteAccount | null>(null)
  const [ext, setExt] = useState<ExternalRemote | null>(null)
  const [formGo, setFormGo] = useState<{ fn: (() => void) | null; label: string }>({ fn: null, label: '' })
  const created = useRef<string | null>(null) // remote made in this sheet and not yet used: removed again on close
  const cloud = kind === 'drive' || kind === 'dropbox'
  const viaRemote = kind === 'remote' && !!(remote || ext)
  const chips = useChips(s, status)

  useEffect(() => {
    if (!sIn) void api.settings().then(setS, () => undefined)
  }, [sIn])

  const loadAccounts = useCallback(async (): Promise<{ accounts: CloudAccount[]; remotes: RemoteAccount[] }> => {
    try {
      const r = await api.cloudAccounts()
      setAccounts(r.accounts)
      return { accounts: r.accounts, remotes: r.remotes ?? [] }
    } catch (e) {
      toast((e as Error).message, 'error')
      setAccounts([])
      return { accounts: [], remotes: [] }
    }
  }, [toast])

  useEffect(() => {
    void loadAccounts().then((list) => {
      if (!editing) return
      const k = kindOf(editing, list.accounts, list.remotes)
      setKind(k.kind)
      setAccount(k.account)
      setFilter(editing.filter)
      setName(editing.name)
      setNameEdited(true)
      if (k.remote) {
        setRemote(k.remote)
        setService(k.remote.service)
      }
      if (k.account || k.remote) setPath(k.path.split('/').filter(Boolean))
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
  const remoteName = remote?.name ?? ext?.name
  const def = service ? serviceById(service) : undefined
  // Bucket-based services need at least a bucket: the top level of an S3 or B2 remote isn't writable.
  const needsBucket = !!remote && (def?.type === 's3' || def?.type === 'b2')
  const target = cloud ? (account ? `${account.name}:${path.join('/')}` : '') : kind === 'remote' ? (remoteName && !(needsBucket && !path.length) ? `${remoteName}:${path.join('/')}` : '') : local.trim()
  const autoName = useMemo(() => {
    if (cloud) return `${KIND_LABEL[kind]}${path.length ? ` · ${path[path.length - 1]}` : ''}`
    if (kind === 'remote') return `${def?.label ?? ext?.name ?? 'Remote'}${path.length ? ` · ${path[path.length - 1]}` : ''}`
    if (kind === 'custom') return 'Custom remote'
    const m = /^([A-Za-z]:)\\[^\\]*$/.exec(local)
    const d = m && chips.drives.find((x) => x.path.toUpperCase().startsWith(m[1].toUpperCase()))
    return d && d.label && d.label !== d.path.slice(0, 2) ? `${d.label} (${m![1].toUpperCase()})` : local ? lastPart(local) : 'Folder'
  }, [cloud, kind, path, local, chips.drives, def, ext])
  // Before saving: does the chosen target already hold a different library's library.json? A warning, never a block.
  useEffect(() => {
    setOther(null)
    if (editing || !target || ((cloud || kind === 'remote') && browsing) || (cloud && !account)) return
    let live = true
    const t = setTimeout(() => {
      api.probeDestination({ type: kind === 'folder' ? 'folder' : 'rclone', target }).then((r) => live && setOther(r.other ? r.library : null), () => undefined)
    }, 600)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [editing, target, kind, cloud, account, browsing])
  const finalName = (nameEdited ? name : autoName).trim() || autoName
  const needsSignIn = cloud && !account
  const inForm = kind === 'remote' && !!service && !remote
  const ready = !linking && (needsSignIn || (inForm ? !!formGo.fn : !!target && !(kind === 'remote' && browsing)))

  /** Forget a remote this sheet created but never saved a destination for. */
  const dropCreated = (): void => {
    if (created.current) void api.cloudDisconnect(created.current).catch(() => undefined)
    created.current = null
  }
  const close = (): void => {
    dropCreated()
    onClose()
  }
  /** Back to the service list (or to the form, from a connected remote): undoes any remote made here. */
  const backToServices = (): void => {
    dropCreated()
    setRemote(null)
    setExt(null)
    setService(null)
    setBrowsing(false)
  }

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    if (needsSignIn) return void connect(kind as CloudProvider, fullAccess)
    if (inForm) return formGo.fn?.()
    setBusy(true)
    try {
      const where = cloud ? [KIND_LABEL[kind], ...path].join(' › ') : kind === 'remote' ? [def?.label ?? ext?.name, ...path].join(' › ') : target
      if (editing) {
        await api.patchDestination(editing.id, { target, name: finalName })
        await api.resync(editing.id)
        onDone(`${finalName} now syncs into ${where}`)
      } else {
        await api.addDestination({ name: finalName, type: kind === 'folder' ? 'folder' : 'rclone', target, filter, enabled: true, mirrorDeletes: mirror })
        created.current = null // in use now: keep it
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
      if (e.key === 'Escape' && !linking) {
        // Esc steps back out of More… before it closes the sheet.
        if (kind === 'remote' && !editing && (service || ext)) backToServices()
        else close()
      }
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
    if (k !== 'custom') backToServices()
    setKind(k)
    setBrowsing(false)
    if (k === 'custom') setLocal('')
  }
  const onConnected = (a: RemoteAccount): void => {
    created.current = a.name
    setRemote(a)
    setPath([])
    setBrowsing(true)
  }
  const useExternal = (r: ExternalRemote): void => {
    setExt(r)
    setPath(['ShotDrop'])
    setBrowsing(true)
  }
  const dayHint = <>A folder per shoot day is made for you. Drop any folder from Explorer onto this sheet to use it.</>

  return (
    <>
      <motion.div className="ad-scrim scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} onClick={() => !linking && close()} />
      <motion.aside className="ad-sheet sheet" role="dialog" aria-label={editing ? 'Change folder' : 'Add destination'} {...slideIn} {...dropProps((p) => kind === 'folder' && setLocal(p))}>
        <header className="ad-head">
          <h2>{editing ? `Change folder · ${editing.name}` : 'Add destination'}</h2>
          <button className="tb ad-cancel" onClick={close} disabled={!!linking}>Cancel <span className="key">Esc</span></button>
        </header>

        <div className="ad-body">
          {!editing && (
            <div className="ad-types" role="tablist" aria-label="Where to send photos">
              {(['drive', 'dropbox', 'folder', 'remote'] as Kind[]).map((k) => {
                const on = kind === k || (k === 'remote' && kind === 'custom') // Advanced lives under More…
                return (
                  <button key={k} role="tab" aria-selected={on} className={`ad-type ${on ? 'on' : ''}`} onClick={() => pick(k)} disabled={!!linking && !on}>
                    <span className="ad-type-i" style={on && (k === 'folder' || k === 'remote') ? { color: 'var(--accent)', background: 'var(--warn-dim)' } : { color: KIND_TINT[k].fg }}><Icon name={KIND_ICON[k]} size={18} /></span>
                    {KIND_LABEL[k]}
                  </button>
                )
              })}
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
                        name={account.name}
                        rootLabel={KIND_LABEL[account.provider]}
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
            ) : kind === 'remote' ? (
              viaRemote ? (
                <>
                  <div className="ad-acct on">
                    {def && remote ? <ServiceBadge def={def} size={32} /> : <span className="ad-acct-i" style={{ color: '#a3a3a3', background: '#242424' }}><Icon name="terminal" /></span>}
                    <span className="ad-acct-main">
                      <strong>{def && remote ? def.label : ext?.name}</strong>
                      <span>{remote ? remote.where : `${ext?.type} · from your rclone config`}{remote?.unpinned ? " · server identity not checked (ssh-keyscan wasn't available)" : ''}</span>
                    </span>
                    <span className="pill ok">Connected</span>
                    {!editing && <button className="ad-link" onClick={backToServices}>Change</button>}
                  </div>
                  {browsing ? (
                    <FolderBrowser
                      name={remoteName!}
                      rootLabel={def && remote ? def.label : ext!.name}
                      external={!remote}
                      levelNoun={needsBucket ? 'bucket' : 'folder'}
                      start={path}
                      toast={toast}
                      onUse={(p) => {
                        setPath(p)
                        setBrowsing(false)
                      }}
                    />
                  ) : (
                    <div className="fp-path">
                      <Icon name="folder" />
                      <span className="mono fp-val">{[def && remote ? def.label : ext?.name, ...path].join(' › ')}<span className="fp-day"> › {'{shoot day}'}</span></span>
                      <button className="fp-btn primary" onClick={() => setBrowsing(true)}>Choose folder…</button>
                    </div>
                  )}
                </>
              ) : def ? (
                <RemoteForm key={def.id} def={def} onConnected={onConnected} onBack={backToServices} registerSubmit={(fn, label) => setFormGo((cur) => (cur.fn === fn && cur.label === label ? cur : { fn, label }))} />
              ) : (
                <ServicePicker onService={setService} onExternal={useExternal} onAdvanced={() => pick('custom')} />
              )
            ) : (
              <>
                <div className="fp-path">
                  <Icon name="terminal" />
                  <input className="ad-input mono ad-bare" data-submit="1" value={local} placeholder="myremote:Photos/ShotDrop (from rclone config)" onChange={(e) => setLocal(e.target.value)} aria-label="rclone remote path" />
                </div>
                <div className="fp-hint">Advanced: any remote from your own <code>rclone config</code>. {!editing && <button className="ad-link" onClick={() => pick('remote')}>Back to the service list</button>}</div>
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

          {other && (
            <div className="ad-warn" role="alert">
              <strong>Another library already syncs here.</strong> {other.name ? `“${other.name}”` : 'It'}{(() => { const w = [...other.writers].sort((a, b) => b.lastSync - a.lastSync)[0]; return w ? `, last written by ${w.host} on ${new Date(w.lastSync).toLocaleDateString()}` : '' })()}. You can still add it; photos from both libraries will mix in this folder.
            </div>
          )}

          {cloud && account && (
            <div className="fp-check ok" role="status"><Icon name="check" size={14} />Signed in{info[account.name]?.quota?.free != null ? ` · ${fmtSize(info[account.name]!.quota!.free!)} free` : ''}{counts ? ` · today's ${fmtSize(counts[filter].bytes)} fits` : ''}</div>
          )}
        </div>

        <footer className="ad-foot">
          <span>{editing ? 'Copies everything again into the new folder.' : "Starts copying today's shoot right away."}</span>
          <button className="tb primary ad-go" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : needsSignIn ? `Sign in to ${KIND_LABEL[kind]}` : inForm ? formGo.label || 'Test and connect' : kind === 'remote' && !viaRemote ? 'Choose a service' : editing ? 'Save' : 'Add and start'} <span className="key accent">⏎</span>
          </button>
        </footer>
      </motion.aside>
    </>
  )
}

/**
 * Folder browser for a linked account or remote: Create folder comes first (Drive's safe mode can only see folders ShotDrop
 * made). For S3 and B2 the top level is the bucket list, so a bucket has to be chosen before "Use this folder".
 */
function FolderBrowser({ name: remote, rootLabel, external, levelNoun = 'folder', start, toast, onUse, onFullAccess }: {
  name: string
  rootLabel: string
  /** In the user's own rclone config: list without ShotDrop's config, and new folders are made on first upload. */
  external?: boolean
  /** 'bucket' when the top level holds buckets. */
  levelNoun?: 'folder' | 'bucket'
  start: string[]
  toast: (t: string, tone?: 'info' | 'error') => void
  onUse: (path: string[]) => void
  onFullAccess?: () => void
}) {
  const [path, setPath] = useState<string[]>(start)
  const [folders, setFolders] = useState<CloudFolder[] | null>(null)
  const [name, setName] = useState('')
  const joined = path.join('/')
  const noun = levelNoun === 'bucket' && !path.length ? 'bucket' : 'folder'

  useEffect(() => {
    let live = true
    setFolders(null)
    ;(external ? api.cloudExternalFolders(remote, joined) : api.cloudFolders(remote, joined)).then(
      (f) => live && setFolders(f),
      () => live && setFolders([]) // a folder that doesn't exist yet is fine: it's made on first upload
    )
    return () => {
      live = false
    }
  }, [remote, joined, external])

  const create = async (): Promise<void> => {
    const n = name.trim().replace(/[\\/]+/g, '-')
    if (!n) return
    try {
      if (!external) await api.cloudMkdir(remote, [...path, n].join('/'))
      setName('')
      setPath([...path, n])
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const crumbs = [rootLabel, ...path]

  return (
    <div className="ad-fb">
      <div className="ad-fb-new">
        <input className="ad-input" placeholder={noun === 'bucket' ? 'New bucket, e.g. shotdrop-photos' : 'New folder, e.g. Harlow & Finn'} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void create() } }} />
        <button className="fp-btn" disabled={!name.trim()} onClick={() => void create()}>+ Create {noun}</button>
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
        {folders && folders.length <= 1 && onFullAccess && (
          <p className="ad-note"><Icon name="shield" size={14} /><span>Empty because of safe mode? ShotDrop can only see folders it created with this link. <button className="ad-link" onClick={onFullAccess}>Upgrade to all folders</button></span></p>
        )}
        {folders?.length === 0 && <span className="ad-empty">{path.length ? 'No folders inside this one.' : `No ${noun}s yet. Create one above.`}</span>}
        {folders?.map((f) => (
          <button key={f.name} onClick={() => setPath([...path, f.name])}><Icon name="folder" /><span>{f.name}</span><Icon name="next" size={14} /></button>
        ))}
      </div>
      <div className="ad-fb-foot">
        <span>{levelNoun === 'bucket' && !path.length ? 'Open a bucket first.' : `Photos copy into ${path.length ? 'this folder' : 'the top level'}, one folder per shoot day.`}</span>
        <button className="fp-btn primary" disabled={levelNoun === 'bucket' && !path.length} onClick={() => onUse(path)}>Use this folder</button>
      </div>
    </div>
  )
}
