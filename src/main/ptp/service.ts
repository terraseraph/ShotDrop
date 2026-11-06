import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import type { PtpSettings, PtpState } from '@shared/types'
import {
  Ev,
  FORMAT_ASSOCIATION,
  InitFailError,
  Op,
  PtpError,
  PtpIpClient,
  DEVICE_BUSY,
  extractJpeg,
  nikonPair,
  nikonWaitReady,
  parseNikonEvents,
  parseObjectInfo,
  type DeviceInfo
} from './ptpip'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const RETRY_MS = 3000
const FRAME_MS = 33 // the camera repeats frames if polled faster than ~30 fps

/**
 * A Wi-Fi camera connected over PTP/IP (Nikon for now). Keeps reconnecting while enabled, pairs when the camera asks,
 * downloads every new shot into `<incoming>/<camera>/` for the normal ingest, and runs live view only while someone watches.
 */
export class PtpService {
  state: PtpState = { status: 'off', camera: null, pairingCode: null, error: null }
  private gen = 0 // bumped on every start/stop; a loop from an older generation exits
  private client: PtpIpClient | null = null
  private viewers = new Set<(jpeg: Buffer) => void>()

  constructor(
    private getIncomingDir: () => string,
    private onChange: () => void
  ) {}

  private set(patch: Partial<PtpState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange()
  }

  start(s: PtpSettings): void {
    this.stop()
    if (!s.enabled || !s.host.trim()) return
    void this.loop(++this.gen, s)
  }

  stop(): void {
    this.gen++
    this.client?.destroy()
    this.client = null
    if (this.state.status !== 'off') this.set({ status: 'off', camera: null, pairingCode: null, error: null })
  }

  /** Receive live-view JPEGs. Live view runs while at least one subscriber is attached. */
  subscribe(fn: (jpeg: Buffer) => void): () => void {
    this.viewers.add(fn)
    return () => this.viewers.delete(fn)
  }

  private async loop(gen: number, s: PtpSettings): Promise<void> {
    while (gen === this.gen) {
      try {
        await this.session(gen, s)
      } catch (e) {
        if (gen !== this.gen) return
        const reason =
          e instanceof InitFailError && e.reason === 1
            ? "The camera's network profile is paired to another computer. Pick or create another profile on the camera."
            : (e as Error).message
        this.set({ status: 'error', error: reason, pairingCode: null })
      } finally {
        this.client?.destroy()
        this.client = null
      }
      await sleep(RETRY_MS)
    }
  }

  private async open(s: PtpSettings): Promise<PtpIpClient> {
    const c = new PtpIpClient({ host: s.host.trim(), guid: s.guid, name: `ShotDrop-${hostname()}`.slice(0, 30) })
    this.client = c
    await c.connect()
    await c.openSession()
    return c
  }

  private async session(gen: number, s: PtpSettings): Promise<void> {
    if (this.state.status !== 'error') this.set({ status: 'connecting', error: null })
    let c = await this.open(s)
    const info = await c.deviceInfo()

    // An unpaired Nikon Z offers only a handful of ops, pairing among them, and drops off Wi-Fi if asked for live view.
    if (!info.operations.includes(Op.NikonGetLiveViewImg) && info.operations.includes(Op.NikonGetPairingCode)) {
      c.destroy()
      c = await this.open(s) // the pairing op must be the first one after OpenSession
      try {
        await nikonPair(c, (code) => this.set({ status: 'pairing', pairingCode: code, error: null }))
      } catch (e) {
        // ZR-style bodies list the pairing op even when already paired; carry on as connected if it's refused.
        if (!(e instanceof PtpError)) throw e
      }
      this.set({ status: 'connecting', pairingCode: null })
      return // the camera restarts Wi-Fi after pairing; the loop reconnects with the same GUID
    }

    const camera = `${info.model}`.trim() || 'Camera'
    this.set({ status: 'connected', camera, error: null, pairingCode: null })
    let alive = true
    c.once('close', () => (alive = false))
    const stopDownloads = this.downloads(c, info, join(this.getIncomingDir(), folderName(info)))
    try {
      await this.liveLoop(gen, c, () => alive)
    } finally {
      stopDownloads()
    }
    if (gen === this.gen) throw new Error('Camera disconnected')
  }

  private async liveLoop(gen: number, c: PtpIpClient, alive: () => boolean): Promise<void> {
    let on = false
    let last = 0
    while (gen === this.gen && alive()) {
      if (!this.viewers.size) {
        if (on) await c.transaction(Op.NikonEndLiveView).catch(() => {})
        on = false
        await sleep(200)
        continue
      }
      if (!on) {
        await c.transaction(Op.NikonStartLiveView)
        await nikonWaitReady(c)
        on = true
      }
      const wait = FRAME_MS - (Date.now() - last)
      if (wait > 0) await sleep(wait)
      last = Date.now()
      let data: Buffer
      try {
        data = (await c.transaction(Op.NikonGetLiveViewImg)).data
      } catch (e) {
        if (!(e instanceof PtpError)) throw e
        // Busy while a shot is taken; anything else (e.g. left live view on the camera) restarts it.
        if (e.code !== DEVICE_BUSY) on = false
        await sleep(100)
        continue
      }
      const jpeg = extractJpeg(data)
      if (jpeg) for (const v of this.viewers) v(jpeg)
    }
    if (on && alive()) await c.transaction(Op.NikonEndLiveView).catch(() => {})
  }

  /** Downloads every new object the camera reports: event channel plus Nikon's GetEvent polling. */
  private downloads(c: PtpIpClient, info: DeviceInfo, dir: string): () => void {
    const seen = new Set<number>()
    const fetch = async (handle: number): Promise<void> => {
      if (seen.has(handle)) return
      seen.add(handle)
      const oi = parseObjectInfo((await c.transaction(Op.GetObjectInfo, [handle])).data)
      if (oi.format === FORMAT_ASSOCIATION) return
      // ponytail: GetObject holds the whole file in memory (fine for stills); use GetPartialObject chunks for video.
      const { data } = await c.transaction(Op.GetObject, [handle])
      mkdirSync(dir, { recursive: true }) // ingest removes the folder once it empties
      const dest = join(dir, oi.filename || `ptp-${handle.toString(16)}.jpg`)
      writeFileSync(dest + '.part', data)
      renameSync(dest + '.part', dest) // ingest ignores .part, so it only ever sees whole files
    }
    const onEvent = (code: number, params: number[]): void => {
      if (code !== Ev.ObjectAdded && code !== Ev.NikonObjectAddedInSdram) return
      fetch(params[0]).catch((e) => {
        seen.delete(params[0])
        this.set({ error: `Download failed: ${(e as Error).message}` })
      })
    }
    const listener = (e: { code: number; params: number[] }): void => onEvent(e.code, e.params)
    c.on('event', listener)
    const poll = info.operations.includes(Op.NikonGetEvent)
      ? setInterval(() => {
          c.transaction(Op.NikonGetEvent)
            .then(({ data }) => parseNikonEvents(data).forEach((e) => onEvent(e.code, e.params)))
            .catch(() => {})
        }, 500)
      : null
    return () => {
      c.off('event', listener)
      if (poll) clearInterval(poll)
    }
  }
}

/** Folder under .incoming; ingest uses it as the shot's source. Model plus serial tail keeps two same-model bodies apart. */
function folderName(info: DeviceInfo): string {
  const safe = (s: string): string => s.replace(/[^\w.-]+/g, '_')
  return `${safe(info.model || 'camera')}-${safe(info.serial.slice(-4) || 'ptp')}`
}
