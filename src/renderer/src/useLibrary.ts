import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerEvent, Shot, ShotPatch, Status } from '@shared/types'
import { api, AuthError } from './api'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'error'
}

/** Loads the library once, then keeps it live from the server's SSE stream. */
export function useLibrary(onArrival: (shot: Shot) => void) {
  const [shots, setShots] = useState<Shot[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [needsPin, setNeedsPin] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [connected, setConnected] = useState(true)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [loadKey, setLoadKey] = useState(0)
  const arrival = useRef(onArrival)
  arrival.current = onArrival

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
  }, [])

  useEffect(() => {
    let cancelled = false
    let closeStream = (): void => undefined
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let watchdog: ReturnType<typeof setTimeout> | null = null
    let seq = 0

    const apply = (e: ServerEvent): void => {
      switch (e.type) {
        case 'shot:added':
          setShots((s) => (s.some((x) => x.id === e.shot.id) ? s : insertSorted(s, e.shot)))
          arrival.current(e.shot)
          break
        case 'shot:updated':
          setShots((s) => (s.some((x) => x.id === e.shot.id) ? s.map((x) => (x.id === e.shot.id ? e.shot : x)) : insertSorted(s, e.shot)))
          break
        case 'shot:removed':
          setShots((s) => s.filter((x) => x.id !== e.id))
          break
        case 'status':
          setStatus(e.status)
          break
        case 'ingest:error':
          toast(`Couldn't import ${e.file.split(/[\\/]/).pop()}: ${e.error}`, 'error')
          break
      }
    }

    // Fallback when SSE can't get through (Cloudflare quick tunnels don't support it): poll the change log.
    const poll = async (): Promise<void> => {
      if (cancelled) return
      try {
        const c = await api.changes(seq)
        if (cancelled) return
        setConnected(true)
        if (c.reset) {
          const { items, seq: s } = await api.shots()
          setShots(items)
          seq = s
        } else {
          c.events.forEach(apply)
          seq = c.seq
        }
        setStatus(c.status)
      } catch {
        setConnected(false)
      }
      pollTimer = setTimeout(() => void poll(), 2500)
    }
    const startPolling = (): void => {
      if (pollTimer || cancelled) return
      closeStream()
      pollTimer = setTimeout(() => void poll(), 0)
    }

    ;(async () => {
      try {
        const [{ items, seq: s }, st] = await Promise.all([api.shots(), api.status()])
        if (cancelled) return
        seq = s
        setShots(items)
        setStatus(st)
        setNeedsPin(false)
        setLoaded(true)
      } catch (e) {
        if (e instanceof AuthError) setNeedsPin(true)
        else setConnected(false)
        setLoaded(true)
        return
      }
      if (location.hostname.endsWith('.trycloudflare.com')) return startPolling()
      // The server sends a status event the moment a stream opens; if none arrives, something in between is buffering.
      watchdog = setTimeout(startPolling, 6000)
      closeStream = api.events(
        (e) => {
          if (watchdog) clearTimeout(watchdog)
          watchdog = null
          setConnected(true)
          apply(e)
        },
        () => setConnected(false)
      )
    })()
    return () => {
      cancelled = true
      closeStream()
      if (pollTimer) clearTimeout(pollTimer)
      if (watchdog) clearTimeout(watchdog)
    }
  }, [loadKey, toast])

  const patch = useCallback(async (ids: number[], p: ShotPatch) => {
    // Optimistic: culling must feel instant.
    setShots((s) => s.map((x) => (ids.includes(x.id) ? { ...x, ...p } : x)))
    try {
      await Promise.all(ids.map((id) => api.patchShot(id, p)))
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, 'error')
    }
  }, [toast])

  const remove = useCallback(async (id: number) => {
    setShots((s) => s.filter((x) => x.id !== id))
    await api.deleteShot(id).catch((e: Error) => toast(`Couldn't delete: ${e.message}`, 'error'))
  }, [toast])

  return { shots, status, loaded, needsPin, connected, toasts, toast, patch, remove, reload: () => setLoadKey((k) => k + 1) }
}

function insertSorted(list: Shot[], shot: Shot): Shot[] {
  const i = list.findIndex((x) => x.capturedAt > shot.capturedAt || (x.capturedAt === shot.capturedAt && x.id > shot.id))
  return i < 0 ? [...list, shot] : [...list.slice(0, i), shot, ...list.slice(i)]
}
