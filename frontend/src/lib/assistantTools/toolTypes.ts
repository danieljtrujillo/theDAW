/**
 * assistantTools/toolTypes — the contract every assistant tool implements.
 *
 * The in-app assistant edits the project by calling tools, not by emitting
 * arbitrary code, so every tool needs the same shape: declared args, a
 * validator, and a `run` that either performs a REAL edit through the editor
 * and returns a receipt, or refuses with a reason a user can read. A tool
 * must never report success for something it did not do.
 *
 * This file is the contract only — no store imports, no React, no DOM. The
 * data shapes below (`ToolClip`, `ToolTrack`, the reference statuses) are
 * deliberately typed independently of `state/editorStore.ts` and
 * `state/assistantReferenceStore.ts` rather than imported from them, so a
 * tool can be unit-tested against a fake `ToolContext` with no Zustand store,
 * no Web Audio, and no live document at all.
 */

/**
 * A tool's answer when it will not perform the requested edit — a stale
 * reference, an argument outside range, anything that would otherwise force a
 * silent no-op or a guess. `reason` is shown to the user, so it must say what
 * is wrong, not just that something is.
 */
export interface ToolRefusal {
  refused: true;
  reason: string;
}

/** Builds a {@link ToolRefusal}. The single call site for the literal shape,
 *  so every refusal is built the same way. */
export const refuse = (reason: string): ToolRefusal => ({ refused: true, reason });

/** Type guard for {@link ToolRefusal}. The one correct way to tell a refusal
 *  apart from a receipt — never a hand-rolled `'refused' in v` check, which
 *  would also match a receipt that happens to carry an unrelated field. */
export const isRefusal = (v: unknown): v is ToolRefusal =>
  typeof v === 'object' && v !== null && (v as ToolRefusal).refused === true;

/**
 * A tool's answer when it DID perform the edit. `before`/`after` hold enough
 * of the changed state to explain the edit to the user and to drive undo;
 * `undoLabel` names the single history entry the app records for it — every
 * tool-driven change is exactly one undo step, never a pile of micro-edits.
 */
export interface ToolReceipt {
  tool: string;
  targetIds: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  undoLabel: string;
}

/**
 * A tool the assistant can call. `validate` turns the model's raw (untyped)
 * args into either a typed `Args` or a refusal, so a malformed call is caught
 * before anything touches the document; `run` performs the edit against a
 * `ToolContext` and always resolves — a tool must never throw, only refuse.
 */
export interface AssistantTool<Args> {
  name: string;
  description: string;
  argsSchema: Record<string, unknown>;
  validate(args: Record<string, unknown>): Args | ToolRefusal;
  run(ctx: ToolContext, args: Args): Promise<ToolReceipt | ToolRefusal>;
}

/**
 * The clip fields a tool is allowed to see. Mirrors the shape of
 * `state/editorStore.ts`'s `AudioClip` for the fields tools reason about, but
 * is its own type: `gain`, `fadeInSec`, `fadeOutSec` and `muted` are resolved
 * to their effective values here (the store's are optional and default
 * through `clipPeakGain`/the fade module) so a tool never has to re-derive a
 * default a fake `ToolContext` would otherwise have to fake too.
 */
export interface ToolClip {
  id: string;
  trackId: string;
  label: string;
  startSec: number;
  durationSec: number;
  offsetIntoSource: number;
  sourceDuration: number;
  /** Linear multiplier, 1 = unity. Convert to/from dB with {@link dbToLinear}/{@link linearToDb}. */
  gain: number;
  fadeInSec: number;
  fadeOutSec: number;
  muted: boolean;
}

/** The track fields a tool is allowed to see, mirroring the subset of
 *  `state/editorStore.ts`'s `EditorTrack` that tools act on. */
export interface ToolTrack {
  id: string;
  name: string;
  /** 0..1, matching the track fader's own range. */
  volume: number;
  mute: boolean;
  solo: boolean;
}

/**
 * Everything a tool's `run` gets to act through. This is the ONLY door a tool
 * has onto the document — no store hooks, no DOM — so a fake implementation
 * of this interface is a complete, real editor for tests. Every mutator here
 * is expected to wrap a real `editorStore` action; a tool that cannot find a
 * mutator for what it needs must refuse rather than fabricate one.
 *
 * `resolveClipReference`/`resolveTrackReference` report how a reference chip
 * resolves against the live document right now: `'ok'` — unchanged since the
 * chip was made; `'changed'` — still exists but has moved/been edited, so a
 * tool may still act but should say so in its receipt; `'missing'` — deleted
 * or otherwise gone, which a tool must refuse (see {@link refuseStaleReference})
 * rather than guess a replacement target. `detail` is the one human-readable
 * line explaining the status.
 */
export interface ToolContext {
  getClip(clipId: string): ToolClip | null;
  getTrack(trackId: string): ToolTrack | null;
  resolveClipReference(clipId: string): { status: 'ok' | 'missing' | 'changed'; detail: string };
  resolveTrackReference(trackId: string): { status: 'ok' | 'missing' | 'changed'; detail: string };
  /** Applies a structural edit to one clip as a single undo step. */
  updateClip(
    clipId: string,
    updates: Partial<Pick<ToolClip, 'startSec' | 'durationSec' | 'offsetIntoSource' | 'gain' | 'fadeInSec' | 'fadeOutSec'>>,
    undoLabel: string,
  ): void;
  /** Splits a clip at `atSec` (TIMELINE-absolute seconds, the same frame as
   *  `ToolClip.startSec` and `editorStore.splitClipAt`), returning the new
   *  clip's id, or null when the split could not be made (the store refuses a
   *  cut within 50 ms of either clip edge). */
  splitClip(clipId: string, atSec: number): string | null;
  setTrackMute(trackId: string, mute: boolean): void;
  setTrackSolo(trackId: string, solo: boolean): void;
  setTrackVolume(trackId: string, volume: number): void;
  /** Resolves the LINEAR sample peak of the clip's audible region (0 for
   *  silence, or a clip with nothing playable). Async because it may have to
   *  decode audio the editor has not touched yet. */
  getClipAudioPeak(clipId: string): Promise<number>;
}

/** Lower bound of the clip-gain dB range, matching the `WaveformEditor`
 *  slider (`components/audio/WaveformEditor.tsx`'s `ClipGainControls`). */
export const CLIP_GAIN_DB_MIN = -24;

/** Upper bound of the clip-gain dB range, matching the same slider. */
export const CLIP_GAIN_DB_MAX = 12;

/** dB to linear gain, matching `ClipGainControls`'s own `10 ** (db / 20)` so a
 *  tool's gain math lands on exactly the value the slider would have set. */
export const dbToLinear = (db: number): number => 10 ** (db / 20);

/** Linear gain to dB. Zero (and negative, which should never reach here) has
 *  no finite dB value, so it reads as -Infinity rather than NaN — the one
 *  value a tool can safely format as "silent" without a separate branch. */
export const linearToDb = (lin: number): number => (lin > 0 ? 20 * Math.log10(lin) : Number.NEGATIVE_INFINITY);

/** Clamps a dB value to the editor's clip-gain range, so a tool can never set
 *  a gain the UI itself could not represent. */
export const clampGainDb = (db: number): number => Math.min(CLIP_GAIN_DB_MAX, Math.max(CLIP_GAIN_DB_MIN, db));

/** Rounds `n` to `places` decimal places. Tools report numbers back to the
 *  user (dB, seconds) and must not echo binary floating-point noise. */
export const roundTo = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * The one guard every tool runs before touching a referenced clip or track:
 * a `'missing'` resolution is refused, carrying the id and the resolver's own
 * detail into the reason so the user sees exactly what went stale. `'ok'` and
 * `'changed'` both return null — a changed reference is still actionable, the
 * tool just may want to note the change in its receipt.
 */
export const refuseStaleReference = (
  kind: 'clip' | 'track',
  id: string,
  resolved: { status: string; detail: string },
): ToolRefusal | null =>
  resolved.status === 'missing'
    ? refuse(`Refusing: the ${kind} reference ${id} is stale — ${resolved.detail}`)
    : null;
