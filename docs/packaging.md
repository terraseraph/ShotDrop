# Packaging (Windows, portable)

```bash
npm run dist:portable
```

This fetches the pinned helper binaries, builds with electron-vite, and writes two files to `release/`
(gitignored). Both contain the same app with every dependency inside. There is no installer, and nothing
has to be installed or downloaded at runtime.

| File | Size | Start-up (measured, warm disk) | Use it for |
|---|---|---|---|
| `ShotDrop-<ver>-win-x64.zip` | 203 MiB (526 MB unzipped) | ~3 s to API ready | **Recommended.** Unzip anywhere, including a USB stick, and run `ShotDrop.exe`. |
| `ShotDrop-<ver>-portable.exe` | 145 MiB | ~12 s on every launch | One file to hand to someone. It unpacks 526 MB to `%TEMP%` on each start and deletes it on exit. |

## Decisions

**Format: zip of `win-unpacked` first, portable exe as an extra.** The single exe is a 7-Zip self-extractor.
It is smaller to download, but it pays the unpack cost on every launch (about 4x slower). It also looks more
suspicious to antivirus heuristics, because it is an unsigned exe that writes a few hundred MB of exes and
DLLs to `%TEMP%` and runs them. The zip starts in about 3 s and keeps its files in one place. NSIS was
dropped because the goal is no installer.

**Where data goes (portable mode).** `src/main/index.ts` checks for a `data` folder next to the exe. For
the single exe it looks next to the launched file (`PORTABLE_EXECUTABLE_DIR`), not in the temp copy.
- `data\` present: `data\app\` holds settings, `library.db`, the preview cache and Chromium state, and
  `data\ShotDrop\` is the default photo library. Nothing is written to `%APPDATA%` or Pictures (verified).
- No `data\` folder: `%APPDATA%\ShotDrop` and `Pictures\ShotDrop`, as before.

The zip ships with a `data\` folder (and a README), so it is portable out of the box. The single exe ships
without one, so it uses `%APPDATA%` unless you create `data\` next to it. Dev runs (`npm run dev`) still use
`.dev-data/`.

**SmartScreen and antivirus (no code signing yet).** A downloaded, unsigned exe gets the "Windows protected
your PC" prompt (More info, then Run anyway) until it builds reputation. Explorer copies the
mark-of-the-web from a downloaded zip to the files it extracts, so the zip prompts too, once per new
location. To remove this, sign `ShotDrop.exe`, the portable exe, and ideally the bundled exes. Azure
Trusted Signing or an OV/EV certificate works; electron-builder signs when `CSC_LINK` or `win.azureSignOptions`
is set. Until then, the zip is less likely than the self-extractor to be flagged by heuristics.

**Bundled tools: rclone and cloudflared both ship in the package.**
`scripts/fetch-binaries.mjs` downloads pinned versions into `resources/bin/win-x64/` (gitignored), checks
each against a pinned SHA-256, and fetches the licence texts. electron-builder copies that folder to
`resources\bin\` through `extraResources`.

| Tool | Version | Licence | Unpacked | Added to the zip |
|---|---|---|---|---|
| rclone | 1.75.2 | MIT (`LICENSE-rclone.txt`) | 85.5 MB | ~29 MB |
| cloudflared | 2026.10.7 | Apache-2.0 (`LICENSE-cloudflared.txt`) | 55.4 MB | ~19 MB |

The alternative was to keep cloudflared on demand (the old in-app download into `<data>\bin`) and bundle
only rclone. That saves about 19 MB of download, but the public link would then need internet access to
GitHub plus a second download before first use. That conflicts with "every dependency inside", so both are
bundled. The download code in `tunnel.ts` is kept as a fallback for builds without the bundled copy (for
example dev on Linux).

Resolution order (`src/main/core/bundled.ts`): a path set in Settings wins. If the setting is left at the
default bare name (`rclone` / `cloudflared`), the app uses the bundled copy. Otherwise it uses the
downloaded copy (cloudflared only), then `PATH`. In dev, no bundled copy exists, so behaviour is unchanged.
To bump a version, edit the version and sha256 in the fetch script.

**Native modules.**
- `sharp` + `@img/sharp-win32-x64`, `better-sqlite3`, `exiftool-vendored.exe` (`exiftool.exe` with its own
  Perl in `exiftool_files\`) are `asarUnpack`ed. exiftool-vendored rewrites `app.asar` to
  `app.asar.unpacked` itself. Verified: `exiftool.exe` runs from `app.asar.unpacked`, and EXIF and previews work.
- Trimmed: better-sqlite3's macOS, Linux and win-arm64 prebuilds, its `deps/` (SQLite source) and `src/`,
  `@img/sharp-wasm32` (WASM fallback, not needed on x64), and all Chromium locales except `en-US`.
- `npmRebuild: false`. Everything ships N-API prebuilds. electron-builder's rebuild only tried to
  compile better-sqlite3 from source, which needs MSVC and leaves a half-built `build/` folder behind.

**Runtime dependencies checked.**
- VC++ redistributable: not needed. No shipped DLL, `.node` or exe imports `VCRUNTIME140`/`MSVCP140`. libvips
  and cloudflared import only the Universal CRT (`api-ms-win-crt-*`), which is part of Windows 10 and 11.
- Network fetches at runtime: none. (The only one was the cloudflared download, now skipped because
  the tool is bundled.) The connection check uses built-in PowerShell and netstat.
- The single exe also contains electron-builder's `elevate.exe`, which is only used if admin rights are
  requested. They are not.

## Verified (2026-11-06, Windows 11, packaged build launched directly, ports moved to 2122/8788)
- Gallery loads. `curl -T IMG_0001.JPG ftp://camera:…@127.0.0.1:2122/` ingests the file, reads EXIF via
  exiftool, and writes a preview and thumbnail.
- `GET /api/status` returns `sync.rcloneAvailable: true` and `tunnel.installed: true`, with neither tool on
  `PATH` and no downloaded copy, so both came from `resources\bin`.
- All writes stayed in `data\` (zip build) or in `data\` next to the single exe. The single exe's temp unpack
  is removed on exit.

## Known gaps / follow-ups
- No app icon yet (`build/icon.ico`), so the default Electron icon is used.
- Chromium's HTTP cache dir (`Cache`) and the app's preview `cache` dir have the same name on a
  case-insensitive disk, so they share `<userData>\cache`. This is harmless today. Renaming the app's folder
  would separate them.
