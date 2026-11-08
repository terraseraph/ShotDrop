import { useCallback, useEffect, useRef, useState } from 'react'
import { SERVICES, missing, parseKeyBlock, webdavUrl, withDefaults, type ExternalRemote, type RemoteAccount, type ServiceDef, type ServiceId } from '@shared/services'
import { api } from '../api'
import { Icon } from './Icon'

const GROUPS: { id: ServiceDef['group']; label: string; note: string }[] = [
  { id: 'storage', label: 'Storage services', note: 'paste an access key' },
  { id: 'server', label: 'Your own server', note: 'host and login' }
]

export const ServiceBadge = ({ def, size = 28 }: { def: ServiceDef; size?: number }) => (
  <span className="rs-badge" style={{ width: size, height: size, color: def.fg, background: def.bg }}>{def.badge}</span>
)

/** More…: every guided service, remotes already in the user's own rclone config, and the raw remote:path escape hatch. */
export function ServicePicker({ onService, onExternal, onAdvanced }: {
  onService: (id: ServiceId) => void
  onExternal: (r: ExternalRemote) => void
  onAdvanced: () => void
}) {
  const [external, setExternal] = useState<ExternalRemote[] | null>(null)
  useEffect(() => { void api.cloudExternal().then((r) => setExternal(r.remotes), () => setExternal([])) }, [])

  return (
    <div className="rs-pick">
      {GROUPS.map((g) => (
        <div key={g.id} className="rs-group">
          <div className="lbl">{g.label.toUpperCase()}<span className="rs-note">{g.note}</span></div>
          <div className="rs-grid">
            {SERVICES.filter((s) => s.group === g.id).map((s) => (
              <button key={s.id} className="rs-svc" onClick={() => onService(s.id)}>
                <ServiceBadge def={s} />
                <span><strong>{s.label}</strong><small>{s.blurb}</small></span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {!!external?.length && (
        <div className="rs-group">
          <div className="lbl">ALREADY SET UP IN RCLONE<span className="rs-note">{external.length} in your rclone config</span></div>
          {external.map((r) => (
            <div key={r.name} className="ad-acct">
              <span className="ad-acct-i" style={{ color: '#a3a3a3', background: '#242424' }}><Icon name="terminal" /></span>
              <span className="ad-acct-main"><strong>{r.name}</strong><span>{r.type}</span></span>
              <button className="fp-btn" onClick={() => onExternal(r)}>Use</button>
            </div>
          ))}
        </div>
      )}
      <button className="fp-btn plain rs-adv" onClick={onAdvanced}><Icon name="terminal" size={14} />Advanced: type an rclone remote:path</button>
    </div>
  )
}

type Phase =
  | { at: 'form' }
  | { at: 'testing' }
  | { at: 'trust'; fingerprint: string; keyType: string; hostKey: string }
  | { at: 'failed'; title: string; fix: string; raw: string }

/**
 * The fields one service needs, then Test: the remote is created and listed in one go. SFTP stops once to confirm the
 * server's fingerprint. Reports the connected remote; the sheet then shows the folder browser.
 */
export function RemoteForm({ def, onConnected, onBack, registerSubmit }: {
  def: ServiceDef
  onConnected: (a: RemoteAccount) => void
  onBack: () => void
  /** The sheet's primary button and Enter run this while the form is showing. Null = not ready yet. */
  registerSubmit: (fn: (() => void) | null, label: string) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [pasted, setPasted] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<Phase>({ at: 'form' })
  const [show, setShow] = useState(false)
  const v = withDefaults(def, values)
  const todo = missing(def, v)
  const set = (k: string, x: string): void => {
    setValues((cur) => ({ ...cur, [k]: x }))
    setPasted((p) => { const n = new Set(p); n.delete(k); return n })
    if (phase.at === 'failed') setPhase({ at: 'form' })
  }

  const run = async (hostKey?: string): Promise<void> => {
    setPhase({ at: 'testing' })
    const r = await api.cloudConnect(def.id, values, hostKey).catch((e: Error) => ({ ok: false as const, error: { title: "Couldn't connect", fix: e.message, raw: e.message } }))
    if (r.ok) return onConnected(r.account)
    if ('needsTrust' in r) return setPhase({ at: 'trust', ...r.needsTrust })
    setPhase({ at: 'failed', ...r.error })
  }

  const busy = phase.at === 'testing' || phase.at === 'trust'
  // The sheet's button calls a stable function that always runs the latest form values.
  const runRef = useRef(run)
  runRef.current = run
  const go = useCallback(() => void runRef.current(), [])
  const canGo = !busy && !todo.length
  const goLabel = phase.at === 'failed' ? 'Try again' : 'Test and connect'
  useEffect(() => registerSubmit(canGo ? go : null, goLabel), [canGo, goLabel, go]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => registerSubmit(null, ''), []) // eslint-disable-line react-hooks/exhaustive-deps

  const onPaste = (text: string): boolean => {
    const got = parseKeyBlock(def, text)
    if (!Object.keys(got).length) return false
    setValues((cur) => ({ ...cur, ...got }))
    setPasted(new Set(Object.keys(got)))
    return true
  }

  const sftpKey = def.id === 'sftp' && v.auth === 'key'
  const shown = def.fields.filter((f) => {
    if (def.id === 'sftp' && f.key === 'auth') return false // drawn as a segmented control
    if (def.id === 'sftp' && f.key === 'pass') return !sftpKey
    if (def.id === 'sftp' && f.key === 'keyFile') return sftpKey
    if (def.id === 'webdav' && f.key === 'vendor') return false
    return true
  })
  const davUrl = def.id === 'webdav' && v.url ? webdavUrl(v.vendor, v.url, v.user || 'you') : null

  return (
    <div className="rs-form">
      <div className="rs-head">
        <ServiceBadge def={def} size={32} />
        <strong>{def.label}</strong>
        <button className="ad-link rs-back" onClick={onBack} disabled={busy}>‹ All services</button>
      </div>
      {def.help && <p className="fp-hint">{def.help}</p>}

      {def.paste && (
        <textarea
          className="rs-paste"
          rows={2}
          placeholder="Paste the key text here and the fields fill themselves in"
          onPaste={(e) => { if (onPaste(e.clipboardData.getData('text'))) e.preventDefault() }}
          onChange={(e) => { if (onPaste(e.target.value)) e.target.value = '' }}
          aria-label="Paste key block"
        />
      )}

      {def.id === 'webdav' && (
        <div className="seg rs-seg" role="radiogroup" aria-label="Server type">
          {def.fields.find((f) => f.key === 'vendor')!.options!.map((o) => (
            <button key={o.value} role="radio" aria-checked={v.vendor === o.value} className={v.vendor === o.value ? 'on' : ''} onClick={() => set('vendor', o.value)}>{o.label}</button>
          ))}
        </div>
      )}

      <div className="rs-fields">
        {shown.map((f) => (
          <label key={f.key} className={`rs-field ${f.key === 'port' ? 'narrow' : ''} ${def.id === 'sftp' && (f.key === 'pass' || f.key === 'keyFile') ? 'late' : ''}`}>
            {/* SFTP's password and key file are each required for their own sign-in method, so not "optional". */}
            <span className="rs-l">{f.label}{f.optional && def.id !== 'sftp' && <em> optional</em>}{pasted.has(f.key) && <b className="rs-auto">✓ from paste</b>}</span>
            {f.kind === 'select' ? (
              <select className="ad-input" value={v[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.kind === 'toggle' ? (
              <span className="rs-toggle"><input type="checkbox" checked={v[f.key] !== 'false'} onChange={(e) => set(f.key, e.target.checked ? 'true' : 'false')} />{f.hint}</span>
            ) : (
              <span className="rs-in">
                <input
                  className="ad-input mono"
                  data-submit="1"
                  type={f.kind === 'secret' && !show ? 'password' : f.kind === 'number' ? 'number' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={f.placeholder ?? f.default}
                  value={values[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                />
                {f.kind === 'secret' && <button className="ad-link rs-show" onClick={(e) => { e.preventDefault(); setShow((x) => !x) }}>{show ? 'hide' : 'show'}</button>}
              </span>
            )}
            {f.hint && f.kind !== 'toggle' && <span className="fp-hint">{f.hint}</span>}
          </label>
        ))}
        {def.id === 'sftp' && (
          <div className="rs-field rs-method">
            <span className="rs-l">Sign in with</span>
            <div className="seg rs-seg" role="radiogroup" aria-label="Sign in with">
              {[['password', 'Password'], ['key', 'SSH key']].map(([k, l]) => (
                <button key={k} role="radio" aria-checked={v.auth === k} className={v.auth === k ? 'on' : ''} onClick={() => set('auth', k)}>{l}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      {davUrl && <p className="fp-hint">Connects to <code>{davUrl}</code></p>}

      {phase.at === 'testing' && (
        <div className="ad-wait"><span className="ad-spin" aria-hidden /><div><strong>Testing the connection…</strong><p>Signing in and listing what's there.</p></div></div>
      )}
      {phase.at === 'trust' && (
        <div className="rs-trust" role="alert">
          <strong>First time connecting to {v.host}</strong>
          <p>Its fingerprint is <code>{phase.fingerprint}</code> ({phase.keyType}). If it matches the one your server shows, trust it. ShotDrop will refuse to connect if it ever changes.</p>
          <div className="rs-row">
            <button className="fp-btn primary" onClick={() => void run(phase.hostKey)}>Trust and continue</button>
            <button className="fp-btn" onClick={() => setPhase({ at: 'form' })}>Cancel</button>
          </div>
        </div>
      )}
      {phase.at === 'failed' && (
        <div className="rs-fail" role="alert">
          <strong>{phase.title}</strong>
          <p>{phase.fix}</p>
          {phase.raw && phase.raw !== phase.fix && <details><summary>Details</summary><code>{phase.raw}</code></details>}
        </div>
      )}
      {phase.at === 'form' && todo.length > 0 && <p className="fp-hint">Still needed: {todo.join(', ')}</p>}
    </div>
  )
}
