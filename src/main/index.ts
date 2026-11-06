import { app, BrowserWindow, shell, Menu, dialog, ipcMain, clipboard, ClipboardItem, nativeImage } from 'electron'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { Core } from './core'
import { startApi } from './api/server'
import { BlinkDetector } from './blink/detector'
import { findEditors } from './editors'
import { primaryFile, resolveImage } from './core/sources'

let core: Core | null = null
let api: { stop: () => Promise<void> } | null = null
let win: BrowserWindow | null = null
let blink: BlinkDetector | null = null

function createWindow(apiBase: string): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0c0e',
    title: 'ShotDrop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--shotdrop-api=${apiBase}`],
      sandbox: false
    }
  })
  // The hidden face-scan window is a window too: without this, window-all-closed never fires and the app lingers.
  win.on('closed', () => blink?.close())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Native helpers the browser can't do (folder picker, reveal in Explorer). Remote browsers simply don't get these.
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('reveal', (_e, path: string) => shell.showItemInFolder(path))
ipcMain.handle('open-path', (_e, path: string) => shell.openPath(path))

// Shot-level desktop actions. The renderer only knows shot ids; paths stay in the main process.
ipcMain.handle('editors', () => findEditors().map(({ id, name }) => ({ id, name })))

ipcMain.handle('shot-action', async (_e, id: number, action: 'reveal' | 'open' | 'openWith' | 'copyImage', arg?: string) => {
  const file = core && primaryFile(core, id)
  if (!core || !file) throw new Error('Shot not found')
  if (action === 'reveal') shell.showItemInFolder(file.path)
  else if (action === 'open') return (await shell.openPath(file.path)) || null
  else if (action === 'openWith') {
    const editor = findEditors().find((x) => x.id === arg)
    // No known editor: Windows' own "Open with" chooser.
    const [cmd, args] = editor ? [editor.exe, [file.path]] : ['rundll32.exe', ['shell32.dll,OpenAs_RunDLL', file.path]]
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } else {
    const key = arg === 'jpeg' || arg === 'embedded' || arg === 'raw' ? arg : null
    const full = key ? await resolveImage(core, id, key, false) : null
    const img = nativeImage.createFromPath(full?.path ?? core.previews.previewPath(id))
    if (img.isEmpty()) throw new Error('No image to copy yet')
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
  }
  return null
})

// Drag a thumbnail into Explorer, mail, Lightroom… The camera JPEG if there is one, else the 2560px preview under the shot's name.
ipcMain.on('drag-shot', (e, id: number) => {
  if (!core) return
  const shot = core.lib.get(id)
  const jpeg = core.lib.files(id).find((f) => f.kind === 'jpeg')
  let file = jpeg?.path
  if (!file && shot) {
    const dir = join(core.previews.previewDir, '..', 'drag')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `${shot.name}.jpg`)
    copyFileSync(core.previews.previewPath(id), file)
  }
  if (file) e.sender.startDrag({ file, icon: nativeImage.createFromPath(core.previews.thumbPath(id)).resize({ width: 96 }) })
})

// Portable mode: a `data` folder beside the exe holds settings, DB, cache and the library instead of %APPDATA%/Pictures.
// The portable .exe unpacks to %TEMP%, so look beside the launched file, not the unpacked one.
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(process.execPath)
const portableDir = app.isPackaged && existsSync(join(exeDir, 'data')) ? join(exeDir, 'data') : null
// Dev runs use a throwaway folder in the repo so test shots never touch the real library.
const devHome = process.env.ELECTRON_RENDERER_URL ? join(app.getAppPath(), '.dev-data') : null
// Must precede the single-instance lock; in dev it also keeps each checkout's instance independent of others.
if (devHome) app.setPath('userData', join(devHome, 'electron'))
else if (portableDir) app.setPath('userData', join(portableDir, 'app'))

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const dataDir = devHome ? join(devHome, 'app') : app.getPath('userData')
  blink = new BlinkDetector(join(dataDir, 'blink'))
  core = new Core({
    dataDir,
    picturesDir: devHome ?? portableDir ?? app.getPath('pictures'),
    version: app.getVersion(),
    trash: (p) => shell.trashItem(p),
    detectFaces: (p) => blink!.detect(p)
  })
  await core.start()
  api = await startApi(core, { rendererDir: join(__dirname, '../renderer') })
  createWindow(`http://127.0.0.1:${core.settings.api.port}`)
  if (core.settings.tunnel.autoStart) void core.startTunnel().catch((e) => console.error('[tunnel]', e))
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !core) return
  e.preventDefault()
  quitting = true
  void (async () => {
    await api?.stop().catch(() => undefined)
    await core?.stop().catch(() => undefined)
    app.quit()
  })()
})

app.on('window-all-closed', () => app.quit())
