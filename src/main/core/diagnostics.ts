import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import type { Check, DiagnosticsReport, FixId, FixResult, LoginAttempt } from '@shared/diagnostics'
import { ftpLoginName } from '@shared/types'
import type { Core } from './index'
import { allowCameras, firewallStatus, removeRules, type FirewallStatus } from './firewall'
import { listInterfaces } from './net'

const isWin = process.platform === 'win32'

// ---------------------------------------------------------------- helpers

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(out)))
  )
}

/** True if nothing else is listening on the port (tries to bind it briefly). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)))
  })
}

export async function findFreePort(from: number, avoid: number[] = []): Promise<number> {
  for (let p = from; p < from + 200; p++) if (!avoid.includes(p) && (await portFree(p))) return p
  throw new Error('No free port found')
}

/** Which program is listening on a TCP port (Windows only). */
async function portOwner(port: number): Promise<{ pid: number; name: string } | null> {
  if (!isWin) return null
  try {
    const out = await run('netstat', ['-ano', '-p', 'TCP'])
    const line = out.split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`).test(l))
    if (!line) return null
    const pid = Number(line.trim().split(/\s+/).pop())
    const csv = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    const name = csv.match(/^"([^"]+)"/m)?.[1] ?? `PID ${pid}`
    return { pid, name }
  } catch {
    return null
  }
}

/** Speaks just enough FTP to prove a camera could log in and open a passive data connection. */
async function ftpSelfTest(host: string, port: number, user: string, pass: string): Promise<{ ok: boolean; step: string; detail: string }> {
  const sock = new Socket()
  const lines: string[] = []
  let buf = ''
  let waiter: ((reply: string) => void) | null = null
  sock.setTimeout(5000)
  sock.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      lines.push(line)
      if (/^\d{3} /.test(line) && waiter) {
        const w = waiter
        waiter = null
        w(line)
      }
    }
  })
  const reply = (): Promise<string> =>
    new Promise((resolve, reject) => {
      waiter = resolve
      sock.once('timeout', () => reject(new Error('no reply (timed out)')))
      sock.once('error', reject)
      sock.once('close', () => reject(new Error('connection closed')))
    })
  const send = async (cmd: string): Promise<string> => {
    const r = reply()
    sock.write(cmd + '\r\n')
    return r
  }

  let step = 'connect'
  try {
    const greeting = reply()
    sock.connect(port, host)
    await greeting
    step = 'login'
    const usr = await send(`USER ${user}`)
    // Anonymous logins are accepted at USER (230); otherwise send the password.
    const pw = usr.startsWith('230') ? usr : await send(`PASS ${pass}`)
    if (!pw.startsWith('230')) return { ok: false, step, detail: pw }
    step = 'passive'
    const pasv = await send('PASV')
    const m = pasv.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/)
    if (!pasv.startsWith('227') || !m) return { ok: false, step, detail: pasv }
    const dataHost = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`
    const dataPort = Number(m[5]) * 256 + Number(m[6])
    step = 'data'
    await new Promise<void>((resolve, reject) => {
      const d = new Socket()
      d.setTimeout(4000)
      d.once('connect', () => {
        d.destroy()
        resolve()
      })
      d.once('timeout', () => {
        d.destroy()
        reject(new Error(`data port ${dataHost}:${dataPort} timed out`))
      })
      d.once('error', (e) => reject(new Error(`data port ${dataHost}:${dataPort}: ${e.message}`)))
      d.connect(dataPort, dataHost)
    })
    sock.write('QUIT\r\n')
    return { ok: true, step: 'done', detail: dataHost === host ? '' : `Passive replies point at ${dataHost}` }
  } catch (e) {
    return { ok: false, step, detail: (e as Error).message }
  } finally {
    sock.destroy()
  }
}

const ago = (ms: number): string => {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return `${Math.floor(s / 3600)} h ago`
}

const STEP_TEXT: Record<string, string> = {
  connect: "Couldn't reach the FTP server",
  login: 'Login was refused',
  passive: 'Passive mode failed',
  data: "Couldn't open the transfer connection"
}

// ---------------------------------------------------------------- checks

/**
 * Runs every connection check. Each one explains the problem in plain words and, where the app
 * can fix it itself, offers a button.
 */
export async function runDiagnostics(core: Core, attempts: LoginAttempt[]): Promise<DiagnosticsReport> {
  const s = core.settings
  const ftp = core.ftp.state
  const checks: Check[] = []
  const pref = s.ftp.preferredAddress
  const ifaces = listInterfaces(pref)
  const primary = ifaces[0]?.address

  // 1. FTP server
  if (!s.ftp.enabled) {
    checks.push({ id: 'ftp', title: 'FTP server', level: 'error', detail: 'The FTP server is turned off, so cameras have nothing to connect to. Turn it on above.' })
  } else if (ftp.running) {
    checks.push({ id: 'ftp', title: 'FTP server', level: 'ok', detail: `Listening on port ${s.ftp.port}.` })
  } else {
    const owner = await portOwner(s.ftp.port)
    const inUse = /in use/i.test(ftp.error ?? '') || !!owner
    checks.push({
      id: 'ftp',
      title: 'FTP server',
      level: 'error',
      detail: inUse
        ? `Port ${s.ftp.port} is already taken${owner ? ` by ${owner.name} (PID ${owner.pid})` : ' by another program'}. Pick a free port, then update the port in the camera.`
        : `The FTP server couldn't start: ${ftp.error ?? 'unknown error'}.`,
      fixes: inUse ? [{ id: 'use-free-port', label: 'Use a free port' }] : undefined
    })
    if (!isWin && s.ftp.port < 1024) {
      checks[checks.length - 1].detail += ' Ports below 1024 need root on macOS/Linux.'
      checks[checks.length - 1].fixes = [{ id: 'use-free-port', label: 'Use a free port' }]
    }
  }

  // 2. Passive ports: cameras open a second connection on one of these for every file.
  {
    const total = s.ftp.pasvMax - s.ftp.pasvMin + 1
    let busy = 0
    for (let p = s.ftp.pasvMin; p <= s.ftp.pasvMax; p++) if (!(await portFree(p))) busy++
    const level = total < 4 || busy > total / 2 ? 'error' : busy > 0 ? 'info' : 'ok'
    checks.push({
      id: 'passive',
      title: 'Transfer ports',
      level,
      detail:
        total < 4
          ? `Only ${total} passive port(s) configured. Use a range of at least 10 (e.g. 50000–50100).`
          : busy
            ? `${busy} of ${total} passive ports (${s.ftp.pasvMin}–${s.ftp.pasvMax}) are used by other programs. ${level === 'error' ? 'Pick a different range.' : 'Plenty are still free.'}`
            : `${total} passive ports free (${s.ftp.pasvMin}–${s.ftp.pasvMax}).`
    })
  }

  // 3. Network adapters
  const real = ifaces.filter((i) => i.kind !== 'vpn-virtual')
  const adapterOf = (a: string): string => ifaces.find((i) => i.address === a)?.adapter ?? 'unknown adapter'
  const chosen = !!pref && pref === primary
  if (!primary) {
    checks.push({ id: 'network', title: 'Network', level: 'error', detail: 'This PC has no network connection. Connect to Wi-Fi or Ethernet, on the same network as the camera.' })
  } else if (!real.length) {
    checks.push({
      id: 'network',
      title: 'Network',
      level: 'warn',
      detail: `Only VPN/virtual adapters are connected (${ifaces.map((i) => i.adapter).join(', ')}). A camera can't reach those. Connect to the same Wi-Fi as the camera.`
    })
  } else {
    const others = real.filter((i) => i.address !== primary)
    checks.push({
      id: 'network',
      title: 'Network',
      level: pref && !chosen ? 'warn' : others.length ? 'info' : 'ok',
      detail:
        (pref && !chosen ? `Your chosen address ${pref} is no longer on this PC, so ShotDrop switched to ${primary}. ` : '') +
        `Cameras should use ${primary} (${adapterOf(primary)})${chosen ? ', the address you chose' : ''}.` +
        (others.length ? ` This PC is also on ${others.map((o) => `${o.address} (${o.adapter})`).join(', ')}; use whichever is on the camera's Wi-Fi.` : '')
    })
  }

  // 4. Firewall
  if (isWin) {
    let fw: FirewallStatus | null = null
    try {
      fw = await firewallStatus(process.execPath)
    } catch (e) {
      checks.push({ id: 'firewall', title: 'Windows Firewall', level: 'info', detail: `Couldn't read firewall settings: ${(e as Error).message}` })
    }
    if (fw) checks.push(firewallCheck(fw, core, primary))
  } else {
    checks.push({
      id: 'firewall',
      title: 'Firewall',
      level: 'info',
      detail: `If this machine runs a firewall, allow TCP ${s.ftp.port} and ${s.ftp.pasvMin}–${s.ftp.pasvMax} from your local network.`
    })
  }

  // 5. Self-test: log in like a camera would, through the network address.
  if (ftp.running && primary && s.ftp.users[0]) {
    const u = s.ftp.users[0]
    const r = await ftpSelfTest(primary, s.ftp.port, ftpLoginName(u), u.password || 'shotdrop')
    checks.push({
      id: 'selftest',
      title: 'Test login',
      level: r.ok ? (r.detail ? 'warn' : 'ok') : 'error',
      detail: r.ok
        ? r.detail
          ? `Login works, but ${r.detail}, which may not be reachable from the camera.`
          : `Logged in as "${ftpLoginName(u)}" via ${primary} and opened a transfer connection, just like a camera. (Tested from this PC, so it can't prove the firewall lets outside devices in.)`
        : `${STEP_TEXT[r.step] ?? 'Test failed'}: ${r.detail}`
    })
  }

  // 6. What cameras have actually done
  const own = new Set([...ifaces.map((i) => i.address), '127.0.0.1', '::1'])
  const external = attempts.filter((a) => !own.has(a.ip.replace(/^::ffff:/, '')))
  const lastOk = external.filter((a) => a.ok).at(-1)
  const recentFails = external.filter((a) => !a.ok && (!lastOk || a.at > lastOk.at))
  if (recentFails.length) {
    const f = recentFails.at(-1)!
    const known = s.ftp.users.some((u) => ftpLoginName(u) === f.username)
    checks.push({
      id: 'camera',
      title: 'Camera activity',
      level: 'error',
      detail: `A device at ${f.ip} tried to log in as "${f.username}" ${ago(f.at)} and was refused: ${known ? 'wrong password' : 'unknown user name'}. Re-enter the ${known ? 'password' : 'user name'} in the camera exactly as shown above.${recentFails.length > 1 ? ` (${recentFails.length} failed attempts.)` : ''}`
    })
  } else if (lastOk) {
    checks.push({ id: 'camera', title: 'Camera activity', level: 'ok', detail: `"${lastOk.username}" connected from ${lastOk.ip} ${ago(lastOk.at)}.` })
  } else {
    checks.push({
      id: 'camera',
      title: 'Camera activity',
      level: 'info',
      detail: "No camera has connected since ShotDrop started. Once you set up the camera, try its \"test connection\" option; if nothing shows up here, the camera isn't reaching this PC (check Wi-Fi and the firewall)."
    })
  }

  // 7. Disk space
  try {
    const st = await statfs(s.libraryDir)
    const free = st.bavail * st.bsize
    const gb = free / 1e9
    checks.push({
      id: 'disk',
      title: 'Disk space',
      level: gb < 1 ? 'error' : gb < 10 ? 'warn' : 'ok',
      detail: `${gb.toFixed(gb < 10 ? 1 : 0)} GB free on the library drive.${gb < 10 ? ' A busy shoot can use 20–50 GB.' : ''}`
    })
  } catch {
    /* library dir missing: the ingest check will complain */
  }

  return { checkedAt: Date.now(), checks }
}

function firewallCheck(fw: FirewallStatus, core: Core, primary: string | undefined): Check {
  const s = core.settings
  const alias = primary ? fw.addressAlias[primary] : undefined
  const net = fw.networks.find((n) => n.alias === alias)
  const category = net?.category ?? 'Public'
  const netText = alias ? `"${alias}" is a ${category} network` : 'This network'
  const allow: Check['fixes'] = [{ id: 'firewall-allow', label: 'Allow cameras', elevated: true }]
  const remove = { id: 'firewall-remove' as const, label: 'Remove ShotDrop rules', elevated: true, danger: true }

  if (!fw.enabled[category]) {
    return { id: 'firewall', title: 'Windows Firewall', level: 'ok', detail: `${netText}, and the firewall is off for it. Nothing to block cameras.` }
  }

  const applies = (r: { profiles: string[]; enabled: boolean }): boolean => r.enabled && (r.profiles.includes('Any') || r.profiles.includes(category))
  const blocks = fw.appRules.filter((r) => r.action === 'Block' && applies(r))
  if (blocks.length) {
    return {
      id: 'firewall',
      title: 'Windows Firewall',
      level: 'error',
      detail: `Windows is blocking ShotDrop on ${category} networks (usually from clicking "Cancel" on the firewall prompt). Cameras can't get in until that's removed.`,
      fixes: allow
    }
  }

  const ours = fw.ourRules.filter((r) => r.action === 'Allow' && applies(r))
  const wanted = [String(s.ftp.port), `${s.ftp.pasvMin}-${s.ftp.pasvMax}`]
  const oursCover = ours.some((r) => wanted.every((w) => r.ports.includes(w)))
  const appAllowed = fw.appRules.some((r) => r.action === 'Allow' && applies(r))
  const needApi = core.settings.remote.enabled
  const apiCovered = !needApi || ours.some((r) => r.ports.includes(String(s.api.port))) || appAllowed

  if (oursCover && apiCovered) {
    return { id: 'firewall', title: 'Windows Firewall', level: 'ok', detail: `${netText}. ShotDrop's rules let devices on your local network in.`, fixes: [remove] }
  }
  if (appAllowed) {
    return {
      id: 'firewall',
      title: 'Windows Firewall',
      level: 'ok',
      detail: `${netText}, and Windows allows ShotDrop on it (from the first-run prompt). Note: an app update can reset that, so a dedicated rule is more reliable.`,
      fixes: [{ id: 'firewall-allow', label: 'Add dedicated rule', elevated: true }]
    }
  }
  return {
    id: 'firewall',
    title: 'Windows Firewall',
    level: 'error',
    detail: ours.length
      ? `ShotDrop's firewall rule is out of date (ports changed). Cameras will be blocked on ${category} networks.`
      : `${netText}, and nothing lets cameras through the firewall yet. Allowing adds a rule for local devices only; nothing on the internet can use it.`,
    fixes: allow
  }
}

// ---------------------------------------------------------------- fixes

export async function applyFix(core: Core, id: FixId, attempts: LoginAttempt[]): Promise<FixResult> {
  const s = core.settings
  let message = ''
  try {
    switch (id) {
      case 'firewall-allow':
        if (!isWin) throw new Error('Only available on Windows')
        await allowCameras({
          exePath: process.execPath,
          ftpPort: s.ftp.port,
          pasvMin: s.ftp.pasvMin,
          pasvMax: s.ftp.pasvMax,
          apiPort: s.remote.enabled ? s.api.port : undefined
        })
        message = 'Firewall updated. Devices on your local network can now reach ShotDrop.'
        break
      case 'firewall-remove':
        if (!isWin) throw new Error('Only available on Windows')
        await removeRules()
        message = 'ShotDrop firewall rules removed.'
        break
      case 'use-free-port': {
        await core.ftp.stop() // release our own port so it isn't counted as taken
        const port = await findFreePort(s.ftp.port === 2121 ? 2122 : 2121, [s.api.port])
        await core.updateSettings({ ftp: { ...s.ftp, enabled: true, port } })
        message = `FTP now uses port ${port}. Update the port in your camera.`
        if (isWin && s.ftp.port !== port) message += ' Then re-check the firewall below.'
        break
      }
    }
    return { ok: true, message, report: await runDiagnostics(core, attempts) }
  } catch (e) {
    return { ok: false, message: (e as Error).message, report: await runDiagnostics(core, attempts) }
  }
}
