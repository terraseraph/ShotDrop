// Generates the PWA icons from the brand mark (run once: node scripts/make-icons.mjs; output is committed).
import sharp from 'sharp'

const svg = (size, inset, radius) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
<rect width="100" height="100" fill="#0b0b0d"/>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5436"/><stop offset=".5" stop-color="#ffb03a"/><stop offset="1" stop-color="#ff5436"/></linearGradient></defs>
<rect x="${inset}" y="${inset}" width="${100 - 2 * inset}" height="${100 - 2 * inset}" rx="${radius}" fill="url(#g)"/>
<circle cx="50" cy="50" r="${(100 - 2 * inset) * 0.17}" fill="#0b0b0d"/>
</svg>`

const out = 'src/renderer/public/'
for (const [name, size, inset, r] of [
  ['icon-192.png', 192, 22, 14],
  ['icon-512.png', 512, 22, 14],
  ['icon-maskable-512.png', 512, 32, 6], // maskable: mark inside the 80% safe zone
  ['apple-touch-icon.png', 180, 22, 14]
]) await sharp(Buffer.from(svg(size, inset, r))).png().toFile(out + name)
