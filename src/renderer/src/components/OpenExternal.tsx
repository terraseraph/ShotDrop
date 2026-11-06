import type { Shot, ShotFile } from '@shared/types'
import { api, desktop } from '../api'

/** On the ShotDrop computer: open the file in the user's own player. In a remote browser: download it. */
export function OpenExternal({ shot, file }: { shot: Shot; file: ShotFile }) {
  if (desktop) {
    return (
      <button
        className="btn"
        onClick={() =>
          void api
            .filePath(file.id)
            .then((r) => desktop!.openPath(r.path))
            .catch(() => undefined)
        }
      >
        Open in default app
      </button>
    )
  }
  return (
    <a className="btn" href={api.downloadUrl(shot, file.id)} download={file.name}>
      Download
    </a>
  )
}
