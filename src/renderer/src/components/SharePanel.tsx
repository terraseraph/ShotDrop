import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Shot, Status } from '@shared/types'
import { api, apiBase, desktop } from '../api'
import { fade, soft } from '../motion'
import { ExportPopover } from './ExportPopover'
import './SharePanel.css'

/** Desktop sharing actions for the selected shot (board: Open in…, Show in folder, Export JPEG, Share link). Remote browsers get nothing here. */
export function SharePanel({ shot }: { shot: Shot }) {
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([])
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  const [exporting, setExporting] = useState(false)
  const exportBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => { void desktop?.editors().then(setEditors).catch(() => undefined) }, [])
  useEffect(() => { setMsg(null); setExporting(false) }, [shot.id])
  if (!desktop) return null

  const act = async (action: 'reveal' | 'open' | 'openWith', arg?: string): Promise<void> => {
    const err = await desktop!.shotAction(shot.id, action, arg)
    if (err) setMsg({ text: err, bad: true })
  }
  const copyLink = async (): Promise<void> => {
    try {
      const r = await api.shareLink(shot.id)
      if (!r.url) return setMsg({ text: r.reason ?? 'No link available', bad: true })
      await navigator.clipboard.writeText(r.url)
      setMsg({ text: `Link copied (${r.via}). It opens this photo's preview only and stays valid until you change the PIN.` })
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true })
    }
  }
  const ed = editors[0]

  return (
    <section className="share">
      <div className="share-grid">
        <button className="tb" onClick={() => void (ed ? act('openWith', ed.id) : act('open'))}>{ed ? `Open in ${ed.name}` : 'Open'}</button>
        <button className="tb" onClick={() => void act('reveal')}>Show in folder</button>
        <button ref={exportBtn} className={`tb strong ${exporting ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={exporting} onClick={() => setExporting((v) => !v)}>Export JPEG</button>
        <button className="tb strong" onClick={() => void copyLink()}>Share link</button>
      </div>
      {msg && <div className={`share-msg ${msg.bad ? 'bad' : ''}`} role="status">{msg.text}</div>}
      <AnimatePresence>{exporting && <ExportPopover key="x" shot={shot} anchor={exportBtn.current} onClose={() => setExporting(false)} />}</AnimatePresence>
    </section>
  )
}

// ================= phone: MShare.dc.html =================

type Size = 'original' | '2048' | '1080'
type Meta = 'all' | 'noGps' | 'none'
const keyHeader = (): Record<string, string> => {
  try {
    const k = localStorage.getItem('shotdrop.key')
    return k ? { 'x-shotdrop-key': k } : {}
  } catch {
    return {}
  }
}

/** Bottom sheet on the phone: Share to… (Web Share API), Copy preview link, Save to phone. The PC makes the JPEG, the phone keeps it. */
export function MobileShareSheet({ shot, status, onClose, toast }: { shot: Shot; status: Status | null; onClose: () => void; toast: (t: string, tone?: 'info' | 'error') => void }) {
  const [size, setSize] = useState<Size>('2048')
  const [meta, setMeta] = useState<Meta>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const t = status?.tunnel
  const canShare = typeof navigator.canShare === 'function'

  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const fetchJpeg = async (): Promise<File> => {
    const res = await fetch(`${apiBase}/api/shots/${shot.id}/export?size=${size}&quality=92&metadata=${meta}`, { headers: keyHeader() })
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status} ${res.statusText}`)
    return new File([await res.blob()], `${shot.name}.jpg`, { type: 'image/jpeg' })
  }
  const run = async (id: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(id)
    try {
      await fn()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }
  const share = (): Promise<void> => run('share', async () => {
    const f = await fetchJpeg()
    if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: shot.name })
    else save(f)
  })
  const save = (f: File): void => {
    const u = URL.createObjectURL(f)
    const a = Object.assign(document.createElement('a'), { href: u, download: f.name })
    a.click()
    setTimeout(() => URL.revokeObjectURL(u), 4000)
  }
  const link = (): Promise<void> => run('link', async () => {
    const r = await api.shareLink(shot.id)
    if (!r.url) throw new Error(r.reason ?? 'No link available')
    await navigator.clipboard.writeText(r.url)
    toast('Preview link copied')
  })

  const meta2 = [shot.rating ? `★${shot.rating}` : null, shot.flag === 1 ? 'Picked' : shot.flag === -1 ? 'Rejected' : null, [...new Set(shot.files.map((x) => x.kind === 'raw' ? 'RAW' : x.kind === 'jpeg' ? 'JPEG' : null).filter(Boolean))].join(' + ')].filter(Boolean).join(' · ')
  const Seg = <T extends string>({ v, set, items, label }: { v: T; set: (n: T) => void; items: [T, string][]; label: string }) => (
    <div><div className="msh-lbl">{label}</div><div className="msh-seg" role="radiogroup" aria-label={label}>{items.map(([k, l]) => <button key={k} role="radio" aria-checked={v === k} className={v === k ? 'on' : ''} onClick={() => set(k)}>{l}</button>)}</div></div>
  )

  return (
    <>
      <motion.div className="msh-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} onClick={onClose} />
      <motion.div className="msh" role="dialog" aria-label="Share" initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={soft}>
        <div className="msh-grab" aria-hidden />
        <div className="msh-head">
          <img src={api.thumbUrl(shot)} alt="" />
          <div style={{ minWidth: 0 }}><div className="msh-name">{shot.name}</div><div className="msh-meta">{meta2}</div></div>
        </div>
        <div className="msh-big">
          <button disabled={!!busy} onClick={() => void share()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
            {canShare ? 'Share to…' : 'Download JPEG'}<span>{busy === 'share' ? 'Preparing…' : `${size === 'original' ? 'Original' : `${size} px`} JPEG`}</span>
          </button>
          <button disabled={!!busy} onClick={() => void link()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 4v16M4 8h16" /></svg>
            Copy preview link<span>valid until PIN changes</span>
          </button>
          <button disabled={!!busy} onClick={() => void run('save', async () => { save(await fetchJpeg()); toast('Saved to your downloads') })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>
            Save to phone<span>{busy === 'save' ? 'Preparing…' : ''}</span>
          </button>
        </div>
        <Seg label="SIZE" v={size} set={setSize} items={[['original', 'Original'], ['2048', '2048 px'], ['1080', '1080 px']]} />
        <Seg label="METADATA" v={meta} set={setMeta} items={[['all', 'Keep'], ['noGps', 'Strip GPS'], ['none', 'Strip all']]} />
        <div className="msh-pub">
          <div style={{ minWidth: 0 }}><div className="msh-name">Public link for this shoot</div><div className="msh-meta">{t?.status === 'running' ? 'On. Anyone with the link and PIN can watch.' : 'Lets a client watch from anywhere.'}</div></div>
          <button onClick={() => void (t?.status === 'running' ? api.tunnelStop() : api.tunnelStart()).catch(() => toast('Change this on the PC.', 'error'))}>{t?.status === 'running' ? 'Turn off' : 'Turn on'}</button>
        </div>
      </motion.div>
    </>
  )
}
