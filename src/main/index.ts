import { app, BrowserWindow, shell, Menu, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Core } from './core'
import { startApi } from './api/server'

let core: Core | null = null
let api: { stop: () => Promise<void> } | null = null
let win: BrowserWindow | null = null

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

// Portable mode: a `data` folder beside the exe holds settings, DB, cache and the library instead of %APPDATA%/Pictures.
// The portable .exe unpacks to %TEMP%, so look beside the launched file, not the unpacked one.
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(process.execPath)
const portableDir = app.isPackaged && existsSync(join(exeDir, 'data')) ? join(exeDir, 'data') : null
if (portableDir) app.setPath('userData', join(portableDir, 'app')) // must precede the single-instance lock

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  // Dev runs use a throwaway folder in the repo so test shots never touch the real library.
  const devHome = process.env.ELECTRON_RENDERER_URL ? join(app.getAppPath(), '.dev-data') : null
  core = new Core({
    dataDir: devHome ? join(devHome, 'app') : app.getPath('userData'),
    picturesDir: devHome ?? portableDir ?? app.getPath('pictures'),
    version: app.getVersion(),
    trash: (p) => shell.trashItem(p)
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
