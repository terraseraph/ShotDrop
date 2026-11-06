import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Label, Shot, ShotPatch } from '@shared/types'
import { analyze, type Cull } from '@shared/cull'
import { MotionConfig } from 'motion/react'
import { useLibrary } from './useLibrary'
import { api, desktop, isRemote } from './api'
import { riseIn } from './motion'
import { useSessionNames } from './sessions'
import { TopBar, type View } from './components/TopBar'
import { Compare } from './components/Compare'
import { useCullSettings } from './components/CullPanel'
import { matchFilter } from './components/FilterChips'
import { TransferStrip } from './components/TransferStrip'
import { NavContext, TabBar, type TabId } from './components/TabBar'
import { Loupe } from './components/Loupe'
import { Filmstrip } from './components/Filmstrip'
import { Grid } from './components/Grid'
import { SessionHeader } from './components/SessionHeader'
import { SyncPage, MobileSync } from './components/SyncBoard'
import { InfoPanel } from './components/InfoPanel'
import { SetupScreen } from './components/SetupScreen'
import { SettingsDrawer, MobileSettings } from './components/SettingsDrawer'
import { Dock } from './components/Dock'
import { type Tab } from './components/SettingsDrawer'
import { PinGate } from './components/PinGate'
import { Shortcuts } from './components/Shortcuts'
import { DeleteWarning } from './components/DeleteWarning'
import { DeleteConfirm } from './components/DeleteConfirm'
import { MobileLoupe, MobileTop } from './components/MobileLoupe'
import type { Burst } from './components/Loupe'
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
  // Phones reach the app as remote browsers; in dev a plain browser tab (no ?desktop) stands in so the phone layout can be checked.
  const on = (isRemote || (import.meta.env.DEV && !desktop)) && m
  useEffect(() => {
    document.documentElement.classList.toggle('mobile', on)
  }, [on])
  return on
}

const LABEL_KEYS: Record<string, Label> = { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' }

function applyFilter(shots: Shot[], f: string, session: string, source: string, cull: Map<number, Cull>): Shot[] {
  return shots.filter((s) => (!session || s.session === session) && (!source || s.source === source) && matchFilter(s, f, cull))
}

export default function App() {
  const [view, setView] = useState<View>('loupe')
  const [follow, setFollow] = useState(true)
  const [filter, setFilter] = useState('all')
  const [syncOpen, setSyncOpen] = useState(false)
  const [compareIds, setCompareIds] = useState<number[]>([])
  const [session, setSession] = useState('')
  const [source, setSource] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [infoOpen, setInfoOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<Tab>('camera')
  const [helpOpen, setHelpOpen] = useState(false)
  const [deleting, setDeleting] = useState<{ shots: Shot[]; advance: boolean } | null>(null)
  const [setupOpen, setSetupOpen] = useState(false) // dialog, opened from Settings
  const [wizard, setWizard] = useState(false) // full-page first-run flow, held open until the test shot is seen
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [liveOpen, setLiveOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const mobile = useMobile()
  const emptyRef = useRef(true)
  const sessionNames = useSessionNames()
  const { reload: reloadNames } = sessionNames
  useEffect(reloadNames, [view, reloadNames]) // the grid's rail renames sessions in the same store
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

  // Comparing pauses Follow so a new frame doesn't yank the panes away; it resumes when you leave.
  const resumeFollow = useRef(false)
  useEffect(() => {
    if (view === 'compare') {
      resumeFollow.current = followRef.current
      setFollow(false)
    } else if (resumeFollow.current) {
      resumeFollow.current = false
      setFollow(true)
    }
  }, [view])

  const lib = useLibrary(onArrival)
  // Open on the newest session, like a day's shoot, rather than the whole library.
  const sessionInit = useRef(false)
  useEffect(() => {
    if (sessionInit.current || !lib.shots.length) return
    sessionInit.current = true
    setSession(lib.shots.reduce((m, s) => (s.session > m ? s.session : m), ''))
  }, [lib.shots])
  const openSettings = (tab: Tab = 'camera'): void => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }
  const cullUI = useCullSettings()
  const cull = useMemo(() => analyze(lib.shots, cullUI.effective), [lib.shots, cullUI.effective])
  const visible = useMemo(() => applyFilter(lib.shots, filter, session, source, cull), [lib.shots, filter, session, source, cull])
  const inSession = useMemo(() => (session ? lib.shots.filter((s) => s.session === session) : lib.shots), [lib.shots, session])
  const index = visible.findIndex((s) => s.id === selectedId)
  const selected = index >= 0 ? visible[index] : null
  const picksDest = lib.status?.destinations.find((d) => d.filter === 'picks' && d.enabled)?.name ?? null
  const burstMembers = useMemo(() => {
    const g = selected ? cull.get(selected.id)?.group : undefined
    return g === undefined ? [] : visible.filter((s) => cull.get(s.id)?.group === g).sort((a, b) => a.capturedAt - b.capturedAt || a.id - b.id)
  }, [selected, visible, cull])
  // Compare shows the frames you chose in the grid; otherwise the burst you are in; otherwise nothing (never unrelated neighbours).
  const chosen = useMemo(() => compareIds.flatMap((id) => lib.shots.find((s) => s.id === id) ?? []), [compareIds, lib.shots])
  const compareIsBurst = chosen.length === 0 && burstMembers.length > 1
  const compareShots = chosen.length ? chosen : compareIsBurst ? burstMembers : []
  const c = selected ? cull.get(selected.id) : undefined
  const burst: Burst | null = selected && c ? { index: burstMembers.findIndex((s) => s.id === selected.id) + 1, size: c.size, best: c.best, soft: c.soft, blink: c.blink } : null

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
      if (deleting || settingsOpen || syncOpen || (e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Shift+digit types '!' on most layouts; the physical key tells us which rating was meant.
      const k = /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key
      const id = selected?.id
      // The Compare view handles its own culling keys (1-4 pick a pane, Shift+1-5 rate, P, Esc); we only keep view switching there.
      if (view === 'compare' && !['l', 'L', 'g', 'G', 'c', 'e', 'E', 'i', '?'].includes(k)) return
      let shiftAdvance = true
      try {
        shiftAdvance = localStorage.getItem('shotdrop.pref.shiftAdvance') !== '0'
      } catch {
        /* storage blocked: default on */
      }
      const advance = (): void => {
        if (e.shiftKey && shiftAdvance) move(1)
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
      else if (k === 'c') setView((v) => (v === 'compare' ? 'loupe' : 'compare'))
      else if (k === 'C') setCompareIds([])
      else if (k === 'l' || k === 'L') setView('loupe')
      else if (k === 'f' || k === 'F') setFollow((f) => !f)
      else if (k === 'g' || k === 'G') setView('grid')
      else if (k === 'e' || k === 'E' || (k === 'Enter' && view === 'grid')) setView('loupe')
      else if (k === 'Escape' && view === 'loupe') setView('grid')
      else if (k === 'Escape' && view === 'grid' && compareIds.length) setCompareIds([])
      else if (k === 'i' || k === 'I') setInfoOpen((o) => !o)
      else if (k === '?') setHelpOpen((o) => !o)
      else if (k === 'Delete' && id && selected) setDeleting({ shots: [selected], advance: true })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, visible, view, move, lib, settingsOpen, syncOpen, compareIds.length, deleting])

  if (lib.needsPin) return <PinGate onUnlocked={lib.reload} />
  // Nothing until the first load settles, so remote visitors don't see the empty state flash before the PIN prompt.
  if (!lib.loaded) return <div className="app" />

  const empty = lib.shots.length === 0
  emptyRef.current = empty
  const patchSelected = (p: ShotPatch): void => {
    if (selected) void lib.patch([selected.id], p)
  }
  const onSync = (): void => {
    setSettingsOpen(false)
    setSyncOpen((o) => !o)
  }
  const share = (): void => {
    if (!selected) return
    const url = new URL(api.previewUrl(selected), location.href).href
    if (navigator.share) void navigator.share({ title: selected.name, url }).catch(() => undefined)
    else void navigator.clipboard?.writeText(url).then(() => lib.toast('Link copied'), () => lib.toast('Could not copy the link', 'error'))
  }
  const navigate = (t: TabId): void => {
    setSettingsOpen(false)
    setSyncOpen(false)
    setSetupOpen(false)
    setWizard(false)
    if (t === 'camera') setWizard(true)
    else if (t === 'sync') setSyncOpen(true)
    else if (t === 'settings') openSettings()
  }
  const tab: TabId = syncOpen ? 'sync' : settingsOpen ? 'settings' : wizard ? 'camera' : 'gallery'
  const best = burstMembers.find((s) => cull.get(s.id)?.best)
  const toasts = (
    <div className="toasts" aria-live="polite">
      {lib.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
      ))}
    </div>
  )

  // Phone Sync and Settings are full pages that bring their own tab bar (MSync / MSettings boards).
  if (mobile && (syncOpen || settingsOpen)) {
    return (
      <MotionConfig reducedMotion="user">
        <NavContext.Provider value={navigate}>
          <div className="app is-mobile">
            {syncOpen ? <MobileSync status={lib.status} toast={lib.toast} /> : <MobileSettings status={lib.status} toast={lib.toast} />}
            {toasts}
          </div>
        </NavContext.Provider>
      </MotionConfig>
    )
  }

  return (
    <MotionConfig reducedMotion="user">
    <NavContext.Provider value={navigate}>
    <div className={`app ${mobile ? 'is-mobile' : ''}`}>
      {mobile && view === 'grid' ? null : mobile ? (
        <>
          <MobileTop
            title={sessionNames.title(session)}
            shots={lib.shots}
            session={session}
            onSession={setSession}
            sessionNames={sessionNames}
            visibleCount={visible.length}
            sub={`${index >= 0 ? index + 1 : visible.length} of ${visible.length}${follow ? ' · following' : ''}`}
            follow={follow}
            onFollow={setFollow}
            onGrid={() => setView((v) => (v === 'grid' ? 'loupe' : 'grid'))}
            onMenu={() => setSheetOpen(true)}
          />
          <TransferStrip status={lib.status} shots={lib.shots} onSync={onSync} mobile />
        </>
      ) : (
        <>
          <TopBar
            status={lib.status}
            connected={lib.connected}
            shots={lib.shots}
            session={session}
            onSession={setSession}
            sessionNames={sessionNames}
            visibleCount={visible.length}
            follow={follow}
            onFollow={setFollow}
            view={view}
            onView={setView}
            onSettings={() => openSettings()}
            onSync={onSync}
            syncOpen={syncOpen}
            onHelp={() => setHelpOpen(true)}
            onPhone={() => setPhoneOpen(true)}
            onLive={() => setLiveOpen(true)}
          />
          <TransferStrip status={lib.status} shots={lib.shots} onSync={onSync} />
        </>
      )}

      <div className="main-row">
        {empty || wizard ? (
          <SetupScreen
            status={lib.status}
            shots={lib.shots}
            onBack={empty ? null : () => setWizard(false)}
            onGallery={(id) => { setWizard(false); setSelectedId(id); setView('loupe') }}
          />
        ) : (
          <div className="workspace">
            <main className="stage">
              {view === 'loupe' ? (
                mobile ? (
                  <>
                    <MobileLoupe shot={selected} position={Math.min(2, index)} neighbours={Math.min(5, visible.length)} burst={burst} onPrev={() => move(-1)} onNext={() => move(1)} />
                    <ActionBar shot={selected} onPatch={patchSelected} onBurst={burst && burst.size > 1 && best ? () => select(best.id) : null} onShare={share} />
                    <Filmstrip shots={visible} selectedId={selected?.id ?? null} freshIds={freshIds} follow={follow} cull={cull} onSelect={select} />
                  </>
                ) : (
                  <>
                    <div className="loupe-row">
                      <div className="loupe-main">
                        <SessionHeader shots={inSession} source={source} onSource={setSource} />
                        <Loupe shot={selected} fresh={selected ? freshIds.has(selected.id) : false} follow={follow} burst={burst} picksDest={picksDest} onPatch={patchSelected} onPrev={() => move(-1)} onNext={() => move(1)} />
                      </div>
                      {infoOpen && <InfoPanel shot={selected} status={lib.status} />}
                    </div>
                    <Filmstrip shots={visible} selectedId={selected?.id ?? null} freshIds={freshIds} follow={follow} cull={cull} onSelect={select} />
                  </>
                )
              ) : view === 'grid' ? (
                <Grid
                  shots={visible}
                  cull={cull}
                  selectedId={selected?.id ?? null}
                  freshIds={freshIds}
                  onSelect={select}
                  onOpen={(id) => { select(id); setView('loupe') }}
                  onPatch={(ids, p) => void lib.patch(ids, p)}
                  tapOpens={mobile}
                  mobile={mobile}
                  allShots={lib.shots}
                  filter={filter}
                  onFilter={setFilter}
                  session={session}
                  onSession={setSession}
                  source={source}
                  onSource={setSource}
                  onDeleteRejects={(ids) => setDeleting({ shots: lib.shots.filter((s) => ids.includes(s.id)), advance: false })}
                  cullUI={cullUI}
                  chosen={compareIds}
                  onChosen={setCompareIds}
                  onCompare={() => setView('compare')}
                />
              ) : (
                <Compare
                  shots={compareShots}
                  burst={compareIsBurst}
                  cull={cull}
                  onPick={(id) => void lib.patch([id], { flag: 1 })}
                  onReject={(id) => void lib.patch([id], { flag: -1 })}
                  onUnflag={(id) => void lib.patch([id], { flag: 0 })}
                  onRate={(id, n) => void lib.patch([id], { rating: n })}
                  onClear={() => setCompareIds([])}
                  onKeep={setCompareIds}
                  onAdd={() => { setCompareIds(compareShots.map((s) => s.id)); setView('grid') }}
                  onClose={() => setView('grid')}
                  mobile={mobile}
                />
              )}
            </main>
          </div>
        )}
      </div>

      {!(mobile && view === 'grid') && <Dock status={lib.status} onSync={onSync} onPhone={() => setPhoneOpen(true)} mobile={mobile} />}
      {mobile && view !== 'grid' && <TabBar current={tab} />}

      {settingsOpen && !isRemote && !mobile && <SettingsDrawer status={lib.status} tab={settingsTab} onClose={() => setSettingsOpen(false)} toast={lib.toast} onSetup={() => { setSettingsOpen(false); setSetupOpen(true) }} onOpenSync={() => { setSettingsOpen(false); setSyncOpen(true) }} />}
      {syncOpen && !isRemote && !mobile && <SyncPage status={lib.status} toast={lib.toast} onClose={() => setSyncOpen(false)} />}
      {setupOpen && !empty && !wizard && !isRemote && (
        <SetupScreen dialog status={lib.status} shots={lib.shots} onBack={() => setSetupOpen(false)} onGallery={() => setSetupOpen(false)} />
      )}
      <AnimatePresence>
        {mobile && sheetOpen && (
          <motion.div className="sheet-backdrop scrim" onClick={() => setSheetOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="sheet m-sheet" role="dialog" aria-label="Photo info" onClick={(e) => e.stopPropagation()} {...riseIn}>
              <div className="sheet-grab" />
              <InfoPanel shot={selected} status={lib.status} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {phoneOpen && !isRemote && <ViewOnPhone status={lib.status} shot={selected} anchor={document.querySelector<HTMLElement>('button[aria-label="Phone and public link"]')} onClose={() => setPhoneOpen(false)} />}
      {liveOpen && !isRemote && <LiveView status={lib.status} onClose={() => setLiveOpen(false)} />}
      {helpOpen && <Shortcuts onClose={() => setHelpOpen(false)} />}
      {deleting && (
        <DeleteConfirm
          shots={deleting.shots}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting
            setDeleting(null)
            if (d.advance) move(1)
            for (const s of d.shots) void lib.remove(s.id)
          }}
        />
      )}
      {lib.deleteFailure && <DeleteWarning failed={lib.deleteFailure} onClose={lib.clearDeleteFailure} />}

      {toasts}
    </div>
    </NavContext.Provider>
    </MotionConfig>
  )
}

function gridCols(): number {
  const grid = document.querySelector('.grid')
  if (!grid) return 1
  return getComputedStyle(grid).gridTemplateColumns.split(' ').length
}
