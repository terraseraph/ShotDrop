import { AnimatePresence } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Label, Shot } from '@shared/types'
import { analyze, type Cull } from '@shared/cull'
import { MotionConfig } from 'motion/react'
import { useLibrary } from './useLibrary'
import { isRemote } from './api'
import { TopBar, type Filter } from './components/TopBar'
import { Loupe } from './components/Loupe'
import { Filmstrip } from './components/Filmstrip'
import { Grid } from './components/Grid'
import { SessionHeader } from './components/SessionHeader'
import { InfoPanel } from './components/InfoPanel'
import { SetupScreen } from './components/SetupScreen'
import { SettingsDrawer } from './components/SettingsDrawer'
import { Dock } from './components/Dock'
import { type Tab } from './components/SettingsDrawer'
import { PinGate } from './components/PinGate'
import { Shortcuts } from './components/Shortcuts'
import { DeleteWarning } from './components/DeleteWarning'
import { MobileLoupe } from './components/MobileLoupe'
import { ActionBar } from './components/ActionBar'
import { ViewOnPhone } from './components/ViewOnPhone'
import { LiveView } from './components/LiveView'

/** Phone layout: remote browsers at phone widths. The desktop window never switches. */
function useMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const f = (): void => setM(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  const on = isRemote && m
  useEffect(() => {
    document.documentElement.classList.toggle('mobile', on)
  }, [on])
  return on
}

const LABEL_KEYS: Record<string, Label> = { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' }

function applyFilter(shots: Shot[], f: Filter, session: string, source: string, cull: Map<number, Cull>): Shot[] {
  return shots.filter((s) => {
    if (session && s.session !== session) return false
    if (source && s.source !== source) return false
    switch (f) {
      case 'picks':
        return s.flag === 1
      case 'rated':
        return s.rating > 0
      case 'rejects':
        return s.flag === -1
      case 'unrejected':
        return s.flag !== -1
      case 'best':
        return cull.get(s.id)?.best !== false
      case 'soft':
        return cull.get(s.id)?.soft === true
      case 'blink':
        return cull.get(s.id)?.blink === true
      default:
        return true
    }
  })
}

export default function App() {
  const [view, setView] = useState<'loupe' | 'grid'>('loupe')
  const [follow, setFollow] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [session, setSession] = useState('')
  const [source, setSource] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [infoOpen, setInfoOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<Tab>('camera')
  const [dockOpen, setDockOpen] = useState(() => {
    try {
      return localStorage.getItem('shotdrop.dock') === '1'
    } catch {
      return false
    }
  })
  const [helpOpen, setHelpOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false) // dialog, opened from Settings
  const [wizard, setWizard] = useState(false) // full-page first-run flow, held open until the test shot is seen
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [liveOpen, setLiveOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const mobile = useMobile()
  const emptyRef = useRef(true)
  const [compare, setCompare] = useState<number[]>([])
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set())
  const followRef = useRef(follow)
  followRef.current = follow

  const onArrival = useCallback((shot: Shot) => {
    // First shot ever: keep the setup screen up so it can show the test shot.
    if (emptyRef.current) setWizard(true)
    setFreshIds((s) => new Set(s).add(shot.id))
    setTimeout(() => setFreshIds((s) => {
      const n = new Set(s)
      n.delete(shot.id)
      return n
    }), 4000)
    if (followRef.current) {
      setSelectedId(shot.id)
      setSession((cur) => (cur && cur !== shot.session ? shot.session : cur))
    }
  }, [])

  const lib = useLibrary(onArrival)
  const toggleDock = useCallback(() => {
    setDockOpen((o) => {
      try {
        localStorage.setItem('shotdrop.dock', o ? '0' : '1')
      } catch {
        /* storage blocked: the dock just won't be remembered */
      }
      return !o
    })
  }, [])
  const openSettings = (tab: Tab = 'camera'): void => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }
  const cull = useMemo(() => analyze(lib.shots), [lib.shots])
  const visible = useMemo(() => applyFilter(lib.shots, filter, session, source, cull), [lib.shots, filter, session, source, cull])
  const inSession = useMemo(() => (session ? lib.shots.filter((s) => s.session === session) : lib.shots), [lib.shots, session])
  const compareShots = useMemo(() => compare.flatMap((id) => lib.shots.find((s) => s.id === id) ?? []), [compare, lib.shots])
  const index = visible.findIndex((s) => s.id === selectedId)
  const selected = index >= 0 ? visible[index] : null

  // Keep a valid selection: default to the newest visible shot.
  useEffect(() => {
    if (!selected && visible.length) setSelectedId(visible[visible.length - 1].id)
  }, [selected, visible])

  const move = useCallback(
    (delta: number) => {
      if (!visible.length) return
      const i = Math.max(0, Math.min(visible.length - 1, (index < 0 ? visible.length - 1 : index) + delta))
      setSelectedId(visible[i].id)
      // Browsing backwards means the user wants to look at something; stop jumping to new frames.
      if (delta < 0 && followRef.current) setFollow(false)
    },
    [visible, index]
  )

  const select = useCallback((id: number) => {
    setSelectedId(id)
    if (followRef.current && visible.length && visible[visible.length - 1].id !== id) setFollow(false)
  }, [visible])

  // Keyboard-first culling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (settingsOpen || (e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      const id = selected?.id
      const advance = (): void => {
        if (e.shiftKey) move(1)
      }
      if (k === 'ArrowRight' || k === 'ArrowDown') move(view === 'grid' && k === 'ArrowDown' ? gridCols() : 1)
      else if (k === 'ArrowLeft' || k === 'ArrowUp') move(view === 'grid' && k === 'ArrowUp' ? -gridCols() : -1)
      else if (k === 'Home') visible[0] && setSelectedId(visible[0].id)
      else if (k === 'End') {
        visible.length && setSelectedId(visible[visible.length - 1].id)
      } else if (/^[0-5]$/.test(k) && id) {
        void lib.patch([id], { rating: Number(k) })
        advance()
      } else if (LABEL_KEYS[k] && id) void lib.patch([id], { label: selected?.label === LABEL_KEYS[k] ? null : LABEL_KEYS[k] })
      else if ((k === 'p' || k === 'P') && id) {
        void lib.patch([id], { flag: 1 })
        advance()
      } else if ((k === 'x' || k === 'X') && id) {
        void lib.patch([id], { flag: -1 })
        advance()
      } else if ((k === 'u' || k === 'U') && id) void lib.patch([id], { flag: 0 })
      else if (k === 'C') setCompare([])
      else if (k === 'c' && id) setCompare((c) => (c.includes(id) ? c : [...c, id].slice(-4)))
      else if (k === 'f' || k === 'F') setFollow((f) => !f)
      else if (k === 'g' || k === 'G') setView('grid')
      else if (k === 'e' || k === 'E' || (k === 'Enter' && view === 'grid')) setView('loupe')
      else if (k === 'Escape' && view === 'loupe') setView('grid')
      else if (k === 'i' || k === 'I') setInfoOpen((o) => !o)
      else if (k === '?') setHelpOpen((o) => !o)
      else if (k === ',' && !isRemote) toggleDock()
      else if (k === 'Delete' && id && selected) {
        if (confirm(`Move ${selected.files.map((f) => f.name).join(' + ')} to the recycle bin?`)) {
          move(1)
          void lib.remove(id)
        }
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, visible, view, move, lib, settingsOpen, toggleDock])

  if (lib.needsPin) return <PinGate onUnlocked={lib.reload} />
  // Nothing until the first load settles, so remote visitors don't see the empty state flash before the PIN prompt.
  if (!lib.loaded) return <div className="app" />

  const empty = lib.shots.length === 0
  emptyRef.current = empty

  return (
    <MotionConfig reducedMotion="user">
    <div className="app">
      <TopBar
        status={lib.status}
        connected={lib.connected}
        shots={lib.shots}
        session={session}
        onSession={setSession}
        filter={filter}
        onFilter={setFilter}
        follow={follow}
        onFollow={setFollow}
        view={view}
        onView={setView}
        onSettings={() => openSettings()}
        dockOpen={dockOpen}
        onDock={toggleDock}
        onHelp={() => setHelpOpen(true)}
        onPhone={() => setPhoneOpen(true)}
        onLive={() => setLiveOpen(true)}
        mobile={mobile}
        visibleCount={visible.length}
      />

      <div className="main-row">
        {empty || wizard ? (
          <SetupScreen
            status={lib.status}
            shots={lib.shots}
            onBack={empty ? null : () => setWizard(false)}
            onGallery={(id) => { setWizard(false); setSelectedId(id); setView('loupe') }}
          />
        ) : (
          <div className={`workspace ${infoOpen && !mobile ? 'with-info' : ''}`}>
            <main className="stage">
              <SessionHeader shots={inSession} session={session} source={source} onSource={setSource} />
              {view === 'loupe' ? (
                mobile ? (
                  <>
                    <MobileLoupe shot={selected} onPrev={() => move(-1)} onNext={() => move(1)} />
                    <ActionBar shot={selected} onPatch={(p) => selected && lib.patch([selected.id], p)} onInfo={() => setSheetOpen(true)} />
                  </>
                ) : (
                <>
                  <Loupe shot={selected} fresh={selected ? freshIds.has(selected.id) : false} follow={follow} onPrev={() => move(-1)} onNext={() => move(1)} />
                  <Filmstrip shots={visible} selectedId={selected?.id ?? null} freshIds={freshIds} onSelect={select} />
                </>
                )
              ) : (
                <Grid shots={visible} cull={cull} selectedId={selected?.id ?? null} freshIds={freshIds} onSelect={select} onOpen={(id) => { select(id); setView('loupe') }} onPatch={(ids, p) => void lib.patch(ids, p)} tapOpens={mobile} />
              )}
            </main>
            {infoOpen && !mobile && <InfoPanel shot={selected} status={lib.status} compare={compareShots} onSelect={select} onPatch={(p) => selected && lib.patch([selected.id], p)} />}
          </div>
        )}
        <AnimatePresence>
          {dockOpen && !isRemote && <Dock status={lib.status} activity={lib.activity} onSettings={openSettings} toast={lib.toast} />}
        </AnimatePresence>
      </div>

      {settingsOpen && !isRemote && <SettingsDrawer status={lib.status} tab={settingsTab} onClose={() => setSettingsOpen(false)} toast={lib.toast} onSetup={() => { setSettingsOpen(false); setSetupOpen(true) }} />}
      {setupOpen && !empty && !wizard && !isRemote && (
        <SetupScreen dialog status={lib.status} shots={lib.shots} onBack={() => setSetupOpen(false)} onGallery={() => setSetupOpen(false)} />
      )}
      {mobile && sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="sheet" role="dialog" aria-label="Photo info" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grab" />
            <InfoPanel shot={selected} status={lib.status} compare={[]} onSelect={select} onPatch={(p) => selected && lib.patch([selected.id], p)} />
          </div>
        </div>
      )}
      {phoneOpen && !isRemote && <ViewOnPhone status={lib.status} onClose={() => setPhoneOpen(false)} />}
      {liveOpen && !isRemote && <LiveView status={lib.status} onClose={() => setLiveOpen(false)} />}
      {helpOpen && <Shortcuts onClose={() => setHelpOpen(false)} />}
      {lib.deleteFailure && <DeleteWarning failed={lib.deleteFailure} onClose={lib.clearDeleteFailure} />}

      <div className="toasts" aria-live="polite">
        {lib.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
        ))}
      </div>
    </div>
    </MotionConfig>
  )
}

function gridCols(): number {
  const grid = document.querySelector('.grid')
  if (!grid) return 1
  return getComputedStyle(grid).gridTemplateColumns.split(' ').length
}
