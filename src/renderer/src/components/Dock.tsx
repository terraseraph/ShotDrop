import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type { DestStatus, DestinationFilter, Status } from '@shared/types'
import { api } from '../api'
import { ago, fmtTime, fmtSize } from '../format'
import type { Activity } from '../useLibrary'
import type { Tab } from './SettingsDrawer'

const RECEIVING_MS = 10_000
const FILTER_TEXT: Record<DestinationFilter, string> = { all: 'everything', jpeg: 'JPEG only', raw: 'RAW only', picks: 'picks only' }
const SETTLE = { type: 'spring', stiffness: 380, damping: 36 } as const
const section = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: SETTLE } }

interface Props {
  status: Status | null
  activity: Activity[]
  onSettings: (tab: Tab) => void
  toast: (t: string, tone?: 'info' | 'error') => void
}

/** Status dock: everything that's happening, one glance. Wrapped by App in AnimatePresence. */
export function Dock({ status, activity, onSettings, toast }: Props) {
  const [now, setNow] = useState(Date.now())
  const [pin, setPin] = useState('')
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => void api.settings().then((s) => setPin(s.remote.pin)), [])

  if (!status) return null
  const { cameras, destinations, library, api: srv, tunnel, sync } = status
  const queued = sync.pending + sync.running
  const urls = [...srv.urls, ...(tunnel.url ? [tunnel.url] : [])]

  const setRemote = (enabled: boolean): void =>
    void api.patchSettings({ remote: { enabled, pin } }).catch((e: Error) => toast(`Couldn't save: ${e.message}`, 'error'))
  const retry = (): void =>
    void api.retrySync().then(() => toast('Retrying failed uploads'), (e: Error) => toast(e.message, 'error'))

  return (
    <MotionConfig reducedMotion="user">
      <motion.aside className="dock" aria-label="Status" initial={{ width: 0 }} animate={{ width: 360 }} exit={{ width: 0 }} transition={SETTLE}>
        <motion.div className="dock-inner" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } } }}>
          <motion.section variants={section}>
            <header>
              <h3>Cameras</h3>
              <button className="btn" onClick={() => onSettings('camera')}>+ Add</button>
            </header>
            {!cameras.length && <p className="muted small">No camera logins yet.</p>}
            {cameras.map((c) => {
              const receiving = c.connected && c.lastAt !== null && now - c.lastAt < RECEIVING_MS
              const state = receiving ? 'receiving' : c.connected ? 'connected' : 'idle'
              return (
                <div className="camrow" key={c.username}>
                  <span className="av">{(c.label || c.username).slice(0, 2).toUpperCase()}</span>
                  <div>
                    <b>{c.label || c.username}</b>
                    <small>
                      {c.username} · {c.lastAt ? `last frame ${ago(c.lastAt)}` : 'no frames yet'} · {c.today} today
                    </small>
                  </div>
                  <span className={`state ${state}`}>
                    <motion.i animate={receiving ? { opacity: [1, 0.35, 1] } : { opacity: 1 }} transition={receiving ? { duration: 1, repeat: Infinity } : undefined} />
                    {state[0].toUpperCase() + state.slice(1)}
                  </span>
                </div>
              )
            })}
          </motion.section>

          <motion.section variants={section}>
            <header>
              <h3>Destinations</h3>
              {(queued > 0 || sync.errors > 0) && (
                <span className="muted small">
                  {queued} queued{sync.errors > 0 && ` · ${sync.errors} failed`}
                </span>
              )}
              <button className="btn" onClick={() => onSettings('sync')}>+ Add</button>
            </header>
            {!destinations.length && <p className="muted small">Shots stay on this PC until you add a destination.</p>}
            {destinations.map((d) => (
              <DestRow key={d.id} d={d} onRetry={retry} />
            ))}
          </motion.section>

          <motion.section variants={section}>
            <header>
              <h3>Remote gallery</h3>
              <button role="switch" aria-checked={srv.remote} aria-label="Remote gallery" className={`switch ${srv.remote ? 'on' : ''}`} style={{ marginLeft: 'auto' }} onClick={() => setRemote(!srv.remote)}>
                <span className="switch-knob" />
              </button>
            </header>
            {srv.remote ? (
              <div className="remote">
                {urls.map((u) => (
                  <span className="mono" key={u}>{u}</span>
                ))}
                <small>PIN {pin || '—'}</small>
              </div>
            ) : (
              <p className="muted small">Off. Turn on to view and cull from a phone on this network.</p>
            )}
          </motion.section>

          <motion.section variants={section}>
            <header><h3>This PC</h3></header>
            <div className="kv">
              <span className="mono" title={library.dir}>{library.dir}</span>
              <b>{library.free !== null ? `${fmtSize(library.free)} free` : '—'}</b>
            </div>
            {library.free !== null && library.total ? (
              <div className="gauge">
                <motion.i initial={{ scaleX: 0 }} animate={{ scaleX: 1 - library.free / library.total }} transition={SETTLE} />
              </div>
            ) : null}
          </motion.section>

          <motion.section variants={section}>
            <header><h3>Activity</h3></header>
            <div className="act">
              {!activity.length && <span className="muted small">Nothing yet.</span>}
              <AnimatePresence initial={false}>
                {activity.map((a) => (
                  <motion.div key={a.id} layout="position" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={SETTLE}>
                    <span className="t">{fmtTime(a.t).slice(0, 5)}</span>
                    <span className={a.tone}>{a.text}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.section>
        </motion.div>
      </motion.aside>
    </MotionConfig>
  )
}

const R = 17

function DestRow({ d, onRetry }: { d: DestStatus; onRetry: () => void }) {
  const p = d.total ? d.done / d.total : 0
  const complete = d.total > 0 && d.done === d.total
  return (
    <div className="drow">
      <span className="ring" data-v={d.errors ? '!' : complete ? '✓' : d.total ? `${Math.round(p * 100)}%` : '–'}>
        <svg viewBox="0 0 44 44" aria-hidden>
          <circle cx="22" cy="22" r={R} className="track" />
          <motion.circle cx="22" cy="22" r={R} className={d.errors ? 'val err' : 'val'} initial={{ pathLength: 0 }} animate={{ pathLength: p }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} />
        </svg>
      </span>
      <div>
        <b>{d.name}</b>
        <small title={d.target}>{d.target}</small>
      </div>
      <div className="meta">
        {d.errors > 0 ? (
          <>
            <em className="bad">{d.errors} failed</em> · <button className="link" onClick={onRetry}>retry</button>
          </>
        ) : d.running > 0 ? (
          <>
            <em>uploading</em>
            {d.bps > 0 && ` ${fmtSize(d.bps)}/s`}
          </>
        ) : (
          `${d.done} / ${d.total}`
        )}
        <br />
        {FILTER_TEXT[d.filter]}
      </div>
    </div>
  )
}
