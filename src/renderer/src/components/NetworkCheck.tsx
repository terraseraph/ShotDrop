import { useCallback, useEffect, useState } from 'react'
import type { Check, CheckFix, DiagnosticsReport, FixResult } from '@shared/diagnostics'
import { apiBase } from '../api'
import { Icon } from './Icon'
import './NetworkCheck.css'

async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  const res = await fetch(apiBase + path, { method })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

const ICON: Record<Check['level'], string> = { ok: 'check', warn: 'alert', error: 'close', info: 'info' }

interface Props {
  /** Re-run when this changes (e.g. FTP port or on/off). */
  watch?: string
  /** Compact: only show problems (used on the empty "waiting for first shot" screen). */
  compact?: boolean
  toast?: (t: string, tone?: 'info' | 'error') => void
}

/**
 * "Why isn't my camera connecting?" in one panel: runs the server's checks and offers
 * one-click fixes (firewall rule, free port). Only works in the desktop window.
 */
export function NetworkCheck({ watch, compact, toast }: Props) {
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [busy, setBusy] = useState<string | null>('check')
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    setBusy('check')
    setError(null)
    try {
      setReport(await call<DiagnosticsReport>('GET', '/api/diagnostics'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check, watch])

  const fix = async (f: CheckFix): Promise<void> => {
    setBusy(f.id)
    try {
      const r = await call<FixResult>('POST', `/api/diagnostics/fix/${f.id}`)
      setReport(r.report)
      toast?.(r.message, r.ok ? 'info' : 'error')
    } catch (e) {
      toast?.((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const problems = report?.checks.filter((c) => c.level === 'error' || c.level === 'warn') ?? []
  const shown = compact ? problems : report?.checks ?? []

  if (compact && !problems.length) return null

  return (
    <div className={`netcheck ${compact ? 'compact' : ''}`}>
      <div className="netcheck-head">
        <span className="netcheck-summary">
          {busy === 'check' && !report ? (
            <span className="muted">Checking connection…</span>
          ) : error ? (
            <span className="lvl-error">Couldn't run the check: {error}</span>
          ) : problems.length ? (
            <span className={problems.some((p) => p.level === 'error') ? 'lvl-error' : 'lvl-warn'}>
              {problems.length} {problems.length === 1 ? 'thing needs' : 'things need'} attention
            </span>
          ) : (
            <span className="lvl-ok">Ready for cameras</span>
          )}
        </span>
        <button className="btn" onClick={() => void check()} disabled={!!busy}>
          <Icon name="refresh" /> {busy === 'check' ? 'Checking…' : 'Check again'}
        </button>
      </div>

      {shown.map((c) => (
        <div key={c.id} className={`netcheck-row lvl-${c.level}`}>
          <span className="netcheck-icon" aria-label={c.level}>
            <Icon name={ICON[c.level]} size={14} />
          </span>
          <div className="netcheck-body">
            <strong>{c.title}</strong>
            <p>{c.detail}</p>
            {c.fixes && (
              <div className="netcheck-fixes">
                {c.fixes.map((f) => (
                  <button key={f.id} className={`btn ${f.danger ? '' : 'primary'}`} disabled={!!busy} onClick={() => void fix(f)}>
                    {busy === f.id ? 'Working…' : f.label}
                  </button>
                ))}
                {c.fixes.some((f) => f.elevated) && <span className="muted small">Windows will ask for permission.</span>}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
