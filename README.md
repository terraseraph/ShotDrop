# ShotDrop

> Working name. Shoot on the camera and see the photo on your screen a few seconds later. Then it syncs to wherever you keep your photos.

ShotDrop is a desktop app that turns your PC into a wireless landing zone for your camera. Most modern mirrorless bodies can upload over FTP on Wi-Fi. ShotDrop runs the FTP server for you, shows each frame in a full-screen gallery as it lands, lets you cull while you shoot, and syncs everything to your own Google Drive, Dropbox or NAS in the background.

It runs on your own machine with your own storage. There's no hosted service, so it costs you nothing to run.

---

## Goals

1. **Camera to screen in seconds.** Point the camera at the PC once, then just shoot.
2. **Gallery first.** The main screen is a fast photo viewer, not a settings panel.
3. **Bring your own storage.** Sync to the user's own Drive, Dropbox, NAS or any rclone/rsync target. Several targets at once is fine.
4. **Zero config for normal users.** No setting up FileZilla, port juggling or command lines.
5. **Reachable remotely when needed.** View the gallery, and optionally receive uploads, over the internet.

## Non-goals (for now)

- Client proofing and sharing (the "wedding gallery" product). See the [Roadmap](#roadmap).
- Editing and RAW development. We hand off to Lightroom, Capture One and so on.
- Hosting anyone's photos on our infrastructure.

---

## Getting started (dev)

```bash
npm install
npm run dev        # Electron app + Vite renderer with hot reload
npm run typecheck
npm run dist       # Windows installer via electron-builder
```

In dev mode, all data (settings, DB, previews, library) goes into a gitignored `.dev-data/` folder in the repo, so test shots never touch your real Pictures folder. A packaged build uses `%APPDATA%/shotdrop` and `Pictures/ShotDrop`.

To fake a camera, upload over FTP with the user and password shown in the app:

```bash
curl -T DSC01234.JPG ftp://camera:<password>@127.0.0.1:2121/
```

On first run, Windows Firewall will ask to allow ShotDrop. If cameras can't connect, open Settings → Camera → **Connection check**. It finds firewall blocks (including the hidden block rule Windows creates when someone clicks Cancel on that prompt), port clashes, wrong adapters and refused camera logins, and offers one-click fixes.

### Project layout

```
src/
  shared/types.ts        types shared by server and UI
  main/
    index.ts             Electron shell: window, IPC for folder picker, lifecycle
    core/                no Electron imports: can run headless later (NAS, NXS box)
      index.ts           Core: wires everything together, applies settings changes
      ftp.ts             embedded FTP server (ftp-srv), one folder per camera login
      ingest.ts          watcher → hash/dedupe → EXIF → file by date → previews
      media.ts           EXIF (exiftool), thumbnails/previews (sharp), embedded RAW JPEGs
      library.ts         SQLite access: shots, files, sync jobs
      sync.ts            background sync queue (folder copy, rclone)
      config.ts / db.ts / net.ts / events.ts
    api/server.ts        Fastify REST API + SSE event stream + serves the web UI
  preload/index.ts       exposes API base + native helpers to the window
  renderer/              React UI (same bundle serves remote browsers)
```

## REST API

The desktop window uses the same HTTP API a remote browser or script would. It listens on `127.0.0.1:8787`, or on all interfaces when remote access is on. Requests that don't come from this machine, including anything through a tunnel, need the PIN as an `x-shotdrop-key` header or a `?key=` parameter. Remote clients can only view and cull: the endpoints marked **local** return 403 to them, even with the PIN, because they change configuration, run programs or send photos elsewhere.

| Method | Path | |
|---|---|---|
| GET | `/api/status` | FTP, API, library and sync state |
| GET | `/api/events` | Server-Sent Events: `shot:added`, `shot:updated`, `shot:removed`, `status`, `ingest:error` |
| GET | `/api/sessions` | Shoot days with counts |
| GET | `/api/shots` | `?session=&minRating=&flag=-1\|0\|1\|notRejected&label=&order=asc\|desc&limit=&offset=` |
| GET | `/api/shots/:id` | One shot |
| PATCH | `/api/shots/:id` | `{ rating?, flag?, label? }` |
| PATCH | `/api/shots` | Bulk: `{ ids: [], patch: {...} }` |
| DELETE | `/api/shots/:id` | Sends the files to the recycle bin |
| GET | `/api/shots/:id/thumb` · `/preview` · `/original?file=` | Images |
| GET / PATCH | `/api/settings` (local) | Changing FTP, library or watch settings restarts those services live |
| POST | `/api/ftp/start` · `/api/ftp/stop` (local) | |
| GET / POST | `/api/destinations` (local) | `{ name, type: folder\|rclone, target, filter: all\|jpeg\|raw\|picks }`. Adding one backfills existing shots. |
| PATCH / DELETE | `/api/destinations/:id` (local) | |
| POST | `/api/destinations/:id/resync` (local) | Queue everything again |
| GET | `/api/sync/jobs?status=` (local) | Recent sync jobs |
| POST | `/api/sync/retry` (local) | Retry failed jobs |
| GET | `/api/changes?after=<seq>` | Polling alternative to `/api/events`: events since `seq` plus current status. `reset: true` means reload `/api/shots` (which returns its own `seq`). |
| GET | `/api/tunnel` | Public link state: `off`, `installing`, `starting`, `running` or `error`, plus the URL |
| POST | `/api/tunnel/install` (local) | Download cloudflared from Cloudflare's GitHub releases into the app data folder |
| POST | `/api/tunnel/start` · `/api/tunnel/stop` (local) | Start or stop a Cloudflare quick tunnel to the API/gallery |
| GET | `/api/diagnostics` (local) | Connection check: FTP server, transfer ports, network adapter, firewall, self-test login, camera login attempts, disk space |
| GET | `/api/diagnostics/attempts` (local) | Recent FTP logins, accepted or refused |
| POST | `/api/diagnostics/fix/:id` (local) | `firewall-allow` (one Windows permission prompt: adds local-subnet-only rules and removes block rules), `firewall-remove`, `use-free-port` |

---

## Features

### Ingest
- [x] Built-in FTP server, started from the app with one toggle (FTPS still to do)
- [x] Auto-detect the LAN IP and show the camera setup details in big readable text: host, port, user, password, folder
- [x] **Camera setup wizard** with per-brand step-by-step instructions (Sony, Canon, Nikon, Fuji)
- [x] **Connection check** with one-click fixes:
  - Windows Firewall rules (local network only), including removing Windows' hidden block rule
  - Port clashes (names the program holding the port, moves to a free one)
  - VPN/virtual adapter warnings
  - A self-test that logs in like a camera
  - Refused camera logins ("wrong password from 192.168.x.x")
  - Disk space
- [ ] QR code or printable card with the connection details
- [x] Multiple cameras at once, each with its own credentials, so frames are tagged by camera or shooter
- [x] Handles JPEG, HEIF and RAW (ARW, CR3, NEF, RAF, DNG), plus JPEG+RAW pairs grouped as one shot
- [x] Also ingest from a watched folder (card reader, tether software output)
- [ ] Drag-and-drop import
- [x] Partial-upload detection: never show or sync a half-written file
- [x] Duplicate detection by hash, so camera re-sends don't create copies
- [ ] Auto-rename and folder rules, e.g. `{date}/{camera}/{seq}`

### Gallery (the main screen)
- [x] New shots appear within seconds, with a subtle "new" pulse
- [x] **Follow mode:** the big view jumps to each new frame as it arrives (live-tether feel). Toggle off to browse freely.
- [x] Grid view, filmstrip view and full-screen loupe
- [x] Instant previews from the JPEG embedded in the RAW, with full decode on demand
- [x] Zoom to 100% and pan for focus checks
- [x] EXIF overlay: shutter, aperture, ISO, focal length, lens, camera, time
- [ ] Optional histogram and highlight-clipping overlay
- [ ] Side-by-side compare (2 to 4 up)
- [x] Filter by session, pick, rating, reject
- [ ] Sort and filter by camera, colour label, file type
- [x] Sessions/shoots: group a day or job into its own collection

### Culling
- [x] Keyboard-first: `1`–`5` stars, `P` pick, `X` reject, `6`–`9` colour labels, arrows to move
- [ ] Ratings written to XMP sidecars so Lightroom and Capture One see them
- [x] "Sync picks only" option per destination
- [x] Delete to the recycle bin (never a hard delete)
- [ ] Batch delete or move rejects

### Sync
- [x] Multiple destinations, each with its own rules
  - [x] Google Drive, Dropbox, OneDrive, S3/R2/B2 and others via **rclone** (user's own `rclone config` for now; bundling and in-app sign-in still to do)
  - [x] Local or NAS folder and network shares
  - [ ] rsync/SSH to a remote box
- [x] Per-destination filters: all files, JPEG only, picks only, RAW only
- [x] Background queue with retry and resume (bandwidth limits still to do)
- [x] Status per photo: local ✓, synced to each destination ✓
- [x] Works offline: queues uploads and catches up when the connection is back
- [ ] Optional resized "share copies", e.g. long edge 2048px JPEG, for faster cloud previews

### Remote access
- [x] **Remote gallery:** view and cull from a phone or another PC through a browser, served by the app's built-in web server
- [x] One-click **Cloudflare quick tunnel**: public HTTPS link to the remote gallery, QR code, no account or port forwarding; cloudflared installs from the app
- [ ] Named Cloudflare Tunnel on the user's own account (stable URL, live SSE instead of polling)
- [x] Password or PIN on the remote gallery
- [ ] **Remote camera uploads** (advanced, see notes below): accept camera uploads from outside the LAN

### App and system
- [ ] Runs in the tray and can start on boot
- [ ] Desktop notifications: camera connected, upload failed, disk low
- [ ] Disk space guard with warnings and a pause-ingest threshold
- [ ] Activity log: who sent what, and when
- [ ] Windows first, then macOS and Linux
- [ ] Auto-update

---

## Architecture

```
┌──────────┐  FTP/FTPS over Wi-Fi  ┌───────────────────────── ShotDrop (Electron) ─────────────────────────┐
│  Camera  │ ────────────────────▶ │ Main process (Node)                                                  │
└──────────┘                       │  ├─ FTP server (ftp-srv)  → writes to ingest dir                     │
                                   │  ├─ Watcher (chokidar)   → detects complete files                    │
┌──────────┐  card / tether        │  ├─ Indexer              → hash, EXIF (exiftool), thumbnails (sharp) │
│  Folder  │ ────────────────────▶ │  ├─ Library DB (SQLite)  → shots, ratings, sync state                │
└──────────┘                       │  ├─ Sync queue           → rclone / rsync child processes            │
                                   │  └─ Web server (HTTP)    → remote gallery + API (+ Cloudflare Tunnel)│
                                   │                                                                      │
                                   │ Renderer (React)         → gallery, loupe, culling, settings         │
                                   └──────────────────────────────────────────────────────────────────────┘
                                                      │
                                       ┌──────────────┼──────────────┐
                                       ▼              ▼              ▼
                                 Google Drive      Dropbox      NAS / rsync
```

### Stack
| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** | Full Node runtime, so the FTP server, file watching and child processes are all easy in JS. Tauri would also work (Rust has `libunftp`) but needs Rust for the backend. |
| UI | React + TypeScript + Vite | The same UI is reused for the remote web gallery |
| FTP | `ftp-srv` | Mature Node FTP/FTPS server with passive mode support |
| Images | `sharp` (thumbnails), `exiftool-vendored` (EXIF and embedded RAW previews, XMP writes) | Fast and handles every RAW format |
| DB | SQLite (`better-sqlite3`) | Local library and sync state |
| Sync | Bundled `rclone` binary, plus `rsync` where available | rclone already handles OAuth, retries and 70+ backends |
| Remote | `cloudflared` (optional download) | HTTPS tunnel with no port forwarding |

### Ingest pipeline
1. The camera uploads `DSC01234.ARW` to the FTP server, which writes it to the ingest dir.
2. The FTP "upload complete" event, plus a size-stable check, marks the file ready.
3. Hash → dedupe → apply rename and folder rules → move into the library.
4. Extract the embedded preview → thumbnail → push to the UI over IPC. **This is the "seconds after the shot" moment.**
5. Read EXIF into the DB.
6. Enqueue on each matching sync destination.

---

## Remote access notes

**Remote gallery (done).** The app serves the React gallery over HTTP. Settings → Remote → *Create public link* starts a Cloudflare quick tunnel (`cloudflared`, installed by the app on Windows and Linux) and shows the HTTPS URL and a QR code. Visitors enter the PIN, then view and cull; configuration stays on the desktop. Things to know:
- The URL is random and changes every time the tunnel starts. "Start the link when ShotDrop opens" brings it back after a restart, but with a new URL.
- [Quick tunnels don't support Server-Sent Events](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), so the gallery polls `/api/changes` every 2.5 s through them. It also falls back to polling if no live event arrives within 6 s through any other proxy.
- Quick tunnels are meant for testing (no uptime guarantee, 200 in-flight requests). A named tunnel on the user's own Cloudflare account is the upgrade path for a permanent address.

**Remote camera uploads (harder).** Cameras speak FTP, which a Cloudflare Tunnel can't carry: the camera can't run `cloudflared`, and FTP uses multiple ports. Options, best first:
1. **Same-network field kit:** camera, phone hotspot and laptop running ShotDrop, all on one Wi-Fi. No internet needed for ingest; the laptop syncs when it has a connection.
2. **Port-forward FTPS/SFTP** on the home router to the ShotDrop PC. Plain FTP over the internet is not acceptable, so require FTPS/SFTP on cameras that support it.
3. **Relay later:** a small cloud FTP endpoint (VPS or similar) that the home app pulls from. This adds hosting cost, so it's deferred.

---

## Camera compatibility (built-in FTP)

Firmware updates keep adding FTP to more bodies, so verify per model. This is a starting list, not a guarantee.

| Brand | Models | Notes |
|---|---|---|
| Sony | a1, a1 II, a9 II, a9 III, a7 IV, a7 V, a7R V, a7S III, a7C II, a7CR, a6700, FX3, FX30 | FTPS supported on most |
| Canon | R1, R3, R5, R5 II, R6 II, R6 III, 1D X III | Older bodies need a WFT transmitter |
| Nikon | Z9, Z8, Z6III | Older Z bodies need a WT-7 |
| Fujifilm | X-H2S, X-H2, GFX100 II | Some need the FT-XH grip or updated firmware |
| Panasonic | S5II/S5IIX, GH7, S1R II | Mainly Frame.io Camera-to-Cloud; FTP support varies |

Entry-level bodies usually only support the brand's phone app, which ShotDrop can't receive from.

---

## Roadmap

**v0.1 (MVP)** ✅ scaffolded
- Electron + React shell, built-in FTP server, camera setup screen
- Live gallery with follow mode, loupe, keyboard culling
- One sync destination via rclone (Google Drive)

**v0.2**
- Multiple destinations and filters, XMP ratings, RAW+JPEG pairing, sessions
- Remote web gallery with Cloudflare quick tunnel ✅

**v0.3**
- Multi-camera, per-brand wizards, notifications, disk guard, auto-update
- Port-forward FTPS mode for remote ingest

**Later**
- **Android app:** the phone *is* the server. Camera → phone hotspot → ShotDrop on Android receives over FTP, shows the gallery and syncs over mobile data. The React UI can be reused (Capacitor or React Native) with a native FTP server module. This makes for a very portable field kit.
- **Share / proofing:** guest links with picks, comments and notifications, built on photos already sitting in the user's own cloud. This is the potential commercial product.
- macOS and Linux builds.

---

## Related

- **NXS remote box:** already syncs the photos drive to Google Drive "Camera Uploads" with an rsync-style job. ShotDrop could use that box as a destination (rsync/SSH) instead of syncing to Drive directly.
