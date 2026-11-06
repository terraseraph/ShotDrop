import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** A tool shipped in the packaged app's resources/bin (see scripts/fetch-binaries.mjs), or null in dev. */
export function bundledBin(name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  // Dev runs (npm run dev from the repo) use the copy fetched into resources/bin/win-x64.
  const dirs = [process.resourcesPath && join(process.resourcesPath, 'bin'), join(process.cwd(), 'resources', 'bin', 'win-x64')]
  return dirs.map((d) => d && join(d, exe)).find((p) => p && existsSync(p)) || null
}

/** A user-set path wins; the default bare name means "bundled copy if shipped, else PATH". */
export function toolPath(configured: string, name: string): string {
  const c = configured.trim()
  return c && c !== name ? c : (bundledBin(name) ?? name)
}
