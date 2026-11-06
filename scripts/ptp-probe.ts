// PTP/IP probe for a camera on Wi-Fi. Exploratory: run with
//   node --experimental-strip-types scripts/ptp-probe.ts <command> [--host 192.168.1.1] [--out DIR] [--port 8090]
// Commands:
//   info   connect, print DeviceInfo (model, vendor ops, whether live view / pairing ops are listed)
//   pair   Nikon Z one-time PIN pairing (compare the code with the camera, confirm on the camera)
//   live   live view as MJPEG at http://127.0.0.1:<port>/ ; with --out also downloads every new shot into DIR
//   watch  only download new shots into DIR (point DIR at <library>/.incoming/<name> to feed ShotDrop's ingest)
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  Ev,
  FORMAT_ASSOCIATION,
  InitFailError,
  Op,
  PtpError,
  PtpIpClient,
  extractJpeg,
  hex,
  newGuid,
  nikonPair,
  nikonWaitReady,
  parseNikonEvents,
  parseObjectInfo,
  type DeviceInfo,
} from '../src/main/ptp/ptpip.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'info'
const flag = (name: string, def?: string): string | undefined => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : def
}
const host = flag('host', '192.168.1.1')! // Nikon "direct connection" (camera as access point) default
const outDir = flag('out')
const httpPort = Number(flag('port', '8090'))

// The GUID must survive restarts: a paired Nikon only accepts the computer it paired with.
const dataDir = resolve('.dev-data')
const guidFile = join(dataDir, 'ptp-guid')
mkdirSync(dataDir, { recursive: true })
if (!existsSync(guidFile)) writeFileSync(guidFile, newGuid())
const guid = readFileSync(guidFile, 'utf8').trim()
const name = `ShotDrop-${hostname()}`.slice(0, 30)

async function connect(): Promise<{ c: PtpIpClient; info: DeviceInfo }> {
  const c = await session()
  const info = await c.deviceInfo()
  console.log(`connected: ${info.manufacturer} ${info.model} fw ${info.version} (camera calls itself "${c.cameraName}")`)
  return { c, info }
}

async function session(): Promise<PtpIpClient> {
  const c = new PtpIpClient({ host, guid, name })
  await c.connect()
  await c.openSession()
  return c
}

const has = (info: DeviceInfo, op: number): boolean => info.operations.includes(op)

async function cmdInfo(): Promise<void> {
  const { c, info } = await connect()
  console.log(`vendor ext ${hex(info.vendorExtensionId)} "${info.vendorExtensionDesc}"`)
  console.log(`ops (${info.operations.length}): ${info.operations.map(hex).join(' ')}`)
  console.log(`events: ${info.events.map(hex).join(' ')}`)
  console.log(`props: ${info.properties.length}`)
  console.log(`live view ops listed: ${has(info, Op.NikonStartLiveView) && has(info, Op.NikonGetLiveViewImg)}`)
  console.log(`pairing op listed (0x952B): ${has(info, Op.NikonGetPairingCode)}`)
  // No live-view probe here: an unpaired Z50II drops off Wi-Fi entirely when asked for it. Use "live" once paired.
  await c.close()
}

async function cmdPair(): Promise<void> {
  const c = await session() // Nikon wants 0x952B straight after OpenSession, before any other op
  console.log('requesting pairing code…')
  await nikonPair(c, (code) => console.log(`\n  PAIRING CODE: ${code}\n  Check the camera shows the same code, then confirm on the camera.\n`))
  console.log('camera confirmed. It will restart Wi-Fi now; reconnecting…')
  c.destroy()
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const again = await connect()
      console.log('paired and reconnected with the same GUID.')
      await again.c.close()
      return
    } catch (e) {
      console.log(`  not back yet (${(e as Error).message})`)
    }
  }
  throw new Error('camera did not come back after pairing; rejoin its Wi-Fi and run "info"')
}

/** Downloads every new object the camera reports. Uses both the event channel and Nikon's GetEvent polling. */
function startDownloads(c: PtpIpClient, info: DeviceInfo, dir: string): () => void {
  mkdirSync(dir, { recursive: true })
  const seen = new Set<number>()
  const fetchObject = async (handle: number): Promise<void> => {
    if (seen.has(handle)) return
    seen.add(handle)
    const oi = parseObjectInfo((await c.transaction(Op.GetObjectInfo, [handle])).data)
    if (oi.format === FORMAT_ASSOCIATION) return
    const t0 = Date.now()
    // ponytail: GetObject holds the whole file in memory; switch to GetPartialObject chunks for big RAW/video.
    const { data } = await c.transaction(Op.GetObject, [handle])
    const dest = join(dir, oi.filename || `ptp-${handle.toString(16)}.jpg`)
    writeFileSync(dest + '.part', data)
    renameSync(dest + '.part', dest) // the ingest watcher never sees a half-written file
    const secs = (Date.now() - t0) / 1000
    console.log(`saved ${dest} (${(data.length / 1e6).toFixed(1)} MB in ${secs.toFixed(1)}s, ${(data.length / 1e6 / secs).toFixed(1)} MB/s)`)
  }
  const onEvent = (code: number, params: number[]): void => {
    if (code === Ev.ObjectAdded || code === Ev.NikonObjectAddedInSdram) {
      fetchObject(params[0]).catch((e) => console.log(`download ${hex(params[0])} failed: ${(e as Error).message}`))
    }
  }
  c.on('event', (e) => onEvent(e.code, e.params))
  const poll = has(info, Op.NikonGetEvent)
    ? setInterval(() => {
        c.transaction(Op.NikonGetEvent)
          .then(({ data }) => parseNikonEvents(data).forEach((e) => onEvent(e.code, e.params)))
          .catch(() => {})
      }, 500)
    : null
  console.log(`downloading new shots to ${dir}${poll ? ' (polling Nikon GetEvent)' : ''}`)
  return () => poll && clearInterval(poll)
}

async function cmdLive(): Promise<void> {
  const { c, info } = await connect()
  if (outDir) startDownloads(c, info, outDir)
  const viewers = new Set<ServerResponse>()
  createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' })
      viewers.add(res)
      req.on('close', () => viewers.delete(res))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<body style="margin:0;background:#111"><img src="/stream" style="width:100vw;height:100vh;object-fit:contain">')
    }
  }).listen(httpPort, '127.0.0.1')
  console.log(`live view: http://127.0.0.1:${httpPort}/`)

  await c.transaction(Op.NikonStartLiveView)
  await nikonWaitReady(c)
  let frames = 0
  let bytes = 0
  let t = Date.now()
  let stopping = false
  process.on('SIGINT', () => (stopping = true))
  let last = 0
  while (!stopping) {
    // The camera answers ~95 req/s with repeats of the same frame; ~30 fps is all it renders and spares the link.
    const wait = 33 - (Date.now() - last)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    last = Date.now()
    let frame
    try {
      frame = await c.transaction(Op.NikonGetLiveViewImg)
    } catch (e) {
      // Busy while a shot is being taken/written; anything else (e.g. 0xA00B not in live view) we restart.
      if (e instanceof PtpError) {
        await new Promise((r) => setTimeout(r, 100))
        if (e.code !== 0x2019) await c.transaction(Op.NikonStartLiveView).catch(() => {})
        continue
      }
      throw e
    }
    const jpg = extractJpeg(frame.data)
    if (!jpg) continue
    for (const v of viewers) v.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`), v.write(jpg), v.write('\r\n')
    frames++
    bytes += jpg.length
    if (Date.now() - t >= 2000) {
      console.log(`live view ${(frames / ((Date.now() - t) / 1000)).toFixed(1)} fps, ${(bytes / frames / 1024).toFixed(0)} KB/frame`)
      frames = bytes = 0
      t = Date.now()
    }
  }
  await c.transaction(Op.NikonEndLiveView).catch(() => {})
  await c.close()
  process.exit(0)
}

async function cmdWatch(): Promise<void> {
  if (!outDir) throw new Error('watch needs --out DIR')
  const { c, info } = await connect()
  startDownloads(c, info, outDir)
  await new Promise((r) => c.once('close', r))
  console.log('camera disconnected')
}

const commands: Record<string, () => Promise<void>> = { info: cmdInfo, pair: cmdPair, live: cmdLive, watch: cmdWatch }
const run = commands[cmd]
if (!run) {
  console.log(`unknown command "${cmd}"; use info | pair | live | watch`)
  process.exit(1)
}
run().catch((e) => {
  if (e instanceof InitFailError && e.reason === 1) {
    console.error(`${e.message}\nOn the camera, switch to a network profile with no paired computer (or create one), then run "pair".`)
  } else console.error(`error: ${(e as Error).message}`)
  process.exit(1)
})
