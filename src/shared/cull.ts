import type { Shot } from '@shared/types'

// ponytail: thresholds are untuned guesses; calibrate with `scripts/calibrate-cull.mjs` on real bursts before trusting "soft" on its own.
export const CULL_DEFAULTS = {
  maxGapMs: 3000, // frames further apart than this are never the same burst
  maxHamming: 12, // of 64 bits; looser than this and different scenes start to merge
  softRatio: 0.6, // soft = under 60% of the sharpest frame in its burst
  softAbs: 20, // lone frames: Laplacian variance this low is almost always blur
  blinkAt: 0.5 // MediaPipe eyeBlink score (0 open .. 1 shut) above which a face counts as eyes-closed
}
export type CullThresholds = typeof CULL_DEFAULTS

export interface Cull {
  group: number // shared by every frame in a burst; unique per frame when it is on its own
  size: number // frames in the burst
  best: boolean // top-scoring frame of its burst (lone frames are their own best)
  soft: boolean
  blink: boolean // at least one face has closed eyes
}

export function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b)
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

/** Sharpness, discounted for blown highlights or crushed shadows (a sharp but unusable frame shouldn't win). */
function score(s: Shot, t: CullThresholds): number {
  const exposure = (s.clipped ?? 0) > 5 || (s.dark ?? 0) > 30 ? 0.5 : 1
  // Someone with their eyes shut loses to any frame where everyone's eyes are open, however sharp it is.
  return (s.sharpness ?? 0) * exposure * (isBlink(s, t) ? 0.1 : 1)
}

function isBlink(s: Shot, t: CullThresholds): boolean {
  return s.blink != null && s.blink > t.blinkAt
}

/** Groups near-identical consecutive frames into bursts and picks the best of each. Pure; runs on whatever list the UI holds. */
export function analyze(shots: Shot[], t: CullThresholds = CULL_DEFAULTS): Map<number, Cull> {
  const sorted = [...shots].sort((a, b) => a.capturedAt - b.capturedAt || a.id - b.id)
  const groups: Shot[][] = []
  let prev: Shot | undefined
  for (const s of sorted) {
    const cur = groups[groups.length - 1]
    const same =
      prev && prev.hash && s.hash && s.capturedAt - prev.capturedAt <= t.maxGapMs && hamming(prev.hash, s.hash) <= t.maxHamming
    if (same) cur.push(s)
    else groups.push([s])
    prev = s
  }
  const out = new Map<number, Cull>()
  groups.forEach((g, i) => {
    const top = g.reduce((a, b) => (score(b, t) > score(a, t) ? b : a))
    const topSharp = top.sharpness ?? 0
    for (const s of g) {
      const sharp = s.sharpness
      const soft = sharp == null ? false : g.length > 1 ? sharp < topSharp * t.softRatio : sharp < t.softAbs
      out.set(s.id, { group: i, size: g.length, best: s === top, soft, blink: isBlink(s, t) })
    }
  })
  return out
}
