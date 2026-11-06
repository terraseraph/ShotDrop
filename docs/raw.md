# RAW files in ShotDrop

How RAW photos are shown, what we looked at, and what ships.

## What the app does

| View | Source | Cost | Where it shows |
|---|---|---|---|
| **Camera JPEG** | the JPEG half of a RAW+JPEG pair, or a plain JPEG | free | loupe, 100% zoom |
| **Camera preview** / **RAW preview** | the *largest* JPEG stored inside the RAW (`JpgFromRaw`, `PreviewImage` or `ThumbnailImage`, whichever has the most pixels), extracted with exiftool | about 0.3 s, cached | loupe, 100% zoom |
| **RAW decode** | a real demosaic of the sensor data with LibRaw's `dcraw_emu` (camera white balance, sRGB, 8 bit), written as a full-size JPEG q92 | 3 to 13 s, cached | "Develop RAW" button in the loupe |

The loupe shows a pill with the true size of whatever is on screen ("Camera JPEG 6024×4024", "RAW preview 1616×1080",
"RAW decode 6246×4170"). A RAW+JPEG pair gets a three-way switch; a RAW-only shot gets preview / decode. Zoom (`Z`) uses
the selected source at full size. Grid thumbnails and the quick 2560 px loupe image are unchanged (the best embedded
preview, or the camera JPEG when there is one).

Develop is on demand only (it needs the ShotDrop computer: `POST /api/shots/:id/develop` is local-only). Results land in
`<data>/cache/full/<id>.raw.jpg` (+ `.json` with the size), so a second view is instant. One decode runs at a time.

### API

- `GET /api/shots/:id/sources` lists the views with true sizes (`ready:false` for a decode not yet made).
- `GET /api/shots/:id/full?src=jpeg|embedded|raw` serves a full-size rendition. `embedded` is generated when first asked
  for; `raw` returns 404 until developed.
- `POST /api/shots/:id/develop` makes the RAW decode and returns its size.

## What we found

Measured here on four openly licensed samples from raw.pixls.us (Windows 11, `dcraw_emu` 0.21.4, one decode at a time):

| Camera | RAW | Largest embedded JPEG | RAW decode | Time (decode + JPEG) |
|---|---|---|---|---|
| Nikon Z 30 NEF | 20 MB | 5568×3712, `JpgFromRaw` (full) | 3728×5600 | 2.6 s |
| Sony ILCE-6400 ARW | 25 MB | **1616×1080**, `PreviewImage` (no full-size JPEG) | 6024×4024 | 2.7 s |
| Canon EOS R10 CR3 | 41 MB | 6000×4000, `JpgFromRaw` (full) | 6000×4000 | 3.1 s |
| Fujifilm X-T30 RAF | 32 MB | 4416×2944, `PreviewImage` | 6246×4170 | 13.1 s (X-Trans demosaic) |

So the "embedded JPEG is full size" rule holds for Nikon and Canon, but Sony's ARW is only 1616×1080 and the Fuji
sample's is a medium size. That is exactly where a real decode matters. (The previous code took the first tag that
extracted; it now compares all three and keeps the biggest.)

Embedded JPEGs also carry the camera's picture style/film simulation, which is usually what the photographer wants to
see when culling. The decode is neutral (camera white balance, no tone curve beyond sRGB gamma), so it looks flatter
and shows true sensor detail rather than the camera's sharpening.

## Options compared

| | Embedded JPEG | `sharp`/libvips | LibRaw `dcraw_emu.exe` (chosen) | WASM LibRaw (`libraw-wasm`) |
|---|---|---|---|---|
| Real decode | no | **no** | yes | yes |
| Licence | none | LGPL (libvips) | LibRaw: LGPL-2.1 or CDDL-1.0, run as a separate exe | same LibRaw licence, plus the wrapper (ISC) |
| Windows portable | already shipped | already shipped | 1 MB of unmodified binaries + licence texts | pure JS/WASM, nothing native |
| Speed | 0.3 s | n/a | 2.6 to 13 s per frame, native | not measured here; WASM is typically a few times slower than native |
| Memory | low | n/a | 100–400 MB transient while decoding | WASM 4 GB address-space cap, whole file copied into the heap |
| Quality | camera's own | n/a | AHD demosaic, camera WB | same engine |

- **`sharp`:** checked on the installed 0.35.5 (libvips 8.18.7): the prebuilt loads jpeg, png, webp, tiff, gif, svg, heif
  and vips only. There is no RAW loader, so it cannot open a NEF/ARW/CR3/RAF at all. It stays our resizer and JPEG encoder.
- **WASM LibRaw:** attractive for a single-codebase, no-binary story and for non-Windows builds. I did not benchmark it.
  Against it: slower, an extra worker plumbing layer, whole-file-in-heap limits for 60–100 MP files, and a third-party
  wrapper to keep current (`libraw-wasm` 1.6.0, ISC). A reasonable later step if we ever ship on macOS/Linux without
  native binaries, behind the same `Previewer.develop()` function.
- **Bundled `dcraw_emu`:** supports everything LibRaw does (all four test brands decoded fine, including CR3/CRX and
  Fuji X-Trans), is a plain process so a crash on a corrupt file cannot take the app down,
  and fits the existing "bundle a pinned binary with a checksum" pattern (`scripts/fetch-binaries.mjs`).
  We pipe a TIFF over stdout into sharp, so nothing is written next to the photo.

LibRaw's licence allows shipping the unmodified Windows build under the LGPL/CDDL terms: keep the licence texts (we do:
`LICENSE-libraw-LGPL.txt`, `-CDDL.txt`, `-COPYRIGHT.txt`) and do not statically link it into closed code (we do not; it
is a separate `dcraw_emu.exe` plus `libraw.dll`).

## Packaging

`npm run fetch-binaries` also downloads LibRaw 0.22.3 as MSYS2's UCRT64 packages (eight `.pkg.tar.zst` files, each
SHA-256 pinned in the script) and copies `dcraw_emu.exe`, `libraw-25.dll`, its runtime DLLs and the licence texts into
`resources/bin/win-x64/`, which electron-builder ships as `resources\bin`. `src/main/core/media.ts` finds it with
`bundledBin('dcraw_emu')`, falling back to `resources/bin/win-x64` in dev and to `dcraw_emu` on `PATH` elsewhere. If none
exists the Develop button is disabled.

This build needs no Visual C++ redistributable (only the Universal CRT built into Windows 10+), so Develop works on a
clean PC. Tested: NEF 2.1 s, ARW 1.1 s, RAF 3.1 s to full-resolution TIFF. About 5.8 MB added to the package.

## Not done

- A "half-size fast develop" (`dcraw_emu -h`) for the slow Fuji decode, or an AMaZE/DCB quality switch.
- Highlight recovery, exposure or WB adjustments on the decode. It is a viewing aid, not a RAW editor.
- Decoding at ingest time. Develop stays on demand to keep FTP bursts fast.
- HEIF/HIF sources in the source switch (they still use the existing preview path).
