import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api } from './api'

// Session names live in each folder's .shotdrop.json (served by /api/sessions), so every device and the sync
// destinations see the same name. This module keeps one shared copy of them for the rail, the top bar and the header.
const OLD_KEY = 'shotdrop.names' // pre-S1 per-browser store; `day:<session>` entries are migrated to the server once

let names: Record<string, string> = {}
const subs = new Set<() => void>()
let started = false
let migrated = false

const emit = (): void => subs.forEach((f) => f())

async function migrateLocalNames(server: Record<string, string>): Promise<void> {
  if (migrated) return
  migrated = true
  let old: Record<string, string>
  try {
    old = JSON.parse(localStorage.getItem(OLD_KEY) ?? '{}')
  } catch {
    return
  }
  const left = { ...old }
  let touched = false
  for (const [k, v] of Object.entries(old)) {
    if (!k.startsWith('day:') || typeof v !== 'string') continue
    const folder = k.slice(4)
    try {
      if (!server[folder] && v.trim()) await api.patchSession(folder, { name: v.trim() })
      delete left[k]
      touched = true
    } catch (e) {
      // A folder that no longer exists can't take a name; any other failure (offline, auth) keeps the label for next time.
      if (e instanceof Error && e.message === 'Unknown session') {
        delete left[k]
        touched = true
      }
    }
  }
  if (!touched) return
  try {
    localStorage.setItem(OLD_KEY, JSON.stringify(left))
  } catch {
    /* storage blocked: the migration just runs again next time */
  }
}

async function refresh(): Promise<void> {
  try {
    const rows = await api.sessions()
    names = Object.fromEntries(rows.filter((r) => r.meta?.name).map((r) => [r.folder, r.meta!.name]))
    emit()
    if (!migrated) {
      await migrateLocalNames(names)
      if (migrated) {
        const again = await api.sessions()
        names = Object.fromEntries(again.filter((r) => r.meta?.name).map((r) => [r.folder, r.meta!.name]))
        emit()
      }
    }
  } catch {
    /* offline or not signed in yet: keep what we have */
  }
}

const subscribe = (f: () => void): (() => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
const snapshot = (): Record<string, string> => names

/** "Thu 6 Nov": the auto-name every session gets from its date (a folder like "2026-11-08 Smith" uses its date part). */
export function fmtDay(session: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(session)
  if (!m) return session
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Session names, read from and written to the session's .shotdrop.json through the API. */
export function useSessionNames() {
  const cur = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    if (started) return
    started = true
    void refresh()
  }, [])
  const reload = useCallback(() => void refresh(), [])
  const rename = useCallback((session: string, name: string) => {
    const n = name.trim()
    if (!session) return
    const next = { ...names }
    if (n) next[session] = n
    else delete next[session]
    names = next // optimistic; the server's answer replaces it
    emit()
    void api.patchSession(session, { name: n }).then(refresh, refresh)
  }, [])
  const custom = useCallback((session: string) => cur[session] ?? '', [cur])
  const title = useCallback(
    (session: string) => {
      if (!session) return 'All sessions'
      const n = cur[session]
      return !n ? fmtDay(session) : n.includes(fmtDay(session)) ? n : `${fmtDay(session)} · ${n}`
    },
    [cur]
  )
  return { rename, title, custom, reload, all: cur }
}
export type SessionNames = ReturnType<typeof useSessionNames>
