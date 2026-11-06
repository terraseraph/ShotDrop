import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { apiBase, setKey } from '../api'
import './PinGate.css'

const MAX = 12
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/** Shown to remote browsers until they enter the PIN set on the desktop (MPin.dc.html). The PIN is remembered in localStorage (api.ts). */
export function PinGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('')
  const [bad, setBad] = useState(false)
  const [checking, setChecking] = useState(false)
  const seq = useRef(0)

  // Try the PIN as soon as it could be complete (4 digits, then every further digit up to 12).
  const attempt = useCallback(async (p: string): Promise<void> => {
    const my = ++seq.current
    setChecking(true)
    try {
      const res = await fetch(`${apiBase}/api/status`, { headers: { 'x-shotdrop-key': p } })
      if (my !== seq.current) return
      if (res.ok) {
        setKey(p)
        onUnlocked()
      } else if (res.status === 401) {
        setBad(true)
        // Four digits is the usual PIN: clear it so the next try starts clean. Longer PINs keep going.
        if (p.length >= MAX) setPin('')
      }
    } catch {
      /* offline: leave the digits, they can try again */
    } finally {
      if (my === seq.current) setChecking(false)
    }
  }, [onUnlocked])

  const push = useCallback((d: string): void => {
    setBad(false)
    setPin((cur) => {
      if (cur.length >= MAX) return cur
      const n = cur + d
      if (n.length >= 4) void attempt(n)
      return n
    })
  }, [attempt])
  const back = useCallback((): void => { setBad(false); seq.current++; setPin((c) => c.slice(0, -1)) }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (/^\d$/.test(e.key)) push(e.key)
      else if (e.key === 'Backspace') back()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [push, back])

  const dots = Math.max(4, pin.length)
  return (
    <div className="pg">
      <div className="pg-top">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#f2b134" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></svg>
        <div>
          <h1>ShotDrop</h1>
          <div className="pg-sub">Remote gallery</div>
        </div>
        <div className="pg-ask" id="pg-ask">Enter the PIN shown on the PC</div>
        <motion.div className="pg-dots" role="status" aria-label={`${pin.length} digits entered`} animate={bad ? { x: [0, -10, 10, -6, 6, 0] } : { x: 0 }} transition={{ duration: 0.35 }}>
          {Array.from({ length: dots }, (_, i) => <span key={i} className={`pg-dot ${i < pin.length ? 'f' : ''} ${bad ? 'bad' : ''}`} />)}
        </motion.div>
        <div className="pg-msg" aria-live="polite">{bad ? "That isn't the PIN. Check the PC, under Settings → Phone and remote." : checking ? 'Checking…' : 'Scanned the QR? The PIN is remembered next time. Add to home screen to skip this.'}</div>
      </div>
      <div className="pg-pad" role="group" aria-labelledby="pg-ask">
        {KEYS.map((d) => <button key={d} className="pg-k" onClick={() => push(d)}>{d}</button>)}
        <span />
        <button className="pg-k" onClick={() => push('0')}>0</button>
        <button className="pg-k plain" aria-label="Delete" onClick={back}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 6H8l-5 6 5 6h13z" /><path d="m12 9 5 6M17 9l-5 6" /></svg>
        </button>
      </div>
    </div>
  )
}
