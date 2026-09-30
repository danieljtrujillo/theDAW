import path from 'node:path'

/**
 * Item 4 (T17 audit): the desktop app's auto-download toggle
 * (generateStore.autoDownload) opened one native Save dialog per take,
 * because watchDownloads (index.ts) never called `item.setSavePath()` — see
 * https://www.electronjs.org/docs/latest/api/download-item#downloaditemsetsavepathpath :
 * "If user doesn't set the save path via the API, Electron will use the
 * original routine to determine the save path; this usually prompts a save
 * dialog." These two pure helpers (no `electron` import, so they run under
 * plain Node/tsx — index.ts itself cannot, since `electron` and
 * `electron-updater` aren't resolvable outside an Electron process) are what
 * `will-download` in index.ts uses once it decides a download IS automatic.
 */

/**
 * Picks a save path for `filename` inside `dir` that does not collide with an
 * existing file: `name.ext`, then `name (1).ext`, `name (2).ext`, ... `exists`
 * is injected (real check: `fs.existsSync`) so this stays pure and testable
 * without touching the disk. Tries a bounded number of numbered variants
 * rather than looping forever against a pathological "everything exists"
 * answer (which would hang the `will-download` handler); if EVERY one of
 * those is also taken, falls back to a timestamp suffix rather than handing
 * back the last numbered candidate as-is — that candidate can still exist at
 * that point, and setSavePath would silently overwrite it.
 */
export function uniqueDownloadPath(
  dir: string,
  filename: string,
  exists: (candidatePath: string) => boolean,
  now: () => number = Date.now,
): string {
  const ext = path.extname(filename)
  const base = filename.slice(0, filename.length - ext.length)
  const MAX_ATTEMPTS = 1000
  let candidate = path.join(dir, filename)
  for (let n = 1; exists(candidate) && n <= MAX_ATTEMPTS; n += 1) {
    candidate = path.join(dir, `${base} (${n})${ext}`)
  }
  if (exists(candidate)) {
    candidate = path.join(dir, `${base}.${now()}${ext}`)
  }
  return candidate
}

/**
 * Which downloads are automatic, keyed by the EXACT filename the renderer is
 * about to click — not just a count. A count-only claim mis-fires: a click
 * that produces no download, a page reload mid-batch, or one blocked
 * download all leave the count positive with nothing left to consume it, so
 * the NEXT unrelated user download (hours later) got silently auto-saved.
 * Matching on filename means an unrelated download's name simply doesn't
 * match and keeps the dialog; each mark also expires after `ttlMs` so a
 * claim nothing ever consumes cannot outlive its own batch (click ->
 * will-download is normally well under a second).
 */
export class AutoDownloadClaims {
  private readonly claims = new Map<string, number>() // filename -> expiresAt (ms)

  constructor(
    private readonly ttlMs: number = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Marks each of `names` as an about-to-happen automatic download, expiring
   *  in `ttlMs`. Also sweeps expired entries first, so a steady trickle of
   *  small batches (one CREATE after another) never accumulates stale marks
   *  no one ever claimed — the map's size is bounded by "marks younger than
   *  ttlMs", not by how many batches have ever run. */
  mark(names: readonly string[]): void {
    this.sweep()
    const expiresAt = this.now() + this.ttlMs
    for (const name of names) {
      if (typeof name === 'string' && name) this.claims.set(name, expiresAt)
    }
  }

  /** True (and consumes the claim) when `filename` was marked and has not
   *  expired; false — keep the native Save dialog — otherwise, including for
   *  an expired mark nothing claimed in time. */
  claim(filename: string): boolean {
    this.sweep()
    const expiresAt = this.claims.get(filename)
    if (expiresAt === undefined) return false
    this.claims.delete(filename)
    return true
  }

  private sweep(): void {
    const t = this.now()
    for (const [name, expiresAt] of this.claims) {
      if (expiresAt <= t) this.claims.delete(name)
    }
  }

  get size(): number {
    this.sweep()
    return this.claims.size
  }
}
