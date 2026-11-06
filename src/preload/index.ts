import { contextBridge, ipcRenderer } from 'electron'

const apiArg = process.argv.find((a) => a.startsWith('--shotdrop-api='))

contextBridge.exposeInMainWorld('shotdrop', {
  apiBase: apiArg ? apiArg.split('=')[1] : 'http://127.0.0.1:8787',
  desktop: true,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('reveal', path),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('open-path', path),
  editors: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke('editors'),
  shotAction: (id: number, action: 'reveal' | 'open' | 'openWith' | 'copyImage', arg?: string): Promise<string | null> =>
    ipcRenderer.invoke('shot-action', id, action, arg),
  dragShot: (id: number): void => ipcRenderer.send('drag-shot', id)
})
