import { useState } from 'react'
import { setKey } from '../api'

/** Shown to remote browsers until they enter the PIN set in the desktop app. */
export function PinGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('')
  return (
    <div className="empty">
      <form
        className="empty-inner pin"
        onSubmit={(e) => {
          e.preventDefault()
          setKey(pin.trim())
          onUnlocked()
        }}
      >
        <h1>ShotDrop</h1>
        <p className="muted">Enter the PIN shown in the desktop app under Settings → Remote.</p>
        <input className="input big mono" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••••" aria-label="PIN" />
        <button className="btn primary" type="submit">Open gallery</button>
      </form>
    </div>
  )
}
