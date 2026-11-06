// Downloads the pinned rclone + cloudflared Windows builds (and their licences) into resources/bin/win-x64,
// which electron-builder ships as <resources>/bin. Checksums are pinned, so a tampered download fails the build.
// Bump a version: change it here, then copy the new sha256 from the release's SHA256SUMS / asset digest.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'resources', 'bin', 'win-x64')

const RCLONE = '1.75.2'
const CLOUDFLARED = '2026.10.7'
const ITEMS = [
  {
    file: 'rclone.exe',
    url: `https://downloads.rclone.org/v${RCLONE}/rclone-v${RCLONE}-windows-amd64.zip`,
    sha256: '8a9db2bad1dc79a65b3348fd857069598e2aab7cf4d118b77b1df23055aff818',
    zipEntry: `rclone-v${RCLONE}-windows-amd64/rclone.exe`,
    license: { file: 'LICENSE-rclone.txt', url: `https://raw.githubusercontent.com/rclone/rclone/v${RCLONE}/COPYING` }
  },
  {
    file: 'cloudflared.exe',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED}/cloudflared-windows-amd64.exe`,
    sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
    license: { file: 'LICENSE-cloudflared.txt', url: `https://raw.githubusercontent.com/cloudflare/cloudflared/${CLOUDFLARED}/LICENSE` }
  }
]

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

mkdirSync(OUT, { recursive: true })
const stamp = join(OUT, 'versions.json')
const want = JSON.stringify({ rclone: RCLONE, cloudflared: CLOUDFLARED })
const have = existsSync(stamp) ? readFileSync(stamp, 'utf8') : ''

for (const it of ITEMS) {
  const dest = join(OUT, it.file)
  if (have === want && existsSync(dest) && existsSync(join(OUT, it.license.file))) {
    console.log(`ok      ${it.file} (cached)`)
    continue
  }
  console.log(`fetch   ${it.url}`)
  const buf = await get(it.url)
  const sum = createHash('sha256').update(buf).digest('hex')
  if (sum !== it.sha256) throw new Error(`${it.file}: sha256 mismatch (got ${sum})`)
  if (it.zipEntry) {
    const tmp = mkdtempSync(join(tmpdir(), 'shotdrop-bin-'))
    try {
      writeFileSync(join(tmp, 'a.zip'), buf)
      // Windows' own bsdtar reads zip; Git Bash's GNU tar does not, hence the explicit path.
      execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', 'a.zip', it.zipEntry], { cwd: tmp })
      copyFileSync(join(tmp, it.zipEntry), dest)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else {
    writeFileSync(dest, buf)
  }
  writeFileSync(join(OUT, it.license.file), await get(it.license.url))
  console.log(`ok      ${it.file}`)
}
writeFileSync(stamp, want)
