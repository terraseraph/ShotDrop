// Pure retry rules for the sync queue. No imports, so scripts/check-retry.mjs can run it directly.

/** Errno codes that mean "can't reach the destination right now", not "this file is broken". */
const UNREACHABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENOTCONN',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EIO', // Windows reports a dropped SMB share mid-copy as EIO
  'UNKNOWN', // ...or as UNKNOWN (ERROR_NETNAME_DELETED and friends have no errno mapping)
  'EBUSY'
])

// rclone exit code 5 = "temporary error, more retries might fix it". https://rclone.org/docs/#exit-code
const RCLONE_TEMPORARY = 5
const RCLONE_NETWORK_TEXT = /timeout|timed out|connection (reset|refused)|no such host|network is unreachable|dial tcp|i\/o timeout|EOF$/i

export interface SyncError extends Error {
  code?: string
  exitCode?: number
  unreachable?: boolean
}

/** True when the job should wait for the destination to come back instead of spending a retry. */
export function isUnreachable(e: SyncError): boolean {
  if (e.unreachable) return true
  if (e.code && UNREACHABLE_CODES.has(e.code)) return true
  if (e.exitCode != null) return e.exitCode === RCLONE_TEMPORARY || RCLONE_NETWORK_TEXT.test(e.message)
  return false
}

/** Wait before probing an unreachable destination again: 5 s doubling to a 5 min ceiling, forever. */
export function offlineDelay(streak: number): number {
  return Math.min(5000 * 2 ** Math.min(streak, 10), 300_000)
}
