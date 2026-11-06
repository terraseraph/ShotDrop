import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Check, CheckFix, DiagnosticsReport, FixResult, LoginAttempt } from '@shared/diagnostics'
import { apiBase } from '../api'
import { ago } from '../format'
import './Setup.css'

async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  const res = await fetch(apiBase + path, { method })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

export interface Diagnostics {
  report: DiagnosticsReport | null
  attempts: LoginAttempt[]
  error: string | null
  /** The fix id being applied, or "all". */
  busy: string | null
  /** Apply fixes one after another; resolves to the last message. */
  fix: (fixes: CheckFix[]) => Promise<string | null>
}

/** Runs /api/diagnostics (and the refused-login list) now and then every `every` ms while `enabled`. */
export function useDiagnostics(enabled: boolean, every: number, watch?: string): Diagnostics {
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [attempts, setAttempts] = useState<LoginAttempt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef(false)

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    try {
      const [r, a] = await Promise.all([call<DiagnosticsReport>('GET', '/api/diagnostics'), call<LoginAttempt[]>('GET', '/api/diagnostics/attempts')])
      setReport(r)
      setAttempts(a)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const t = setInterval(() => void refresh(), every)
    return () => clearInterval(t)
  }, [enabled, every, refresh, watch])

  const fix = useCallback(
    async (fixes: CheckFix[]) => {
      busyRef.current = true
      setBusy(fixes.length > 1 ? 'all' : fixes[0].id)
      let message: string | null = null
      try {
        for (const f of fixes) {
          const r = await call<FixResult>('POST', `/api/diagnostics/fix/${f.id}`)
          setReport(r.report)
          message = r.message
          if (!r.ok) break
        }
      } catch (e) {
        message = (e as Error).message
      } finally {
        busyRef.current = false
        setBusy(null)
      }
      void refresh()
      return message
    },
    [refresh]
  )

  return { report, attempts, error, busy, fix }
}

export const problemsOf = (r: DiagnosticsReport | null): Check[] => r?.checks.filter((c) => c.level === 'error' || c.level === 'warn') ?? []

const GLYPH: Record<Check['level'], string> = { ok: 'm5 12 5 5L20 7', error: 'M18 6 6 18M6 6l12 12', warn: 'M12 8v5M12 17h.01', info: 'M12 11v6M12 7.5h.01' }
const CLS: Record<Check['level'], string> = { ok: 'ok', error: 'bad', warn: 'warn', info: 'run' }

function StatusCircle({ check }: { check: Check }) {
  const spin = check.level === 'info' && check.id === 'camera'
  return (
    <div className={`su-ic ${CLS[check.level]}`} aria-label={check.level}>
      <svg className={spin ? 'su-spin' : ''} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path d={spin ? 'M21 12a9 9 0 1 1-6.2-8.6' : GLYPH[check.level]} />
      </svg>
    </div>
  )
}

interface CardProps {
  diag: Diagnostics
  freeBytes?: number | null
  onBack: () => void
  toast?: (t: string, tone?: 'info' | 'error') => void
}

/** "Nothing arrived yet. Here's why." One row per check, a fix button where there is one. */
export function CheckCard({ diag, freeBytes, onBack, toast }: CardProps) {
  const { report, attempts, error, busy, fix } = diag
  const checks = report?.checks ?? []
  const problems = problemsOf(report)
  const fixes = [...new Map(problems.flatMap((c) => c.fixes ?? []).map((f) => [f.id, f])).values()]
  const run = async (f: CheckFix[]): Promise<void> => {
    const m = await fix(f)
    if (m) toast?.(m)
  }
  const refused = attempts.filter((a) => !a.ok).slice(-2)
  const copy = (): void => {
    const lines = checks.map((c) => `[${c.level.toUpperCase()}] ${c.title}: ${c.detail}`)
    void navigator.clipboard.writeText(`ShotDrop connection report\n${new Date().toLocaleString()}\n\n${lines.join('\n')}`)
    toast?.('Report copied')
  }
  const rawRoom = freeBytes ? Math.floor(freeBytes / 25e6) : 0
  return (
    <div className="su-check">
      <div className="su-check-head">
        <div>
          <h2>Nothing arrived yet. Here&apos;s why.</h2>
          <p>
            {error
              ? `Couldn't run the check: ${error}`
              : !report
                ? 'Checking the usual causes…'
                : problems.length
                  ? `ShotDrop checked the usual causes. ${problems.length === 1 ? 'One needs a click' : problems.length === 2 ? 'Two need a click' : `${problems.length} need attention`}; the rest are fine.`
                  : 'Everything checks out. Take a shot; it should land within seconds.'}
          </p>
        </div>
        {fixes.length > 1 && (
          <button className="su-fix primary" disabled={!!busy} onClick={() => void run(fixes)}>
            {busy === 'all' ? 'Working…' : fixes.length === 2 ? 'Fix both' : 'Fix all'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        )}
      </div>

      <div className="su-rows">
        {checks.map((c, i) => (
          <motion.div key={c.id} className={`su-row ${c.level === 'error' ? 'bad' : c.level === 'warn' ? 'warn' : ''}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1], delay: i * 0.08 }}>
            <StatusCircle check={c} />
            <div className="su-row-body">
              <div className="t">{c.title}</div>
              <div className="s">
                {c.detail}
                {c.id === 'disk' && rawRoom > 0 ? ` Room for about ${(rawRoom >= 1000 ? Math.round(rawRoom / 100) * 100 : rawRoom).toLocaleString()} RAW files.` : ''}
              </div>
              {c.id === 'camera' && refused.map((a) => (
                <div key={a.at} className="s refused mono">{a.ip.replace(/^::ffff:/, '')} tried “{a.username}” and was refused · {ago(a.at)}</div>
              ))}
            </div>
            {c.fixes?.map((f) => (
              <button key={f.id} className="su-fix" disabled={!!busy} onClick={() => void run([f])} title={f.elevated ? 'Windows will ask for permission' : undefined}>
                {busy === f.id || busy === 'all' ? 'Working…' : f.label}
              </button>
            ))}
          </motion.div>
        ))}
      </div>

      <div className="su-check-foot">
        <span>Re-checks every 5 s while this is open.</span>
        <button className="tb" onClick={copy}>Copy report</button>
        <button className="su-fix" onClick={onBack}>Back to setup card</button>
      </div>
    </div>
  )
}
