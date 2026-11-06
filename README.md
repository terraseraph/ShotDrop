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

## Features

### Ingest
- [ ] Built-in FTP server (with FTPS where the camera supports it), started from the app with one toggle
- [ ] Auto-detect the LAN IP and show the camera setup details in big readable text: host, port, user, password, folder
- [ ] **Camera setup wizard** with per-brand step-by-step instructions (Sony, Canon, Nikon, Fuji)
- [ ] QR code or printable card with the connection details
- [ ] Multiple cameras at once, each with its own credentials, so frames are tagged by camera or shooter
- [ ] Handles JPEG, HEIF and RAW (ARW, CR3, NEF, RAF, DNG), plus JPEG+RAW pairs grouped as one shot
- [ ] Also ingest from a watched folder (card reader, tether software output) and drag-and-drop
- [ ] Partial-upload detection: never show or sync a half-written file
- [ ] Duplicate detection by hash, so camera re-sends don't create copies
- [ ] Auto-rename and folder rules, e.g. `{date}/{camera}/{seq}`

### Gallery (the main screen)
- [ ] New shots appear within seconds, with a subtle "new" pulse
- [ ] **Follow mode:** the big view jumps to each new frame as it arrives (live-tether feel). Toggle off to browse freely.
- [ ] Grid view, filmstrip view and full-screen loupe
- [ ] Instant previews from the JPEG embedded in the RAW, with full decode on demand
- [ ] Zoom to 100% and pan for focus checks
- [ ] EXIF overlay: shutter, aperture, ISO, focal length, lens, camera, time
- [ ] Optional histogram and highlight-clipping overlay
- [ ] Side-by-side compare (2 to 4 up)
- [ ] Sort and filter by time, camera, rating, flag, colour label, file type
- [ ] Sessions/shoots: group a day or job into its own collection

### Culling
- [ ] Keyboard-first: `1`–`5` stars, `P` pick, `X` reject, `6`–`9` colour labels, arrows to move
- [ ] Ratings written to XMP sidecars so Lightroom and Capture One see them
- [ ] "Sync picks only" option per destination
- [ ] Batch delete or move rejects (to the recycle bin, never a hard delete)

### Sync
- [ ] Multiple destinations per shoot, each with its own rules
  - Google Drive, Dropbox, OneDrive, S3/R2/B2 and others via bundled **rclone** (user signs into their own account)
  - Local or NAS folder and network shares
  - rsync/SSH to a remote box
- [ ] Per-destination filters: all files, JPEG only, picks only, RAW only
- [ ] Background queue with retry, resume and bandwidth limits
- [ ] Status per photo: local ✓, synced to each destination ✓
- [ ] Works offline: queues uploads and catches up when the connection is back
- [ ] Optional resized "share copies", e.g. long edge 2048px JPEG, for faster cloud previews

### Remote access
- [ ] **Remote gallery:** view and cull from a phone or another PC through a browser, served by the app's built-in web server
- [ ] One-click **Cloudflare Tunnel** to expose the remote gallery over HTTPS without port forwarding (free; needs the user's Cloudflare account, or a quick tunnel for temporary URLs)
- [ ] Password or PIN on the remote gallery
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

**Remote gallery (easy).** The app serves the React gallery over HTTP. A Cloudflare Tunnel (`cloudflared`) gives it a public HTTPS URL with no router changes. This covers viewing and culling from your phone while away from the PC.

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

**v0.1 (MVP)**
- Electron + React shell, built-in FTP server, camera setup screen
- Live gallery with follow mode, loupe, keyboard culling
- One sync destination via rclone (Google Drive)

**v0.2**
- Multiple destinations and filters, XMP ratings, RAW+JPEG pairing, sessions
- Remote web gallery with Cloudflare quick tunnel

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
