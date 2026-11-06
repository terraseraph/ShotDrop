// Downloads the pinned rclone + cloudflared + ffmpeg + LibRaw Windows builds (and their licences) into resources/bin/win-x64,
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
const FFMPEG = '2026-11-05-git-0893feba65' // gyan.dev "essentials" GPL build; only used to grab a frame for video thumbnails
// LibRaw for "Develop RAW": MSYS2's UCRT64 build (dcraw_emu.exe + libraw-25.dll) and the runtime DLLs it loads.
// Unlike LibRaw's own MSVC zip it needs no Visual C++ redistributable, only the UCRT that ships with Windows 10+.
// LibRaw is LGPL-2.1/CDDL (separate, replaceable DLL); GCC runtimes are GPL-3 + runtime exception; the rest MIT/BSD/zlib.
const LIBRAW = '0.22.3-1'
const MSYS = 'https://repo.msys2.org/mingw/ucrt64/'
const LIBRAW_PKGS = [
  { pkg: 'mingw-w64-ucrt-x86_64-libraw-0.22.3-1-any.pkg.tar.zst', sha256: '4c61c19f59e10d2a625bd042074c113f7b4454bf82b7353dee74daecd7035fdb', bin: ['dcraw_emu.exe', 'libraw-25.dll'] },
  { pkg: 'mingw-w64-ucrt-x86_64-libgcc-16.2.0-6-any.pkg.tar.zst', sha256: '80b2497f019977dd9528b1abc8621b1328a0115ab1f724047ccbb56bf323f11d', bin: ['libgcc_s_seh-1.dll'] },
  { pkg: 'mingw-w64-ucrt-x86_64-libstdc++-16.2.0-6-any.pkg.tar.zst', sha256: '33c5e58a85a538cf843a8672991cce591f0231d66da3b66a57629712d64be17f', bin: ['libstdc++-6.dll'] },
  { pkg: 'mingw-w64-ucrt-x86_64-libgomp-16.2.0-6-any.pkg.tar.zst', sha256: '809b95086d8d3ba145e041bb36d5756b4407d1d97c0524ef731d3b94548faa69', bin: ['libgomp-1.dll'] },
  { pkg: 'mingw-w64-ucrt-x86_64-libwinpthread-14.0.0.r598.ge3d18511f-1-any.pkg.tar.zst', sha256: 'c35d6be83d141c8cfbb61f1637dd4b53aac8f5562d766aa26d0741c40bad4e4d', bin: ['libwinpthread-1.dll'] },
  { pkg: 'mingw-w64-ucrt-x86_64-libjpeg-turbo-3.2.1-1-any.pkg.tar.zst', sha256: '8eed77c1e0d6de7f8822687f7b1dfa32cda09394806ef67b23399e63de1a92a6', bin: ['libjpeg-8.dll'] },
  { pkg: 'mingw-w64-ucrt-x86_64-lcms2-2.20-1-any.pkg.tar.zst', sha256: '4e1d12047e72c63832f2b50c2fc87c7ec9d2e5a8bd40ce6e820ccbeedf2e7b8f', bin: ['liblcms2-2.dll'] },
  { pkg: 'mingw-w64-ucrt-x86_64-zlib-1.3.2-3-any.pkg.tar.zst', sha256: '130e6ef04c654fc2150a177600aa5ed0035087665a893479d2c85ba7485d5704', bin: ['zlib1.dll'] }
]
const ITEMS = [
  {
    file: 'ffmpeg.exe',
    url: `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG}/ffmpeg-${FFMPEG}-essentials_build.zip`,
    sha256: '763ca14d6896b4d8aabde8ff90be4f1428f8a21bd43e438a371be6d7ebf891a6',
    zipEntry: `ffmpeg-${FFMPEG}-essentials_build/bin/ffmpeg.exe`,
    license: { file: 'LICENSE-ffmpeg.txt', url: 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1/COPYING.GPLv3' }
  },
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
const want = JSON.stringify({ rclone: RCLONE, cloudflared: CLOUDFLARED, ffmpeg: FFMPEG, libraw: LIBRAW })
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
const libFiles = LIBRAW_PKGS.flatMap((p) => p.bin)
if (have === want && libFiles.every((f) => existsSync(join(OUT, f)))) {
  console.log('ok      dcraw_emu.exe + LibRaw DLLs (cached)')
} else {
  // Old MSVC build's files: no longer used.
  for (const f of ['libraw.dll', 'LICENSE-libraw-COPYRIGHT.txt', 'LICENSE-libraw-LGPL.txt', 'LICENSE-libraw-CDDL.txt']) rmSync(join(OUT, f), { force: true })
  const tar = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') // Windows bsdtar reads .zst
  for (const p of LIBRAW_PKGS) {
    console.log(`fetch   ${MSYS}${p.pkg}`)
    const buf = await get(MSYS + p.pkg)
    const sum = createHash('sha256').update(buf).digest('hex')
    if (sum !== p.sha256) throw new Error(`${p.pkg}: sha256 mismatch (got ${sum})`)
    const tmp = mkdtempSync(join(tmpdir(), 'shotdrop-bin-'))
    try {
      writeFileSync(join(tmp, 'a.tar.zst'), buf)
      // Windows' bsdtar reads .zst on current Windows 10/11; if this one can't, decompress with zstd (ships with Git for Windows).
      let archive = 'a.tar.zst'
      try {
        execFileSync(tar, ['-tf', archive], { cwd: tmp, stdio: 'ignore' })
      } catch {
        execFileSync('zstd', ['-q', '-d', 'a.tar.zst', '-o', 'a.tar'], { cwd: tmp })
        archive = 'a.tar'
      }
      const entries = execFileSync(tar, ['-tf', archive], { cwd: tmp, encoding: 'utf8' }).split(/\r?\n/)
      const licences = entries.filter((e) => /^ucrt64\/share\/licenses\/[^/]+\/[^/]+$/.test(e))
      execFileSync(tar, ['-xf', archive, ...p.bin.map((b) => `ucrt64/bin/${b}`), ...licences], { cwd: tmp })
      for (const b of p.bin) copyFileSync(join(tmp, 'ucrt64', 'bin', b), join(OUT, b))
      for (const l of licences) {
        const [, , , name, file] = l.split('/')
        copyFileSync(join(tmp, l), join(OUT, `LICENSE-${name}-${file.replace(/\.(txt|md)$/i, '')}.txt`))
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  console.log('ok      dcraw_emu.exe + LibRaw DLLs')
}
writeFileSync(stamp, want)
