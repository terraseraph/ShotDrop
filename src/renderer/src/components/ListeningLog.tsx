import { AnimatePresence, motion } from 'motion/react'

export interface LogLine {
  id: string
  text: string
  tone?: 'ok' | 'dim' | 'bad'
}

/** Green ripple plus the lines that appear as things happen (listening, connected, receiving, landed). */
export function ListeningLog({ lines, live }: { lines: LogLine[]; live: boolean }) {
  return (
    <div className="su-log">
      <div className={`su-ripple ${live ? 'live' : ''}`} aria-hidden="true">
        {live && <><i /><i className="b" /></>}
        <span />
      </div>
      <div className="su-lines mono" aria-live="polite">
        <AnimatePresence initial={false}>
          {lines.map((l) => (
            <motion.div key={l.id} className={`su-ln ${l.tone ?? ''}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}>
              {l.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
