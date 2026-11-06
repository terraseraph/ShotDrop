import { useCallback, useState } from 'react'

// Same store and `day:<session>` keys as the grid's session rail, so a rename in either place shows in both.
const KEY = 'shotdrop.names'
const day = (session: string): string => `day:${session}`
const read = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** "Thu 6 Nov": the auto-name every session gets from its date. */
export function fmtDay(session: string): string {
  const [y, m, d] = session.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Session names are a per-device nicety (the server only knows the date), so they live in localStorage. */
export function useSessionNames() {
  const [names, setNames] = useState<Record<string, string>>(read)
  const reload = useCallback(() => setNames(read()), [])
  const rename = useCallback((session: string, name: string) => {
    setNames((cur) => {
      const next = { ...cur }
      if (name.trim()) next[day(session)] = name.trim()
      else delete next[day(session)]
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage blocked: the name lasts until reload */
      }
      return next
    })
  }, [])
  const custom = useCallback((session: string) => names[day(session)] ?? '', [names])
  const title = useCallback(
    (session: string) => {
      if (!session) return 'All sessions'
      const n = names[day(session)]
      return !n ? fmtDay(session) : n.includes(fmtDay(session)) ? n : `${fmtDay(session)} · ${n}`
    },
    [names]
  )
  return { rename, title, custom, reload }
}
export type SessionNames = ReturnType<typeof useSessionNames>
