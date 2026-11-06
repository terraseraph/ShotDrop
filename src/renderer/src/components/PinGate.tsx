import { useState } from 'react'
import { setKey } from '../api'

/** Shown to remote browsers until they enter the PIN set in the desktop app. The PIN is remembered in localStorage (api.ts). */
export function PinGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('')
  return (
    <div className="empty pin-page">
      <form
        className="empty-inner pin"
        onSubmit={(e) => {
          e.preventDefault()
          setKey(pin.trim())
          onUnlocked()
        }}
      >
        <span className="pin-mark" aria-hidden />
        <h1>ShotDrop</h1>
        <p className="muted">Enter the PIN shown on the desktop under Settings → Remote.</p>
        <input
          className="input big mono"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="current-password"
          enterKeyHint="go"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="••••••"
          aria-label="PIN"
        />
        <button className="btn primary" type="submit" disabled={!pin.trim()}>Open gallery</button>
      </form>
    </div>
  )
}
