import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import QRCode from 'qrcode'
import type { Settings, Shot, Status } from '@shared/types'
import { api, desktop } from '../api'
import { NetworkCheck } from './NetworkCheck'
import { Icon } from './Icon'

const BRAND_STEPS: { brand: string; where: string; steps: string[] }[] = [
  {
    brand: 'Sony',
    where: 'Menu → Network → FTP Transfer Func.',
    steps: [
      'Server Setting → pick a server slot.',
      'Host name and Port from the card. Secure protocol: Off. Passive mode: On.',
      'User / Password from the card. Directory: leave blank.',
      'Connect the camera to the same Wi-Fi (Network → Wi-Fi → Access Point Set.).',
      'Turn on Auto FTP Transfer, then take a frame.'
    ]
  },
  {
    brand: 'Canon',
    where: 'Menu → Network → Network settings → Connection option settings → FTP transfer',
    steps: [
      'Run the connection wizard: choose the Wi-Fi network, then FTP mode (not SFTP/FTPS).',
      'Address and Port from the card. Passive mode: Enable. Proxy: none.',
      'Login: the User and Password on the card. Target folder: Root folder.',
      'Transfer settings → Auto transfer: Enable.'
    ]
  },
  {
    brand: 'Nikon',
    where: 'Network menu → Connect to FTP server',
    steps: [
      'Network settings → Create profile, choose Wi-Fi and join the same network as this PC.',
      'Server type: FTP. Address and Port from the card. Passive mode: On.',
      'Login with the User and Password on the card, then Connect.',
      'Options → Auto send: On.'
    ]
  },
  {
    brand: 'Fujifilm',
    where: 'Network/USB settings → FTP transfer settings',
    steps: [
      'Server settings: Server and Port from the card. Passive mode: On.',
      'User ID / Password from the card. Upload folder: blank.',
      'Join the same Wi-Fi as this PC, then enable Auto Image Transfer Order.'
    ]
  },
  {
    brand: 'Other',
    where: 'Look for FTP, FTP transfer or Network upload in the camera menu',
    steps: [
      'Plain FTP, not SFTP or FTPS. Passive mode on.',
      'Host, Port, User and Password from the card. Folder: blank.',
      'Join the same Wi-Fi as this PC and turn on automatic transfer.'
    ]
  }
]

interface LogLine {
  id: number
  at: Date
  text: string
  detail?: string
  tone: 'ok' | 'rx'
}

const clock = (d: Date): string => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="setup-field">
      <span className="k">{label}</span>
      <span className="v mono">{value}</span>
      <button
        className="icon-btn small"
        title={`Copy ${label.toLowerCase()}`}
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  )
}

interface Props {
  status: Status | null
  shots: Shot[]
  /** Set when reached from the app rather than as the empty state. */
  onBack: (() => void) | null
  onGallery: (id: number) => void
}

export function SetupScreen({ status, shots, onBack, onGallery }: Props) {
  const reduced = useReducedMotion()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [brand, setBrand] = useState('Sony')
  const [userIdx, setUserIdx] = useState(0)
  const [qr, setQr] = useState('')
  const [log, setLog] = useState<LogLine[]>([])
  const seen = useRef(new Set(shots.map((s) => s.id)))
  const prev = useRef({ running: false, conns: 0 })
  const nextId = useRef(0)

  const ftp = status?.ftp
  const user = settings?.ftp.users[Math.min(userIdx, (settings?.ftp.users.length ?? 1) - 1)]
  const host = ftp?.addresses[0]
  // The first shot that arrives after this screen opened is the test shot.
  const first = shots.find((s) => !seen.current.has(s.id))
  const connected = (ftp?.activeConnections ?? 0) > 0

  useEffect(() => {
    api.settings().then(setSettings).catch(() => undefined)
  }, [ftp?.port])

  useEffect(() => {
    if (!ftp?.running || !host || !user) return setQr('')
    const url = `ftp://${encodeURIComponent(user.username)}:${encodeURIComponent(user.password)}@${host}:${ftp.port}/`
    QRCode.toDataURL(url, { margin: 0, width: 240 }).then(setQr).catch(() => setQr(''))
  }, [ftp?.running, ftp?.port, host, user])

  const push = (text: string, tone: LogLine['tone'], detail?: string): void =>
    setLog((l) => [{ id: nextId.current++, at: new Date(), text, tone, detail }, ...l].slice(0, 6))

  useEffect(() => {
    if (!ftp) return
    const p = prev.current
    if (ftp.running && !p.running) push('FTP server listening', 'ok', `${host ?? 'no network'}:${ftp.port}`)
    if (ftp.activeConnections > p.conns) push('Camera connected', 'ok')
    prev.current = { running: ftp.running, conns: ftp.activeConnections }
  }, [ftp, host]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (first) push(`Received ${first.files.map((f) => f.name).join(' + ')}`, 'rx')
  }, [first?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const done = [true, !!host, connected || !!first, !!first]
  const active = done.indexOf(false)
  const stepRows = [
    { title: 'Pick your brand', sub: brand },
    { title: 'Same Wi-Fi', sub: host ? `PC is at ${host}` : 'No network found' },
    { title: 'Enter these on the camera', sub: 'Or scan the QR' },
    { title: 'Take a test shot', sub: "We'll wait for it" }
  ]
  const guide = BRAND_STEPS.find((b) => b.brand === brand)!
  const seconds = first ? (first.importedAt - first.capturedAt) / 1000 : -1
  const received = seconds >= 0.1 && seconds < 120 ? `Received in ${seconds.toFixed(1)} s` : 'Received'

  const col = (i: number) => ({ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5, ease: [0.2, 0.8, 0.2, 1] as const, delay: i * 0.08 } })

  return (
    <MotionConfig reducedMotion="user">
      <div className="setup">
        <motion.aside className="setup-steps" {...col(0)}>
          <h2>Add a camera</h2>
          {stepRows.map((s, i) => (
            <div key={s.title} className={`setup-step ${done[i] ? 'done' : ''} ${i === active ? 'on' : ''}`}>
              <span className="n">{done[i] ? <Icon name="check" size={12} /> : i + 1}</span>
              <span>{s.title}<small>{s.sub}</small></span>
            </div>
          ))}
          {onBack && <button className="link setup-skip" onClick={onBack}>I've done this before →</button>}
        </motion.aside>

        <motion.main className="setup-main" {...col(1)}>
          <h2>Type this into the camera's FTP menu</h2>
          <p className="muted">Big on purpose. Menu names vary by model and firmware; these are a starting point.</p>

          <div className="setup-brands" role="tablist" aria-label="Camera brand">
            {BRAND_STEPS.map((b) => (
              <button key={b.brand} role="tab" aria-selected={brand === b.brand} className={brand === b.brand ? 'on' : ''} onClick={() => setBrand(b.brand)}>
                {b.brand}
              </button>
            ))}
          </div>

          {settings && settings.ftp.users.length > 1 && (
            <div className="setup-users" role="tablist" aria-label="Camera login">
              {settings.ftp.users.map((u, i) => (
                <button key={u.username} role="tab" aria-selected={user === u} className={user === u ? 'on' : ''} onClick={() => setUserIdx(i)}>
                  {u.label || u.username}
                </button>
              ))}
            </div>
          )}

          {!ftp?.running ? (
            <div className="conn-card off">
              <p>{ftp?.error ? `FTP server error: ${ftp.error}` : 'The FTP server is off. Turn it on in Settings → Camera.'}</p>
            </div>
          ) : (
            <div className="setup-conn">
              <div>
                <CopyRow label="Host name" value={host ?? 'No network found'} />
                <CopyRow label="Port" value={String(ftp.port)} />
                {user && <CopyRow label="User" value={user.username} />}
                {user && <CopyRow label="Password" value={user.password} />}
                <div className="setup-field">
                  <span className="k">Mode</span>
                  <span className="v sm">FTP · Passive on · Secure off · Directory blank</span>
                  <span />
                </div>
              </div>
              {qr && (
                <div className="setup-qr">
                  <img src={qr} alt="QR code with the FTP connection details" width={148} height={148} />
                  <small>ftp:// link with these details</small>
                </div>
              )}
            </div>
          )}
          {desktop && <NetworkCheck compact watch={`${ftp?.running}-${ftp?.port}`} />}
          {ftp && ftp.addresses.length > 1 && (
            <p className="muted small">Other addresses on this PC: {ftp.addresses.slice(1).join(', ')}. Use the one on the same Wi-Fi as the camera.</p>
          )}

          <div className="setup-guide">
            <header>
              Where it is on a {brand === 'Other' ? 'camera' : brand} <span className="muted">{guide.where}</span>
            </header>
            <AnimatePresence mode="wait" initial={false}>
              <motion.ol key={brand} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                {guide.steps.map((s) => <li key={s}>{s}</li>)}
              </motion.ol>
            </AnimatePresence>
          </div>
        </motion.main>

        <motion.aside className="setup-listen" {...col(2)}>
          <div className="setup-listen-top">
            <div className={`setup-pulse ${ftp?.running ? 'live' : ''}`} aria-hidden>
              {ftp?.running && !reduced && [0, 1.2].map((d) => (
                <motion.i key={d} initial={{ scale: 0.3, opacity: 0.8 }} animate={{ scale: 1.7, opacity: 0 }} transition={{ duration: 2.4, ease: 'easeOut', repeat: Infinity, delay: d }} />
              ))}
              <span />
            </div>
            <strong>{first ? 'Camera is set up' : connected ? 'Camera connected' : ftp?.running ? 'Listening for your camera' : 'FTP server is off'}</strong>
            <p className="muted">{first ? 'Your test shot made it.' : 'Take a shot and it lands here.'}</p>
          </div>

          <div className="setup-log" aria-live="polite">
            <AnimatePresence initial={false}>
              {log.map((l) => (
                <motion.div key={l.id} layout="position" className={`setup-ev ${l.tone}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}>
                  <span className="t">{clock(l.at)}</span>
                  <span className="msg">{l.text}{l.detail && <small>{l.detail}</small>}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="setup-listen-foot">
            <AnimatePresence>
              {first && (
                <motion.div className="setup-testshot" initial={{ opacity: 0, x: 18, scale: 0.9 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>
                  <img src={api.thumbUrl(first.id)} alt="" />
                  <div>
                    <b className="mono">{first.files.map((f) => f.name).join(' + ')}</b>
                    <span>{received} · camera is set up</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <button className="btn primary" disabled={!first && !shots.length} onClick={() => onGallery((first ?? shots[shots.length - 1]).id)}>
              Open the gallery →
            </button>
          </div>
        </motion.aside>
      </div>
    </MotionConfig>
  )
}
