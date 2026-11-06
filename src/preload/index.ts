import { contextBridge, ipcRenderer } from 'electron'

const apiArg = process.argv.find((a) => a.startsWith('--shotdrop-api='))

contextBridge.exposeInMainWorld('shotdrop', {
  apiBase: apiArg ? apiArg.split('=')[1] : 'http://127.0.0.1:8787',
  desktop: true,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('reveal', path),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('open-path', path)
})
