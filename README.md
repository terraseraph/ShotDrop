# ShotDrop

**Shoot on the camera, see the photo on your screen seconds later, cull while you shoot, and sync to your own storage.**

ShotDrop turns your PC into a wireless landing zone for your camera. Most modern mirrorless bodies can send each shot over Wi-Fi by FTP. ShotDrop runs that FTP server for you, shows every frame in a full-screen gallery as it lands, and copies your photos to Google Drive, Dropbox, a NAS or another drive in the background. It runs entirely on your machine with your own storage: no account, no hosted service, nothing to pay for.

[![Build](https://github.com/terraseraph/ShotDrop/actions/workflows/build.yml/badge.svg)](https://github.com/terraseraph/ShotDrop/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/terraseraph/ShotDrop?label=download)](https://github.com/terraseraph/ShotDrop/releases/latest)

## Download

| | Windows 10 / 11 (64-bit) | |
|---|---|---|
| **Recommended** | [**ShotDrop-win-x64.zip**](https://github.com/terraseraph/ShotDrop/releases/latest/download/ShotDrop-win-x64.zip) | Unzip anywhere (even a USB stick) and run `ShotDrop.exe`. Starts in about 3 s. |
| Single file | [ShotDrop-portable.exe](https://github.com/terraseraph/ShotDrop/releases/latest/download/ShotDrop-portable.exe) | One file to hand to someone. Unpacks itself on every launch, so it starts slower (about 12 s). |

All versions and release notes: [Releases](https://github.com/terraseraph/ShotDrop/releases). Builds from the latest commit are attached to each [Actions run](https://github.com/terraseraph/ShotDrop/actions/workflows/build.yml).

- **No installer, nothing else to install.** rclone, cloudflared, ffmpeg, LibRaw and ExifTool are all inside the package.
- **Unsigned for now.** Windows SmartScreen may say "Windows protected your PC": click **More info → Run anyway**.
- On first launch, allow ShotDrop through Windows Firewall on private networks, or use **Settings → Camera → Connection check → Allow cameras**.

### Quick start

1. Run ShotDrop. The setup screen shows the **host, port, user and password** in big type, plus a QR code.
2. Put the camera on the same Wi-Fi as the PC, open its FTP transfer menu, and type those in. ShotDrop has step-by-step guides for Sony, Canon, Nikon and Fujifilm.
3. Take a shot. It appears in the gallery a few seconds later. If nothing arrives, the **Connection check** tells you why and fixes most causes with one click.

---

## Features

### Camera → screen
- **Built-in FTP server** for camera uploads. Toggle it on, no FileZilla or port setup.
- **Full-screen camera setup**: big connection card, ftp:// QR code, guides per camera brand, and a live "listening" log that shows the test shot arriving.
- **Pick the right network address.** Every address on the PC is listed with its adapter and type (Wi-Fi, Ethernet, VPN). Choose the one the camera should use; VPNs such as Tailscale and WireGuard sort last.
- **Connection check with one-click fixes:**
  - Windows Firewall rules for your local network only, including removing the hidden block rule Windows creates when someone clicks Cancel on its prompt.
  - Port clashes: names the program holding the port and moves to a free one.
  - Wrong network adapter or VPN warnings.
  - A self-test that logs in the way a camera does.
  - Refused camera logins ("wrong password from 192.168.x.x").
  - Disk space.
- **Several cameras at once**, each with its own login, so every frame is tagged by camera or shooter, with per-camera filters.
- **JPEG, HEIF and RAW** (ARW, CR3, NEF, RAF, DNG and more). RAW+JPEG pairs are grouped as one shot.
- **Video files** (MP4, MOV, MXF, MTS): thumbnails, plus a browser-playable copy for codecs that won't play directly (HEVC, ProRes, 10-bit).
- **Watched folders** for card readers or tethering software. Originals are copied, never moved.
- **Safe ingest:** half-written uploads are never shown or synced, duplicates are detected by hash, and every upload is written to `ftp.log` for troubleshooting.
- **Wi-Fi live view over PTP/IP** (experimental, Nikon Z): live view and shot download without FTP.

### Gallery
- **Follow mode:** the big view jumps to each new frame as it lands, like wireless tethering.
- Loupe, grid and filmstrip, with **100% zoom and pan** for focus checks.
- **Histogram and highlight-clipping** overlay (`H`).
- **Compare up to 4 shots** side by side (`C`, `Shift+C` clears).
- EXIF at a glance: shutter, aperture, ISO, focal length, lens, camera, time.
- Shoot days grouped as sessions, plus filters by camera, pick, rating and reject.
- A **status dock** showing cameras connected, frames received, sync progress and disk space.

### Culling
- **Keyboard-first:** `1`–`5` stars, `P` pick, `X` reject, `U` clear, `6`–`9` colour labels. Add `Shift` to rate and move to the next shot.
- **Burst culling:** bursts are grouped automatically and the best frame is marked. **Soft/blurred** frames and **eyes closed** are flagged, so you can filter by *Best of burst*, *Soft* or *Eyes closed*.
- **XMP sidecars:** ratings, picks/rejects and labels are written to `<name>.xmp` next to each photo, so Lightroom and Capture One see your culling. Sidecars sync with the photos and are read back on import.
- **Delete really deletes:** the recycle bin first, then a permanent delete if needed. If a file is locked by another program, you get a warning naming it, and the photo stays in the gallery so nothing is left orphaned on disk.

### RAW and metadata
- Previews from the **largest JPEG embedded in the RAW**, with its true size shown.
- **Develop RAW:** a full-resolution decode with LibRaw (bundled, no extra runtime needed). Switch between camera JPEG, embedded preview and RAW decode.
- **All metadata:** EXIF, maker notes, XMP, IPTC and GPS, searchable. The summary shows shutter count, AF point, drive mode, stabilisation, serial numbers, firmware, white balance and film simulation or picture profile when the camera records them. GPS gets an "Open in maps" link.

### Export and share
- **Export JPEG** at original size, 2048 or 1080 px, with your choice of quality and with metadata kept, GPS stripped, or everything stripped.
- **Copy to clipboard, Show in folder, Open, Open in** Lightroom, Photoshop, Capture One, Affinity or DxO when installed.
- **Drag a thumbnail** straight into Explorer, email or an editor.
- **Share link** to a single photo's preview through the remote gallery or public link. It stays valid until you change the PIN.

### Sync to your own storage
- **Settings → Sync shows where photos travel:** camera → this PC → each destination, with live progress and health on every card: Up to date, Syncing, Paused, Can't reach, Failed or Sign-in expired.
- **One-click Google Drive and Dropbox.** Sign in in your browser, then pick or create the folder. By default Drive access is limited to folders ShotDrop creates. Accounts are kept in ShotDrop's own config, and your own app credentials are supported.
- **Folder / NAS** destinations (local drives or network shares), plus **any rclone remote** (S3, B2, SFTP, OneDrive…) for advanced setups.
- **Choose what each destination gets:** everything, JPEGs only, RAW only, or **picks only**, which are sent the moment you press `P`. The sheet shows how many files and how much data that is right now.
- **A background queue that survives anything:** offline periods, unplugged drives and restarts. It retries, then catches up. Pause and resume per destination, errors in plain English, and **Reconnect** when a sign-in expires.

### Phone and remote
- **Remote gallery in any browser**, protected by a PIN. Remote viewers can look and cull, but settings stay on the PC.
- **Phone app (PWA):** scan the **View on phone** QR code, enter the PIN, and add it to your home screen. Touch layout with swipe, pinch zoom and a culling bar.
- **Public link from anywhere** with one click, via a Cloudflare quick tunnel. No account and no router changes.

### Portable and private
- **Everything in one portable package.** Settings and the database stay next to the app, and photos default to `Pictures\ShotDrop` (or any folder you choose).
- No hosted service, no telemetry, no account. Your photos only go where you send them.
- A **REST API with live events** for scripting and integrations. The app's own UI uses the same API.

### Not yet
FTPS for cameras, drag-and-drop import, rename/folder rules, batch delete of rejects, rsync/SSH destinations, bandwidth limits, tray icon and notifications, auto-update, macOS/Linux builds, a named Cloudflare tunnel with a fixed URL, uploads from cameras outside your network, and client proofing galleries.

---

## Camera compatibility (built-in FTP)

Firmware updates keep adding FTP to more bodies, so check your model. This is a starting list, not a guarantee.

| Brand | Models | Notes |
|---|---|---|
| Sony | a1, a1 II, a9 II, a9 III, a7 IV, a7 V, a7R V, a7S III, a7C II, a7CR, a6700, FX3, FX30 | |
| Canon | R1, R3, R5, R5 II, R6 II, R6 III, 1D X III | Older bodies need a WFT transmitter |
| Nikon | Z9, Z8, Z6III | Older Z bodies need a WT-7. PTP/IP live view is experimental |
| Fujifilm | X-H2S, X-H2, GFX100 II | Some need the FT-XH grip or updated firmware |
| Panasonic | S5II/S5IIX, GH7, S1R II | Mainly Frame.io Camera-to-Cloud; FTP support varies |

Entry-level bodies usually only support the maker's phone app, which ShotDrop can't receive from.

---

## Development

```bash
npm install
npm run dev              # Electron app + Vite renderer with hot reload
npm run typecheck
npm run fetch-binaries   # pinned rclone, cloudflared, ffmpeg, LibRaw into resources/bin (needed for sync/RAW in dev)
npm run dist:portable    # release/ShotDrop-win-x64.zip + release/ShotDrop-portable.exe
```

- **Dev data:** all settings, the database, previews and the library go into a gitignored `.dev-data/` folder, so test shots never touch your real Pictures folder.
- **A second dev copy** next to the first needs its own data folder and ports. Create `<dir>/app/settings.json` containing `{"api":{"port":8792},"ftp":{"port":2132,"pasvMin":51200,"pasvMax":51220}}`, then run:
  ```bash
  SHOTDROP_DEV_HOME=<dir> SHOTDROP_VITE_PORT=5182 VITE_SHOTDROP_API=http://127.0.0.1:8792 npm run dev
  ```
- **Desktop-only screens in a browser:** add `?desktop` to the dev URL (dev builds only) to see Settings and setup screens in a browser tab.
- **Fake a camera:** `curl -T DSC01234.JPG ftp://camera:<password>@127.0.0.1:2121/`

**Releases:** every push to `main` builds both packages on Windows with [GitHub Actions](.github/workflows/build.yml) and publishes them as a new release numbered `0.1.<build>`, so the download links above always serve the newest build. Push a tag such as `v0.2.0` for a named version. Pull requests build too, with the files attached to the Actions run.

### Project layout

```
src/
  shared/              types shared by server and UI (types.ts, cull.ts, diagnostics.ts)
  main/
    index.ts           Electron shell: window, IPC (folder picker, open-with, clipboard, drag-out), lifecycle
    core/              no Electron imports: could run headless (NAS, home server)
      index.ts         Core: wires everything together, applies settings changes live
      ftp.ts           embedded FTP server, one folder per camera login, upload log
      ingest.ts        watcher → hash/dedupe → EXIF → file by date → previews
      media.ts         previews (sharp), embedded RAW JPEGs, LibRaw develop, video frames/proxies (ffmpeg)
      library.ts       SQLite: shots, files, sync jobs
      sync.ts retry.ts background sync queue (folder copy, rclone) with offline-aware retries
      cloud.ts         Google Drive / Dropbox accounts via rclone with ShotDrop's own config
      xmp.ts metadata.ts exporter.ts sources.ts   sidecars, full metadata, export, RAW sources
      diagnostics.ts firewall.ts net.ts           connection check, firewall fixes, address picking
      tunnel.ts        Cloudflare quick tunnel
    api/               Fastify REST API + SSE, serves the web/phone UI
    ptp/               PTP/IP client (Wi-Fi live view, experimental)
    blink/             eyes-closed detection for burst culling
  preload/index.ts     exposes the API base + native helpers to the window
  renderer/            React UI, also served to phones and remote browsers
docs/                  packaging.md, raw.md, cloud-linking.md, mockups/
```

### REST API

The desktop window uses the same HTTP API a phone or script would. It listens on `127.0.0.1:8787`, or on all interfaces when remote access is on. Requests that don't come from this PC, including anything through the tunnel, need the PIN as an `x-shotdrop-key` header or a `?key=` parameter. Endpoints marked **local** refuse remote callers even with the PIN, because they change configuration, run programs or send photos elsewhere.

| Method | Path | |
|---|---|---|
| GET | `/api/status` | FTP, cameras, API, library, sync, tunnel and per-destination state |
| GET | `/api/events` · `/api/changes?after=<seq>` | Live events (SSE), or the polling equivalent used through tunnels |
| GET | `/api/sessions` · `/api/library/counts` | Shoot days; file counts and sizes per sync filter |
| GET | `/api/shots` | `?session=&source=&minRating=&flag=-1\|0\|1\|notRejected&label=&order=&limit=&offset=` |
| GET / PATCH | `/api/shots/:id` | One shot; `{ rating?, flag?, label? }`. `PATCH /api/shots` does bulk updates |
| DELETE | `/api/shots/:id` | Deletes from disk; `409` with the files that couldn't be removed |
| GET | `/api/shots/:id/thumb` · `/preview` · `/original?file=` · `/full?src=` · `/sources` · `/metadata` | Images, RAW sources, full metadata |
| POST | `/api/shots/:id/develop` · `/export` · `/proxy` (local) | RAW decode, JPEG export, video proxy |
| GET | `/api/shots/:id/link` (local) | Share link to one preview |
| GET / PATCH | `/api/settings` (local) | Changes apply live (FTP, library, watch folders, remote) |
| GET / POST / PATCH / DELETE | `/api/destinations[/:id]` (local) | `{ name, type: folder\|rclone, target, filter: all\|jpeg\|raw\|picks, enabled }`; `POST …/resync` |
| GET / POST | `/api/sync/jobs` · `/api/sync/retry` (local) | Queue inspection, retry failed |
| * | `/api/cloud/…` (local) | Link/cancel/disconnect accounts, browse/create folders, account info |
| * | `/api/tunnel[/install\|start\|stop]` | Public link state and control (control is local) |
| * | `/api/diagnostics[/attempts\|/fix/:id]` (local) | Connection check and one-click fixes |
| POST | `/api/ftp/start` · `/api/ftp/stop` (local) | |

### Stack

| Layer | Choice |
|---|---|
| Shell | Electron |
| UI | React, TypeScript, Vite, Motion |
| Server | Fastify (REST + SSE), ftp-srv |
| Images | sharp, ExifTool (exiftool-vendored), LibRaw (`dcraw_emu`) |
| Video | ffmpeg |
| Data | SQLite (better-sqlite3) |
| Sync and remote | rclone, cloudflared |
| Culling | MediaPipe face landmarks (eyes closed), luma sharpness, perceptual hash |

More detail: [docs/packaging.md](docs/packaging.md) (portable build, bundled tools, licences), [docs/raw.md](docs/raw.md) (RAW decoding), [docs/cloud-linking.md](docs/cloud-linking.md) (Drive/Dropbox via rclone), [docs/mockups/cloud](docs/mockups/cloud/index.html) (Sync UI design).

## Roadmap

- **Next:** FTPS for cameras, rename/folder rules, batch actions on rejects, tray icon and notifications, auto-update.
- **Remote ingest:** a phone-hotspot field kit today; port-forwarded FTPS or a relay later.
- **Android:** the phone as the server (camera → phone hotspot → ShotDrop on Android), reusing the same React UI.
- **Client proofing:** guest galleries with picks and comments, built on photos already in the photographer's own cloud.
- macOS and Linux builds.

## Third-party software

The Windows package bundles unmodified builds of **rclone** (MIT), **cloudflared** (Apache-2.0), **ffmpeg** (GPL-3.0; gyan.dev essentials build), **LibRaw** (LGPL-2.1 / CDDL-1.0, from MSYS2 with its runtime DLLs) and **ExifTool** (Perl Artistic / GPL). Their licence texts ship with them (`resources\bin\LICENSE-*.txt`, and ExifTool's inside its package). See [docs/packaging.md](docs/packaging.md).
