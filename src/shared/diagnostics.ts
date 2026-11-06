// Connection check: types shared by the server and the UI.

export type CheckLevel = 'ok' | 'warn' | 'error' | 'info'

export type FixId = 'firewall-allow' | 'firewall-remove' | 'use-free-port'

export interface CheckFix {
  id: FixId
  label: string
  /** Windows will show a permission (UAC) prompt. */
  elevated?: boolean
  danger?: boolean
}

export interface Check {
  id: 'ftp' | 'passive' | 'network' | 'firewall' | 'selftest' | 'camera' | 'disk'
  title: string
  level: CheckLevel
  detail: string
  fixes?: CheckFix[]
}

export interface DiagnosticsReport {
  checkedAt: number
  checks: Check[]
}

export interface LoginAttempt {
  at: number
  ip: string
  username: string
  ok: boolean
}

export interface FixResult {
  ok: boolean
  message: string
  report: DiagnosticsReport
}
