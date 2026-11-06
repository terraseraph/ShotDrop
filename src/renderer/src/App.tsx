import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Label, Shot } from '@shared/types'
import { useLibrary } from './useLibrary'
import { isRemote } from './api'
import { TopBar, type Filter } from './components/TopBar'
import { Loupe } from './components/Loupe'
import { Filmstrip } from './components/Filmstrip'
import { Grid } from './components/Grid'
import { SessionHeader } from './components/SessionHeader'
import { InfoPanel } from './components/InfoPanel'
import { EmptyState } from './components/EmptyState'
import { SettingsDrawer } from './components/SettingsDrawer'
import { PinGate } from './components/PinGate'
import { Shortcuts } from './components/Shortcuts'

const LABEL_KEYS: Record<string, Label> = { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' }

function applyFilter(shots: Shot[], f: Filter, session: string, source: string): Shot[] {
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
  const [helpOpen, setHelpOpen] = useState(false)
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set())
  const followRef = useRef(follow)
  followRef.current = follow

  const onArrival = useCallback((shot: Shot) => {
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
  const visible = useMemo(() => applyFilter(lib.shots, filter, session, source), [lib.shots, filter, session, source])
  const inSession = useMemo(() => (session ? lib.shots.filter((s) => s.session === session) : lib.shots), [lib.shots, session])
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
      else if (k === 'f' || k === 'F') setFollow((f) => !f)
      else if (k === 'g' || k === 'G') setView('grid')
      else if (k === 'e' || k === 'E' || (k === 'Enter' && view === 'grid')) setView('loupe')
      else if (k === 'Escape' && view === 'loupe') setView('grid')
      else if (k === 'i' || k === 'I') setInfoOpen((o) => !o)
      else if (k === '?') setHelpOpen((o) => !o)
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
  }, [selected, visible, view, move, lib, settingsOpen])

  if (lib.needsPin) return <PinGate onUnlocked={lib.reload} />
  // Nothing until the first load settles, so remote visitors don't see the empty state flash before the PIN prompt.
  if (!lib.loaded) return <div className="app" />

  const empty = lib.shots.length === 0

  return (
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
        onSettings={() => setSettingsOpen(true)}
        onHelp={() => setHelpOpen(true)}
        visibleCount={visible.length}
      />

      {empty ? (
        <EmptyState status={lib.status} onSettings={() => setSettingsOpen(true)} />
      ) : (
        <div className={`workspace ${infoOpen ? 'with-info' : ''}`}>
          <main className="stage">
            <SessionHeader shots={inSession} session={session} source={source} onSource={setSource} />
            {view === 'loupe' ? (
              <>
                <Loupe shot={selected} fresh={selected ? freshIds.has(selected.id) : false} follow={follow} onPrev={() => move(-1)} onNext={() => move(1)} />
                <Filmstrip shots={visible} selectedId={selected?.id ?? null} freshIds={freshIds} onSelect={select} />
              </>
            ) : (
              <Grid shots={visible} selectedId={selected?.id ?? null} freshIds={freshIds} onSelect={select} onOpen={(id) => { select(id); setView('loupe') }} />
            )}
          </main>
          {infoOpen && <InfoPanel shot={selected} status={lib.status} onPatch={(p) => selected && lib.patch([selected.id], p)} />}
        </div>
      )}

      {settingsOpen && !isRemote && <SettingsDrawer status={lib.status} onClose={() => setSettingsOpen(false)} toast={lib.toast} />}
      {helpOpen && <Shortcuts onClose={() => setHelpOpen(false)} />}

      <div className="toasts" aria-live="polite">
        {lib.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
        ))}
      </div>
    </div>
  )
}

function gridCols(): number {
  const grid = document.querySelector('.grid')
  if (!grid) return 1
  return getComputedStyle(grid).gridTemplateColumns.split(' ').length
}
