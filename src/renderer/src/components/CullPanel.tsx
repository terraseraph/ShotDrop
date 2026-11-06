import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Shot, ShotPatch } from '@shared/types'
import { CULL_DEFAULTS, type Cull, type CullThresholds } from '@shared/cull'
import { matchFilter, type GridFilter } from './FilterChips'
import { getPref, setPref } from './fsApi'
import { Icon } from './Icon'
import { firm } from '../motion'
import './CullPanel.css'

export type DetKey = 'sim' | 'blur' | 'eyes' | 'expo'
type On = Record<DetKey, boolean>
type TKey = keyof CullThresholds

interface Slider { key: TKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string; lo: string; hi: string }
interface Detector { k: DetKey; name: string; short: string; filter: GridFilter; color: string; icon: string; help: string; sliders: Slider[] }

const pct = (v: number): string => `${Math.round(v * 100)}%`

/** One colour + icon per detector, used everywhere it shows: toolbar, panel, rail and thumbnail badges. */
export const DETECTORS: Detector[] = [
  {
    k: 'sim', name: 'Similar shots', short: 'Similar', filter: 'similar', color: 'var(--d-sim)', icon: 'M8 8h12v12H8zM4 16V4h12',
    help: 'Stacks bursts and near-duplicates and marks the best one. Flags the rest.',
    sliders: [
      { key: 'maxHamming', label: 'How alike counts as similar', min: 4, max: 28, step: 1, fmt: (v) => (v <= 10 ? 'very close' : v <= 18 ? 'close' : 'loose'), lo: 'Near identical', hi: 'Loosely alike' },
      { key: 'maxGapMs', label: 'Max time between frames', min: 500, max: 10000, step: 500, fmt: (v) => `${(v / 1000).toFixed(1)} s`, lo: '0.5 s', hi: '10 s' }
    ]
  },
  {
    k: 'blur', name: 'Blurry', short: 'Blur', filter: 'soft', color: 'var(--d-blur)', icon: 'M3 8c3-3 6 3 9 0s6 3 9 0M3 16c3-3 6 3 9 0s6 3 9 0',
    help: 'Flags frames that look soft next to the best in their burst, and lone frames that are plainly blurry.',
    sliders: [
      { key: 'softRatio', label: 'Soft next to the best in its burst', min: 0.3, max: 0.9, step: 0.05, fmt: (v) => `under ${pct(v)} as sharp`, lo: 'Only the worst', hi: 'Strict' },
      { key: 'softAbs', label: 'Blur floor for single frames', min: 5, max: 60, step: 1, fmt: (v) => String(v), lo: 'Only the worst', hi: 'Catch more' }
    ]
  },
  {
    k: 'eyes', name: 'Eyes closed', short: 'Eyes', filter: 'blink', color: 'var(--d-eyes)', icon: 'M3 10c2.5 3.5 5.5 5 9 5s6.5-1.5 9-5M6 13.5l-2 2.5M10 15l-.5 3M14 15l.5 3M18 13.5l2 2.5',
    help: 'Spots blinks and half-shut eyes on anyone in the frame.',
    sliders: [{ key: 'blinkAt', label: 'How shut counts as closed', min: 0.2, max: 0.8, step: 0.05, fmt: (v) => `${pct(v)} shut`, lo: 'Catch more', hi: 'Only obvious' }]
  },
  {
    k: 'expo', name: 'Exposure', short: 'Exposure', filter: 'exposure', color: 'var(--d-expo)',
    icon: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    help: 'Blown-out highlights or crushed shadows. Also lowers a frame’s chance of being a burst’s best.',
    sliders: [
      { key: 'clipAt', label: 'Blown highlights', min: 1, max: 20, step: 1, fmt: (v) => `over ${v}% pure white`, lo: 'Catch more', hi: 'Only obvious' },
      { key: 'darkAt', label: 'Crushed shadows', min: 10, max: 60, step: 5, fmt: (v) => `over ${v}% pure black`, lo: 'Catch more', hi: 'Only obvious' }
    ]
  }
]

const KEY = 'shotdrop.cull'
function load(): { t?: Partial<CullThresholds>; on?: Partial<On> } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** Detector switches and thresholds. "Similar shots" is the same setting as Settings → "Group bursts" (pref `bursts`). */
export function useCullSettings() {
  const [t, setT] = useState<CullThresholds>(() => ({ ...CULL_DEFAULTS, ...load().t }))
  const [on, setOn] = useState<On>(() => ({ blur: true, eyes: true, expo: true, ...load().on, sim: getPref('bursts') !== '0' }))
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ t, on })) } catch { /* not remembered */ }
  }, [t, on])
  useEffect(() => {
    const f = (e: Event): void => {
      const d = (e as CustomEvent<{ key: string; value: string }>).detail
      if (d.key === 'bursts') setOn((o) => ({ ...o, sim: d.value !== '0' }))
    }
    window.addEventListener('shotdrop:prefs', f)
    return () => window.removeEventListener('shotdrop:prefs', f)
  }, [])
  // A switched-off detector gets a threshold nothing can cross, so analyze() stays one pure function.
  const effective = useMemo<CullThresholds>(() => ({
    ...t,
    ...(on.sim ? {} : { maxGapMs: -1 }),
    ...(on.blur ? {} : { softRatio: 0, softAbs: 0 }),
    ...(on.eyes ? {} : { blinkAt: 1 }),
    ...(on.expo ? {} : { clipAt: 101, darkAt: 101 })
  }), [t, on])
  return {
    t,
    on,
    effective,
    set: (k: TKey, v: number) => setT((x) => ({ ...x, [k]: v })),
    toggle: (k: DetKey) => (k === 'sim' ? setPref('bursts', on.sim ? '0' : '1') : setOn((o) => ({ ...o, [k]: !o[k] }))),
    reset: () => setT(CULL_DEFAULTS)
  }
}
export type CullUI = ReturnType<typeof useCullSettings>

/** The frames each detector flags, out of the given (session/camera-scoped) list. */
export function flaggedBy(shots: Shot[], cull: Map<number, Cull>): Record<DetKey, Shot[]> {
  const out = {} as Record<DetKey, Shot[]>
  for (const d of DETECTORS) out[d.k] = shots.filter((s) => matchFilter(s, d.filter, cull))
  return out
}

const tint = (d: Detector): CSSProperties => ({ ['--c' as string]: d.color })

export function DetIcon({ d, size = 14 }: { d: Detector; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d.icon} />
    </svg>
  )
}

/** Small coloured icons on a thumbnail saying why it was flagged. Similar shots already show as a burst box. */
export function FlagBadges({ c }: { c?: Cull }) {
  if (!c) return null
  const why: [DetKey, boolean][] = [['blur', c.soft], ['eyes', c.blink], ['expo', c.exposure]]
  return (
    <>
      {why.filter(([, v]) => v).map(([k]) => {
        const d = DETECTORS.find((x) => x.k === k)!
        return <span key={k} className="badge dbadge" style={tint(d)} title={d.name} aria-label={d.name}><DetIcon d={d} size={12} /></span>
      })}
    </>
  )
}

/** Quick on/off chips for the grid toolbar. */
export function DetectorChips({ ui, flagged }: { ui: CullUI; flagged: Record<DetKey, Shot[]> }) {
  return (
    <>
      {DETECTORS.map((d) => {
        const on = ui.on[d.k]
        return (
          <button key={d.k} className={`chip dchip ${on ? 'on' : ''}`} style={tint(d)} aria-pressed={on} title={`${on ? 'Turn off' : 'Turn on'} ${d.name}`} onClick={() => ui.toggle(d.k)}>
            <DetIcon d={d} size={13} />
            {d.short}
            <span className="n">{on ? flagged[d.k].length : 'off'}</span>
          </button>
        )
      })}
    </>
  )
}

interface PanelProps {
  ui: CullUI
  flagged: Record<DetKey, Shot[]>
  filter: string
  onFilter: (f: GridFilter) => void
  onPatch: (ids: number[], p: ShotPatch) => void
  onBestOfBursts: () => void
}

/** Right-hand culling panel. Collapses to an icon rail rather than disappearing. */
export function CullPanel({ ui, flagged, filter, onFilter, onPatch, onBestOfBursts }: PanelProps) {
  const [open, setOpenRaw] = useState(() => {
    try { return localStorage.getItem('shotdrop.cullPanel') !== '0' } catch { return true }
  })
  const setOpen = (v: boolean): void => {
    setOpenRaw(v)
    try { localStorage.setItem('shotdrop.cullPanel', v ? '1' : '0') } catch { /* not remembered */ }
  }

  if (!open) {
    return (
      <aside className="cp cp-rail" aria-label="Culling">
        <button className="cp-railbtn" onClick={() => setOpen(true)} aria-label="Open culling panel" title="Open culling panel"><Icon name="prev" size={14} /></button>
        {DETECTORS.map((d) => (
          <button key={d.k} className={`cp-railbtn ${ui.on[d.k] ? 'on' : ''}`} style={tint(d)} title={d.name} aria-label={`${d.name}: ${ui.on[d.k] ? flagged[d.k].length : 'off'}`} onClick={() => { setOpen(true); if (!ui.on[d.k]) ui.toggle(d.k) }}>
            <DetIcon d={d} size={16} />
            <span>{ui.on[d.k] ? flagged[d.k].length : '–'}</span>
          </button>
        ))}
      </aside>
    )
  }

  return (
    <aside className="cp" aria-label="Culling">
      <header className="cp-h">
        <strong>Culling</strong>
        <button className="tb" onClick={() => setOpen(false)} aria-label="Collapse culling panel" title="Collapse"><Icon name="next" size={14} /></button>
      </header>
      <div className="cp-body">
        {DETECTORS.map((d) => {
          const on = ui.on[d.k]
          const list = flagged[d.k]
          const ids = list.filter((s) => s.flag === 0).map((s) => s.id) // leave picks and existing rejects alone
          const showing = filter === d.filter
          return (
            <section key={d.k} className={`cp-card ${on ? 'on' : ''}`} style={tint(d)}>
              <div className="cp-row">
                <span className="cp-ic"><DetIcon d={d} size={15} /></span>
                <span className="cp-name">{d.name}</span>
                <span className="cp-n">{on ? `${list.length} flagged` : 'off'}</span>
                <button role="switch" aria-checked={on} aria-label={d.name} className={`sw cp-sw ${on ? 'on' : ''}`} onClick={() => ui.toggle(d.k)}><i /></button>
              </div>
              <AnimatePresence initial={false}>
                {on && (
                  <motion.div className="cp-more" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={firm}>
                    <div className="cp-inner">
                      <p className="cp-help">{d.help}</p>
                      {d.sliders.map((sl) => (
                        <label key={sl.key} className="cp-sl">
                          <span className="cp-sl-h"><span>{sl.label}</span><b>{sl.fmt(ui.t[sl.key])}</b></span>
                          <input type="range" min={sl.min} max={sl.max} step={sl.step} value={ui.t[sl.key]} onChange={(e) => ui.set(sl.key, Number(e.target.value))} />
                          <span className="cp-sl-f"><span>{sl.lo}</span><span>Default {sl.fmt(CULL_DEFAULTS[sl.key])}</span><span>{sl.hi}</span></span>
                        </label>
                      ))}
                      <div className="cp-acts">
                        <button className={`tb ${showing ? 'on' : ''}`} aria-pressed={showing} onClick={() => onFilter(showing ? 'all' : d.filter)}>{showing ? 'Show all' : 'Show only these'}</button>
                        <button className="tb cp-rej" disabled={!ids.length} onClick={() => onPatch(ids, { flag: -1 })}>Reject {ids.length}</button>
                      </div>
                      {d.k === 'sim' && <button className="tb cp-best" onClick={onBestOfBursts}>Pick the best of every burst</button>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )
        })}
      </div>
      <footer className="cp-f">
        <span>Reject only marks frames. Nothing is deleted.</span>
        <button className="tb" onClick={ui.reset}>Reset to defaults</button>
      </footer>
    </aside>
  )
}
