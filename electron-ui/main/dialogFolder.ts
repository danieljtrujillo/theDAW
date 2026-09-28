// The folder a native open/save dialog starts in.
//
// From Electron 43 a dialog given no defaultPath opens in the user's Downloads
// folder, and the OS no longer restores the folder the user last browsed to.
// The main process therefore remembers the last folder itself and hands it to
// every dialog whose caller named no folder. The folder is kept in a small JSON
// file under userData so it survives a restart, as the OS-remembered folder did.

import * as fs from 'fs'
import * as path from 'path'

export type DialogKind = 'openFile' | 'openDirectory' | 'save'

/** The defaultPath to hand the dialog. A caller's absolute path wins; a bare
 *  file name (a save dialog's suggested name) is placed in the last folder; no
 *  path at all starts in the last folder. With no remembered folder the
 *  caller's value passes through unchanged. */
export function dialogDefaultPath(given: string | undefined, lastDir: string | undefined): string | undefined {
  if (!lastDir) return given
  if (!given) return lastDir
  if (path.isAbsolute(given)) return given
  return path.join(lastDir, given)
}

/** The folder to remember after a dialog closed, or undefined when it was
 *  cancelled or returned nothing. */
export function folderAfterDialog(
  kind: DialogKind,
  result: { canceled: boolean; filePaths?: string[]; filePath?: string },
): string | undefined {
  if (result.canceled) return undefined
  if (kind === 'save') return result.filePath ? path.dirname(result.filePath) : undefined
  const first = result.filePaths?.[0]
  if (!first) return undefined
  return kind === 'openDirectory' ? first : path.dirname(first)
}

/** Reads and writes the remembered folder in `file`. A missing or unreadable
 *  file reads as no folder; a failed write keeps the folder for this session. */
export class DialogFolderMemory {
  private folder: string | undefined
  private loaded = false

  constructor(private readonly file: string) {}

  get(): string | undefined {
    if (!this.loaded) {
      this.loaded = true
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { folder?: unknown }
        if (typeof data.folder === 'string' && data.folder) this.folder = data.folder
      } catch {
        this.folder = undefined
      }
    }
    return this.folder
  }

  set(folder: string | undefined): void {
    if (!folder) return
    this.loaded = true
    this.folder = folder
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ folder }))
    } catch (err) {
      console.warn(`[dialog] could not save the last dialog folder: ${String(err)}`)
    }
  }
}
