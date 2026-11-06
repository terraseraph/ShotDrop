import { useEffect, useState } from 'react'
import type { ExportOptions, Shot } from '@shared/types'
import { api, desktop } from '../api'

const STORE = 'shotdrop.export'
type Form = Omit<ExportOptions, 'size'> & { size: string }
const DEFAULTS: Form = { dir: '', size: '2048', quality: 90, metadata: 'all' }

function load(): Form {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

/** Desktop-only sharing actions for the selected shot. Remote browsers can't reach the file system, so they get nothing here. */
export function SharePanel({ shot }: { shot: Shot }) {
  const [form, setForm] = useState<Form>(load)
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([])
  const [msg, setMsg] = useState<{ text: string; path?: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    desktop?.editors().then(setEditors).catch(() => undefined)
  }, [])
  useEffect(() => setMsg(null), [shot.id])
  if (!desktop) return null

  const set = (p: Partial<Form>): void => {
    const next = { ...form, ...p }
    setForm(next)
    try {
      localStorage.setItem(STORE, JSON.stringify(next))
    } catch {
      /* private mode */
    }
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
      let dir = form.dir
      if (!dir) {
        dir = (await desktop!.pickFolder()) ?? ''
        if (!dir) return
        set({ dir })
      }
      const { path } = await api.exportJpeg(shot.id, { ...form, dir, size: form.size === 'original' ? 'original' : Number(form.size) })
      return { text: 'Exported', path }
    })

  const act = (action: 'reveal' | 'open' | 'copyImage', done?: string) => run(async () => {
    const err = await desktop!.shotAction(shot.id, action)
    if (err) throw new Error(err)
    return done ? { text: done } : undefined
  })

  const copyLink = (): Promise<void> =>
    run(async () => {
      const r = await api.shareLink(shot.id)
      if (!r.url) return { text: r.reason ?? 'No link available', bad: true }
      await navigator.clipboard.writeText(r.url)
      return { text: `Link copied (${r.via}). It opens this photo's preview only and stays valid until you change the PIN.` }
    })

  return (
    <section>
      <h3>Share &amp; export</h3>
      <div className="share-grid">
        <button className="btn" disabled={busy} onClick={() => void act('copyImage', 'Image copied')}>Copy image</button>
        <button className="btn" disabled={busy} onClick={() => void copyLink()}>Copy link</button>
        <button className="btn" disabled={busy} onClick={() => void act('reveal')}>Show in Explorer</button>
        <button className="btn" disabled={busy} onClick={() => void act('open')}>Open</button>
        <select
          className="select span2"
          value=""
          disabled={busy}
          aria-label="Open with"
          onChange={(e) => void run(async () => void (await desktop!.shotAction(shot.id, 'openWith', e.target.value)))}
        >
          <option value="">Open with…</option>
          {editors.map((ed) => (
            <option key={ed.id} value={ed.id}>{ed.name}</option>
          ))}
          <option value="dialog">Choose app…</option>
        </select>
      </div>

      <div className="export-form">
        <label>
          Size
          <select className="select" value={form.size} onChange={(e) => set({ size: e.target.value })}>
            <option value="original">Original size</option>
            <option value="2048">2048 px</option>
            <option value="1080">1080 px</option>
          </select>
        </label>
        <label>
          Quality
          <input className="input" type="number" min={1} max={100} value={form.quality} onChange={(e) => set({ quality: Math.min(100, Math.max(1, Number(e.target.value) || 90)) })} />
        </label>
        <label className="span2">
          Metadata
          <select className="select" value={form.metadata} onChange={(e) => set({ metadata: e.target.value as Form['metadata'] })}>
            <option value="all">Keep all</option>
            <option value="noGps">Remove GPS location</option>
            <option value="none">Remove all metadata</option>
          </select>
        </label>
        <label className="span2">
          Folder
          <span className="row-actions">
            <input className="input" readOnly value={form.dir} placeholder="Choose on first export" title={form.dir} />
            <button className="btn small" onClick={() => void desktop!.pickFolder().then((d) => d && set({ dir: d }))}>Browse</button>
          </span>
        </label>
        <button className="btn primary span2" disabled={busy} onClick={() => void doExport()}>
          {busy ? 'Working…' : 'Export JPEG'}
        </button>
      </div>

      {msg && (
        <div className={`share-msg ${msg.bad ? 'bad' : ''}`} role="status">
          {msg.text}
          {msg.path && (
            <>
              {' '}
              <a href="#" onClick={(e) => { e.preventDefault(); void desktop!.reveal(msg.path!) }} title={msg.path}>Show file</a>
            </>
          )}
        </div>
      )}
    </section>
  )
}
