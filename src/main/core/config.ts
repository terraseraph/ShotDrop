import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Settings } from '@shared/types'

const randomPassword = (): string => randomBytes(4).toString('hex')

export function defaultSettings(picturesDir: string): Settings {
  return {
    libraryDir: join(picturesDir, 'ShotDrop'),
    ftp: {
      enabled: true,
      port: 2121,
      pasvMin: 50000,
      pasvMax: 50100,
      preferredAddress: null,
      users: [{ username: 'camera', password: randomPassword(), label: 'Camera 1' }]
    },
    api: { port: 8787 },
    remote: { enabled: true, pin: String(Math.floor(100000 + Math.random() * 900000)) },
    watchFolders: [],
    destinations: [],
    rclonePath: 'rclone',
    xmpSidecars: true,
    tunnel: { autoStart: false, cloudflaredPath: 'cloudflared' },
    ptp: { enabled: false, host: '', guid: randomBytes(16).toString('hex') }
  }
}

/** Settings persisted as JSON in the app data dir. Deep-merges with defaults so new keys appear on upgrade. */
export class ConfigStore {
  private file: string
  private value: Settings

  constructor(dataDir: string, picturesDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'settings.json')
    const defaults = defaultSettings(picturesDir)
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      this.value = {
        ...defaults,
        ...saved,
        ftp: { ...defaults.ftp, ...saved.ftp },
        api: { ...defaults.api, ...saved.api },
        remote: { ...defaults.remote, ...saved.remote },
        tunnel: { ...defaults.tunnel, ...saved.tunnel },
        ptp: { ...defaults.ptp, ...saved.ptp }
      }
    } else {
      this.value = defaults
    }
    this.save()
  }

  get(): Settings {
    return structuredClone(this.value)
  }

  update(patch: Partial<Settings>): Settings {
    this.value = {
      ...this.value,
      ...patch,
      ftp: { ...this.value.ftp, ...patch.ftp },
      api: { ...this.value.api, ...patch.api },
      remote: { ...this.value.remote, ...patch.remote },
      tunnel: { ...this.value.tunnel, ...patch.tunnel },
      ptp: { ...this.value.ptp, ...patch.ptp }
    }
    this.save()
    return this.get()
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.value, null, 2))
  }
}
