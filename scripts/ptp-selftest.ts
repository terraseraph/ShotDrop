// Self-check for src/main/ptp/ptpip.ts against a fake Nikon speaking PTP/IP.
//   node --experimental-strip-types scripts/ptp-selftest.ts
// Covers framing (packets split across TCP writes, multi-packet data), handshake + Init_Fail, pairing, live view, downloads.
import { createServer, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { Ev, InitFailError, Op, PtpIpClient, extractJpeg, newGuid, nikonPair, nikonWaitReady, parseNikonEvents, parseObjectInfo } from '../src/main/ptp/ptpip.ts'

const PAIRED = newGuid()
const PHOTO = randomBytes(300_000)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(5000), Buffer.from([0xff, 0xd9])])

const pkt = (type: number, body: Buffer): Buffer => {
  const h = Buffer.alloc(8)
  h.writeUInt32LE(8 + body.length, 0)
  h.writeUInt32LE(type, 4)
  return Buffer.concat([h, body])
}
const u16 = (n: number): Buffer => (((b) => (b.writeUInt16LE(n), b))(Buffer.alloc(2)))
const u32 = (n: number): Buffer => (((b) => (b.writeUInt32LE(n >>> 0), b))(Buffer.alloc(4)))
const str = (s: string): Buffer => (s ? Buffer.concat([Buffer.from([s.length + 1]), Buffer.from(s + '\0', 'utf16le')]) : Buffer.from([0]))
const arr = (xs: number[]): Buffer => Buffer.concat([u32(xs.length), ...xs.map(u16)])

const deviceInfo = Buffer.concat([
  u16(100), u32(0x0a), u16(100), str('microsoft.com: 1.0'), u16(0),
  arr([0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x90c7, 0x90c8, 0x9201, 0x9202, 0x9203, 0x952b, 0x935a]),
  arr([0x4002, 0x4008]), arr([0x5001]), arr([]), arr([0x3801]),
  str('Nikon Corporation'), str('Z 6_2'), str('V1.60'), str('6000123'),
])
const objectInfo = Buffer.concat([
  u32(0x00010001), u16(0x3801), u16(0), u32(PHOTO.length), u16(0), u32(0), u32(0), u32(0), u32(6048), u32(4024), u32(24), u32(0), u16(0), u32(0), u32(0),
  str('DSC_0001.JPG'), str('20261106T120000'), str(''), str(''),
])

// Writes in awkward 1000-byte slices so the client has to reassemble packets.
const send = (s: Socket, b: Buffer): void => {
  for (let o = 0; o < b.length; o += 1000) s.write(b.subarray(o, o + 1000))
}

let evtSock: Socket | null = null
let busyOnce = true
let eventsOnce = true

function reply(s: Socket, tx: number, code: number, data?: Buffer): void {
  if (data) {
    const start = Buffer.alloc(12)
    start.writeUInt32LE(tx, 0)
    start.writeBigUInt64LE(BigInt(data.length), 4)
    send(s, pkt(9, start))
    // split payload: DATA packets of 64 KB, last chunk in END_DATA
    let o = 0
    for (; data.length - o > 65536; o += 65536) send(s, pkt(10, Buffer.concat([u32(tx), data.subarray(o, o + 65536)])))
    send(s, pkt(12, Buffer.concat([u32(tx), data.subarray(o)])))
  }
  send(s, pkt(7, Buffer.concat([u16(code), u32(tx)])))
}

function handle(s: Socket, type: number, body: Buffer): void {
  if (type === 1) {
    const guid = body.subarray(0, 16).toString('hex')
    if (guid !== PAIRED) return void send(s, pkt(5, u32(1)))
    return void send(s, pkt(2, Buffer.concat([u32(7), Buffer.from(PAIRED, 'hex'), Buffer.from('Z 6_2\0', 'utf16le'), u32(0x10000)])))
  }
  if (type === 3) {
    evtSock = s
    return void send(s, pkt(4, Buffer.alloc(0)))
  }
  if (type !== 6) return
  const op = body.readUInt16LE(4)
  const tx = body.readUInt32LE(6)
  switch (op) {
    case 0x1001: return reply(s, tx, 0x2001, deviceInfo)
    case 0x952b: return reply(s, tx, 0x2001, Buffer.from([4, 0, 0, 0, 1, 6, 5, 2]))
    case 0x935a:
      reply(s, tx, 0x2001)
      setTimeout(() => evtSock && send(evtSock, pkt(8, Buffer.concat([u16(0x4008), u32(0)]))), 30)
      return
    case 0x90c8:
      if (busyOnce) return (busyOnce = false), reply(s, tx, 0x2019)
      return reply(s, tx, 0x2001)
    case 0x9203: return reply(s, tx, 0x2001, Buffer.concat([Buffer.alloc(384), JPEG]))
    case 0x90c7:
      if (eventsOnce) return (eventsOnce = false), reply(s, tx, 0x2001, Buffer.concat([u16(1), u16(0xc101), u32(0xffff0001)]))
      return reply(s, tx, 0x2001, u16(0))
    case 0x1008: return reply(s, tx, 0x2001, objectInfo)
    case 0x1009: return reply(s, tx, 0x2001, PHOTO)
    default: return reply(s, tx, 0x2001)
  }
}

const server = createServer((s) => {
  let buf = Buffer.alloc(0)
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 8 && buf.length >= buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0)
      handle(s, buf.readUInt32LE(4), buf.subarray(8, len))
      buf = buf.subarray(len)
    }
  })
  s.on('error', () => {})
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port

// Wrong GUID -> Init_Fail reason 1 (Nikon: profile paired to another computer)
await assert.rejects(new PtpIpClient({ host: '127.0.0.1', port, guid: newGuid(), name: 'x' }).connect(), (e) => e instanceof InitFailError && e.reason === 1)

const c = new PtpIpClient({ host: '127.0.0.1', port, guid: PAIRED, name: 'ShotDrop-test' })
await c.connect()
assert.equal(c.cameraName, 'Z 6_2')
await c.openSession()
const info = await c.deviceInfo()
assert.equal(info.model, 'Z 6_2')
assert.equal(info.serial, '6000123')
assert.ok(info.operations.includes(Op.NikonGetLiveViewImg))

let shown = ''
await nikonPair(c, (code) => (shown = code))
assert.equal(shown, '1652')

await c.transaction(Op.NikonStartLiveView)
await nikonWaitReady(c) // first answer is Busy
const frame = await c.transaction(Op.NikonGetLiveViewImg)
assert.deepEqual(extractJpeg(frame.data), JPEG)

const evs = parseNikonEvents((await c.transaction(Op.NikonGetEvent)).data)
assert.deepEqual(evs, [{ code: Ev.NikonObjectAddedInSdram, params: [0xffff0001] }])
const oi = parseObjectInfo((await c.transaction(Op.GetObjectInfo, [0xffff0001])).data)
assert.equal(oi.filename, 'DSC_0001.JPG')
assert.equal(oi.size, PHOTO.length)
const [a, b] = await Promise.all([c.transaction(Op.GetObject, [1]), c.transaction(Op.NikonGetLiveViewImg)]) // interleaved callers stay serialized
assert.deepEqual(a.data, PHOTO)
assert.deepEqual(extractJpeg(b.data), JPEG)

await c.close()
server.close()
console.log('ptp self-test: all checks passed')
