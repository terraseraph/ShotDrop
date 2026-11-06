import type { Status } from '@shared/types'
import { ConnectionCard } from './ConnectionCard'
import { NetworkCheck } from './NetworkCheck'
import { desktop } from '../api'

export function EmptyState({ status, onSettings }: { status: Status | null; onSettings: () => void }) {
  return (
    <div className="empty">
      <div className="empty-inner">
        <div className={`empty-pulse ${status?.ftp.running ? 'live' : ''}`} aria-hidden>
          <span />
        </div>
        <h1>Waiting for your first shot</h1>
        <p className="muted">
          Point your camera's FTP transfer at this PC. Frames show up here a few seconds after you press the shutter.
        </p>
        <ConnectionCard status={status} />
        {desktop && <NetworkCheck compact watch={`${status?.ftp.running}-${status?.ftp.port}`} />}
        <p className="muted small">
          Camera and PC must be on the same Wi-Fi. Setup steps for each camera brand are in{' '}
          <button className="link" onClick={onSettings}>
            Settings → Camera
          </button>
          .
        </p>
      </div>
    </div>
  )
}
