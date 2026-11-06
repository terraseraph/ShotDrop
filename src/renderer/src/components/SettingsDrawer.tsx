import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { FtpUser, Settings, Status } from '@shared/types'
import { ftpLoginName } from '@shared/types'
import { api, desktop } from '../api'
import { fade, firm } from '../motion'
import { fmtSize } from '../format'
import { AddressPicker, CopyField } from './ConnectionCard'
import { FolderPicker } from './FolderPicker'
import { NetworkCheck } from './NetworkCheck'
import { PhoneLink } from './PhoneLink'
import { TabBar } from './TabBar'
import { type PrefKey, type Drive, dropProps, fetchPlaces, getPref, lastPart, setPref } from './fsApi'
import { lanUrl } from './ViewOnPhone'
import { Dialog } from './Dialog'
import './FolderPicker.css'
import './Phone.css'
import './Settings.css'

export type Tab = 'camera' | 'sync' | 'library' | 'remote'
type Toast = (t: string, tone?: 'info' | 'error') => void

interface Props {
  status: Status | null
  tab?: Tab
  onClose: () => void
  toast: Toast
  onSetup?: () => void
  /** Opens the Sync page (the "Sync" row in the left nav). */
  onOpenSync?: () => void
}

const SECTIONS = [
  { id: 'library', label: 'Library' },
  { id: 'cameras', label: 'Cameras' },
  { id: 'culling', label: 'Culling' },
  { id: 'remote', label: 'Phone and remote' },
  { id: 'sync', label: 'Sync' },
  { id: 'apps', label: 'Open in…' },
  { id: 'about', label: 'About' }
] as const
const TAB_SECTION: Record<Tab, string> = { camera: 'cameras', sync: 'sync', library: 'library', remote: 'remote' }

/** Settings that apply the moment they change: optimistic update, PATCH, roll back with a message on failure. */
function useLiveSettings(toast: Toast) {
  const [s, setS] = useState<Settings | null>(null)
  const load = useCallback(() => void api.settings().then(setS, (e: Error) => toast(e.message, 'error')), [toast])
  useEffect(load, [load])
  const apply = useCallback(
    async (patch: Partial<Settings>): Promise<void> => {
      setS((cur) => (cur ? { ...cur, ...patch } : cur))
      try {
        const { destinations: _d, ...rest } = patch
        setS(await api.patchSettings(rest))
      } catch (e) {
        const m = (e as Error).message
        toast(/only available|only pause/i.test(m) ? 'Change this on the PC.' : `Couldn't change that: ${m}`, 'error')
        load()
      }
    },
    [toast, load]
  )
  return { s, apply, load }
}

function Switch({ on, onChange, label, className = '' }: { on: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`sw ${on ? 'on' : ''} ${className}`} onClick={() => onChange(!on)}>
      <i />
    </button>
  )
}

const rememberedPin = (): string | null => {
  try {
    return localStorage.getItem('shotdrop.key')
  } catch {
    return null
  }
}
const newPin = (): string => String(Math.floor(1000 + Math.random() * 9000))
const addrOf = (status: Status | null): string => (status?.ftp.addresses[0] ? `${status.ftp.addresses[0]}:${status.ftp.port}` : '')

function usePref(k: PrefKey): [string, (v: string) => void] {
  const [v, setV] = useState(() => getPref(k))
  return [v, (n) => { setPref(k, n); setV(n) }]
}

// ================= desktop =================

/** Full Settings view under the top bar (Esc goes back). Kept under its old name so App keeps compiling. */
export function SettingsDrawer({ status, tab, onClose, toast, onSetup, onOpenSync }: Props) {
  const { s, apply } = useLiveSettings(toast)
  const [active, setActive] = useState('library')
  const main = useRef<HTMLElement>(null)
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([])
  const [removable, setRemovable] = useState<Drive[]>([])
  const [bursts, setBursts] = usePref('bursts')
  const [shift, setShift] = usePref('shiftAdvance')
  const [del, setDel] = usePref('deleteMode')
  const [open, setOpen] = useState<{ card?: number; rename?: number; address?: boolean; check?: boolean; qr?: boolean; adv?: boolean }>({})

  useEffect(() => { void desktop?.editors().then(setEditors).catch(() => undefined) }, [])
  useEffect(() => { void fetchPlaces().then((p) => setRemovable((p?.drives ?? []).filter((d) => d.kind === 'removable'))) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const go = useCallback((id: string): void => {
    if (id === 'sync' && onOpenSync) return onOpenSync()
    setActive(id)
    document.getElementById(`st-${id}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }, [onOpenSync])
  useEffect(() => { if (tab) go(TAB_SECTION[tab]) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = main.current
    if (!el || !s) return
    const io = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setActive(v.target.id.slice(3)) }, { root: el, rootMargin: '0px 0px -70% 0px' })
    el.querySelectorAll('section.sec').forEach((n) => io.observe(n))
    return () => io.disconnect()
  }, [s])

  const ftp = s?.ftp
  const setFtp = (p: Partial<Settings['ftp']>): void => void apply({ ftp: { ...s!.ftp, ...p } })
  const setUsers = (users: FtpUser[]): void => setFtp({ users })
  const lan = lanUrl(status)
  const t = status?.tunnel
  const tunnelOn = t?.status === 'running' || t?.status === 'starting' || t?.status === 'installing'
  const toggleTunnel = async (): Promise<void> => {
    try {
      if (tunnelOn) await api.tunnelStop()
      else {
        if (t && !t.installed) await api.tunnelInstall()
        await api.tunnelStart()
      }
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const watchAdd = (p: string): void => { if (s && !s.watchFolders.includes(p)) void apply({ watchFolders: [...s.watchFolders, p] }) }

  return (
    <Dialog title="Settings" onClose={onClose} wide>
    <div className="st-page">
      <nav className="st-nav" aria-label="Settings sections">
        {SECTIONS.map((x) => (
          <a key={x.id} href={`#st-${x.id}`} className={active === x.id ? 'on' : ''} onClick={(e) => { e.preventDefault(); go(x.id) }}>
            {x.label}
            {x.id === 'sync' && s && <span className="st-n">{s.destinations.length}</span>}
          </a>
        ))}
        <div className="st-foot">Changes apply instantly. Nothing to save.</div>
      </nav>

      <main className="st-main" ref={main} {...dropProps((p) => void apply({ libraryDir: p }))}>
        {!s || !ftp ? <p className="st-muted">Loading…</p> : (
          <>
            <Sec id="library" title="Library" i={0}>
              <Row label="Photos land in" stack>
                <FolderPicker value={s.libraryDir} onChange={(p) => void apply({ libraryDir: p })} s={s} status={status} dayFolder noCheck={false}
                  hint={`${status?.library.free != null ? `${fmtSize(status.library.free)} free. ` : ''}A folder per shoot day. Photos you copy into it yourself are picked up too. Drop a folder from Explorer anywhere on this page to use it.`}
                  extra={<>
                    {desktop && <button className="fp-btn plain" onClick={() => void desktop!.openPath(s.libraryDir)}>Show</button>}
                    <button className="fp-btn plain" title="Add photos that are in the library folder but not in the gallery" onClick={async () => {
                      try {
                        const { queued } = await api.rescanLibrary()
                        toast(queued ? `Adding ${queued} photo${queued === 1 ? '' : 's'} from the library folder.` : 'Everything in the library folder is already in the gallery.')
                      } catch (e) { toast((e as Error).message, 'error') }
                    }}>Rescan</button>
                  </>} />
              </Row>
              <Row label="Also watch" hint="Copied in, never moved. Card readers are offered here automatically when plugged in.">
                <div className="st-chips">
                  {s.watchFolders.map((f, i) => (
                    <span key={f} className="quick" title={f}>{f.length > 28 ? lastPart(f) : f}<button className="x" aria-label={`Stop watching ${f}`} onClick={() => void apply({ watchFolders: s.watchFolders.filter((_, j) => j !== i) })}>×</button></span>
                  ))}
                  {removable.filter((d) => !s.watchFolders.includes(d.path)).map((d) => (
                    <button key={d.path} className="quick on" onClick={() => watchAdd(d.path)}>+ Watch {d.path.slice(0, 2)} {d.label}</button>
                  ))}
                  {desktop && <button className="quick dashed" onClick={async () => { const p = await desktop!.pickFolder(); if (p) watchAdd(p) }}>+ Card reader or tether folder</button>}
                </div>
              </Row>
            </Sec>

            <Sec id="cameras" title="Cameras" i={1}>
              <div className="st-cams">
                {ftp.users.map((u, i) => {
                  const cam = status?.cameras.find((c) => c.username === ftpLoginName(u))
                  return (
                    <div key={i} className="st-cam-wrap">
                      <div className="st-cam">
                        <span className={`dot ${cam?.connected ? 'live' : ''}`} style={cam?.connected ? undefined : { background: 'var(--faintest)' }} />
                        <div className="st-cam-t">
                          {open.rename === i ? (
                            <input className="st-input" autoFocus defaultValue={u.label} aria-label="Camera name" onBlur={(e) => { setUsers(ftp.users.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))); setOpen({}) }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); setOpen({}) } }} />
                          ) : (
                            <div className="st-cam-n">{u.label || ftpLoginName(u)} <span className="st-muted">· {u.label ? 'named' : 'named automatically'}</span></div>
                          )}
                          <div className="mono st-cam-s">user {ftpLoginName(u)}{u.username && u.password ? ` · ${u.password}` : u.username ? ' · any password' : ' · no password'}</div>
                        </div>
                        <button className="tb" onClick={() => setOpen({ rename: i })}>Rename</button>
                        <button className="tb" onClick={() => setOpen({ card: open.card === i ? undefined : i })}>Show card</button>
                        {ftp.users.length > 1 && <button className="tb" aria-label="Remove login" onClick={() => setUsers(ftp.users.filter((_, j) => j !== i))}>×</button>}
                      </div>
                      <AnimatePresence>
                        {open.card === i && (
                          <motion.div className="st-card" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fade}>
                            <div className="st-card-in">
                              <CopyField label="Host" value={status?.ftp.addresses[0] ?? ''} />
                              <CopyField label="Port" value={String(ftp.port)} />
                              <CopyField label="User" value={ftpLoginName(u)} />
                              {u.username && u.password && <CopyField label="Password" value={u.password} />}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )
                })}
                <button className="st-cam dashed" onClick={() => setUsers([...ftp.users, { label: '', username: `camera${ftp.users.length + 1}`, password: Math.random().toString(36).slice(2, 10) }])}>+ Add a camera login</button>
              </div>
              <Row label="FTP server">
                <Switch on={ftp.enabled} onChange={(v) => setFtp({ enabled: v })} label={ftp.enabled ? 'FTP server on' : 'FTP server off'} />
                <span className="mono st-text2">{addrOf(status) || `port ${ftp.port}`}</span>
                <button className="tb" onClick={() => setOpen({ ...open, address: !open.address })}>Change address</button>
                <button className="tb" onClick={() => setOpen({ ...open, check: !open.check })}>Connection check</button>
                {onSetup && <button className="tb" onClick={onSetup}>Camera setup</button>}
              </Row>
              <AnimatePresence>
                {open.address && status && <Reveal key="a"><AddressPicker ftp={status.ftp} /></Reveal>}
                {open.check && <Reveal key="c"><NetworkCheck watch={`${status?.ftp.running}-${status?.ftp.port}`} toast={toast} /></Reveal>}
              </AnimatePresence>
              <Row label={<>Wi-Fi live view <span className="st-muted">(Nikon Z, experimental)</span></>}>
                <Switch on={s.ptp.enabled} onChange={(v) => void apply({ ptp: { ...s.ptp, enabled: v } })} label={s.ptp.enabled ? 'Live view on' : 'Live view off'} />
              </Row>
            </Sec>

            <Sec id="culling" title="Culling" i={2}>
              <Row label="Group bursts and mark the best"><Switch on={bursts === '1'} onChange={(v) => setBursts(v ? '1' : '0')} label="Bursts" /><span className="st-muted">Flags soft frames and eyes closed too</span></Row>
              <Row label="Write XMP sidecars"><Switch on={s.xmpSidecars} onChange={(v) => void apply({ xmpSidecars: v })} label="XMP sidecars" /><span className="st-muted">Lightroom and Capture One see your ratings</span></Row>
              <Row label="Shift + key moves to next"><Switch on={shift === '1'} onChange={(v) => setShift(v ? '1' : '0')} label="Shift advances" /></Row>
              <Row label="Delete goes to">
                <div className="seg" role="radiogroup" aria-label="Delete goes to">
                  <button role="radio" aria-checked={del === 'bin'} className={del === 'bin' ? 'on' : ''} onClick={() => setDel('bin')}>Recycle bin</button>
                  <button role="radio" aria-checked={del === 'permanent'} className={del === 'permanent' ? 'on' : ''} onClick={() => setDel('permanent')}>Permanent</button>
                </div>
              </Row>
            </Sec>

            <Sec id="remote" title="Phone and remote" i={3}>
              <Row label="Remote gallery">
                <Switch on={s.remote.enabled} onChange={(v) => void apply({ remote: { ...s.remote, enabled: v, pin: s.remote.pin || newPin() } })} label="Remote gallery" />
                <span className="st-muted">PIN</span>
                <span className="mono st-pin">{s.remote.pin ? s.remote.pin.split('').join(' ') : '—'}</span>
                <button className="tb" onClick={() => void apply({ remote: { ...s.remote, pin: newPin() } })}>New PIN</button>
                <button className="tb st-accent" onClick={() => setOpen({ ...open, qr: !open.qr })}>Show QR</button>
              </Row>
              <AnimatePresence>
                {open.qr && <Reveal key="q">{lan && s.remote.enabled ? <PhoneLink url={lan} pin={s.remote.pin} size={180} /> : <p className="st-muted">Turn on the remote gallery and connect to a network to get a QR code.</p>}</Reveal>}
              </AnimatePresence>
              <Row label="Public link">
                <Switch on={tunnelOn} onChange={() => void toggleTunnel()} label="Public link" />
                <span className="st-muted">{t?.status === 'running' && t.url ? t.url : t?.status === 'error' ? t.error ?? 'Could not start' : t?.status === 'installing' ? 'Getting the helper…' : 'One click, no account. Lets a client watch from anywhere.'}</span>
              </Row>
            </Sec>

            <Sec id="sync" title="Sync" i={4}>
              {s.destinations.length === 0 && <p className="st-muted">No destinations yet. Photos stay on this PC.</p>}
              {s.destinations.map((d) => <div key={d.id} className="st-dest"><span className="st-cam-n">{d.name}</span><span className="mono st-muted st-ell">{d.target}</span></div>)}
              {onOpenSync && <div><button className="tb" onClick={onOpenSync}>Open Sync</button></div>}
            </Sec>

            <Sec id="apps" title="Open in…" i={5}>
              {editors.length ? <div className="st-chips">{editors.map((e) => <span key={e.id} className="quick">{e.name}</span>)}</div> : <p className="st-muted">No editors detected. "Open with…" in the photo panel lets you choose one.</p>}
              <Row label="rclone"><input className="st-input mono" defaultValue={s.rclonePath} aria-label="rclone executable" onBlur={(e) => e.target.value !== s.rclonePath && void apply({ rclonePath: e.target.value })} /></Row>
            </Sec>

            <Sec id="about" title="About" i={6}>
              <Row label="ShotDrop"><span className="mono st-text2">{status?.version ?? ''}</span></Row>
              <Row label="Ports">
                <button className="tb" onClick={() => setOpen({ ...open, adv: !open.adv })}>{open.adv ? 'Hide' : 'Show'} FTP and API ports</button>
              </Row>
              <AnimatePresence>
                {open.adv && (
                  <Reveal key="p">
                    <div className="st-ports">
                      <Num label="FTP port" v={ftp.port} on={(n) => setFtp({ port: n })} />
                      <Num label="Passive from" v={ftp.pasvMin} on={(n) => setFtp({ pasvMin: n })} />
                      <Num label="to" v={ftp.pasvMax} on={(n) => setFtp({ pasvMax: n })} />
                      <Num label="API port (restart to apply)" v={s.api.port} on={(n) => void apply({ api: { port: n } })} />
                    </div>
                  </Reveal>
                )}
              </AnimatePresence>
            </Sec>
          </>
        )}
      </main>
    </div>
    </Dialog>
  )
}

function Num({ label, v, on }: { label: string; v: number; on: (n: number) => void }) {
  return <label className="st-num">{label}<input className="st-input mono" type="number" defaultValue={v} key={v} onBlur={(e) => { const n = Number(e.target.value); if (n && n !== v) on(n) }} /></label>
}
const Reveal = ({ children }: { children: React.ReactNode }) => (
  <motion.div className="st-reveal" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fade}>{children}</motion.div>
)
function Sec({ id, title, i, children }: { id: string; title: string; i: number; children: React.ReactNode }) {
  return (
    <motion.section className="sec" id={`st-${id}`} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ ...firm, delay: i * 0.06 }}>
      <h2>{title}</h2>
      {children}
    </motion.section>
  )
}
function Row({ label, hint, stack, children }: { label: React.ReactNode; hint?: string; stack?: boolean; children: React.ReactNode }) {
  return (
    <div className={`st-row ${stack ? 'stack' : ''}`}>
      <div className="l">{label}</div>
      <div className="c">{children}</div>
      {hint && <div className="h">{hint}</div>}
    </div>
  )
}

// ================= phone =================

/** MSettings.dc.html: grouped rows, 44px switches. Writes go through the same API; the PC decides what a phone may change. */
export function MobileSettings({ status, toast }: { status: Status | null; toast: Toast }) {
  const { s, apply } = useLiveSettings(toast)
  const [bursts, setBursts] = usePref('bursts')
  const [del, setDel] = usePref('deleteMode')
  const [card, setCard] = useState<number | null>(null)
  const [check, setCheck] = useState(false)
  const t = status?.tunnel
  return (
    <div className="m-page">
      <div className="m-head"><div><h1>Settings</h1><div className="st-sub">Changes apply instantly on the PC.</div></div></div>
      <div className="m-scroll st-m">
        {!s ? <p className="st-muted">Loading…</p> : (
          <>
            <MGroup title="LIBRARY">
              <div className="mrow stack">
                <div className="t"><div>Photos land in</div><div className="mono s">{s.libraryDir}{'\\{day}'}</div></div>
                <FolderPicker value={s.libraryDir} onChange={(p) => { if (p !== s.libraryDir) toast(`Picked ${p}. The library folder is changed on the PC, in Settings.`) }} s={s} status={status} remote noCheck />
              </div>
              <div className="mrow"><div className="t"><div>Watched folders</div><div className="s">{s.watchFolders.length ? s.watchFolders.join(', ') : 'None'}</div></div></div>
            </MGroup>
            <MGroup title="CAMERAS">
              {s.ftp.users.map((u, i) => {
                const cam = status?.cameras.find((c) => c.username === ftpLoginName(u))
                return (
                  <div key={i} className="mrow stack">
                    <div className="mline">
                      <span className={`dot ${cam?.connected ? 'live' : ''}`} style={cam?.connected ? undefined : { background: 'var(--faintest)' }} />
                      <div className="t"><div>{u.label || ftpLoginName(u)}</div><div className="mono s">{ftpLoginName(u)}{u.password ? ` · ${u.password}` : ''}</div></div>
                      <button className="mlink" onClick={() => setCard(card === i ? null : i)}>Show card</button>
                    </div>
                    {card === i && <div className="st-card-in"><CopyField label="Host" value={status?.ftp.addresses[0] ?? ''} /><CopyField label="Port" value={String(s.ftp.port)} /><CopyField label="User" value={ftpLoginName(u)} />{u.username && u.password && <CopyField label="Password" value={u.password} />}</div>}
                  </div>
                )
              })}
              <div className="mrow"><div className="t"><div>FTP server</div><div className="mono s">{addrOf(status) || `port ${s.ftp.port}`}</div></div><Switch className="m" on={s.ftp.enabled} onChange={(v) => void apply({ ftp: { ...s.ftp, enabled: v } })} label="FTP server" /></div>
              <button className="mrow tap" onClick={() => setCheck(!check)}><div className="t"><div>Connection check</div></div><span className="chev">›</span></button>
              {check && <div className="mrow stack"><NetworkCheck watch={`${status?.ftp.running}-${status?.ftp.port}`} toast={toast} /></div>}
            </MGroup>
            <MGroup title="CULLING">
              <div className="mrow"><div className="t"><div>Group bursts, mark best</div><div className="s">Also flags soft and eyes closed</div></div><Switch className="m" on={bursts === '1'} onChange={(v) => setBursts(v ? '1' : '0')} label="Bursts" /></div>
              <div className="mrow"><div className="t"><div>Write XMP sidecars</div><div className="s">Lightroom and Capture One see ratings</div></div><Switch className="m" on={s.xmpSidecars} onChange={(v) => void apply({ xmpSidecars: v })} label="XMP sidecars" /></div>
              <button className="mrow tap" onClick={() => setDel(del === 'bin' ? 'permanent' : 'bin')}><div className="t"><div>Delete goes to</div></div><span className="st-text2">{del === 'bin' ? 'Recycle bin' : 'Permanent'}</span><span className="chev">›</span></button>
            </MGroup>
            <MGroup title="PHONE AND REMOTE">
              <div className="mrow"><div className="t"><div>Remote gallery</div><div className="s">PIN <span className="mono st-pin-s">{rememberedPin() || (s.remote.enabled ? 'not needed here' : 'off')}</span></div></div><Switch className="m" on={s.remote.enabled} onChange={(v) => void apply({ remote: { ...s.remote, enabled: v } })} label="Remote gallery" /></div>
              <div className="mrow"><div className="t"><div>Public link</div><div className="s">{t?.status === 'running' ? 'On' : 'One click, no account'}</div></div><Switch className="m" on={t?.status === 'running'} onChange={(v) => void (v ? api.tunnelStart() : api.tunnelStop()).catch(() => toast('Change this on the PC.', 'error'))} label="Public link" /></div>
            </MGroup>
          </>
        )}
      </div>
      <TabBar current="settings" />
    </div>
  )
}
const MGroup = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="msec"><h2>{title}</h2>{children}</section>
