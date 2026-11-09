import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem =
  | { id: string; label: string; hint?: string; tone?: 'pri' | 'danger'; checked?: boolean; switch?: boolean; disabled?: boolean }
  | { sep: true }
  | { head: string }

/** A small menu at a point (right-click, long-press, or under a button). Arrow keys move, Enter picks, Esc or an outside click closes. */
export function RemoteMenu({ x, y, items, label, onPick, onClose }: { x: number; y: number; items: MenuItem[]; label: string; onPick: (id: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const down = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const bs = [...(box.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!bs.length) return
      e.preventDefault()
      const i = bs.indexOf(document.activeElement as HTMLButtonElement)
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div className="bw-menu" role="menu" aria-label={label} ref={box} style={pos}>
      {items.map((it, i) =>
        'sep' in it ? <hr key={i} /> :
        'head' in it ? <div key={i} className="bw-menu-head">{it.head}</div> : (
          <button key={it.id} role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.checked} disabled={it.disabled} className={it.tone ?? ''} onClick={() => onPick(it.id)}>
            <span>{it.label}</span>
            {it.switch !== undefined ? <span className={`bw-sw ${it.switch ? 'on' : ''}`} aria-hidden /> : it.checked ? <span aria-hidden>✓</span> : it.hint ? <span className="bw-menu-k">{it.hint}</span> : null}
          </button>
        )
      )}
    </div>
  )
}
