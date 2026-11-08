// Generates every app icon from build/icon.svg (run after editing it: node scripts/make-icons.mjs; output is committed).
// build/icon.ico is the Windows exe/taskbar icon electron-builder picks up; the PNGs in public/ are the PWA icons.
import sharp from 'sharp'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const tile = readFileSync('build/icon.svg', 'utf8')
// Maskable and Apple icons get cropped by the OS, so draw the mark full-bleed, shrunk into the 80% safe zone.
const mark = tile.replace(/<rect [^>]*\/>/, '').replace(/<svg [^>]*>|<\/svg>/g, '')
const bleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#141414"/>
<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${mark}</g></svg>`

const png = (svg, size) => sharp(Buffer.from(svg), { density: Math.max(72, (size / 512) * 72 * 4) }).resize(size, size).png().toBuffer()

const out = 'src/renderer/public/'
copyFileSync('build/icon.svg', out + 'favicon.svg')
for (const [name, svg, size] of [
  ['icon-192.png', tile, 192],
  ['icon-512.png', tile, 512],
  ['icon-maskable-512.png', bleed(0.72), 512],
  ['apple-touch-icon.png', bleed(0.86), 180]
]) writeFileSync(out + name, await png(svg, size))

// ICO with PNG-compressed entries (supported since Vista): 6-byte header, 16-byte directory entry per image, then the data.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(sizes.map((s) => png(tile, s)))
const head = Buffer.alloc(6 + 16 * sizes.length)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(sizes.length, 4)
let offset = head.length
sizes.forEach((s, i) => {
  const e = 6 + 16 * i
  head.writeUInt8(s % 256, e) // 0 means 256
  head.writeUInt8(s % 256, e + 1)
  head.writeUInt16LE(1, e + 4)
  head.writeUInt16LE(32, e + 6)
  head.writeUInt32LE(images[i].length, e + 8)
  head.writeUInt32LE(offset, e + 12)
  offset += images[i].length
})
writeFileSync('build/icon.ico', Buffer.concat([head, ...images]))
