import { useCallback, useEffect, useState } from 'react'
import type { CloudAccount, CloudFolder, CloudProvider, CloudQuota, CloudState } from '@shared/types'
import { api } from '../api'
import { fmtSize } from '../format'
import { Icon } from './Icon'

const LABEL: Record<CloudProvider, string> = { drive: 'Google Drive', dropbox: 'Dropbox' }

interface Props {
  /** Called with an rclone target such as "gdrive-a1b2:ShotDrop/Weddings" and a suggested destination name. */
  onPick: (target: string, name: string) => void
  toast: (t: string, tone?: 'info' | 'error') => void
}

/** Link Google Drive / Dropbox with one click, then pick or create the folder to sync into. */
export function CloudPicker({ onPick, toast }: Props) {
  const [accounts, setAccounts] = useState<CloudAccount[]>([])
  const [linking, setLinking] = useState<CloudState['linking']>(null)
  const [fullAccess, setFullAccess] = useState(false)
  const [own, setOwn] = useState({ clientId: '', clientSecret: '' })
  const [info, setInfo] = useState<Record<string, { email: string | null; quota: CloudQuota | null }>>({})
  const [browse, setBrowse] = useState<{ account: CloudAccount; path: string[] } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.cloudAccounts()
      setAccounts(r.accounts)
      setLinking(r.linking)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [toast])
  useEffect(() => void refresh(), [refresh])

  // Account details (email, space left) come from the provider, so fetch them once per account.
  useEffect(() => {
    for (const a of accounts) {
      if (!info[a.name]) void api.cloudInfo(a.name).then((i) => setInfo((cur) => ({ ...cur, [a.name]: i })), () => undefined)
    }
  }, [accounts, info])

  // While waiting for the browser, poll so the sign-in link (fallback if no browser opened) shows up.
  useEffect(() => {
    if (!linking) return
    const t = setInterval(() => void api.cloudAccounts().then((r) => setLinking(r.linking), () => undefined), 1500)
    return () => clearInterval(t)
  }, [linking])

  const connect = async (provider: CloudProvider): Promise<void> => {
    setLinking({ provider, startedAt: Date.now() })
    try {
      const a = await api.cloudLink(provider, {
        fullAccess: provider === 'drive' && fullAccess,
        ...(own.clientId.trim() && own.clientSecret.trim() ? { clientId: own.clientId.trim(), clientSecret: own.clientSecret.trim() } : {})
      })
      toast(`${LABEL[provider]} connected`)
      setBrowse({ account: a, path: [] })
    } catch (e) {
      const m = (e as Error).message
      if (m !== 'Cancelled') toast(m, 'error')
    } finally {
      setLinking(null)
      void refresh()
    }
  }

  const disconnect = async (a: CloudAccount): Promise<void> => {
    if (!confirm(`Disconnect ${LABEL[a.provider]}? ShotDrop forgets this sign-in; files already uploaded stay in your cloud.`)) return
    try {
      await api.cloudDisconnect(a.name)
      if (browse?.account.name === a.name) setBrowse(null)
      void refresh()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="stack">
      {accounts.map((a) => {
        const i = info[a.name]
        return (
          <div className="dest" key={a.name}>
            <div className="dest-main">
              <strong>{LABEL[a.provider]}</strong>
              <span className="small muted">
                {i?.email ?? a.name}
                {i?.quota?.free != null && ` · ${fmtSize(i.quota.free)} free`}
                {a.provider === 'drive' && !a.fullAccess && ' · only folders ShotDrop creates'}
              </span>
            </div>
            <button className="btn" onClick={() => setBrowse({ account: a, path: [] })}>
              <Icon name="folder" /> Choose folder
            </button>
            <button className="icon-btn" title="Disconnect" onClick={() => void disconnect(a)}>
              <Icon name="trash" />
            </button>
          </div>
        )
      })}

      {linking ? (
        <div className="warn-box small">
          <div className="row between">
            <span>Finish signing in in your browser…</span>
            <button className="btn" onClick={() => void api.cloudCancel().catch(() => undefined)}>Cancel</button>
          </div>
          {linking.authUrl && (
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Browser didn't open? <a className="link" href={linking.authUrl} target="_blank" rel="noreferrer">Open the sign-in page</a>
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="row tight">
            <button className="btn primary" onClick={() => void connect('drive')}>Connect Google Drive</button>
            <button className="btn primary" onClick={() => void connect('dropbox')}>Connect Dropbox</button>
          </div>
          <details className="small">
            <summary className="muted">Sign-in options (use your own Google/Dropbox app)</summary>
            <p className="muted small">Google is retiring rclone's shared Drive sign-in during 2026. If Drive sign-in fails or is rate limited, create your own client ID and paste it here.</p>
            <label className="row tight small" style={{ margin: '8px 0' }}>
              <input type="checkbox" checked={fullAccess} onChange={(e) => setFullAccess(e.target.checked)} />
              Google Drive: let ShotDrop see all my folders (otherwise it only sees folders it creates)
            </label>
            <p className="muted small">Optional: use your own app credentials if sign-in is rate limited (see docs/cloud-linking.md).</p>
            <div className="row tight">
              <input className="input mono" placeholder="Client ID" value={own.clientId} onChange={(e) => setOwn({ ...own, clientId: e.target.value })} />
              <input className="input mono" placeholder="Client secret" type="password" value={own.clientSecret} onChange={(e) => setOwn({ ...own, clientSecret: e.target.value })} />
            </div>
          </details>
        </>
      )}

      {browse && (
        <FolderBrowser
          key={browse.account.name}
          account={browse.account}
          start={browse.path}
          toast={toast}
          onPick={(path) => onPick(`${browse.account.name}:${path}`, LABEL[browse.account.provider])}
        />
      )}
    </div>
  )
}

function FolderBrowser({ account, start, toast, onPick }: { account: CloudAccount; start: string[]; toast: Props['toast']; onPick: (path: string) => void }) {
  const [path, setPath] = useState<string[]>(start)
  const [folders, setFolders] = useState<CloudFolder[] | null>(null)
  const [newName, setNewName] = useState('')
  const joined = path.join('/')

  const load = useCallback((): void => {
    setFolders(null)
    api.cloudFolders(account.name, joined).then(setFolders, (e: Error) => {
      toast(e.message, 'error')
      setFolders([])
    })
  }, [account.name, joined, toast])
  useEffect(load, [load])

  const create = async (): Promise<void> => {
    const n = newName.trim().replace(/[\\/]+/g, '-')
    if (!n) return
    try {
      await api.cloudMkdir(account.name, [...path, n].join('/'))
      setNewName('')
      setPath([...path, n])
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="panel" style={{ margin: 0 }}>
      <div className="row tight small" style={{ flexWrap: 'wrap' }}>
        <button className="link" onClick={() => setPath([])}>{LABEL[account.provider]}</button>
        {path.map((p, i) => (
          <span key={i}>
            <span className="muted"> / </span>
            <button className="link" onClick={() => setPath(path.slice(0, i + 1))}>{p}</button>
          </span>
        ))}
      </div>
      <div className="stack" style={{ margin: '8px 0', maxHeight: 180, overflow: 'auto' }}>
        {folders === null && <span className="muted small">Loading…</span>}
        {folders?.length === 0 && (
          <span className="muted small">
            {account.provider === 'drive' && !account.fullAccess && !path.length
              ? "No folders yet. ShotDrop can only see folders it creates, so make one below."
              : 'No sub-folders here.'}
          </span>
        )}
        {folders?.map((f) => (
          <button key={f.name} className="link" style={{ textAlign: 'left', textDecoration: 'none' }} onClick={() => setPath([...path, f.name])}>
            <Icon name="folder" /> {f.name}
          </button>
        ))}
      </div>
      <div className="row tight">
        <input className="input" placeholder="New folder name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        <button className="btn" disabled={!newName.trim()} onClick={() => void create()}>
          <Icon name="plus" /> Create
        </button>
        <button className="btn primary" onClick={() => onPick(joined)}>Use this folder</button>
      </div>
    </div>
  )
}
