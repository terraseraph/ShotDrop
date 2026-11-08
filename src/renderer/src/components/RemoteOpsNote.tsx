import { useEffect, useState } from 'react'
import type { RemoteOp } from '@shared/remote'
import { api } from '../api'
import './MoveToSessionSheet.css'

/** "Renaming on 2 destinations": the folder moves still queued after a rename or move. Quiet when there are none. */
export function RemoteOpsNote() {
  const [ops, setOps] = useState<RemoteOp[]>([])
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      api.remoteOps().then(
        (o) => live && setOps(o),
        () => undefined
      )
      timer = setTimeout(tick, 4000)
    }
    tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [])

  const moves = ops.filter((o) => o.op === 'move')
  if (!moves.length) return null
  const failed = moves.filter((m) => m.status === 'error')
  const dests = new Set(moves.map((m) => m.destId)).size
  if (failed.length)
    return (
      <div className="mv-ops err" role="status" title={failed[0].error}>
        Renaming failed on {new Set(failed.map((f) => f.destId)).size} destination{dests === 1 ? '' : 's'}.
        <button onClick={() => void api.retryRemoteOps().then(() => api.remoteOps().then(setOps))}>Retry</button>
      </div>
    )
  return (
    <div className="mv-ops" role="status">
      Renaming on {dests} destination{dests === 1 ? '' : 's'}…
    </div>
  )
}
