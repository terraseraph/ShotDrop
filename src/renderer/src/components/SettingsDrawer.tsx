import { useEffect, useState } from 'react'
import type { Settings, Status } from '@shared/types'
import { api, desktop } from '../api'
import { NetworkCheck } from './NetworkCheck'
import { TunnelPanel } from './TunnelPanel'
import { PhoneLink } from './PhoneLink'
import { lanUrl } from './ViewOnPhone'
import { Icon } from './Icon'
import { SyncBoard } from './SyncBoard'

export type Tab = 'camera' | 'sync' | 'library' | 'remote'

interface Props {
  status: Status | null
  tab?: Tab
  onClose: () => void
  toast: (t: string, tone?: 'info' | 'error') => void
  onSetup: () => void
}

const isWindows = navigator.userAgent.includes('Windows')
const PORT_HINT = isWindows
  ? 'Any free port works; set the same number in the camera. Use a free port in the connection check if this one is taken.'
  : 'Any free port works. Ports below 1024 need root on macOS/Linux.'

export function SettingsDrawer({ status, tab: initialTab, onClose, toast, onSetup }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'camera')
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
      <aside className={`drawer ${tab === 'sync' ? 'wide' : ''}`} role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
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
            <CameraTab s={s} status={status} edit={edit} toast={toast} onSetup={onSetup} />
          ) : tab === 'sync' ? (
            <SyncBoard s={s} status={status} reload={load} toast={toast} />
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

function CameraTab({ s, status, edit, toast, onSetup }: { s: Settings; status: Status | null; edit: (p: Partial<Settings>) => void; toast: Props['toast']; onSetup: () => void }) {
  const ftp = s.ftp
  const setFtp = (p: Partial<Settings['ftp']>): void => edit({ ftp: { ...ftp, ...p } })

  return (
    <>
      <section className="panel">
        <div className="row between">
          <h3>Camera connection</h3>
          <Switch checked={ftp.enabled} onChange={(v) => setFtp({ enabled: v })} label={ftp.enabled ? 'FTP server on' : 'FTP server off'} />
        </div>
        <p className="muted small">Host, password, QR code and per-brand menu steps are on the setup screen.</p>
        <button className="btn" onClick={onSetup}><Icon name="camera" /> Camera setup</button>
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

    </>
  )
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
        <h3>XMP sidecars</h3>
        <p className="muted small">
          Write rating, pick/reject and colour label to a <span className="mono">.xmp</span> file next to each shot, so Lightroom, Capture One and
          Bridge see your culling. Sidecars are synced along with the photos.
        </p>
        <Switch checked={s.xmpSidecars} onChange={(v) => edit({ xmpSidecars: v })} label={s.xmpSidecars ? 'Write sidecars' : 'Off'} />
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
          View and cull from a phone or another computer on the same network. When on, anyone on your network can open it. The public (internet) link still asks for a PIN.
        </p>
        <Field label="Public link PIN">
          <input className="input mono big" value={s.remote.pin} onChange={(e) => edit({ remote: { ...s.remote, pin: e.target.value.replace(/\D/g, '').slice(0, 12) } })} />
        </Field>
        {status?.api.remote && lanUrl(status) && (
          <div className="remote-qr">
            <PhoneLink url={lanUrl(status)!} size={200} />
            <p className="muted small">Scan with a phone on this network, then Add to Home Screen.</p>
          </div>
        )}
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
