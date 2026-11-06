import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Windows Defender Firewall helpers. Reading needs no admin rights; changing rules runs one
 * elevated PowerShell script, so the user sees a single Windows permission prompt.
 * All rules we create live in the "ShotDrop" group so they can be found and removed cleanly.
 */

export const RULE_GROUP = 'ShotDrop'
const CATEGORY = ['Public', 'Private', 'Domain'] as const // NetConnectionProfile.NetworkCategory
const ACTION: Record<number, string> = { 0: 'NotConfigured', 2: 'Allow', 4: 'Block' }

export type NetCategory = (typeof CATEGORY)[number]

export interface FirewallRule {
  name: string
  action: string
  enabled: boolean
  profiles: string[]
  ports: string[]
}

export interface FirewallStatus {
  /** Per profile: firewall switched on? */
  enabled: Record<'Domain' | 'Private' | 'Public', boolean>
  /** Network category of each connected adapter. */
  networks: { alias: string; category: NetCategory }[]
  /** IPv4 address → adapter alias. */
  addressAlias: Record<string, string>
  /** Rules Windows created for our executable (from its first-run prompt). */
  appRules: FirewallRule[]
  /** Rules ShotDrop created. */
  ourRules: FirewallRule[]
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

function profileNames(mask: number): string[] {
  if (mask === 0 || mask === 0x7fffffff) return ['Any']
  const out: string[] = []
  if (mask & 1) out.push('Domain')
  if (mask & 2) out.push('Private')
  if (mask & 4) out.push('Public')
  return out
}

function powershell(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout))
    )
  })
}

const arr = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

interface RawRule {
  DisplayName: string
  Action: number
  Enabled: number | boolean
  Profile: number
  Ports?: string | string[] | null
}

const toRule = (r: RawRule): FirewallRule => ({
  name: r.DisplayName,
  action: ACTION[r.Action] ?? String(r.Action),
  enabled: r.Enabled === 1 || r.Enabled === true,
  profiles: profileNames(r.Profile),
  ports: arr(r.Ports).map(String)
})

export async function firewallStatus(exePath: string): Promise<FirewallStatus> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$exe = ${psQuote(exePath)}
$app = Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule | Where-Object Direction -eq 1 |
  Select-Object DisplayName, Action, Enabled, Profile
$ours = Get-NetFirewallRule -Group ${psQuote(RULE_GROUP)} | ForEach-Object {
  [pscustomobject]@{ DisplayName = $_.DisplayName; Action = [int]$_.Action; Enabled = [int]$_.Enabled; Profile = [int]$_.Profile;
    Ports = @(($_ | Get-NetFirewallPortFilter).LocalPort) }
}
$nets = Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory
$addrs = Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress, InterfaceAlias
$fw = Get-NetFirewallProfile | Select-Object Name, Enabled
@{ app = @($app); ours = @($ours); nets = @($nets); addrs = @($addrs); fw = @($fw) } | ConvertTo-Json -Depth 5 -Compress
`
  const raw = JSON.parse(await powershell(script)) as {
    app: RawRule[]
    ours: RawRule[]
    nets: { InterfaceAlias: string; NetworkCategory: number }[]
    addrs: { IPAddress: string; InterfaceAlias: string }[]
    fw: { Name: 'Domain' | 'Private' | 'Public'; Enabled: number | boolean }[]
  }
  const enabled = { Domain: true, Private: true, Public: true }
  for (const p of arr(raw.fw)) enabled[p.Name] = p.Enabled === 1 || p.Enabled === true
  return {
    enabled,
    networks: arr(raw.nets).map((n) => ({ alias: n.InterfaceAlias, category: CATEGORY[n.NetworkCategory] ?? 'Public' })),
    addressAlias: Object.fromEntries(arr(raw.addrs).map((a) => [a.IPAddress, a.InterfaceAlias])),
    appRules: arr(raw.app).map(toRule),
    ourRules: arr(raw.ours).map(toRule)
  }
}

export interface AllowOptions {
  exePath: string
  ftpPort: number
  pasvMin: number
  pasvMax: number
  /** Also open the API/web gallery port to the local network (remote access on). */
  apiPort?: number
}

/**
 * Replaces ShotDrop's rules and removes any *block* rules Windows made for our executable
 * (created when someone clicks Cancel on the first-run firewall prompt; block always beats allow).
 * Rules only accept devices on the same local subnet, on every network type, so a phone hotspot
 * (usually "Public") works too without exposing anything to the internet.
 */
export function allowCameras(o: AllowOptions): Promise<void> {
  const ports = [String(o.ftpPort), `${o.pasvMin}-${o.pasvMax}`]
  const api = o.apiPort
    ? `New-NetFirewallRule -DisplayName 'ShotDrop remote gallery' -Group $g -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${o.apiPort} -RemoteAddress LocalSubnet -Profile Any | Out-Null`
    : ''
  return runElevated(`
$g = ${psQuote(RULE_GROUP)}
Remove-NetFirewallRule -Group $g -ErrorAction SilentlyContinue
Get-NetFirewallApplicationFilter -Program ${psQuote(o.exePath)} -ErrorAction SilentlyContinue | Get-NetFirewallRule |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'ShotDrop camera uploads (FTP)' -Group $g -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${ports.map(psQuote).join(',')} -RemoteAddress LocalSubnet -Profile Any | Out-Null
${api}
`)
}

export function removeRules(): Promise<void> {
  return runElevated(`Remove-NetFirewallRule -Group ${psQuote(RULE_GROUP)} -ErrorAction SilentlyContinue`)
}

/** Runs a script as administrator (one UAC prompt) and reports its outcome through a result file. */
async function runElevated(body: string): Promise<void> {
  const id = randomUUID()
  const scriptPath = join(tmpdir(), `shotdrop-${id}.ps1`)
  const resultPath = join(tmpdir(), `shotdrop-${id}.txt`)
  await writeFile(
    scriptPath,
    `$ErrorActionPreference = 'Stop'
try {
${body}
  Set-Content -LiteralPath ${psQuote(resultPath)} -Value 'ok'
} catch {
  Set-Content -LiteralPath ${psQuote(resultPath)} -Value ('error: ' + $_.Exception.Message)
}
`,
    'utf8'
  )
  try {
    await powershell(
      `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(`"${scriptPath}"`)}`,
      180_000
    ).catch((e: Error) => {
      throw new Error(/cancel/i.test(e.message) ? 'Windows permission was declined' : e.message)
    })
    const result = (await readFile(resultPath, 'utf8').catch(() => '')).trim()
    if (result !== 'ok') throw new Error(result.replace(/^error:\s*/, '') || 'The firewall change did not complete')
  } finally {
    await rm(scriptPath, { force: true })
    await rm(resultPath, { force: true })
  }
}
