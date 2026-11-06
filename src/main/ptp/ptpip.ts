// Minimal PTP/IP client (CIPA DC-005) plus the Nikon vendor bits ShotDrop needs: pairing, live view, new-object download.
// Prototype: no imports outside node builtins so `scripts/ptp-probe.ts` can run it with `node --experimental-strip-types`.
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'

// Packet types
const INIT_CMD_REQ = 1
const INIT_CMD_ACK = 2
const INIT_EVT_REQ = 3
const INIT_EVT_ACK = 4
const INIT_FAIL = 5
const OP_REQ = 6
const OP_RESP = 7
const EVENT = 8
const START_DATA = 9
const DATA = 10
const END_DATA = 12
const PROBE_REQ = 13
const PROBE_RESP = 14

export const OK = 0x2001
export const DEVICE_BUSY = 0x2019

export const Op = {
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetStorageIDs: 0x1004,
  GetObjectHandles: 0x1007,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009,
  GetPartialObject: 0x101b,
  // Nikon
  NikonCapture: 0x90c0, // InitiateCaptureRecInSdram
  NikonGetEvent: 0x90c7,
  NikonDeviceReady: 0x90c8,
  NikonStartLiveView: 0x9201,
  NikonEndLiveView: 0x9202,
  NikonGetLiveViewImg: 0x9203,
  NikonGetPairingCode: 0x952b,
  NikonConfirmPairing: 0x935a,
} as const

export const Ev = {
  ObjectAdded: 0x4002,
  DeviceInfoChanged: 0x4008,
  CaptureComplete: 0x400d,
  NikonObjectAddedInSdram: 0xc101,
} as const

export const hex = (n: number): string => '0x' + n.toString(16).padStart(4, '0')

export class PtpError extends Error {
  code: number
  constructor(op: number, code: number) {
    super(`PTP ${hex(op)} failed: ${hex(code)}`)
    this.code = code
  }
}

/** Camera refused the handshake. On Nikon Z, reason 1 = this profile is paired to a different computer (GUID). */
export class InitFailError extends Error {
  reason: number
  constructor(reason: number) {
    super(`PTP/IP init refused, reason ${reason}${reason === 1 ? ' (camera profile is paired to another computer)' : ''}`)
    this.reason = reason
  }
}

interface Packet {
  type: number
  body: Buffer
}

/** Splits a TCP stream into PTP/IP packets ([u32 length incl. header][u32 type][body]). */
class PacketStream {
  chunks: Buffer[] = []
  size = 0
  waiters: Array<{ resolve: (p: Packet) => void; reject: (e: Error) => void }> = []
  ready: Packet[] = []
  error: Error | null = null
  onPacket: ((p: Packet) => void) | null = null // when set, packets bypass next()

  constructor(sock: Socket) {
    sock.on('data', (d) => this.push(d as Buffer))
    const fail = (e: Error): void => {
      this.error = e
      for (const w of this.waiters.splice(0)) w.reject(e)
    }
    sock.on('error', fail)
    sock.on('close', () => fail(new Error('camera closed the connection')))
  }

  push(d: Buffer): void {
    this.chunks.push(d)
    this.size += d.length
    // ponytail: concat per packet is O(n) copies; fine for live-view frames, revisit if RAW downloads get slow.
    while (this.size >= 8) {
      const head = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
      this.chunks = [head]
      const len = head.readUInt32LE(0)
      if (len < 8) {
        this.error = new Error(`bad PTP/IP packet length ${len}`)
        return
      }
      if (head.length < len) return
      const p = { type: head.readUInt32LE(4), body: head.subarray(8, len) }
      const rest = head.subarray(len)
      this.chunks = rest.length ? [rest] : []
      this.size = rest.length
      if (this.onPacket) this.onPacket(p)
      else {
        const w = this.waiters.shift()
        if (w) w.resolve(p)
        else this.ready.push(p)
      }
    }
  }

  next(timeoutMs = 30000): Promise<Packet> {
    const p = this.ready.shift()
    if (p) return Promise.resolve(p)
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (x: Packet) => (clearTimeout(t), resolve(x)),
        reject: (e: Error) => (clearTimeout(t), reject(e)),
      }
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error('timed out waiting for the camera'))
      }, timeoutMs)
      this.waiters.push(w)
    })
  }
}

function packet(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(8 + body.length, 0)
  head.writeUInt32LE(type, 4)
  return Buffer.concat([head, body])
}

function u32(...ns: number[]): Buffer {
  const b = Buffer.alloc(4 * ns.length)
  ns.forEach((n, i) => b.writeUInt32LE(n >>> 0, i * 4))
  return b
}

function utf16z(s: string): Buffer {
  return Buffer.from(s + '\0', 'utf16le')
}

function connectSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = new Socket()
    const t = setTimeout(() => (s.destroy(), reject(new Error(`no answer from ${host}:${port}`))), timeoutMs)
    s.once('error', (e) => (clearTimeout(t), reject(e)))
    s.connect(port, host, () => {
      clearTimeout(t)
      s.removeAllListeners('error')
      s.setNoDelay(true)
      s.setKeepAlive(true, 5000)
      resolve(s)
    })
  })
}

export interface PtpEvent {
  code: number
  params: number[]
}

export interface Response {
  code: number
  params: number[]
  data: Buffer
}

export interface ClientOptions {
  host: string
  port?: number
  /** 16 bytes as 32 hex chars. Must stay the same across runs: Nikon Z pairs to it. */
  guid: string
  name: string
}

export function newGuid(): string {
  return randomBytes(16).toString('hex')
}

/**
 * One PTP/IP connection: a command socket for transactions and an event socket for camera events.
 * Emits 'event' (PtpEvent) and 'close'. Transactions are serialized, so live view and downloads can share it.
 */
export class PtpIpClient extends EventEmitter {
  opts: ClientOptions
  cmd: Socket | null = null
  evt: Socket | null = null
  cmdStream: PacketStream | null = null
  connNumber = 0
  cameraName = ''
  txId = 0
  queue: Promise<unknown> = Promise.resolve()

  constructor(opts: ClientOptions) {
    super()
    this.opts = opts
  }

  async connect(timeoutMs = 8000): Promise<void> {
    try {
      await this.#connect(timeoutMs)
    } catch (e) {
      this.destroy()
      throw e
    }
  }

  async #connect(timeoutMs: number): Promise<void> {
    const { host, port = 15740, guid, name } = this.opts
    this.cmd = await connectSocket(host, port, timeoutMs)
    this.cmdStream = new PacketStream(this.cmd)
    this.cmd.on('close', () => this.emit('close'))
    this.cmd.write(packet(INIT_CMD_REQ, Buffer.concat([Buffer.from(guid, 'hex'), utf16z(name), u32(0x00010000)])))
    const ack = await this.cmdStream.next(timeoutMs)
    if (ack.type === INIT_FAIL) throw new InitFailError(ack.body.readUInt32LE(0))
    if (ack.type !== INIT_CMD_ACK) throw new Error(`unexpected init reply type ${ack.type}`)
    this.connNumber = ack.body.readUInt32LE(0)
    this.cameraName = readUtf16z(ack.body, 20)

    this.evt = await connectSocket(host, port, timeoutMs)
    const evs = new PacketStream(this.evt)
    this.evt.write(packet(INIT_EVT_REQ, u32(this.connNumber)))
    const eack = await evs.next(timeoutMs)
    if (eack.type === INIT_FAIL) throw new InitFailError(eack.body.readUInt32LE(0))
    if (eack.type !== INIT_EVT_ACK) throw new Error(`unexpected event-channel reply type ${eack.type}`)
    evs.onPacket = (p) => {
      if (p.type === EVENT) {
        const params: number[] = []
        for (let o = 6; o + 4 <= p.body.length; o += 4) params.push(p.body.readUInt32LE(o))
        this.emit('event', { code: p.body.readUInt16LE(0), params } satisfies PtpEvent)
      } else if (p.type === PROBE_REQ) this.evt?.write(packet(PROBE_RESP, Buffer.alloc(0)))
    }
    this.evt.on('error', () => {}) // the command socket's close is what callers watch
  }

  /** Runs one operation. Throws PtpError unless the response is OK or listed in `allow`. */
  transaction(op: number, params: number[] = [], dataOut?: Buffer, allow: number[] = []): Promise<Response> {
    const run = this.queue.then(() => this.#run(op, params, dataOut, allow))
    this.queue = run.catch(() => {})
    return run
  }

  async #run(op: number, params: number[], dataOut: Buffer | undefined, allow: number[]): Promise<Response> {
    const cmd = this.cmd
    const stream = this.cmdStream
    if (!cmd || !stream) throw new Error('not connected')
    // Transaction 0 is reserved for OpenSession; every other op gets a fresh id.
    const tx = op === Op.OpenSession ? 0 : ++this.txId
    const req = Buffer.alloc(10)
    req.writeUInt32LE(dataOut ? 2 : 1, 0)
    req.writeUInt16LE(op, 4)
    req.writeUInt32LE(tx, 6)
    cmd.write(packet(OP_REQ, Buffer.concat([req, u32(...params)])))
    if (dataOut) {
      const start = Buffer.alloc(12)
      start.writeUInt32LE(tx, 0)
      start.writeBigUInt64LE(BigInt(dataOut.length), 4)
      cmd.write(packet(START_DATA, start))
      cmd.write(packet(END_DATA, Buffer.concat([u32(tx), dataOut])))
    }
    const parts: Buffer[] = []
    for (;;) {
      const p = await stream.next(60000)
      if (p.type === START_DATA) continue
      if (p.type === DATA || p.type === END_DATA) parts.push(p.body.subarray(4))
      else if (p.type === OP_RESP) {
        const code = p.body.readUInt16LE(0)
        const rp: number[] = []
        for (let o = 6; o + 4 <= p.body.length; o += 4) rp.push(p.body.readUInt32LE(o))
        if (code !== OK && !allow.includes(code)) throw new PtpError(op, code)
        return { code, params: rp, data: Buffer.concat(parts) }
      }
    }
  }

  openSession(): Promise<Response> {
    this.txId = 0
    return this.transaction(Op.OpenSession, [1])
  }

  async deviceInfo(): Promise<DeviceInfo> {
    return parseDeviceInfo((await this.transaction(Op.GetDeviceInfo)).data)
  }

  /** Waits for one camera event matching `code`. */
  waitEvent(code: number, timeoutMs: number): Promise<PtpEvent> {
    return new Promise((resolve, reject) => {
      const on = (e: PtpEvent): void => {
        if (e.code !== code) return
        clearTimeout(t)
        this.off('event', on)
        resolve(e)
      }
      const t = setTimeout(() => (this.off('event', on), reject(new Error(`no ${hex(code)} event within ${timeoutMs / 1000}s`))), timeoutMs)
      this.on('event', on)
    })
  }

  /** Drops both sockets without CloseSession (Nikon resets the link after pairing anyway). */
  destroy(): void {
    this.cmd?.destroy()
    this.evt?.destroy()
    this.cmd = this.evt = null
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.transaction(Op.CloseSession), new Promise((r) => setTimeout(r, 1500))])
    } catch {
      // camera may already be gone
    }
    this.destroy()
  }
}

// ---- datasets -------------------------------------------------------------

function readUtf16z(b: Buffer, off: number): string {
  let end = off
  while (end + 1 < b.length && (b[end] || b[end + 1])) end += 2
  return b.toString('utf16le', off, end)
}

/** Sequential reader for PTP datasets (little endian, length-prefixed UTF-16 strings and arrays). */
class Reader {
  b: Buffer
  o = 0
  constructor(b: Buffer) {
    this.b = b
  }
  u8(): number {
    return this.b.readUInt8(this.o++)
  }
  u16(): number {
    const v = this.b.readUInt16LE(this.o)
    this.o += 2
    return v
  }
  u32(): number {
    const v = this.b.readUInt32LE(this.o)
    this.o += 4
    return v
  }
  str(): string {
    const n = this.u8() // chars including the terminator
    const s = n ? this.b.toString('utf16le', this.o, this.o + (n - 1) * 2) : ''
    this.o += n * 2
    return s
  }
  u16s(): number[] {
    const n = this.u32()
    return Array.from({ length: n }, () => this.u16())
  }
}

export interface DeviceInfo {
  vendorExtensionId: number
  vendorExtensionDesc: string
  operations: number[]
  events: number[]
  properties: number[]
  manufacturer: string
  model: string
  version: string
  serial: string
}

export function parseDeviceInfo(b: Buffer): DeviceInfo {
  const r = new Reader(b)
  r.u16() // standard version
  const vendorExtensionId = r.u32()
  r.u16() // vendor extension version
  const vendorExtensionDesc = r.str()
  r.u16() // functional mode
  const operations = r.u16s()
  const events = r.u16s()
  const properties = r.u16s()
  r.u16s() // capture formats
  r.u16s() // image formats
  return { vendorExtensionId, vendorExtensionDesc, operations, events, properties, manufacturer: r.str(), model: r.str(), version: r.str(), serial: r.str() }
}

export interface ObjectInfo {
  storageId: number
  format: number
  size: number
  filename: string
  captureDate: string
}

export const FORMAT_ASSOCIATION = 0x3001 // folders

export function parseObjectInfo(b: Buffer): ObjectInfo {
  const r = new Reader(b)
  const storageId = r.u32()
  const format = r.u16()
  r.u16() // protection
  const size = r.u32()
  r.o += 2 + 4 * 7 + 2 + 4 + 4 // thumb format .. sequence number
  return { storageId, format, size, filename: r.str(), captureDate: r.str() }
}

// ---- Nikon ----------------------------------------------------------------

/**
 * One-time PIN pairing for newer Nikon Z bodies (protocol from libgphoto2 issue #1314, tested there on a ZR).
 * Call straight after openSession. `showCode` gets the digits the camera is also showing; the user confirms on the camera.
 * Afterwards the camera restarts Wi-Fi: destroy() this client and reconnect with the same GUID.
 */
export async function nikonPair(c: PtpIpClient, showCode: (code: string) => void, timeoutMs = 120000): Promise<void> {
  const { data } = await c.transaction(Op.NikonGetPairingCode)
  const n = data.readUInt32LE(0)
  showCode(Array.from(data.subarray(4, 4 + n), (d) => String(d)).join(''))
  const confirmed = c.waitEvent(Ev.DeviceInfoChanged, timeoutMs)
  await c.transaction(Op.NikonConfirmPairing, [0x2001])
  await confirmed
}

/** Polls DeviceReady until the camera stops answering Busy. */
export async function nikonWaitReady(c: PtpIpClient, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const { code } = await c.transaction(Op.NikonDeviceReady, [], undefined, [DEVICE_BUSY])
    if (code === OK) return
    if (Date.now() > until) throw new Error('camera stayed busy')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Pulls the JPEG out of a Nikon live-view frame: a model-specific header (sizes vary) precedes it. */
export function extractJpeg(frame: Buffer): Buffer | null {
  const start = frame.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
  if (start < 0) return null
  const end = frame.lastIndexOf(Buffer.from([0xff, 0xd9]))
  return frame.subarray(start, end > start ? end + 2 : frame.length)
}

/** Nikon GetEvent (0x90C7) data: u16 count, then count × (u16 code, u32 param). */
export function parseNikonEvents(b: Buffer): PtpEvent[] {
  if (b.length < 2) return []
  const n = b.readUInt16LE(0)
  const out: PtpEvent[] = []
  for (let i = 0, o = 2; i < n && o + 6 <= b.length; i++, o += 6) out.push({ code: b.readUInt16LE(o), params: [b.readUInt32LE(o + 2)] })
  return out
}
