import { BrowserWindow, app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

export interface FaceResult {
  faces: number
  /** Worst eye-closure (0 open .. 1 shut) among all faces in the frame; null when there are no faces. */
  blink: number | null
}

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

/**
 * Finds faces and eye blinks with MediaPipe Face Landmarker. MediaPipe needs a browser runtime (DOM + WASM),
 * so it lives in one hidden window; Node only sends it JPEG bytes and reads back two numbers.
 * The ~4 MB model is downloaded once into the data dir.
 */
export class BlinkDetector {
  private win: Promise<BrowserWindow> | null = null
  private broken = false

  constructor(private dir: string) {}

  async detect(imagePath: string): Promise<FaceResult | null> {
    if (this.broken) return null
    let win: BrowserWindow
    try {
      win = await (this.win ??= this.open())
    } catch (e) {
      // Offline, blocked download, or WASM failure: stop trying until the app restarts, shots stay unscanned.
      console.error('[blink] disabled:', e)
      this.broken = true
      return null
    }
    try {
      // Faces are small in a 480px thumbnail; 1280px is the sweet spot for accuracy vs WASM CPU time.
      const jpeg = await sharp(imagePath).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
      return (await win.webContents.executeJavaScript(`window.detect(${JSON.stringify(jpeg.toString('base64'))})`)) as FaceResult
    } catch (e) {
      // One bad image (missing preview, corrupt file) must not switch scanning off for everything else.
      console.error('[blink] skipped', imagePath, e)
      return null
    }
  }

  close(): void {
    void this.win?.then((w) => w.destroy()).catch(() => undefined)
    this.win = null
  }

  private async open(): Promise<BrowserWindow> {
    mkdirSync(this.dir, { recursive: true })
    const modelPath = join(this.dir, 'face_landmarker.task')
    if (!existsSync(modelPath)) {
      const res = await fetch(MODEL_URL)
      if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length < 1_000_000) throw new Error('model download looks truncated')
      await writeFile(modelPath + '.part', bytes)
      await rename(modelPath + '.part', modelPath)
    }

    // Unpacked copy when packaged: WASM can't be read from inside the asar archive reliably.
    const vision = pathToFileURL(join(app.getAppPath(), 'node_modules/@mediapipe/tasks-vision').replace('app.asar', 'app.asar.unpacked')).href
    const pagePath = join(this.dir, 'blink.html')
    await writeFile(
      pagePath,
      `<!doctype html><meta charset="utf-8"><script type="module">
try {
  const { FaceLandmarker, FilesetResolver } = await import(${JSON.stringify(vision + '/vision_bundle.mjs')})
  const files = await FilesetResolver.forVisionTasks(${JSON.stringify(vision + '/wasm')})
  const lm = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: ${JSON.stringify(pathToFileURL(modelPath).href)}, delegate: 'CPU' },
    runningMode: 'IMAGE', numFaces: 10, outputFaceBlendshapes: true
  })
  window.detect = async (b64) => {
    const img = new Image()
    img.src = 'data:image/jpeg;base64,' + b64
    await img.decode()
    const r = lm.detect(img)
    let blink = null
    for (const shapes of r.faceBlendshapes) {
      const v = (n) => shapes.categories.find((c) => c.categoryName === n)?.score ?? 0
      const b = (v('eyeBlinkLeft') + v('eyeBlinkRight')) / 2
      if (blink === null || b > blink) blink = b
    }
    return { faces: r.faceLandmarks.length, blink: blink === null ? null : Math.round(blink * 100) / 100 }
  }
  window.ready = true
} catch (e) { window.failed = String(e) }
</script>`
    )

    // webSecurity off only so this one local page may import local modules/WASM; it loads nothing remote and never navigates.
    const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false, backgroundThrottling: false, sandbox: true } })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    await win.loadFile(pagePath)
    for (let i = 0; i < 120; i++) {
      const state = (await win.webContents.executeJavaScript('window.ready ? "ok" : (window.failed || "")')) as string
      if (state === 'ok') return win
      if (state) throw new Error(state)
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('face model took over 60s to load')
  }
}
