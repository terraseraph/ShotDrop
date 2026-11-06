import { createContext, useContext } from 'react'

export type TabId = 'gallery' | 'camera' | 'sync' | 'settings'

/** App provides this so any phone screen can render <TabBar current="sync" /> without wiring props. */
export const NavContext = createContext<(tab: TabId) => void>(() => undefined)

const TABS: { id: TabId; label: string; path: string }[] = [
  { id: 'gallery', label: 'Gallery', path: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { id: 'camera', label: 'Camera', path: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' },
  { id: 'sync', label: 'Sync', path: 'M21 12a9 9 0 0 1-15.5 6.3M3 12a9 9 0 0 1 15.5-6.3M21 4v5h-5M3 20v-5h5' },
  { id: 'settings', label: 'Settings', path: 'M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M8 16v4' }
]

/** Phone bottom navigation: 56px plus the home-indicator inset, every target 44px+. `onSelect` overrides the App-provided navigation. */
export function TabBar({ current, onSelect }: { current: TabId; onSelect?: (t: TabId) => void }) {
  const nav = useContext(NavContext)
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <button key={t.id} className={t.id === current ? 'on' : ''} aria-current={t.id === current ? 'page' : undefined} onClick={() => (onSelect ?? nav)(t.id)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={t.path} />
          </svg>
          {t.label}
        </button>
      ))}
    </nav>
  )
}
