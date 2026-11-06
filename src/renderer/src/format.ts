export const fmtShutter = (s: string | null): string | null => {
  if (!s) return null
  const n = Number(s)
  if (Number.isFinite(n) && n > 0 && n < 1) return `1/${Math.round(1 / n)}s`
  return `${s}s`
}

export const fmtAperture = (a: number | null): string | null => (a ? `ƒ/${a % 1 ? a.toFixed(1) : a}` : null)
export const fmtFocal = (f: number | null): string | null => (f ? `${Math.round(f)}mm` : null)
export const fmtIso = (i: number | null): string | null => (i ? `ISO ${i}` : null)

export const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const fmtDate = (session: string): string => {
  const [y, m, d] = session.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export const fmtSize = (b: number): string =>
  b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`

export const ago = (ms: number): string => {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return fmtTime(ms)
}
