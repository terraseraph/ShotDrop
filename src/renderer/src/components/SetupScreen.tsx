import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { ftpLoginName, type FtpUser, type NetInterface, type Settings, type Shot, type Status } from '@shared/types'
import { api, desktop } from '../api'
import { fmtSize } from '../format'
import { riseIn } from '../motion'
import { BrandGuide } from './BrandGuide'
import { CheckCard, problemsOf, useDiagnostics } from './CheckCard'
import { ListeningLog, type LogLine } from './ListeningLog'
import { QrCode } from './QrCode'
import './Setup.css'

interface Props {
  status: Status | null
  shots: Shot[]
  /** Set when reached from the app rather than as the empty state. */
  onBack: (() => void) | null
  onGallery: (id: number) => void
  /** Modal over the gallery (from Settings): no ghost grid, closes instead of dissolving. */
  dialog?: boolean
  /** Called the moment the first new frame lands, before the card dissolves. */
  onFirstFrame?: (shot: Shot) => void
  /** Skip for now. Without it the card just hides itself and leaves a "Show camera setup" chip. */
  onSkip?: () => void
}

const WORDS = ['river', 'amber', 'cedar', 'maple', 'harbor', 'falcon', 'meadow', 'orbit', 'lantern', 'pebble', 'summit', 'willow']
const newPassword = (): string => {
  const r = crypto.getRandomValues(new Uint32Array(2))
  return `${WORDS[r[0] % WORDS.length]}-${1000 + (r[1] % 9000)}`
}

const KIND: Record<NetInterface['kind'], string> = { wifi: 'Wi-Fi', ethernet: 'Ethernet', 'vpn-virtual': 'VPN / virtual', other: 'Other' }
const isVpn = (i: NetInterface): boolean => i.kind === 'vpn-virtual'
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function useNarrow(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const f = (): void => setM(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  return m
}

export function SetupScreen({ status, shots, onBack, onGallery, dialog, onFirstFrame, onSkip }: Props) {
  const mobile = useNarrow()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [userIdx, setUserIdx] = useState(0)
  const [view, setView] = useState<'setup' | 'check'>('setup')
  const [skipped, setSkipped] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [addrOpen, setAddrOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [events, setEvents] = useState<LogLine[]>([])
  const [, tick] = useState(0)
  const mounted = useRef(Date.now())
  const connectedAt = useRef<number | null>(null)
  const autoShown = useRef(false)
  const seen = useRef(new Set(shots.map((s) => s.id)))
  const prevConns = useRef(status?.ftp.activeConnections ?? 0)
  const nextId = useRef(0)

  const ftp = status?.ftp
  const users = settings?.ftp.users ?? []
  const uIdx = Math.min(userIdx, Math.max(users.length - 1, 0))
  const user: FtpUser | undefined = users[uIdx]
  const host = ftp?.addresses[0]
  const first = shots.find((s) => !seen.current.has(s.id))
  const iface = ftp?.interfaces.find((i) => i.address === host)
  const others = (ftp?.interfaces ?? []).filter((i) => i.address !== host).sort((a, b) => Number(isVpn(a)) - Number(isVpn(b)))

  const diag = useDiagnostics(!!desktop && ftp?.running !== false, view === 'check' ? 5000 : 15000, `${ftp?.running}-${ftp?.port}`)
  const problems = problemsOf(diag.report)
  const allOk = !!diag.report && !problems.length

  useEffect(() => {
    api.settings().then(setSettings).catch(() => undefined)
  }, [ftp?.port])

  const push = (text: string, tone?: LogLine['tone']): void =>
    setEvents((l) => [...l, { id: String(nextId.current++), text, tone }].slice(-4))

  const patchFtp = async (users: FtpUser[]): Promise<void> => {
    if (!settings) return
    // The server merges `ftp` shallowly, so send the whole ftp block with the new users.
    setSettings(await api.patchSettings({ ftp: { ...settings.ftp, users } }))
  }
  const regenerate = (): void => void patchFtp(users.map((u, i) => (i === uIdx ? { ...u, password: newPassword() } : u)))
  const addCamera = async (): Promise<void> => {
    const n = users.length + 1
    await patchFtp([...users, { username: `camera${n}`, password: newPassword(), label: `Camera ${n}` }])
    setUserIdx(users.length)
  }
  const watchFolder = async (): Promise<void> => {
    const p = await desktop?.pickFolder()
    if (p && settings && !settings.watchFolders.includes(p)) setSettings(await api.patchSettings({ watchFolders: [...settings.watchFolders, p] }))
  }
  const useAddress = (address: string): void => {
    void api.patchSettings({ ftp: { preferredAddress: address } } as Partial<Settings>)
    setAddrOpen(false)
  }

  const login = user ? ftpLoginName(user) : ''
  const pass = user?.username ? user.password : ''
  const url = host && ftp && user ? `ftp://${user.username ? `${encodeURIComponent(user.username)}${pass ? `:${encodeURIComponent(pass)}` : ''}@` : ''}${host}:${ftp.port}/` : ''
  const copyAll = (): void => {
    void navigator.clipboard.writeText([`Address: ${host}`, `Port: ${ftp?.port}`, `User: ${login}`, user?.username && pass ? `Password: ${pass}` : null].filter(Boolean).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  // Log: listening is derived, the rest are events as they arrive.
  useEffect(() => {
    const c = ftp?.activeConnections ?? 0
    if (c > prevConns.current) {
      // The built-in self-test also connects (from this PC's own address); only a real camera counts.
      const a = diag.attempts.filter((x) => x.ok).pop()
      const ip = a?.ip.replace(/^::ffff:/, '')
      if (!a || !(ip === '127.0.0.1' || ip === '::1' || ftp?.addresses.includes(ip!))) {
        connectedAt.current ??= Date.now()
        push(a ? `Camera ${ip} connected as ${a.username}` : `Camera connected as ${login}`)
      }
    }
    prevConns.current = c
  }, [ftp?.activeConnections]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!first) return
    const secs = ((Date.now() - (connectedAt.current ?? mounted.current)) / 1000).toFixed(1)
    push(`Receiving ${first.files.map((x) => x.name).join(' + ')} … ${fmtSize(first.files.reduce((n, x) => n + x.size, 0))}`)
    push(`First frame landed in ${secs} s.${dialog ? '' : ' Opening the gallery…'}`, 'ok')
    onFirstFrame?.(first)
    if (dialog) return
    const t = setTimeout(() => setLeaving(true), 1400)
    return () => clearTimeout(t)
  }, [first?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Show elapsed time, and bring up the check by itself if nothing arrived for ~60 s and something is wrong.
  useEffect(() => {
    const t = setInterval(() => {
      tick((n) => n + 1)
      if (!autoShown.current && !pinned && !first && Date.now() - mounted.current >= 60000 && problems.length) {
        autoShown.current = true
        setView('check')
        setSkipped(false)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [pinned, first, problems.length])

  useEffect(() => {
    if (!dialog || !onBack) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, onBack])

  const skip = (): void => (onSkip ? onSkip() : dialog && onBack ? onBack() : setSkipped(true))
  const elapsed = Math.round((Date.now() - mounted.current) / 1000)

  const lines: LogLine[] = [
    ftp?.running
      ? { id: 'listen', text: `Listening on ${host ?? 'no network'}:${ftp.port}${diag.report ? ` · ${problems.length ? 'needs attention' : 'firewall OK · port free'}` : ''}` }
      : { id: 'off', text: ftp?.error ? `FTP server error: ${ftp.error}` : 'The FTP server is off. Turn it on in Settings → Camera.', tone: 'bad' as const },
    ...events.map((e) => ({ ...e, tone: e.tone ?? ('dim' as const) }))
  ]

  const summary = (
    <div className="su-sum">
      <span className={`dot ${!diag.report ? 'run' : allOk ? 'live' : problems.some((p) => p.level === 'error') ? 'bad' : 'warn'}`} style={allOk ? { animation: 'none' } : undefined} />
      <span>
        {!desktop ? 'Connection check runs in the desktop app' : !diag.report ? (diag.error ? 'Connection check unavailable' : 'Checking the connection…') : allOk
          ? 'Connection check passed · firewall, port, adapter, self-login'
          : `Needs attention: ${problems.map((p) => p.title).join(' · ')}`}
      </span>
      {desktop && diag.report && <button className="tb" onClick={() => setView('check')}>Details</button>}
    </div>
  )

  const fields = ftp?.running ? (
    <>
      {users.length > 1 && (
        <div className="su-users" role="tablist" aria-label="Camera login">
          {users.map((u, i) => (
            <button key={i} role="tab" aria-selected={i === uIdx} className={`chip ${i === uIdx ? 'on' : ''}`} onClick={() => setUserIdx(i)}>{u.label || ftpLoginName(u)}</button>
          ))}
        </div>
      )}
      <div className="su-fields">
        <div className="su-field wide">
          <div className="l">
            {mobile ? 'ADDRESS' : 'ADDRESS'}
            {iface && <span className={`note ${isVpn(iface) ? 'bad' : ''}`}>{isVpn(iface) ? 'VPN · a camera can’t reach this' : `${KIND[iface.kind]} · same network as the camera`}</span>}
          </div>
          <div className="v big">{host ?? 'No network found'}</div>
          {others.length > 0 && (
            <>
              <button className="tb su-link" aria-expanded={addrOpen} onClick={() => setAddrOpen((o) => !o)}>
                Not this one? {others.length} other {others.length === 1 ? 'address' : 'addresses'}
              </button>
              <AnimatePresence initial={false}>
                {addrOpen && (
                  <motion.div className="su-addrs" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
                    {others.map((i) => (
                      <div key={i.address}>
                        <span className="mono">{i.address}</span>
                        <span>{i.adapter} · {KIND[i.kind]}</span>
                        {isVpn(i) && <span className="pill warn">{/tailscale|wireguard|^wg|zerotier|vpn/i.test(i.adapter) ? 'VPN' : 'Virtual'} · last</span>}
                        <button className="tb" onClick={() => useAddress(i.address)}>Use this</button>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
        {mobile ? null : (
          <>
            <div className="su-field"><div className="l">PORT</div><div className="v">{ftp.port}</div></div>
            <div className="su-field"><div className="l">MODE</div><div className="v sm">Passive · FTP</div></div>
            <div className="su-field"><div className="l">USER</div><div className="v">{login}</div></div>
            <div className="su-field">
              <div className="l">PASSWORD {user?.username && <button className="tb" onClick={regenerate}>regenerate</button>}</div>
              <div className="v">{user?.username ? pass || 'any' : 'none'}</div>
            </div>
          </>
        )}
      </div>
    </>
  ) : (
    <p className="su-off">{ftp?.error ? `FTP server error: ${ftp.error}` : 'The FTP server is off. Turn it on in Settings → Camera.'}</p>
  )

  const qrBlock = url ? <QrCode value={url} size={mobile ? 96 : 132} label="QR code with the ftp address" /> : null

  const desktopCard = (
    <motion.div key="setup" className="su-card" {...riseIn}>
      <div className="su-left">
        <div>
          <h2>Point your camera here</h2>
          <div className="lede">Everything below was picked for you. Type it into the camera&apos;s FTP menu, or scan the code with the phone app.</div>
        </div>
        {fields}
        <div className="su-actions">
          <button className="tb fill" onClick={copyAll}>{copied ? 'Copied' : 'Copy all'}</button>
          <button className="tb fill" onClick={() => void addCamera()}>Add a second camera</button>
          {desktop && <button className="tb quiet" onClick={() => void watchFolder()}>Use a watched folder instead</button>}
        </div>
        <ListeningLog lines={lines} live={!!ftp?.running} />
      </div>
      <div className="su-right">
        <div className="su-qrrow">
          {qrBlock}
          <div className="su-qrtext"><b>Scan to skip typing</b>Cameras with a QR pairing screen, and the ShotDrop phone app, read this <span className="mono">ftp://</span> link directly.</div>
        </div>
        <BrandGuide />
        {summary}
        <div className="su-foot">
          <button className="tb quiet" onClick={skip}>{dialog ? 'Close' : 'Skip for now'}</button>
          <button className="tb fill" onClick={() => setPinned((p) => !p)}>{pinned ? '✓ Staying open' : 'Keep this open while I set the camera'}</button>
        </div>
      </div>
    </motion.div>
  )

  const sheet = (
    <motion.div
      key="sheet"
      className="su-sheet"
      {...riseIn}
      initial={{ y: 40, opacity: 0 }}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={(_, i) => i.offset.y > 120 && skip()}
    >
      <div className="su-grab" aria-hidden="true" />
      <div>
        <h2>Point your camera here</h2>
        <div className="lede">Picked for you. Type these into the camera, or scan.</div>
      </div>
      <div className="su-qrrow">
        {qrBlock}
        <div className="su-field" style={{ flex: 1 }}>
          <div className="l">ADDRESS{iface ? ` · ${KIND[iface.kind].toUpperCase()}` : ''}</div>
          <div className="v big">{host ?? 'No network'}</div>
          <div className="su-fields" style={{ gap: 8, marginTop: 8 }}>
            <div className="su-field"><div className="l">PORT</div><div className="v">{ftp?.port}</div></div>
            <div className="su-field"><div className="l">USER</div><div className="v">{login}</div></div>
            <div className="su-field wide"><div className="l">PASSWORD</div><div className="v">{user?.username ? pass || 'any' : 'none'}</div></div>
          </div>
        </div>
      </div>
      <BrandGuide compact />
      <ListeningLog lines={lines.slice(-2)} live={!!ftp?.running} />
      {others.length > 0 && <button className="tb su-link" style={{ height: 44 }} onClick={() => setAddrOpen((o) => !o)}>Not this one? {others.length} other</button>}
      {addrOpen && others.map((i) => <button key={i.address} className="tb" style={{ height: 44 }} onClick={() => useAddress(i.address)}>{i.address} · {KIND[i.kind]}</button>)}
      <div className="su-btns">
        <button onClick={copyAll}>{copied ? 'Copied' : 'Copy all'}</button>
        <button className="ghost" onClick={skip}>Skip for now</button>
      </div>
    </motion.div>
  )

  const checkCard = (
    <motion.div key="check" className={mobile ? 'su-sheet check' : 'su-card narrow'} {...riseIn}>
      <CheckCard diag={diag} freeBytes={status?.library.free} onBack={() => { setView('setup'); setPinned(true) }} />
    </motion.div>
  )

  const folder = settings?.libraryDir ?? status?.library.dir ?? ''
  const sep = folder.includes('\\') ? '\\' : '/'
  const count = shots.length

  const overlay = !skipped && (
    <motion.div
      className={`su-overlay scrim ${dialog ? 'dialog' : ''} ${mobile ? 'sheet' : ''}`}
      initial={false}
      animate={{ opacity: leaving ? 0 : 1 }}
      transition={{ duration: 0.4 }}
      onAnimationComplete={() => leaving && first && onGallery(first.id)}
      onClick={dialog ? onBack ?? undefined : undefined}
    >
      <motion.div style={{ display: 'contents' }}>
        <motion.div animate={{ scale: leaving ? 0.97 : 1 }} transition={{ duration: 0.4 }} style={{ display: 'flex', width: mobile ? '100%' : undefined, maxWidth: '100%', maxHeight: '100%', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
          <AnimatePresence mode="wait" initial>
            {view === 'check' ? checkCard : mobile ? sheet : desktopCard}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </motion.div>
  )

  return (
    <MotionConfig reducedMotion="user">
      {dialog ? (
        overlay
      ) : (
        <div className={`su-root ${mobile ? 'su-mobile' : ''}`}>
          <div className="su-strip">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            {!mobile && 'Photos land in'}
            <span className="path mono" title={folder}>{folder ? `${folder}${sep}${today()}` : ''}</span>
            {desktop && !mobile && (
              <button className="tb" onClick={async () => {
                const p = await desktop!.pickFolder()
                if (p && settings && p !== settings.libraryDir) setSettings(await api.patchSettings({ libraryDir: p }))
              }}>Change…</button>
            )}
            <span className="end">{count ? `${count} frames` : view === 'check' ? `Empty · nothing has arrived in ${elapsed} s` : 'Empty · waiting for the first frame'}</span>
          </div>
          <div className="su-ghosts" aria-hidden="true">{Array.from({ length: mobile ? 12 : 24 }, (_, i) => <i key={i} />)}</div>
          {skipped && <button className="tb su-fix" style={{ position: 'absolute', right: 20, bottom: 20 }} onClick={() => setSkipped(false)}>Show camera setup</button>}
          {overlay}
        </div>
      )}
    </MotionConfig>
  )
}
