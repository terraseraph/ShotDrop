import { useEffect, useState } from 'react'
import type { ExportOptions, Shot } from '@shared/types'
import { api, desktop } from '../api'
import { fmtSize } from '../format'
import { Popover } from './Popover'
import { useChips } from './fsApi'

const STORE = 'shotdrop.export2'
type Size = 'original' | '2048' | '1080'
type Dest = 'desktop' | 'pictures' | 'same' | 'custom'
interface Form { size: Size; metadata: ExportOptions['metadata']; quality: number; dest: Dest; custom: string }
const DEFAULTS: Form = { size: '2048', metadata: 'all', quality: 92, dest: 'desktop', custom: '' }

function load(): Form {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

/** Rough JPEG size: ~0.4 bytes per pixel at q92, falling with quality. Only an estimate, so the line says "About". */
const estimate = (shot: Shot, size: Size, q: number): number | null => {
  if (!shot.width || !shot.height) return null
  const long = Math.max(shot.width, shot.height)
  const k = size === 'original' ? 1 : Math.min(1, Number(size) / long)
  return shot.width * shot.height * k * k * 0.4 * (q / 92) ** 2
}

/** Export popover hanging from the Export JPEG button. Everything is pre-set; Enter exports. */
export function ExportPopover({ shot, anchor, onClose }: { shot: Shot; anchor?: HTMLElement | null; onClose: () => void }) {
  const [f, setF] = useState<Form>(load)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; path?: string; bad?: boolean } | null>(null)
  const { places } = useChips(null, null)
  const dirOf = (id: string): string | undefined => places.find((p) => p.id === id)?.path
  const set = (p: Partial<Form>): void => {
    const n = { ...f, ...p }
    setF(n)
    try {
      localStorage.setItem(STORE, JSON.stringify(n))
    } catch {
      /* not remembered */
    }
  }
  useEffect(() => setMsg(null), [shot.id])

  const folder = async (): Promise<string | null> => {
    if (f.dest === 'custom') return f.custom || null
    if (f.dest === 'same') {
      const file = shot.files.find((x) => x.kind === 'jpeg') ?? shot.files.find((x) => x.kind === 'raw') ?? shot.files[0]
      return file ? (await api.filePath(file.id)).path.replace(/[\\/][^\\/]*$/, '') : null
    }
    return dirOf(f.dest) ?? null
  }
  const run = async (what: () => Promise<{ text: string; path?: string } | void>): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await what()
      if (r) setMsg(r)
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true })
    } finally {
      setBusy(false)
    }
  }
  const doExport = (): Promise<void> =>
    run(async () => {
      let dir = await folder()
      if (!dir) {
        dir = (await desktop?.pickFolder()) ?? null
        if (!dir) return
        set({ dest: 'custom', custom: dir })
      }
      const { path } = await api.exportJpeg(shot.id, { dir, size: f.size === 'original' ? 'original' : Number(f.size), quality: f.quality, metadata: f.metadata })
      return { text: 'Exported', path }
    })
  const copy = (): Promise<void> =>
    run(async () => {
      const err = await desktop!.shotAction(shot.id, 'copyImage')
      if (err) throw new Error(err)
      return { text: 'Copied to the clipboard' }
    })
  const browse = async (): Promise<void> => {
    const p = await desktop?.pickFolder()
    if (p) set({ dest: 'custom', custom: p })
  }

  const est = estimate(shot, f.size, f.quality)
  const chip = (d: Dest, label: string): React.ReactNode => (
    <button key={d} className={`chip ${f.dest === d ? 'on' : ''}`} style={{ height: 30 }} onClick={() => set({ dest: d })}>{label}</button>
  )

  return (
    <Popover anchor={anchor} width={340} label="Export JPEG" onClose={onClose} onEnter={() => void doExport()}>
      <div className="pop-head"><h3>Export JPEG</h3><span className="pop-sub">· 1 photo</span><button className="tb pop-x" aria-label="Close" onClick={onClose}>×</button></div>
      <div>
        <div className="pop-lbl">SIZE</div>
        <div className="seg" role="radiogroup" aria-label="Size">
          {([['original', 'Original'], ['2048', '2048 px'], ['1080', '1080 px']] as [Size, string][]).map(([v, l]) => <button key={v} role="radio" aria-checked={f.size === v} className={f.size === v ? 'on' : ''} onClick={() => set({ size: v })}>{l}</button>)}
        </div>
      </div>
      <div>
        <div className="pop-lbl">METADATA</div>
        <div className="seg" role="radiogroup" aria-label="Metadata">
          {([['all', 'Keep'], ['noGps', 'Strip GPS'], ['none', 'Strip all']] as [Form['metadata'], string][]).map(([v, l]) => <button key={v} role="radio" aria-checked={f.metadata === v} className={f.metadata === v ? 'on' : ''} onClick={() => set({ metadata: v })}>{l}</button>)}
        </div>
      </div>
      <div className="pop-q">
        <div className="pop-lbl" style={{ margin: 0 }}>QUALITY</div>
        <input type="range" min={50} max={100} value={f.quality} aria-label="Quality" onChange={(e) => set({ quality: Number(e.target.value) })} />
        <span className="mono">{f.quality}</span>
      </div>
      <div>
        <div className="pop-lbl">SAVE TO</div>
        <div className="pop-save">
          {dirOf('desktop') && chip('desktop', 'Desktop')}
          {dirOf('pictures') && chip('pictures', 'Pictures')}
          {chip('same', 'Same folder')}
          {f.dest === 'custom' && f.custom && <button className="chip on" style={{ height: 30 }} title={f.custom} onClick={() => void browse()}>{f.custom.split(/[\\/]/).filter(Boolean).pop()}</button>}
          <button className="chip" style={{ height: 30 }} onClick={() => void browse()}>Browse…</button>
        </div>
      </div>
      <div className="pop-foot">
        <span className="pop-est" role="status">
          {msg ? <span className={msg.bad ? 'pop-bad' : ''}>{msg.text}{msg.path && <> · <a href="#" onClick={(e) => { e.preventDefault(); void desktop!.reveal(msg.path!) }}>Show file</a></>}</span> : est != null ? `About ${fmtSize(est)}` : ''}
        </span>
        <button className="tb" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void copy()}>Copy to clipboard</button>
        <button className="tb primary" disabled={busy} onClick={() => void doExport()}>{busy ? 'Working…' : 'Export'} <span className="key accent">⏎</span></button>
      </div>
    </Popover>
  )
}
