import { useEffect, useSyncExternalStore } from 'react'
import type { RemoteSessions } from '@shared/remote'
import type { DestStatus } from '@shared/types'
import { api } from './api'

// One shared copy of /api/remote/sessions (no network work on the server side) and the destination list, for the rail's
// destination chips and the "Found on destinations" group. Refreshed every 8 s and whenever a transfer moves.
interface State { sessions: RemoteSessions | null; dests: DestStatus[] }
let state: State = { sessions: null, dests: [] }
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let off: (() => void) | null = null
let inFlight = false

const emit = (): void => subs.forEach((f) => f())

export async function refreshRemoteSessions(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const [sessions, status] = await Promise.all([api.remoteSessions(), api.status()])
    state = { sessions, dests: status.destinations }
    emit()
  } catch {
    /* offline or PIN not entered yet: keep what we have */
  } finally {
    inFlight = false
  }
}

function start(): void {
  if (timer) return
  void refreshRemoteSessions()
  timer = setInterval(() => void refreshRemoteSessions(), 8000)
  off = api.onTransfer(() => void refreshRemoteSessions())
}

function stop(): void {
  if (subs.size || !timer) return
  clearInterval(timer)
  timer = null
  off?.()
  off = null
}

export function useRemoteSessions(): State {
  useEffect(() => {
    start()
    return () => {
      // Deferred so a rail re-mount doesn't tear the poll down and up again.
      setTimeout(stop, 0)
    }
  }, [])
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state
  )
}
