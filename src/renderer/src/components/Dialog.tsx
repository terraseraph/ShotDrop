import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { fade, popIn } from '../motion'
import './Dialog.css'

/** A centred dialog over the current view: scrim, title, close button. Esc and scrim click are handled by the caller's onClose. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="dlg-root">
      <motion.div className="dlg-scrim scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} />
      <motion.div className={`dlg sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} {...popIn}>
        <header className="dlg-head">
          <h2>{title}</h2>
          <button className="tb dlg-close" onClick={onClose} aria-label={`Close ${title}`}>
            <span className="key">Esc</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>
        <div className="dlg-body">{children}</div>
      </motion.div>
    </div>
  )
}
