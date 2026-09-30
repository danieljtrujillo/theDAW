/**
 * D18 — the disk destination Mixdown remembers between runs.
 *
 * `commitEdit` used to force a brand-new Save As every single time (a fresh
 * `mixdown_<timestamp>.wav` name with no destination remembered), so "Commit
 * Edit" twice in a row meant navigating the Save dialog twice even when the
 * user plainly wanted the same file both times. The backend will only ever
 * write to a path the user granted through that native dialog (see
 * `backend/modules/places/router.py` — one-time grant, no route around it,
 * and rightly so: the server binds 0.0.0.0), so the dialog itself can never
 * be skipped, and it still asks to confirm overwriting an existing file. What
 * CAN be skipped is forcing the user to re-pick the folder and re-type a
 * brand-new name: when a target is already known, the dialog is defaulted
 * onto it, so confirming it re-writes the same file instead of navigating to
 * a folder and typing a fresh name from scratch.
 *
 * Pure and DOM-free, like `clipDoubleClick.ts`: no store, no `saveFile`, no
 * browser. `WaveformEditor` holds the one `MixdownSaveTarget | null` (module
 * state, session-only — same lifetime as every other in-memory job/runner
 * state in that file) and calls these to decide what to hand `saveFile`, and
 * whether a job's completed save should be the one that updates it.
 */

export interface MixdownSaveTarget {
  /** Absolute folder the last mixdown was written to. */
  readonly dir: string;
  /** File name (with extension) the last mixdown was written to. */
  readonly name: string;
}

export interface MixdownSaveOptions {
  readonly suggestedName: string;
  readonly initialDir?: string;
}

/** `dir`/`name` from a save's resulting absolute path, given the two path
 *  helpers `placesClient.ts` already exports (`dirnameOf`, `basenameOf`), so
 *  this stays pure and does not re-implement path splitting. `null` when
 *  either half is empty (a bare file name with no folder, or vice versa) —
 *  there is nothing worth remembering. */
export function mixdownSaveTargetFromPath(
  path: string | null,
  dirnameOf: (p: string) => string,
  basenameOf: (p: string) => string,
): MixdownSaveTarget | null {
  if (!path) return null;
  const dir = dirnameOf(path);
  const name = basenameOf(path);
  if (!dir || !name) return null;
  return { dir, name };
}

/**
 * The `saveFile` options for a mixdown titled `title`, given the remembered
 * `target` (or `null` when there isn't one yet — the very first mixdown of
 * the session, or one that was cancelled/downloaded rather than saved to a
 * real path).
 *
 * `explicitName` is a FACT the caller supplies — did `title` come from the
 * mixdown-name field, or is it the auto-generated `mixdown_<n>.wav` fallback
 * — never guessed from the text itself: a user who happens to type exactly
 * the auto-generated shape must still be treated as explicit, which a
 * regex/text-sniffing check cannot tell apart from the real fallback.
 *
 * An explicit name always wins over the remembered file name — typing a new
 * name is the user asking for a NEW file — but the remembered FOLDER is
 * still reused, so the dialog still opens in the right place. With no
 * explicit name, both the folder and the file name are reused, so the
 * dialog reopens already pointed at the same file: confirming it (its own
 * overwrite prompt included) re-writes it, with no fresh navigate/type.
 */
export function mixdownSaveOptions(
  title: string,
  explicitName: boolean,
  target: MixdownSaveTarget | null,
): MixdownSaveOptions {
  if (!target) return { suggestedName: title };
  if (explicitName) return { suggestedName: title, initialDir: target.dir };
  return { suggestedName: target.name, initialDir: target.dir };
}

/**
 * Whether a mixdown save that just completed, tagged `seq` (assigned once
 * per job, increasing in the order jobs START running), should become the
 * new remembered target, given `lastAppliedSeq` — the `seq` of whichever
 * save last won (`-1` before any has).
 *
 * Two mixdowns queued back to back ("Commit Edit" pressed twice) render and
 * save independently, and the Save As dialog is never awaited (the queue
 * moves on to the next job while it is up — see `runMixdownJob`), so either
 * job's save can complete first. An OLDER job's save finishing AFTER a NEWER
 * job's must not overwrite the newer job's target with a stale one, so this
 * is `>=`, not "most recently settled wins".
 */
export function shouldApplyMixdownSave(seq: number, lastAppliedSeq: number): boolean {
  return seq >= lastAppliedSeq;
}
