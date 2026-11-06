# PTP/IP over Wi-Fi: live view and transfer (prototype)

`ptpip.ts` is a minimal PTP/IP client written from the spec (CIPA DC-005), plus Nikon's live-view and pairing operations. It has no dependencies and no libgphoto2 code, so it stays clear of the LGPL. It is not wired into the app yet.

```bash
node --experimental-strip-types scripts/ptp-selftest.ts                      # mock camera, no hardware needed
node --experimental-strip-types scripts/ptp-probe.ts info  --host 192.168.1.1
node --experimental-strip-types scripts/ptp-probe.ts pair  --host 192.168.1.1  # Nikon Z, one time
node --experimental-strip-types scripts/ptp-probe.ts live  --host 192.168.1.1 --out .dev-data/library/.incoming/ptp-nikon
node --experimental-strip-types scripts/ptp-probe.ts watch --host 192.168.1.1 --out <dir>
```

- `live` serves the stream at http://127.0.0.1:8090/. With `--out`, it also downloads each new shot over the same session.
- The GUID lives in `.dev-data/ptp-guid` and must stay stable. A paired Nikon only accepts the GUID it was paired with.

## How it works

1. Open a TCP connection to port 15740 and send `Init_Command_Request` with the host GUID, name and version. The camera replies `Init_Command_Ack` with a connection number, or `Init_Fail` and a reason.
2. Open a second TCP connection for the event channel: send `Init_Event_Request` with that connection number and get back `Init_Event_Ack`. The camera pushes events (`ObjectAdded 0x4002`, …) here and sends probe requests, which we answer.
3. Send `OpenSession`. From then on, every operation is `Operation_Request`, then an optional `Start_Data`/`Data`/`End_Data`, then `Operation_Response`. Transactions are serialized, so live-view polling and downloads can share one session.
4. **Nikon live view:**
   - `StartLiveView 0x9201`.
   - Poll `DeviceReady 0x90C8` until it stops returning Busy (0x2019).
   - Loop `GetLiveViewImg 0x9203`. Each frame is a model-specific header followed by a JPEG; we find the JPEG by its start marker.
   - `EndLiveView 0x9202` when done.
5. **New shots:**
   - Watch `ObjectAdded` on the event channel. Also poll Nikon `GetEvent 0x90C7`, because Nikon reports most events that way. Handle `0xC101 ObjectAddedInSdram` for shots taken with no card.
   - Call `GetObjectInfo` then `GetObject`, write to `<name>.part`, then rename.
6. **Nikon Z pairing.** Protocol from [libgphoto2#1314](https://github.com/gphoto/libgphoto2/issues/1314), reverse-engineered there on a ZR.
   - `0x952B` returns a PIN as one byte per digit. Show it to the user.
   - Send `0x935A(0x2001)`. The user confirms on the camera, and the camera sends event `0x4008`.
   - Drop the sockets without `CloseSession` and reconnect with the same GUID; the camera restarts Wi-Fi.
   - Each network profile on the camera pairs with exactly one GUID. If another GUID is paired, the camera answers `Init_Fail` with reason 1.

## Per-brand viability

| | Nikon | Canon | Sony | Fujifilm |
|---|---|---|---|---|
| Works without vendor SDK | **Yes.** Standard PTP/IP plus documented Nikon ops; newer Z bodies need one PIN pairing. | **Yes** via PTP/IP ("Connect to EOS Utility" mode). Pairing is done without Canon software in [groundglass](https://github.com/akhater/groundglass/pull/3) on an R6 III. CCAPI is a separate HTTP API that needs Canon's activation (unverified). | **Not on current bodies.** Wi-Fi PC Remote uses Sony's Camera Remote SDK / PTP-IP with access authentication, which isn't publicly documented. [RemoteCam](https://github.com/RemingtonWilcox/RemoteCam) does it, but I haven't read how. Older bodies used the deprecated Camera Remote API (HTTP). | **Probably.** Fuji uses its own PTP/IP variant (ports 55740–55742, from memory, unverified). Community projects exist. |
| Live view | Yes (`0x9203`). Implemented here. | Yes: EOS `GetViewFinderData 0x9153` after setting EVF output. groundglass reports 960×640 at about 11 fps on an R6 III. Not implemented. | Yes via SDK. A USB reverse-engineering exists ([sony-camera-android](https://github.com/YLTai/sony-camera-android)); I haven't confirmed the Wi-Fi path. | Unverified. |
| Transfer of new shots | Yes: `ObjectAdded`/`GetEvent` then `GetObject`. Implemented here. | Yes: EOS `GetEvent 0x9116` reports new objects, then `GetObject`. Not implemented. | Yes via SDK. | Unverified. |
| Coexists with FTP | Not needed. FTP and "Connect to computer" are separate network profiles and only one runs at a time (my understanding; verify on your body). PTP transfer replaces FTP. | Same: FTP and EOS Utility are separate Wi-Fi functions, one at a time (unverified). | Unverified per body. | Unverified. |
| Licensing | Clean: our own code from the spec plus a public protocol write-up. | Clean for PTP/IP done this way. CCAPI requires agreeing to Canon's developer terms. | The SDK forbids redistribution, but the Command toolkit allows embedding (see the earlier research). Reverse-engineering the auth is legally grey. | Clean if we write our own code. |
| **Verdict** | **Go.** Test on real hardware next. | **Go, second.** Add an EOS module on this client. | **Hold.** The only clean route is Sony's toolkit terms. | **Later.** Needs a body to reverse-engineer against. |

## Fitting it into the app

- **A "PTP camera" connection mode in `core`, alongside FTP.** A service owns one `PtpIpClient` per camera and downloads into `<library>/.incoming/ptp-<serial>/`. The existing incoming watcher (`ingest.ts`) moves those files into the library and uses the first folder name as the shot's source. Hashing, EXIF, previews, culling and sync then apply unchanged.
- **Live view as an MJPEG endpoint on the existing API** (for example `/api/live/:camera`), shown as an `<img>` in the renderer. This is the same approach `ptp-probe.ts live` uses. Pause live-view polling while a download is in flight on slow links.
- **Discovery and pairing in the setup screen.**
  - Nikon advertises `_ptp._tcp` over mDNS. Its TXT `apps=PAIR` means unpaired, `$DSC` means paired.
  - The setup screen would show the PIN and say "confirm on the camera".
  - The GUID would be stored once in settings.
  - `Init_Fail` reason 1 should be reported as "this camera's network profile is paired to another computer".
- **Large files.** `GetObject` holds the whole file in memory. Switch to `GetPartialObject 0x101B` chunks before shipping, for RAW and video.

## Not verified

- **Nothing has run against a real camera.** The protocol paths are only checked against the mock in `scripts/ptp-selftest.ts`.
- **Station mode.** The Nikon pairing flow was documented only in camera-as-access-point mode.
- **Older Nikon bodies.** The D-series with WMU/WT units may want a fixed GUID.
- **Untested facts.** Every per-brand claim marked "unverified" above is untested.
