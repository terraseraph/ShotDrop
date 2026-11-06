// Calibrates the thresholds in src/shared/cull.ts against a shoot you have labelled by hand.
//
//   node --experimental-strip-types scripts/calibrate-cull.mjs template [--db <library.db>] [--session YYYY-MM-DD] > labels.csv
//     Writes one row per shot, pre-filled with what the current thresholds decide. Open it in a spreadsheet and fix
//     the burst / soft / blink columns (same burst = same text in "burst"; soft and blink are 1 or 0; blank burst = on its own).
//
//   node --experimental-strip-types scripts/calibrate-cull.mjs score labels.csv [--db <library.db>]
//     Sweeps each threshold against your labels and prints the errors per value, plus suggested constants.
//
//   node --experimental-strip-types scripts/calibrate-cull.mjs flags [--db <library.db>] [--session YYYY-MM-DD]
//     No labels file: treats your Reject flags as "soft or blink" and reports how well the current flags agree. Rough only.
//
// --db defaults to the dev library (.dev-data/app/library.db). A packaged build keeps it in its data folder or %APPDATA%/ShotDrop.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { CULL_DEFAULTS, analyze, hamming } from '../src/shared/cull.ts'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const [cmd, ...rest] = process.argv.slice(2)
const opt = (name, def) => {
  const i = rest.indexOf('--' + name)
  return i >= 0 ? rest[i + 1] : def
}

function loadShots() {
  const db = new Database(opt('db', '.dev-data/app/library.db'), { readonly: true, fileMustExist: true })
  const session = opt('session')
  const rows = db
    .prepare(
      `SELECT s.id, s.captured_at AS capturedAt, s.hash, s.sharpness, s.clipped, s.dark, s.blink, s.faces, s.flag,
              (SELECT name FROM files f WHERE f.shot_id = s.id ORDER BY f.id LIMIT 1) AS file
         FROM shots s
        WHERE NOT EXISTS (SELECT 1 FROM files v WHERE v.shot_id = s.id AND v.kind = 'video') ${session ? 'AND s.session = ?' : ''}
        ORDER BY s.captured_at, s.id`
    )
    .all(...(session ? [session] : []))
  db.close()
  return rows
}

const f1 = (tp, fp, fn) => {
  const p = tp + fp ? tp / (tp + fp) : 1
  const r = tp + fn ? tp / (tp + fn) : 1
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 }
}
const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%'
const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => +(a + i * step).toFixed(3))

/** Pure: split/merge counts for adjacent pairs. analyze() chains bursts pair by pair, so this is exactly what it sees. */
export function burstErrors(shots, truth, maxGapMs, maxHamming) {
  let splits = 0
  let merges = 0
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1]
    const b = shots[i]
    if (!truth.has(a.id) || !truth.has(b.id)) continue
    const tA = truth.get(a.id).burst
    const truthSame = tA !== '' && tA === truth.get(b.id).burst
    const predSame = !!(a.hash && b.hash && b.capturedAt - a.capturedAt <= maxGapMs && hamming(a.hash, b.hash) <= maxHamming)
    if (truthSame && !predSame) splits++
    if (!truthSame && predSame) merges++
  }
  return { splits, merges }
}

function template() {
  const shots = loadShots()
  const cull = analyze(shots)
  console.log('id,burst,soft,blink,time,sharpness,blinkScore,file')
  for (const s of shots) {
    const c = cull.get(s.id)
    const burst = c.size > 1 ? 'b' + c.group : ''
    const time = new Date(s.capturedAt).toISOString().slice(11, 23)
    console.log([s.id, burst, c.soft ? 1 : 0, c.blink ? 1 : 0, time, s.sharpness ?? '', s.blink ?? '', JSON.stringify(s.file ?? '')].join(','))
  }
}

function readLabels(path) {
  const truth = new Map()
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(1)
  for (const line of lines) {
    if (!line.trim()) continue
    const [id, burst, soft, blink] = line.split(',').map((x) => x.trim())
    // Blank soft/blink = not labelled; those rows are left out of that metric.
    truth.set(Number(id), { burst, soft: soft === '' ? null : soft === '1', blink: blink === '' ? null : blink === '1' })
  }
  return truth
}

function score(path) {
  const truth = readLabels(path)
  const shots = loadShots().filter((s) => truth.has(s.id))
  if (shots.length < 2) throw new Error('no labelled shots found in that library (wrong --db?)')
  const missing = shots.filter((s) => !s.hash || s.sharpness == null).length
  console.log(`${shots.length} labelled shots, ${missing} not yet analysed (no hash/sharpness), ${shots.filter((s) => s.blink != null).length} with faces\n`)

  // 1. Bursts
  const gaps = [500, 1000, 1500, 2000, 3000, 4000, 6000, 10000]
  const hams = [4, 6, 8, 10, 12, 14, 16, 20, 24]
  console.log('Burst errors (splits+merges) by max gap (rows, ms) x max hamming (cols)')
  console.log('gap\\ham ' + hams.map((h) => String(h).padStart(5)).join(''))
  // Start from the current values so a flat sweep (no signal) suggests no change.
  const d = burstErrors(shots, truth, CULL_DEFAULTS.maxGapMs, CULL_DEFAULTS.maxHamming)
  let best = { err: d.splits + d.merges, ...d, g: CULL_DEFAULTS.maxGapMs, h: CULL_DEFAULTS.maxHamming }
  for (const g of gaps) {
    let row = String(g).padStart(7) + ' '
    for (const h of hams) {
      const { splits, merges } = burstErrors(shots, truth, g, h)
      const err = splits + merges
      row += String(err).padStart(5)
      // Ties go to the tighter setting: wrongly merging two scenes hides a frame, a split only costs a glance.
      if (err < best.err || (err === best.err && merges < best.merges && g <= best.g)) best = { err, splits, merges, g, h }
    }
    console.log(row)
  }
  console.log(`-> maxGapMs ${best.g}, maxHamming ${best.h}: ${best.splits} splits, ${best.merges} merges\n`)

  // 2. Soft, with the chosen burst settings
  const truthSoft = shots.filter((s) => s.sharpness != null && truth.get(s.id).soft != null)
  const softF1 = (r, a) => {
    const cull = analyze(shots, { ...CULL_DEFAULTS, maxGapMs: best.g, maxHamming: best.h, softRatio: r, softAbs: a })
    let tp = 0, fp = 0, fn = 0
    for (const s of truthSoft) {
      const pred = cull.get(s.id).soft
      const t = truth.get(s.id).soft
      if (pred && t) tp++
      else if (pred) fp++
      else if (t) fn++
    }
    return f1(tp, fp, fn)
  }
  let bestSoft = { ...softF1(CULL_DEFAULTS.softRatio, CULL_DEFAULTS.softAbs), ratio: CULL_DEFAULTS.softRatio, a: CULL_DEFAULTS.softAbs }
  console.log('Soft F1 by softRatio (rows) x softAbs (cols)')
  const absVals = [5, 10, 15, 20, 30, 40, 60, 100]
  console.log('ratio\\abs' + absVals.map((a) => String(a).padStart(6)).join(''))
  for (const r of range(0.3, 0.85, 0.05)) {
    let row = String(r).padStart(9)
    for (const a of absVals) {
      const m = softF1(r, a)
      row += pct(m.f1).padStart(6)
      if (m.f1 > bestSoft.f1) bestSoft = { ...m, ratio: r, a }
    }
    console.log(row)
  }
  console.log(`-> softRatio ${bestSoft.ratio}, softAbs ${bestSoft.a}: precision ${pct(bestSoft.p)}, recall ${pct(bestSoft.r)}\n`)

  // 3. Blink: only frames where faces were found
  const faced = shots.filter((s) => s.blink != null && truth.get(s.id).blink != null)
  let bestBlink = { f1: -1, b: CULL_DEFAULTS.blinkAt }
  console.log('Blink threshold   precision  recall  F1')
  for (const b of range(0.2, 0.8, 0.05)) {
    let tp = 0, fp = 0, fn = 0
    for (const s of faced) {
      const pred = s.blink > b
      const t = truth.get(s.id).blink
      if (pred && t) tp++
      else if (pred) fp++
      else if (t) fn++
    }
    const m = f1(tp, fp, fn)
    console.log(`  ${b.toFixed(2)}            ${pct(m.p)}     ${pct(m.r)}  ${pct(m.f1)}`)
    if (m.f1 > bestBlink.f1 || (m.f1 === bestBlink.f1 && b === CULL_DEFAULTS.blinkAt)) bestBlink = { ...m, b }
  }
  console.log(faced.length ? `-> blinkAt ${bestBlink.b}\n` : '-> no faces in this shoot, blinkAt unchanged\n')

  console.log('Suggested CULL_DEFAULTS:')
  console.log(
    JSON.stringify(
      { maxGapMs: best.g, maxHamming: best.h, softRatio: bestSoft.ratio, softAbs: bestSoft.a, blinkAt: faced.length ? bestBlink.b : CULL_DEFAULTS.blinkAt },
      null,
      2
    )
  )
}

function flags() {
  const shots = loadShots()
  const cull = analyze(shots)
  let tp = 0, fp = 0, fn = 0
  for (const s of shots) {
    const c = cull.get(s.id)
    const pred = c.soft || c.blink || (c.size > 1 && !c.best)
    const t = s.flag === -1
    if (pred && t) tp++
    else if (pred) fp++
    else if (t) fn++
  }
  const m = f1(tp, fp, fn)
  console.log(`${shots.length} shots, ${shots.filter((s) => s.flag === -1).length} rejected by you`)
  console.log(`"soft, blink or not best-of-burst" vs your rejects: precision ${pct(m.p)}, recall ${pct(m.r)}, F1 ${pct(m.f1)}`)
  console.log('Rejects mix reasons (duplicates, composition), so use `template` + `score` to tune the actual thresholds.')
}

if (cmd === 'template') template()
else if (cmd === 'score' && rest[0]) score(rest[0])
else if (cmd === 'flags') flags()
else if (cmd === 'selftest') {
  const shots = [
    { id: 1, capturedAt: 0, hash: '0000000000000000' },
    { id: 2, capturedAt: 500, hash: '0000000000000001' }, // 1 bit from #1
    { id: 3, capturedAt: 9000, hash: '0000000000000001' } // far in time
  ]
  const truth = new Map([[1, { burst: 'a' }], [2, { burst: 'a' }], [3, { burst: '' }]])
  const ok = (c, msg) => { if (!c) throw new Error('selftest failed: ' + msg) }
  ok(burstErrors(shots, truth, 3000, 12).splits === 0 && burstErrors(shots, truth, 3000, 12).merges === 0, 'exact match')
  ok(burstErrors(shots, truth, 3000, 0).splits === 1, 'too-tight hamming splits')
  ok(burstErrors(shots, truth, 10000, 12).merges === 1, 'too-loose gap merges')
  console.log('selftest ok')
} else {
  console.log('usage: calibrate-cull.mjs template|score <labels.csv>|flags|selftest [--db path] [--session YYYY-MM-DD]')
  process.exitCode = 1
}
