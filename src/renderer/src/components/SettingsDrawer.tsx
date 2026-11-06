import { useEffect, useState } from 'react'
import type { Destination, DestinationFilter, DestinationType, Settings, Status } from '@shared/types'
import { api, desktop } from '../api'
import { ConnectionCard } from './ConnectionCard'
import { NetworkCheck } from './NetworkCheck'
import { TunnelPanel } from './TunnelPanel'
import { Icon } from './Icon'

type Tab = 'camera' | 'sync' | 'library' | 'remote'

interface Props {
  status: Status | null
  onClose: () => void
  toast: (t: string, tone?: 'info' | 'error') => void
}

const isWindows = navigator.userAgent.includes('Windows')
const PORT_HINT = isWindows
  ? 'Any free port works; set the same number in the camera. Use a free port in the connection check if this one is taken.'
  : 'Any free port works. Ports below 1024 need root on macOS/Linux.'

const BRAND_STEPS: { brand: string; steps: string[] }[] = [
  {
    brand: 'Sony',
    steps: [
      'Menu → Network → FTP Transfer Func. → Server Setting → pick a server slot.',
      'Host name: the Server address shown above. Port: as shown. Secure protocol: Off.',
      'User / Password: as shown. Passive mode: On. Directory: leave blank.',
      'Connect the camera to the same Wi-Fi (Network → Wi-Fi → Access Point Set.).',
      'Turn on Auto FTP Transfer to send each shot as you take it.'
    ]
  },
  {
    brand: 'Canon',
    steps: [
      'Menu → Network → Network settings → Connection option settings → FTP transfer.',
      'Run the connection wizard: choose the Wi-Fi network, then FTP mode (not SFTP/FTPS).',
      'Address: the Server address. Port: as shown. Passive mode: Enable. Proxy: none.',
      'Login: the User and Password shown. Target folder: Root folder.',
      'Transfer settings → Auto transfer: Enable.'
    ]
  },
  {
    brand: 'Nikon',
    steps: [
      'Network menu → Connect to FTP server → Network settings → Create profile.',
      'Choose Wi-Fi and join the same network as this PC.',
      'Server type: FTP. Address: the Server address. Port: as shown. Passive mode: On.',
      'Login with the User and Password shown, then Connect.',
      'Options → Auto send: On.'
    ]
  },
  {
    brand: 'Fujifilm',
    steps: [
      'Network/USB settings → FTP transfer settings → Server settings.',
      'Server: the Server address. Port: as shown. Passive mode: On.',
      'User ID / Password: as shown. Upload folder: blank.',
      'Join the same Wi-Fi as this PC, then enable Auto Image Transfer Order.'
    ]
  }
]

export function SettingsDrawer({ status, onClose, toast }: Props) {
  const [tab, setTab] = useState<Tab>('camera')
  const [s, setS] = useState<Settings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = (): void => void api.settings().then((v) => {
    setS(v)
    setDirty(false)
  })
  useEffect(load, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const edit = (patch: Partial<Settings>): void => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (!s) return
    setSaving(true)
    try {
      const { destinations: _ignored, ...rest } = s
      setS(await api.patchSettings(rest))
      setDirty(false)
      toast('Settings saved')
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <nav className="tabs">
          {(['camera', 'sync', 'library', 'remote'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        <div className="drawer-body">
          {!s ? (
            <p className="muted">Loading…</p>
          ) : tab === 'camera' ? (
            <CameraTab s={s} status={status} edit={edit} toast={toast} />
          ) : tab === 'sync' ? (
            <SyncTab s={s} status={status} reload={load} toast={toast} />
          ) : tab === 'library' ? (
            <LibraryTab s={s} edit={edit} />
          ) : (
            <RemoteTab s={s} status={status} edit={edit} toast={toast} />
          )}
        </div>

        {tab !== 'sync' && (
          <footer className="drawer-foot">
            <span className="muted small">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
            <button className="btn" disabled={!dirty || saving} onClick={load}>Revert</button>
            <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </footer>
        )}
      </aside>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
      <span>{label}</span>
    </button>
  )
}

function CameraTab({ s, status, edit, toast }: { s: Settings; status: Status | null; edit: (p: Partial<Settings>) => void; toast: Props['toast'] }) {
  const ftp = s.ftp
  const setFtp = (p: Partial<Settings['ftp']>): void => edit({ ftp: { ...ftp, ...p } })
  const [brand, setBrand] = useState<string | null>(null)

  return (
    <>
      <section className="panel">
        <div className="row between">
          <h3>Camera connection</h3>
          <Switch checked={ftp.enabled} onChange={(v) => setFtp({ enabled: v })} label={ftp.enabled ? 'FTP server on' : 'FTP server off'} />
        </div>
        <ConnectionCard status={status} />
      </section>

      <section className="panel">
        <h3>Connection check</h3>
        <NetworkCheck watch={`${status?.ftp.running}-${status?.ftp.port}`} toast={toast} />
      </section>

      <section className="panel">
        <h3>Cameras / FTP users</h3>
        <p className="muted small">Give each camera or shooter its own login and their frames are tagged by name.</p>
        {ftp.users.map((u, i) => (
          <div className="row user-row" key={i}>
            <input className="input" value={u.label} placeholder="Label" aria-label="Label"
              onChange={(e) => setFtp({ users: ftp.users.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <input className="input mono" value={u.username} placeholder="user" aria-label="Username"
              onChange={(e) => setFtp({ users: ftp.users.map((x, j) => (j === i ? { ...x, username: e.target.value.replace(/[^\w.-]/g, '') } : x)) })} />
            <input className="input mono" value={u.password} placeholder="password" aria-label="Password"
              onChange={(e) => setFtp({ users: ftp.users.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)) })} />
            <button className="icon-btn" disabled={ftp.users.length === 1} title="Remove"
              onClick={() => setFtp({ users: ftp.users.filter((_, j) => j !== i) })}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
        <button className="btn" onClick={() => setFtp({
          users: [...ftp.users, { label: `Camera ${ftp.users.length + 1}`, username: `camera${ftp.users.length + 1}`, password: Math.random().toString(36).slice(2, 10) }]
        })}>
          <Icon name="plus" /> Add camera
        </button>
      </section>

      <section className="panel">
        <h3>Ports</h3>
        <div className="row">
          <Field label="FTP port" hint={PORT_HINT}>
            <input className="input mono" type="number" value={ftp.port} onChange={(e) => setFtp({ port: Number(e.target.value) })} />
          </Field>
          <Field label="Passive ports" hint="Cameras use these for the photo transfer. 'Allow cameras' in the connection check opens them.">
            <div className="row tight">
              <input className="input mono" type="number" value={ftp.pasvMin} onChange={(e) => setFtp({ pasvMin: Number(e.target.value) })} />
              <span className="muted">–</span>
              <input className="input mono" type="number" value={ftp.pasvMax} onChange={(e) => setFtp({ pasvMax: Number(e.target.value) })} />
            </div>
          </Field>
        </div>
      </section>

      <section className="panel">
        <h3>Camera setup guides</h3>
        <div className="brands">
          {BRAND_STEPS.map((b) => (
            <div key={b.brand} className={`brand-guide ${brand === b.brand ? 'open' : ''}`}>
              <button className="brand-head" onClick={() => setBrand(brand === b.brand ? null : b.brand)} aria-expanded={brand === b.brand}>
                {b.brand}
                <Icon name={brand === b.brand ? 'prev' : 'next'} />
              </button>
              {brand === b.brand && (
                <ol>
                  {b.steps.map((st) => <li key={st}>{st}</li>)}
                </ol>
              )}
            </div>
          ))}
        </div>
        <p className="muted small">Menu names vary by model and firmware. These are a starting point.</p>
      </section>
    </>
  )
}

function SyncTab({ s, status, reload, toast }: { s: Settings; status: Status | null; reload: () => void; toast: Props['toast'] }) {
  const empty = { name: '', type: 'rclone' as DestinationType, target: '', filter: 'all' as DestinationFilter }
  const [draft, setDraft] = useState(empty)
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn()
      if (ok) toast(ok)
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const sync = status?.sync

  return (
    <>
      <section className="panel">
        <div className="row between">
          <h3>Destinations</h3>
          {sync && (
            <span className="muted small">
              {sync.pending} queued · {sync.running} uploading · {sync.errors} failed
              {sync.errors > 0 && (
                <button className="link" onClick={() => void run(() => api.retrySync(), 'Retrying failed uploads')}> Retry</button>
              )}
            </span>
          )}
        </div>
        {!s.destinations.length && <p className="muted small">No destinations yet. Shots stay on this PC until you add one.</p>}
        {s.destinations.map((d: Destination) => (
          <div className="dest" key={d.id}>
            <div className="dest-main">
              <strong>{d.name}</strong>
              <span className="mono small muted">{d.type === 'rclone' ? 'rclone' : 'folder'} → {d.target}</span>
              <span className="small muted">{FILTER_TEXT[d.filter]}</span>
            </div>
            <Switch checked={d.enabled} onChange={(v) => void run(() => api.patchDestination(d.id, { enabled: v }))} label="" />
            <button className="icon-btn" title="Resync everything" onClick={() => void run(async () => toast(`Queued ${(await api.resync(d.id)).queued} files`))}>
              <Icon name="refresh" />
            </button>
            <button className="icon-btn" title="Remove" onClick={() => confirm(`Remove ${d.name}? Files already uploaded stay where they are.`) && void run(() => api.deleteDestination(d.id))}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </section>

      <section className="panel">
        <h3>Add destination</h3>
        <div className="seg wide">
          <button className={draft.type === 'rclone' ? 'on' : ''} onClick={() => setDraft({ ...draft, type: 'rclone' })}>Cloud (rclone)</button>
          <button className={draft.type === 'folder' ? 'on' : ''} onClick={() => setDraft({ ...draft, type: 'folder' })}>Folder / NAS</button>
        </div>
        <Field label="Name">
          <input className="input" value={draft.name} placeholder={draft.type === 'rclone' ? 'Google Drive' : 'NAS'} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field
          label={draft.type === 'rclone' ? 'rclone remote path' : 'Folder'}
          hint={draft.type === 'rclone' ? 'e.g. gdrive:Photos/ShotDrop. Set up remotes once with `rclone config`.' : 'Local folder or network share, e.g. \\\\nas\\photos'}
        >
          <div className="row tight">
            <input className="input mono" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
            {draft.type === 'folder' && desktop && (
              <button className="btn" onClick={async () => {
                const p = await desktop!.pickFolder()
                if (p) setDraft({ ...draft, target: p })
              }}>
                <Icon name="folder" /> Browse
              </button>
            )}
          </div>
        </Field>
        <Field label="What to sync">
          <select className="select" value={draft.filter} onChange={(e) => setDraft({ ...draft, filter: e.target.value as DestinationFilter })}>
            {Object.entries(FILTER_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {draft.type === 'rclone' && status && !status.sync.rcloneAvailable && (
          <p className="warn-box small">rclone wasn't found on this PC. Install it from rclone.org, or set its path under Library.</p>
        )}
        <button
          className="btn primary"
          disabled={!draft.name.trim() || !draft.target.trim()}
          onClick={() => void run(async () => {
            await api.addDestination({ ...draft, enabled: true })
            setDraft(empty)
          }, 'Destination added. Existing shots are queued.')}
        >
          <Icon name="plus" /> Add
        </button>
      </section>
    </>
  )
}

const FILTER_TEXT: Record<DestinationFilter, string> = {
  all: 'Everything',
  jpeg: 'JPEG / HEIF only',
  raw: 'RAW only',
  picks: 'Picks only'
}

function LibraryTab({ s, edit }: { s: Settings; edit: (p: Partial<Settings>) => void }) {
  return (
    <>
      <section className="panel">
        <h3>Library folder</h3>
        <p className="muted small">Shots are filed into a folder per day, e.g. 2026-11-06.</p>
        <div className="row tight">
          <input className="input mono" value={s.libraryDir} onChange={(e) => edit({ libraryDir: e.target.value })} />
          {desktop && (
            <>
              <button className="btn" onClick={async () => {
                const p = await desktop!.pickFolder()
                if (p) edit({ libraryDir: p })
              }}>
                <Icon name="folder" /> Browse
              </button>
              <button className="btn" onClick={() => void desktop!.openPath(s.libraryDir)}>Open</button>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <h3>Watched folders</h3>
        <p className="muted small">New images in these folders are copied in (originals left alone). Handy for card readers or tethering software.</p>
        {s.watchFolders.map((f, i) => (
          <div className="row tight" key={f}>
            <span className="input mono readonly">{f}</span>
            <button className="icon-btn" title="Remove" onClick={() => edit({ watchFolders: s.watchFolders.filter((_, j) => j !== i) })}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
        {desktop && (
          <button className="btn" onClick={async () => {
            const p = await desktop!.pickFolder()
            if (p && !s.watchFolders.includes(p)) edit({ watchFolders: [...s.watchFolders, p] })
          }}>
            <Icon name="plus" /> Add folder
          </button>
        )}
      </section>

      <section className="panel">
        <h3>rclone</h3>
        <Field label="rclone executable" hint="Leave as 'rclone' if it's on your PATH.">
          <input className="input mono" value={s.rclonePath} onChange={(e) => edit({ rclonePath: e.target.value })} />
        </Field>
      </section>
    </>
  )
}

function RemoteTab({ s, status, edit, toast }: { s: Settings; status: Status | null; edit: (p: Partial<Settings>) => void; toast: Props['toast'] }) {
  return (
    <>
      <section className="panel">
        <div className="row between">
          <h3>Remote gallery</h3>
          <Switch checked={s.remote.enabled} onChange={(v) => edit({ remote: { ...s.remote, enabled: v } })} label={s.remote.enabled ? 'On' : 'Off'} />
        </div>
        <p className="muted small">
          View and cull from a phone or another computer on the same network. When on, the API listens on your network and asks for this PIN. The public link below uses the same PIN.
        </p>
        <Field label="PIN">
          <input className="input mono big" value={s.remote.pin} onChange={(e) => edit({ remote: { ...s.remote, pin: e.target.value.replace(/\D/g, '').slice(0, 12) } })} />
        </Field>
        {status?.api.remote && (
          <div className="conn-card">
            {status.api.urls.map((u) => (
              <div className="conn-field" key={u}>
                <span className="conn-label">Open</span>
                <span className="conn-value mono">{u}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>API</h3>
        <Field label="Port" hint="REST API and web gallery. Restart ShotDrop after changing it.">
          <input className="input mono" type="number" value={s.api.port} onChange={(e) => edit({ api: { port: Number(e.target.value) } })} />
        </Field>
      </section>

      <TunnelPanel s={s} status={status} edit={edit} toast={toast} />
    </>
  )
}
