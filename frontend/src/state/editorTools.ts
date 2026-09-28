/**
 * The assistant's imperative facade over the EDIT timeline.
 *
 * One module, one calling convention: every exported function takes a plain
 * arguments object (snake_case keys, the same vocabulary `orb-kit`'s action
 * handlers already use) and returns a {@link ToolResult} — never throws, never
 * returns a bare string, never reports success for work it did not do. Tool
 * REGISTRATION (catalog, handler table, permission tiers) is a separate layer;
 * this file is only the verbs.
 *
 * The three rules that shaped it:
 *
 * 1. **Everything goes through the store's own actions.** `updateClip`,
 *    `addClipToTrack`, `updateTrack`, `setLoopRegion`, … are what the undo
 *    subscription in `editorStore` watches, so writing through them is what
 *    makes every one of these operations undoable without a second history
 *    mechanism. Nothing here calls `useEditorStore.setState` directly.
 *
 * 2. **Notes are edited as notes.** A piano-roll clip IS its note list, so
 *    "quantize this" is `rollClip.quantizeRollClip` (clipNotes.quantizeNotes on
 *    the roll's own notes) — not a guess at what quantized audio would sound
 *    like — written to the notes the clip plays and to the roll's own notes
 *    (lib/clipRollSync), so the piano roll opens with the edit. The clip's
 *    audio is a cache (lib/midiRender): a clip with an instrument plays live on
 *    EDIT's synths and renders when an export needs it, so an edit to one that
 *    holds no render renders nothing. A clip that holds a render, or has no
 *    instrument to play live, is re-rendered, and that note mutation AWAITS the
 *    render before reporting success, so the audio an offline bounce reads
 *    never falls behind the notes.
 *
 * 3. **An operation this layer cannot really perform is an error, not a stub.**
 *    Audio time-stretch needs the backend. Freezing a track needs the offline
 *    renderer that lives in the timeline component. The metronome does not
 *    exist in the model at all. Each of those returns a refusal that names
 *    what is missing and where the real path is, because a tool that quietly
 *    does nothing and says "done" is worse than one that says no.
 *
 * Ids: every `*_id` argument accepts either a real id or the object's
 * label/name, matched case-insensitively. An ambiguous name lists its
 * candidates rather than picking one.
 *
 * Node-testability is deliberate: nothing here imports React or touches the
 * DOM beyond `Blob`, and every audio path takes an optional `ctxFactory` /
 * `render` seam so the whole surface can be exercised without a browser.
 */
import {
  SNAP_DIVISIONS,
  clipPeakGain,
  midiCcOfTarget,
  midiCcTarget,
  useEditorStore,
  validTimeSignature,
} from './editorStore';
import { PART_CONTROLLERS, partController } from '../lib/rollTracks';
import type {
  AudioClip,
  AutomationLane,
  AutomationTarget,
  AutomationTargetKind,
  EditorTrack,
  SnapDivision,
  ToolMode,
} from './editorStore';
import { DEFAULT_LANES, sanitizeLanes, withTicks, type PianoNote } from './pianoRollStore';
import { publishSelectedClips } from './editorSelectionBridge';
import { callEditorPlay, callEditorStop, isEditorPlaybackRegistered } from './editorPlaybackBridge';
import { logInfo } from './logStore';
import {
  divisionToSteps,
  filterNotes as filterNotesPure,
  fixOverlaps as fixOverlapsPure,
  humanizeNotes,
  humanizeSections,
  noteEndStep,
  nudgeNotes as nudgeNotesPure,
  scaleVelocity as scaleVelocityPure,
  transposeNotes,
} from '../lib/clipNotes';
import type { OverlapMode } from '../lib/clipNotes';
import { quantizeRollClip } from '../lib/rollClip';
import { builtinGrooves, grooveById } from '../lib/grooveTemplate';
import {
  DEFAULT_SAMPLE_RATE,
  applyFadesToBlob,
  bounceMidiClip,
  concatBlobs,
  crossfadePlan,
  defaultOfflineCtxFactory,
  duplicateClip as duplicateClipPure,
  mergePlan,
  normalizeBlob,
  nudgeClip as nudgeClipPure,
  reverseBlob,
  selectRange as selectRangePure,
  setClipProps,
  setClipSourceBpm as setClipSourceBpmPure,
  stretchMidiClip,
  stretchPlan,
  trimClip as trimClipPure,
} from '../lib/clipOps';
import type { ClipOpResult, OfflineCtxFactory, StepNoteRenderer } from '../lib/clipOps';
import { encodeWav } from '../lib/wavEncode';
import { clipVoice, drumKitName, GM_STANDARD_KIT, isPercussionTrack, renderedVoiceFields, type ClipVoice } from '../lib/clipProgram';
import { isMidiClip } from '../lib/clipEditTarget';
import { DROP_RENDER_FIELDS, hasMidiNotes, midiClipNominalSec, midiRenderFields, midiRenderSig, midiRenderState, midiRenderStateText } from '../lib/midiRender';
import { midiGlobalVoice, midiLiveIfHeard, withRenderTurn } from './midiRenderQueue';
import { rollNotesAfterEdit } from '../lib/clipRollSync';
import { playedRollNotes } from '../lib/rollClip';
import { sanitizeBends } from '../lib/pitchBend';
import { GM_NAMES } from '../lib/gmInstruments';
import { playedTempoMap, stepClock } from '../lib/rollTempo';
import {
  arrangementClipTime,
  arrangementClipTimeAtSec,
  editBarAtSec,
  editBarPosToBeat,
  editBarStartSec,
  editBeatToBarPos,
  editBpmText,
  editMeterLabel,
  editMoveByBars,
  editMoveByBeats,
  editTempoAtSec,
  parseEditMeter,
  sanitizeEditMeterMap,
} from '../lib/editTimeMap';
import { barAt, barStartStep, normalizeMeterMap, roundUpToBar, sanitizeMeter, type MeterSegment, type PolyLane } from '../lib/meterMap';
import type { Meter } from '../lib/colony';
import { FERMATA_STRETCH_MAX, FERMATA_STRETCH_MIN, TEMPO_BPM_MAX, TEMPO_BPM_MIN, type TempoEvent } from '../lib/tempoMap';
import type { ArrangementMidiScope } from '../lib/arrangementMidi';
import { exportArrangementMidi, type ArrangementMidiSeams } from '../lib/arrangementMidiApp';

/* ── result envelope ─────────────────────────────────────────────────────── */

/**
 * What every tool returns. `message` is written for a user to read verbatim and
 * always carries the numbers involved; `error` is written for the same reader
 * and says what would have to change for the call to work.
 *
 * The mirrored `error?: undefined` / `message?: undefined` members are load
 * bearing: this project compiles with `strictNullChecks` off, and without them
 * TypeScript will not narrow this union on the boolean `ok` discriminant — so
 * `if (!r.ok) return r.error` would not compile at a call site. Same reason
 * `clipOps`' `ClipOpResult` declares them.
 */
export type ToolResult =
  | { ok: true; message: string; data?: unknown; error?: undefined }
  | { ok: false; error: string; message?: undefined; data?: undefined };

const done = (message: string, data?: unknown): ToolResult => {
  logInfo('editor', message);
  return { ok: true, message, data };
};
const fail = (error: string): ToolResult => ({ ok: false, error });

/** Internal resolution envelope, same shape as `ClipOpResult`. */
type Found<T> = { ok: true; value: T; error?: undefined } | { ok: false; error: string; value?: undefined };

const store = () => useEditorStore.getState();

/**
 * Run a tool's document writes as exactly ONE undo step.
 *
 * `editorStore.undoGroup` forces a history boundary before and after `fn` and
 * folds every write inside it into one step, so neither timing accident can
 * happen: an edit the user made just before asking (inside the store's
 * coalescing window) is never swallowed into the tool's step, and a tool that
 * writes several times is never split into several.
 *
 * Only ever wrap the synchronous COMMIT — never an await. Anything that writes
 * the document while a group is open joins it, so a group held open across a
 * render would absorb whatever the user did during the render into the tool's
 * undo step. Every call site below opens it after the last await.
 */
const oneStep = <T>(fn: () => T): T => store().undoGroup(fn);

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ── argument coercion ───────────────────────────────────────────────────── */

/** A finite number, or undefined. Accepts the numeric strings a model writes. */
const numArg = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const boolArg = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return undefined;
};

const strArg = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
};

/** Round for display without turning 4 into "4.00". */
const n2 = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/* ── id-or-name resolution ───────────────────────────────────────────────── */

/**
 * Resolve a reference that may be an id or a human-facing name. Exact id wins
 * outright; otherwise names are matched case-insensitively and an ambiguous
 * match is refused with its candidates, because picking one of two clips called
 * "Verse" is how a tool edits the wrong thing and reports success.
 */
function resolveOne<T>(
  ref: unknown,
  items: readonly T[],
  idOf: (item: T) => string,
  nameOf: (item: T) => string,
  kind: string,
): Found<T> {
  const asked = strArg(ref);
  if (!asked) return { ok: false, error: `${kind}: pass an id or a name` };

  const byId = items.find((item) => idOf(item) === asked);
  if (byId) return { ok: true, value: byId };

  const lower = asked.toLowerCase();
  const byName = items.filter((item) => nameOf(item).toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, value: byName[0] };
  if (byName.length > 1) {
    return {
      ok: false,
      error: `${byName.length} ${kind}s are called "${asked}": ${byName.map(idOf).join(', ')}. Pass the id.`,
    };
  }

  const known = items.slice(0, 20).map((item) => `${nameOf(item)} (${idOf(item)})`).join(', ') || 'none';
  return { ok: false, error: `No ${kind} "${asked}". Known ${kind}s: ${known}` };
}

const resolveClip = (ref: unknown): Found<AudioClip> =>
  resolveOne(ref, store().clips, (c) => c.id, (c) => c.label, 'clip');

const resolveTrack = (ref: unknown): Found<EditorTrack> =>
  resolveOne(ref, store().tracks, (t) => t.id, (t) => t.name, 'track');

/** The live record for an id — helpers hold stale copies across an await. */
const liveClip = (id: string): AudioClip | undefined => store().clips.find((c) => c.id === id);

/* ── stale-write guard ───────────────────────────────────────────────────────
   Every render or decode is an await, and the user keeps editing while it runs.
   A result computed from the clip AS IT WAS must not be written over the clip AS
   IT IS if anything it was computed from has moved in between — that would
   silently revert a drag, a trim or a note edit the user just made. So after
   every await the clip is re-read and the fields each operation actually
   depends on are compared by identity (the store replaces values immutably, so
   an unchanged field is the same reference). A change refuses the write; no
   change hands back the CURRENT record to build the update from, so unrelated
   edits made during the wait (a rename, a colour) are kept, not stomped. */

/** Where the clip sits and which part of its media plays. Every render writes
 *  a window of its own, so any of these moving invalidates it. */
const WINDOW_FIELDS: readonly (keyof AudioClip)[] = ['trackId', 'startSec', 'offsetIntoSource', 'durationSec'];
/** What a MIDI re-bounce is rendered FROM: its notes, its tempo and tempo map, and its voice. */
const MIDI_INPUTS: readonly (keyof AudioClip)[] = [
  ...WINDOW_FIELDS, 'sourcePianoRoll', 'sourceRollNotes', 'sourceBpm', 'sourceTempoMap', 'instrumentProgram',
  'sourceLanes', 'sourceBends', 'sourceMeterMap', 'sourcePickupSteps', 'sourceTotalSteps',
];
/** What a sample-domain op (reverse / normalize) is computed from. */
const AUDIO_INPUTS: readonly (keyof AudioClip)[] = [...WINDOW_FIELDS, 'audioBlob'];
/** An audio bounce also prints the envelope and gain it read. */
const BOUNCE_INPUTS: readonly (keyof AudioClip)[] = [...AUDIO_INPUTS, 'fadeInSec', 'fadeOutSec', 'gain'];
/** A merge part additionally contributes silence when muted. */
const MERGE_INPUTS: readonly (keyof AudioClip)[] = [...BOUNCE_INPUTS, 'muted'];

/** Re-read `before` after an await. Refuses when it is gone or when any of
 *  `inputs` changed; otherwise returns the current record. */
const recheck = (before: AudioClip, inputs: readonly (keyof AudioClip)[]): Found<AudioClip> => {
  const now = liveClip(before.id);
  if (!now) {
    return { ok: false, error: `"${before.label}" was removed while its audio was rendering; nothing was written` };
  }
  const changed = inputs.filter((key) => now[key] !== before[key]);
  if (changed.length) {
    return { ok: false, error: `"${before.label}" changed while rendering (${changed.join(', ')}) — nothing written` };
  }
  return { ok: true, value: now };
};

/** A piano-roll clip with its notes still attached, or a refusal that says which
 *  of the two things is missing. */
const resolveMidiClip = (ref: unknown, allowEmpty = false): Found<AudioClip> => {
  const found = resolveClip(ref);
  if (!found.ok) return found;
  const clip = found.value;
  if (clip.sourceKind !== 'piano-roll') {
    return { ok: false, error: `"${clip.label}" is an audio clip; note operations need a piano-roll (MIDI) clip` };
  }
  // An empty roll is still a roll (lib/clipEditTarget): writing notes into it is how it is filled.
  if (allowEmpty && isMidiClip(clip)) return { ok: true, value: clip };
  if (!clip.sourcePianoRoll || clip.sourcePianoRoll.length === 0) {
    return { ok: false, error: `"${clip.label}" is a piano-roll clip but carries no notes, so there is nothing to edit` };
  }
  return { ok: true, value: clip };
};

/* ── audio plumbing ──────────────────────────────────────────────────────── */

/** Test seams shared by every operation that renders or decodes audio. */
export interface RenderArgs {
  /** Replaces the MIDI renderer (`lib/midiSynth` by default). */
  render?: StepNoteRenderer;
  /** Replaces the `OfflineAudioContext` factory. Node has no Web Audio. */
  ctxFactory?: OfflineCtxFactory;
  /** Rate the offline context decodes to. Defaults to 44100. */
  sample_rate?: number;
}

const rateOf = (args: RenderArgs): number => numArg(args.sample_rate) ?? DEFAULT_SAMPLE_RATE;

/**
 * The clip's AUDIBLE window as its own WAV — `offsetIntoSource` .. `+durationSec`
 * of the source, nothing else.
 *
 * Every sample-domain edit needs this first: a trimmed clip's `audioBlob` still
 * holds the whole source, so reversing or merging the blob would drag in audio
 * the clip does not play. The timeline already does exactly this before sending
 * a clip to the stretch backend (`WaveformEditor.extractRegionWav`); it is here
 * rather than in `clipOps` because `clipOps` is closed for this ticket, and it
 * goes through the same injected context the ops use so it stays provable in
 * Node. A clip that already uses all of its source is passed through untouched
 * rather than paying a second 16-bit round trip.
 */
const extractWindow = async (asked: AudioClip, args: RenderArgs): Promise<Blob> => {
  // A MIDI clip holding no render is rendered for this edit (through the same
  // seam as the note tools), its window following the render as an export's does.
  let clip = asked;
  if (!clip.audioBlob) {
    if (!hasMidiNotes(clip)) throw new Error(`"${clip.label}" has no audio (an empty MIDI clip)`);
    const voice = voiceFor(clip);
    // In the MIDI render queue's turn, so it never overlaps another render, and in
    // the bank EDIT plays the clip's program in (its roll part's Bank), which the
    // render's stamp (midiRenderFields) records.
    const rendered = await withRenderTurn(clip.id, clip.label, () =>
      bounceMidiClip(clip, { render: args.render, bpm: store().bpm, program: voice.program, bank: voice.bank, percussion: voice.percussion }));
    clip = { ...clip, ...midiRenderFields(clip, rendered, voice) };
  }
  const offset = Math.max(0, clip.offsetIntoSource ?? 0);
  const total = clip.sourceDuration;
  if (offset <= 1e-9 && (!Number.isFinite(total) || clip.durationSec >= total - 1e-6)) {
    return clip.audioBlob;
  }
  const make = args.ctxFactory ?? defaultOfflineCtxFactory;
  const ctx = make(rateOf(args));
  if (!ctx || typeof ctx.decodeAudioData !== 'function' || typeof ctx.createBuffer !== 'function') {
    throw new Error('editorTools: the audio context factory returned nothing usable');
  }
  const bytes = await clip.audioBlob.arrayBuffer();
  const src = await ctx.decodeAudioData(bytes.slice(0));
  const sr = src.sampleRate;
  const start = Math.min(src.length, Math.max(0, Math.floor(offset * sr)));
  const len = Math.max(1, Math.min(src.length - start, Math.ceil(clip.durationSec * sr)));
  const out = ctx.createBuffer(src.numberOfChannels, len, sr);
  for (let c = 0; c < src.numberOfChannels; c += 1) {
    const from = src.getChannelData(c);
    const to = out.getChannelData(c);
    for (let i = 0; i < len; i += 1) to[i] = from[start + i];
  }
  return encodeWav(out);
};

/** The voice a MIDI clip plays and renders through: its own program, else its
 *  track's, else the instrument picker's while soundfonts are on, on the drum
 *  channel with the Standard kit as the default on a percussion track
 *  (lib/clipProgram). The picker is the one the MIDI render queue was handed
 *  (state/midiRenderQueue midiGlobalVoice), the same one live playback and
 *  EDIT's render sync read, so a render stamps the voice they expect and is not
 *  rendered a second time; with no renderer configured (node tests) soundfonts
 *  read as off. */
const voiceFor = (clip: AudioClip): ClipVoice => {
  const track = store().tracks.find((t) => t.id === clip.trackId);
  return clipVoice(clip, track, midiGlobalVoice());
};

/**
 * True when `next` (a clip as an edit is about to leave it) plays live when
 * heard: the plan play() makes, with `next` in its place (the MIDI render
 * queue's configured plan, state/midiRenderQueue midiLiveIfHeard).
 */
const playsLiveAs = (next: AudioClip): boolean =>
  midiLiveIfHeard(store().clips.map((c) => (c.id === next.id ? next : c))).has(next.id);

/**
 * True when `clip` holds a render EDIT made only so it could be heard
 * (renderAuto) and `next` plays live: the edit drops that render instead of
 * rendering it again (state/midiRenderQueue dropAutoRender does the same).
 */
const autoRenderGoes = (clip: AudioClip, next: AudioClip): boolean =>
  clip.renderAuto === true && !!clip.audioBlob && playsLiveAs(next);

/**
 * The auto mark a render written by an edit carries. A render asked for (the
 * bounce tool) is kept. Otherwise it keeps the reason the clip held a render,
 * and a clip that held none (it cannot play live) holds this one so it can be
 * heard.
 */
const autoMarkFor = (clip: AudioClip, asked: boolean): Pick<AudioClip, 'renderAuto'> => ({
  renderAuto: !asked && (clip.audioBlob ? clip.renderAuto === true : true) ? true : undefined,
});

/**
 * Write a new note list onto a MIDI clip, and re-render its audio when it
 * holds a render or has no instrument to play live.
 *
 * The roll's own notes (`sourceRollNotes`) are written in the same step, each
 * edited note in its lane (lib/clipRollSync), so the edit is still there when
 * the clip is opened in the piano roll. The grid keeps its length, growing to
 * the bar line after the last note when the notes run past it, so reopening
 * shows the same bars.
 *
 * A clip's audio is a cache (lib/midiRender). A clip that holds one gets a new
 * render (nothing is committed until it succeeds, so a failed synth leaves the
 * clip exactly as it was), and so does a clip with no program of its own or on
 * its track, which cannot play live; `render: 'always'` renders regardless (the
 * bounce tool). A clip that plays live and holds no render takes the notes at
 * once and renders when an export needs it, and a render EDIT made only so it
 * could be heard (renderAuto) is dropped rather than rendered again once it
 * plays live. Each render takes the MIDI render queue's turn, so it never
 * overlaps another render.
 */
const commitNotes = async (
  clip: AudioClip,
  notes: PianoNote[],
  args: RenderArgs,
  programOverride?: number,
  /** Folded into the SAME updateClip, so a caller that needs more than the
   *  re-bounce (bounce + flatten) still costs exactly one write. */
  extra: Partial<AudioClip> = {},
  opts: { render?: 'always' | 'when-cached' } = {},
): Promise<Found<{ duration: number; totalSteps: number; lengthNote: string; rendered: boolean }>> => {
  if (notes.length === 0) {
    return { ok: false, error: `refusing: that would leave "${clip.label}" with no notes at all` };
  }
  const pickup = clip.sourcePickupSteps ?? 0;
  const noteEnd = noteEndStep(notes, 1);
  const barEnd = roundUpToBar(clip.sourceMeterMap ?? [], noteEnd, pickup);
  const totalSteps = Math.max(clip.sourceTotalSteps ?? 0, clip.sourceMeterMap ? barEnd : noteEndStep(notes, 16), noteEnd);
  const rollFields = rollNotesAfterEdit(clip, notes, totalSteps);
  return commitMidiFields(clip, {
    sourcePianoRoll: notes,
    sourceTotalSteps: totalSteps,
    ...rollFields,
    // A program set here drops the bank the old program was chosen in (lib/clipProgram clipBank).
    ...(programOverride !== undefined ? { instrumentProgram: programOverride, instrumentBank: undefined } : {}),
  }, args, extra, opts);
};

/**
 * Write a MIDI clip's note fields (`noteFields` names at least
 * `sourcePianoRoll` and `sourceTotalSteps`) in one undo step, rendering when
 * the clip holds a render or cannot play live, or when `render: 'always'`
 * (see commitNotes).
 */
const commitMidiFields = async (
  clip: AudioClip,
  noteFields: Partial<AudioClip>,
  args: RenderArgs,
  extra: Partial<AudioClip> = {},
  opts: { render?: 'always' | 'when-cached' } = {},
): Promise<Found<{ duration: number; totalSteps: number; lengthNote: string; rendered: boolean }>> => {
  const next: AudioClip = { ...clip, ...noteFields };
  const totalSteps = next.sourceTotalSteps ?? 0;
  const voice = voiceFor(next);
  const empty = !next.sourcePianoRoll?.length;
  const asked = opts.render === 'always';
  // A render EDIT made only so the clip could be heard goes once the clip plays live.
  const autoGoes = !asked && autoRenderGoes(clip, next);
  const renders = !empty && (asked || (!!clip.audioBlob && !autoGoes) || voice.program === undefined);
  if (!renders) {
    // Plays live with no render, or has no notes left to render: the notes and
    // the grid's window, nothing rendered. An emptied clip's old render goes,
    // and so does a render made only so a clip that now plays live was heard.
    const nominal = midiClipNominalSec(next, store().bpm);
    const current = recheck(clip, MIDI_INPUTS);
    if (!current.ok) return { ok: false, error: current.error };
    oneStep(() => store().updateClip(current.value.id, {
      ...noteFields,
      ...((empty || autoGoes) && clip.audioBlob ? { ...DROP_RENDER_FIELDS } : {}),
      offsetIntoSource: 0,
      sourceDuration: nominal,
      durationSec: nominal,
      ...extra,
    }));
    const lengthNote = Math.abs(nominal - clip.durationSec) > 1e-6 ? ` (clip length ${n2(clip.durationSec)}s → ${n2(nominal)}s)` : '';
    return { ok: true, value: { duration: nominal, totalSteps, lengthNote, rendered: false } };
  }
  let rendered: { blob: Blob; duration: number };
  try {
    // In the MIDI render queue's turn, so it never overlaps another render.
    rendered = await withRenderTurn(clip.id, clip.label, () =>
      bounceMidiClip(next, { render: args.render, bpm: store().bpm, program: voice.program, bank: voice.bank, percussion: voice.percussion }));
  } catch (e) {
    return { ok: false, error: `the edit was not applied: re-rendering "${clip.label}" failed — ${reason(e)}` };
  }
  const current = recheck(clip, MIDI_INPUTS);
  if (!current.ok) return { ok: false, error: current.error };
  oneStep(() => store().updateClip(current.value.id, {
    ...noteFields,
    audioBlob: rendered.blob,
    mimeType: 'audio/wav',
    sourceDuration: rendered.duration,
    durationSec: rendered.duration,
    offsetIntoSource: 0,
    ...renderedVoiceFields(voice),
    renderSig: midiRenderSig(next),
    ...autoMarkFor(clip, asked),
    // The cached waveform describes the old audio; leaving it would draw the
    // pre-edit shape until something else happened to recompute it.
    peaks: undefined,
    ...extra,
  }));
  // A re-bounce always writes the FULL rendered length, so a clip that had been
  // trimmed grows back and everything the user placed after it is now overlapped.
  // That is a change they did not ask for as part of "quantize this", so every
  // note tool says it out loud instead of leaving it to be noticed.
  const lengthNote =
    Math.abs(rendered.duration - clip.durationSec) > 1e-6
      ? ` (clip length ${n2(clip.durationSec)}s → ${n2(rendered.duration)}s)`
      : '';
  return { ok: true, value: { duration: rendered.duration, totalSteps, lengthNote, rendered: true } };
};

/** Commit a fresh blob onto a clip, flattening its source window (the blob IS
 *  the clip now). Used by reverse / normalize / bounce. */
const commitAudio = (clip: AudioClip, blob: Blob, duration: number, extra: Partial<AudioClip> = {}): void => {
  oneStep(() => store().updateClip(clip.id, {
    audioBlob: blob,
    mimeType: 'audio/wav',
    offsetIntoSource: 0,
    sourceDuration: duration,
    durationSec: duration,
    peaks: undefined,
    ...extra,
  }));
};

/* ── notes ───────────────────────────────────────────────────────────────── */

export interface ClipArgs {
  clip_id?: unknown;
  /** Alias, so a caller that speaks in labels does not have to use `clip_id`. */
  clip?: unknown;
}

const clipRef = (args: ClipArgs): unknown => args.clip_id ?? args.clip;

/** Read a MIDI clip's notes. */
export function getNotes(args: ClipArgs): ToolResult {
  const found = resolveMidiClip(clipRef(args), true);
  if (!found.ok) return fail(found.error);
  const clip = found.value;
  const notes = (clip.sourcePianoRoll ?? []).map((n) => ({ ...n }));
  return done(
    `"${clip.label}" has ${notes.length} note(s) over ${clip.sourceTotalSteps ?? 0} step(s) at ${clip.sourceBpm ?? store().bpm} bpm`,
    { clipId: clip.id, label: clip.label, bpm: clip.sourceBpm ?? store().bpm, totalSteps: clip.sourceTotalSteps, notes },
  );
}

export interface SetNotesArgs extends ClipArgs, RenderArgs {
  notes?: unknown;
}

/** Replace a MIDI clip's note list wholesale and re-render its audio. */
export async function setNotes(args: SetNotesArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args), true);
  if (!found.ok) return fail(found.error);
  if (!Array.isArray(args.notes)) return fail('setNotes: pass notes as an array of { note, step, length, velocity }');

  const notes: PianoNote[] = [];
  for (let i = 0; i < args.notes.length; i += 1) {
    const raw = args.notes[i] as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return fail(`setNotes: note ${i} is not an object`);
    const note = numArg(raw.note);
    const step = numArg(raw.step);
    const length = numArg(raw.length);
    const velocity = numArg(raw.velocity);
    if (note === undefined || note < 0 || note > 127) return fail(`setNotes: note ${i} needs a pitch 0-127`);
    if (step === undefined || step < 0) return fail(`setNotes: note ${i} needs a step >= 0`);
    if (length === undefined || length <= 0) return fail(`setNotes: note ${i} needs a length > 0`);
    if (velocity === undefined || velocity < 1 || velocity > 127) return fail(`setNotes: note ${i} needs a velocity 1-127`);
    notes.push({ id: strArg(raw.id) ?? uid(), note: Math.round(note), step, length, velocity: Math.round(velocity) });
  }

  const written = await commitNotes(found.value, notes, args);
  if (!written.ok) return fail(written.error);
  return done(`Replaced the notes on "${found.value.label}" with ${notes.length} note(s) (${written.value.totalSteps} steps, ${n2(written.value.duration)}s)${written.value.lengthNote}`);
}

export interface QuantizeArgs extends ClipArgs, RenderArgs {
  grid?: unknown;
  strength?: unknown;
  swing?: unknown;
  quantize_ends?: unknown;
  /** A feel laid over the grid: a groove id (lib/grooveTemplate grooveById). */
  groove?: unknown;
  /** How far into the groove, 0..1. Default 1. */
  groove_strength?: unknown;
}

/**
 * Snap a MIDI clip's notes toward a grid, and lay a groove over them.
 *
 * The notes go through `rollClip.quantizeRollClip`, which quantizes the
 * roll's own lane document (`sourceRollNotes`, what EDIT IN PIANO ROLL opens)
 * and derives the played list (`sourcePianoRoll`, what the clip renders) from
 * the result, so the two lists never disagree. The groove pass is
 * `applyGrooveInMeter`, which follows each bar's own meter and groups.
 */
export async function quantizeClip(args: QuantizeArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);

  const grid = strArg(args.grid) as SnapDivision;
  if (!grid || !SNAP_DIVISIONS.includes(grid) || divisionToSteps(grid) <= 0) {
    return fail(`quantize: "${strArg(args.grid) ?? ''}" is not a grid. Use one of: ${SNAP_DIVISIONS.filter((d) => d !== 'off').join(', ')}`);
  }
  const strength = numArg(args.strength) ?? 1;
  const swing = numArg(args.swing) ?? 0;
  if (strength < 0 || strength > 1) return fail('quantize: strength must be between 0 and 1');
  if (swing < -1 || swing > 1) return fail('quantize: swing must be between -1 and 1');

  const grooveId = strArg(args.groove);
  const groove = grooveId ? grooveById(grooveId) : null;
  if (grooveId && !groove) {
    return fail(`quantize: "${grooveId}" is not a groove. Use one of: ${builtinGrooves().map((g) => g.id).join(', ')}, or swing8:/swing16:/group8:/group16: with a percent from 50 to 75`);
  }
  const grooveStrength = numArg(args.groove_strength) ?? 1;
  if (grooveStrength < 0 || grooveStrength > 1) return fail('quantize: groove_strength must be between 0 and 1');

  const clip = found.value;
  // A clip bounced from the roll carries its meter, so the grid restarts on its
  // bar lines (a pickup or a 7/32 bar keeps its own lines); one without a meter
  // keeps the grid from step 0.
  const q = quantizeRollClip(clip, {
    grid,
    strength,
    swing,
    quantizeEnds: boolArg(args.quantize_ends) ?? false,
    ...(clip.sourceMeterMap?.length ? { meterMap: clip.sourceMeterMap, pickupSteps: clip.sourcePickupSteps ?? 0 } : {}),
    ...(groove ? { groove, grooveStrength } : {}),
  });
  const notes = q.sourcePianoRoll;
  // The roll's own notes ride in the same write; a clip bounced before the roll
  // kept its own list has none, and none is made up for it.
  const written = await commitNotes(clip, notes, args, undefined, q.sourceRollNotes.length ? { sourceRollNotes: q.sourceRollNotes } : {});
  if (!written.ok) return fail(written.error);
  const feel = groove ? `, ${groove.name} at ${Math.round(grooveStrength * 100)}%` : '';
  return done(`Quantized ${notes.length} notes to ${grid} at ${Math.round(strength * 100)}% (swing ${swing}${feel}) on "${clip.label}"${written.value.lengthNote}`);
}

export interface NudgeNotesArgs extends ClipArgs, RenderArgs {
  steps?: unknown;
  ms?: unknown;
  ticks?: unknown;
  bpm?: unknown;
}

/** Shift every note in a MIDI clip in time. Exactly one unit. */
export async function nudgeNotes(args: NudgeNotesArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;

  const units: Record<string, number | undefined> = {
    steps: numArg(args.steps),
    ms: numArg(args.ms),
    ticks: numArg(args.ticks),
  };
  const given = Object.keys(units).filter((k) => units[k] !== undefined);

  // A clip with a tempo map moves each note by the milliseconds at its own
  // place in the map (what compare_timing measured), so a note in the Allegro
  // moves as many ms as one in the Adagio. An explicit bpm keeps one tempo.
  const clock = stepClock(clip.sourceBpm ?? store().bpm, clip.sourceTempoMap);
  const ms = units.ms;
  if (given.length === 1 && ms !== undefined && numArg(args.bpm) === undefined && clock.stepSec === undefined) {
    const moved = clip.sourcePianoRoll.map((n) => ({ ...n, step: Math.max(0, clock.stepAt(clock.at(n.step) + ms / 1000)) }));
    const written = await commitNotes(clip, moved, args);
    if (!written.ok) return fail(written.error);
    return done(`Nudged ${moved.length} notes by ${ms} ms through the clip's tempo map on "${clip.label}"${written.value.lengthNote}`);
  }

  let notes: PianoNote[];
  try {
    // `nudgeNotes` THROWS on zero or two units (guessing which one was meant
    // would move somebody's part to the wrong place); a tool turns that into a
    // sentence rather than an exception.
    notes = nudgeNotesPure(clip.sourcePianoRoll, {
      steps: units.steps,
      ms: units.ms,
      ticks: units.ticks,
      bpm: numArg(args.bpm) ?? clip.sourceBpm ?? store().bpm,
    });
  } catch (e) {
    return fail(`nudge: ${reason(e)}`);
  }

  const written = await commitNotes(clip, notes, args);
  if (!written.ok) return fail(written.error);
  return done(`Nudged ${notes.length} notes by ${units[given[0]]} ${given[0]} on "${clip.label}"${written.value.lengthNote}`);
}

export interface TransposeArgs extends ClipArgs, RenderArgs {
  semitones?: unknown;
}

/** Transpose a MIDI clip, clamped to the MIDI pitch range. */
export async function transposeClip(args: TransposeArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const semitones = numArg(args.semitones);
  if (semitones === undefined) return fail('transpose: pass semitones (negative moves down)');

  const clip = found.value;
  const notes = transposeNotes(clip.sourcePianoRoll, semitones);
  const written = await commitNotes(clip, notes, args);
  if (!written.ok) return fail(written.error);
  const shift = Math.round(semitones);
  return done(`Transposed ${notes.length} notes by ${shift >= 0 ? '+' : ''}${shift} semitone(s) on "${clip.label}"${written.value.lengthNote}`);
}

export interface VelocityArgs extends ClipArgs, RenderArgs {
  factor?: unknown;
  offset?: unknown;
  min?: unknown;
  max?: unknown;
}

/** Scale and/or shift a MIDI clip's velocities. */
export async function scaleVelocity(args: VelocityArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const factor = numArg(args.factor);
  const offset = numArg(args.offset);
  if (factor === undefined && offset === undefined) {
    return fail('scale_velocity: pass factor and/or offset (min/max clamp the result)');
  }
  if (factor !== undefined && factor < 0) return fail('scale_velocity: factor must be >= 0');

  const clip = found.value;
  const notes = scaleVelocityPure(clip.sourcePianoRoll, {
    factor,
    offset,
    min: numArg(args.min),
    max: numArg(args.max),
  });
  const written = await commitNotes(clip, notes, args);
  if (!written.ok) return fail(written.error);
  const parts = [factor !== undefined ? `x${factor}` : null, offset !== undefined ? `${offset >= 0 ? '+' : ''}${offset}` : null]
    .filter(Boolean)
    .join(' then ');
  return done(`Velocity ${parts} on ${notes.length} notes of "${clip.label}"${written.value.lengthNote}`);
}

export interface HumanizeArgs extends ClipArgs, RenderArgs {
  timing_steps?: unknown;
  velocity?: unknown;
  seed?: unknown;
}

/** Scatter a MIDI clip's timing and velocity so it stops sounding drawn-in. */
export async function humanizeClip(args: HumanizeArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);

  const timingSteps = numArg(args.timing_steps) ?? 0.1;
  const velocity = numArg(args.velocity) ?? 8;
  const seed = numArg(args.seed);
  if (timingSteps === 0 && velocity === 0) return fail('humanize: timing_steps and velocity are both 0, so there is nothing to scatter');

  const clip = found.value;
  const notes = humanizeNotes(clip.sourcePianoRoll, { timingSteps, velocity, seed });
  const written = await commitNotes(clip, notes, args);
  if (!written.ok) return fail(written.error);
  return done(
    `Humanized ${notes.length} notes on "${clip.label}" (timing ±${timingSteps} steps, velocity ±${velocity}${seed === undefined ? '' : `, seed ${seed}`})${written.value.lengthNote}`,
  );
}

export interface HumanizeTracksArgs extends RenderArgs {
  /** The tracks to humanize together (ids or names); left out, EDIT's selected tracks. */
  track_ids?: unknown;
  /** 'light', 'medium' (the default) or 'strong': how far sections, phrases and velocities move. */
  strength?: unknown;
  seed?: unknown;
}

/** How far each strength moves a section, a phrase and a velocity. */
export const SECTION_HUMANIZE_STRENGTHS = {
  light: { onsetBias: 0.006, drift: 0.004, velocity: 6 },
  medium: { onsetBias: 0.012, drift: 0.008, velocity: 10 },
  strong: { onsetBias: 0.02, drift: 0.014, velocity: 16 },
} as const;
export type SectionHumanizeStrength = keyof typeof SECTION_HUMANIZE_STRENGTHS;

/**
 * Humanize the MIDI clips of several tracks together, by section
 * (lib/clipNotes/humanize humanizeSections): the tracks read one set of
 * sections (EDIT's timeline markers and the FORM sections their clips carry)
 * and one set of phrases on the timeline, so each section pushes or lays back
 * as an ensemble, each phrase drifts as one, and velocities lean toward each
 * phrase's peak. Every clip's notes go back through their own clock. One
 * undo step for the lot.
 */
export async function humanizeTracks(args: HumanizeTracksArgs): Promise<ToolResult> {
  const s = store();
  const wanted = Array.isArray(args.track_ids) ? args.track_ids : args.track_ids === undefined ? s.selectedTrackIds : [args.track_ids];
  const tracks: EditorTrack[] = [];
  for (const ref of wanted) {
    const found = resolveTrack(ref);
    if (!found.ok) return fail(found.error);
    if (!tracks.some((t) => t.id === found.value.id)) tracks.push(found.value);
  }
  if (!tracks.length) return fail('humanize by section: select the tracks to humanize together, or pass track_ids');
  const strength = (strArg(args.strength) ?? 'medium') as SectionHumanizeStrength;
  const feel = SECTION_HUMANIZE_STRENGTHS[strength];
  if (!feel) return fail(`humanize by section: strength must be one of ${Object.keys(SECTION_HUMANIZE_STRENGTHS).join(', ')}`);
  const ids = new Set(tracks.map((t) => t.id));
  const clips = s.clips.filter((c) => ids.has(c.trackId) && isMidiClip(c) && (c.sourcePianoRoll?.length ?? 0) > 0);
  if (!clips.length) return fail('humanize by section: those tracks hold no MIDI notes');

  // Every note on the timeline, through its clip's own clock.
  const clockOf = new Map(clips.map((c) => [c.id, stepClock(c.sourceBpm ?? s.bpm, c.sourceTempoMap)]));
  const sep = '';
  const sections = new Set<number>(s.markers.map((m) => m.t));
  for (const c of clips) {
    const clock = clockOf.get(c.id)!;
    for (const m of c.sourceMarkers ?? []) {
      if (m.kind !== 'section' && m.kind !== 'movement') continue;
      const t = c.startSec + clock.at(m.tick / 240) - (c.offsetIntoSource ?? 0);
      if (t >= c.startSec - 1e-9 && t <= c.startSec + c.durationSec) sections.add(t);
    }
  }
  const parts = tracks.map((t) => ({
    id: t.id,
    notes: clips
      .filter((c) => c.trackId === t.id)
      .flatMap((c) => {
        const clock = clockOf.get(c.id)!;
        const off = c.offsetIntoSource ?? 0;
        return (c.sourcePianoRoll ?? []).map((n) => ({
          id: `${c.id}${sep}${n.id}`,
          t: c.startSec + clock.at(n.step) - off,
          dur: clock.at(n.step + n.length) - clock.at(n.step),
          velocity: n.velocity,
          note: n.note,
        }));
      }),
  }));
  const seed = numArg(args.seed);
  const moved = humanizeSections(parts, { ...feel, sections: [...sections], ...(seed !== undefined ? { seed } : { seed: Math.floor(Math.random() * 1e9) }) });
  const byId = new Map<string, { t: number; velocity: number }>();
  for (const list of moved.values()) for (const n of list) byId.set(n.id, n);

  let count = 0;
  const failed: string[] = [];
  await oneStep(async () => {
    for (const c of clips) {
      const clock = clockOf.get(c.id)!;
      const off = c.offsetIntoSource ?? 0;
      const notes = (c.sourcePianoRoll ?? []).map((n) => {
        const m = byId.get(`${c.id}${sep}${n.id}`);
        if (!m) return { ...n };
        const tick = Math.max(0, Math.round(clock.stepAt(m.t - c.startSec + off) * 240));
        count += 1;
        return { ...n, tick, step: tick / 240, velocity: m.velocity };
      });
      const written = await commitNotes(c, notes, args);
      if (!written.ok) failed.push(`${c.label}: ${written.error}`);
    }
  });
  if (failed.length) return fail(`humanize by section: ${failed.join('; ')}`);
  return done(
    `Humanized ${count} notes across ${tracks.length} track${tracks.length === 1 ? '' : 's'} together by section (${strength}; ${sections.size} section mark${sections.size === 1 ? '' : 's'})`,
  );
}

export interface OverlapArgs extends ClipArgs, RenderArgs {
  mode?: unknown;
}

const OVERLAP_MODES: OverlapMode[] = ['legato', 'trim', 'dedupe'];

/** Resolve same-pitch collisions inside a MIDI clip. */
export async function fixOverlaps(args: OverlapArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const mode = (strArg(args.mode) ?? 'trim') as OverlapMode;
  if (!OVERLAP_MODES.includes(mode)) return fail(`fix_overlaps: mode must be one of ${OVERLAP_MODES.join(', ')}`);

  const clip = found.value;
  const before = clip.sourcePianoRoll.length;
  const notes = fixOverlapsPure(clip.sourcePianoRoll, { mode });
  const written = await commitNotes(clip, notes, args);
  if (!written.ok) return fail(written.error);
  const dropped = before - notes.length;
  return done(`Fixed overlaps on "${clip.label}" (${mode}): ${notes.length} notes kept${dropped ? `, ${dropped} duplicate(s) dropped` : ''}${written.value.lengthNote}`);
}

export interface FilterArgs extends ClipArgs, RenderArgs {
  min_length_steps?: unknown;
  min_velocity?: unknown;
  min_pitch?: unknown;
  max_pitch?: unknown;
  max_gap_steps?: unknown;
}

/** Strip junk notes (blips, near-silent notes, out-of-range and stranded ones). */
export async function filterNotes(args: FilterArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);

  const options = {
    minLengthSteps: numArg(args.min_length_steps),
    minVelocity: numArg(args.min_velocity),
    minPitch: numArg(args.min_pitch),
    maxPitch: numArg(args.max_pitch),
    maxGapSteps: numArg(args.max_gap_steps),
  };
  if (Object.values(options).every((v) => v === undefined)) {
    return fail('filter_notes: pass at least one threshold (min_length_steps, min_velocity, min_pitch, max_pitch, max_gap_steps)');
  }

  const clip = found.value;
  const { kept, removed } = filterNotesPure(clip.sourcePianoRoll, options);
  if (kept.length === 0) {
    return fail(`filter_notes: those thresholds would remove all ${removed.length} notes of "${clip.label}"; loosen them`);
  }
  if (removed.length === 0) {
    return done(`Nothing to strip on "${clip.label}": all ${kept.length} notes pass those thresholds`);
  }
  const written = await commitNotes(clip, kept, args);
  if (!written.ok) return fail(written.error);
  return done(`Removed ${removed.length} junk note(s) from "${clip.label}", ${kept.length} kept${written.value.lengthNote}`);
}

export interface InstrumentArgs extends ClipArgs, RenderArgs {
  program?: unknown;
}

/** Point a MIDI clip at a GM program and re-render its audio through it. */
export async function setClipInstrument(args: InstrumentArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const program = numArg(args.program);
  if (program === undefined || !Number.isInteger(program) || program < 0 || program > 127) {
    return fail('set_clip_instrument: program must be an integer GM program 0-127');
  }
  const clip = found.value;
  const written = await commitNotes(clip, clip.sourcePianoRoll.map((n) => ({ ...n })), args, program);
  if (!written.ok) return fail(written.error);
  return done(`"${clip.label}" now plays GM program ${program}; ${written.value.rendered ? `its audio was re-rendered (${n2(written.value.duration)}s)` : 'it plays live and renders when exported'}${written.value.lengthNote}`);
}

/* ── clip tempo + stretch ────────────────────────────────────────────────── */

export interface SourceBpmArgs extends ClipArgs {
  bpm?: unknown;
}

/** Declare the tempo a clip's media was recorded/rendered at. Does not stretch. */
export function setClipSourceBpm(args: SourceBpmArgs): ToolResult {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const bpm = numArg(args.bpm);
  if (bpm === undefined) return fail('set_clip_source_bpm: pass bpm');

  const res: ClipOpResult<AudioClip> = setClipSourceBpmPure(found.value, bpm);
  if (!res.ok) return fail(`set_clip_source_bpm: ${res.error}`);
  oneStep(() => store().updateClip(found.value.id, { sourceBpm: bpm }));
  return done(`"${found.value.label}" is now tagged as ${bpm} bpm source material`);
}

export interface StretchArgs extends ClipArgs, RenderArgs {
  target_bpm?: unknown;
  target_duration_sec?: unknown;
}

/**
 * Re-render a MIDI clip at a new tempo. Audio clips are refused: a
 * pitch-preserving audio stretch is a backend operation, and resampling one
 * here would move its pitch.
 */
export async function stretchClip(args: StretchArgs): Promise<ToolResult> {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;

  const plan = stretchPlan(clip, {
    targetBpm: numArg(args.target_bpm),
    targetDurationSec: numArg(args.target_duration_sec),
  });
  if (!plan.ok) return fail(`stretch: ${plan.error}`);
  if (plan.value.kind === 'audio') return fail('audio stretch is a backend operation (T13)');

  // A MIDI clip that plays live with no render takes the new tempo at once and
  // renders when an export needs it (lib/midiRender); a render EDIT made only
  // so it could be heard goes with the old tempo.
  const liveBpm = (clip.sourceBpm ?? store().bpm) / plan.value.ratio;
  const autoGoes = autoRenderGoes(clip, { ...clip, sourceBpm: liveBpm });
  if ((!clip.audioBlob || autoGoes) && voiceFor(clip).program !== undefined) {
    const stretched = { ...clip, sourceBpm: liveBpm };
    const nominal = midiClipNominalSec(stretched, store().bpm);
    oneStep(() => store().updateClip(clip.id, {
      sourceBpm: liveBpm,
      ...(autoGoes ? { ...DROP_RENDER_FIELDS } : {}),
      offsetIntoSource: 0,
      sourceDuration: nominal,
      durationSec: nominal,
    }));
    return done(`Stretched "${clip.label}" x${plan.value.ratio.toFixed(3)}: it plays live at ${liveBpm.toFixed(1)} bpm, now ${n2(nominal)}s, and renders when exported`);
  }

  let rendered: { blob: Blob; duration: number };
  try {
    const voice = voiceFor(clip);
    // In the MIDI render queue's turn, so it never overlaps another render.
    rendered = await withRenderTurn(clip.id, clip.label, () =>
      stretchMidiClip(clip, plan.value.ratio, { render: args.render, bpm: store().bpm, program: voice.program, bank: voice.bank, percussion: voice.percussion }));
  } catch (e) {
    return fail(`stretch: ${reason(e)}`);
  }
  const current = recheck(clip, MIDI_INPUTS);
  if (!current.ok) return fail(current.error);

  // The clip's source tempo IS the tempo its audio was rendered at, so it moves
  // with the render — otherwise a later tempo match would compute its ratio from
  // a number the blob no longer matches. (`sourceBpm` is one of the rechecked
  // inputs, so the stale and current values are the same here.)
  const newBpm = (current.value.sourceBpm ?? store().bpm) / plan.value.ratio;
  commitAudio(current.value, rendered.blob, rendered.duration, {
    sourceBpm: newBpm,
    ...renderedVoiceFields(voiceFor(current.value)),
    renderSig: midiRenderSig({ ...current.value, sourceBpm: newBpm }),
    ...autoMarkFor(current.value, false),
  });
  return done(
    `Stretched "${clip.label}" x${plan.value.ratio.toFixed(3)} — re-rendered at ${newBpm.toFixed(1)} bpm, now ${n2(rendered.duration)}s`,
  );
}

/* ── transport, meter, loop ──────────────────────────────────────────────── */

export interface TimeSignatureArgs {
  num?: unknown;
  den?: unknown;
  /** "7/8" as one string, which is how a person says it. */
  time_signature?: unknown;
}

/** Set bar 1's meter; later meter changes stay. */
export function setTimeSignature(args: TimeSignatureArgs): ToolResult {
  let num = numArg(args.num);
  let den = numArg(args.den);
  const compact = strArg(args.time_signature);
  if (compact && (num === undefined || den === undefined)) {
    const parts = compact.split('/');
    num = numArg(parts[0]);
    den = numArg(parts[1]);
  }
  if (num === undefined || den === undefined) return fail('set_time_signature: pass num and den (e.g. 7 and 8)');

  const valid = validTimeSignature(num, den);
  if (!valid) {
    return fail(`set_time_signature: ${num}/${den} is not a meter the editor can bar out — num must be a whole 1-32 and den one of 1, 2, 4, 8, 16, 32`);
  }
  oneStep(() => store().setTimeSignature(valid.num, valid.den));
  const later = store().meterMap.length - 1;
  return done(`Time signature is now ${valid.num}/${valid.den} from bar 1${later > 0 ? ` (${later} later meter change${later === 1 ? '' : 's'} kept)` : ''}`);
}

/** The arrangement's two maps, as editTimeMap reads them. */
const timeMaps = () => {
  const s = store();
  return { tempoMap: s.tempoMap, meterMap: s.meterMap };
};

/** The arrangement's meter map as the tool speaks it: 1-based bars. */
const meterMapOut = () =>
  store().meterMap.map((seg) => ({ bar: seg.bar + 1, num: seg.meter.num, den: seg.meter.den, groups: [...seg.meter.groups], label: editMeterLabel(seg.meter) }));

/** The arrangement's tempo map as the tool speaks it: 1-based bars and quarter notes into the bar. */
const tempoMapOut = () => {
  const { tempoMap, meterMap } = timeMaps();
  return tempoMap.map((e) => {
    const pos = editBeatToBarPos(meterMap, e.beat);
    return e.fermata
      ? { bar: pos.bar, beat: pos.beatInBar, fermata: { beats: e.fermata.beats, stretch: e.fermata.stretch } }
      : { bar: pos.bar, beat: pos.beatInBar, bpm: Math.round(e.bpm * 100) / 100, curve: e.curve === 'linear' ? 'linear' : 'step' };
  });
};

/** Both maps in words: "4/4 from bar 1, 7/8 3+2+2 from bar 9; 120 BPM from bar 1, ramp to 90 BPM at bar 17". */
const timeMapsText = (): string => {
  const meters = meterMapOut().map((m) => `${m.label} from bar ${m.bar}`).join(', ');
  const tempos = tempoMapOut().map((e) => {
    const at = `bar ${e.bar}${e.beat ? ` beat +${n2(e.beat)}` : ''}`;
    if ('fermata' in e && e.fermata) return `hold ${n2(e.fermata.beats)} beat(s) x${n2(e.fermata.stretch)} at ${at}`;
    return `${'curve' in e && e.curve === 'linear' ? 'ramp from ' : ''}${'bpm' in e ? e.bpm : ''} BPM from ${at}`;
  }).join(', ');
  return `${meters}; ${tempos}`;
};

export interface MeterMapArgs {
  /** [{bar, num, den, groups?}] or [{bar, meter: "7/8 3+2+2"}], bars 1-based. Replaces the whole meter map. */
  meter_map?: unknown;
  /** [{bar, beat?, bpm, curve?}] or [{bar, beat?, fermata: {beats, stretch}}], bars 1-based, beat = quarter notes into the bar. Replaces the whole tempo map. */
  tempo_map?: unknown;
  /** A MIDI clip whose tempo and meter the arrangement takes from the clip's first step on. */
  adopt_clip_id?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * A meter map as a tool is handed it: [{bar, num, den, groups?}] or
 * [{bar, meter: "7/8 3+2+2"}], bars 1-based. Returns the segments with 0-based
 * bars, unsorted and without a bar-0 default (each caller decides that).
 */
const parseMeterMapArg = (list: unknown, tool: string): Found<MeterSegment[]> => {
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: `${tool}: meter_map must be a non-empty list of {bar, num, den, groups?}` };
  const segs: MeterSegment[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = asRecord(list[i]);
    if (!raw) return { ok: false, error: `${tool}: meter_map[${i}] must be an object` };
    const bar = numArg(raw.bar);
    if (bar === undefined || !Number.isInteger(bar) || bar < 1) return { ok: false, error: `${tool}: meter_map[${i}] needs a whole bar >= 1 (bar 1 is the start)` };
    let meter: Meter | null;
    const text = typeof raw.meter === 'string' ? raw.meter : undefined;
    if (text !== undefined) {
      meter = parseEditMeter(text);
    } else {
      const groups = Array.isArray(raw.groups)
        ? raw.groups.map(Number)
        : typeof raw.groups === 'string' && raw.groups.trim()
          ? raw.groups.split('+').map((g) => Number(g.trim()))
          : [];
      const num = numArg(raw.num);
      const den = numArg(raw.den);
      meter = sanitizeMeter({ num, den, groups });
      if (meter && groups.length > 1 && meter.groups.length === 0) meter = null;
    }
    if (!meter) {
      return { ok: false, error: `${tool}: meter_map[${i}] is not a meter: num must be a whole 1-64, den one of 1, 2, 4, 8, 16, 32, and groups (when given) whole numbers that add up to num` };
    }
    segs.push({ bar: bar - 1, meter });
  }
  return { ok: true, value: segs };
};

/**
 * Set the arrangement's meter map, tempo map, or both, or take them from a MIDI
 * clip. Bars are 1-based, as on screen. A map passed replaces the whole map;
 * without a bar-1 entry, bar 1 keeps its meter (or start tempo). One undo step.
 */
export function setMeterMap(args: MeterMapArgs): ToolResult {
  const adopt = args.adopt_clip_id;
  const hasMeter = args.meter_map !== undefined && args.meter_map !== null;
  const hasTempo = args.tempo_map !== undefined && args.tempo_map !== null;
  if (adopt !== undefined && adopt !== null && adopt !== '') {
    if (hasMeter || hasTempo) return fail('set_meter_map: pass adopt_clip_id alone, or meter_map / tempo_map, not both');
    const found = resolveMidiClip(adopt);
    if (!found.ok) return fail(found.error);
    const res = oneStep(() => store().adoptClipTimeMaps(found.value.id));
    if (!res.ok) return fail(`set_meter_map: ${res.error}`);
    return done(`The arrangement follows "${found.value.label}" from its first bar: ${timeMapsText()}`, { meter_map: meterMapOut(), tempo_map: tempoMapOut() });
  }
  if (!hasMeter && !hasTempo) return fail('set_meter_map: pass meter_map, tempo_map, or adopt_clip_id');

  const s = store();
  let meterMap: MeterSegment[] | null = null;
  if (hasMeter) {
    const parsed = parseMeterMapArg(args.meter_map, 'set_meter_map');
    if (!parsed.ok) return fail(parsed.error);
    const segs = parsed.value;
    if (!segs.some((seg) => seg.bar === 0)) segs.push({ bar: 0, meter: { ...s.meterMap[0].meter, groups: [...s.meterMap[0].meter.groups] } });
    meterMap = sanitizeEditMeterMap(segs);
  }

  // Tempo positions are read against the meter map this call ends with, so a
  // meter change and a tempo change "at bar 9" in one call land together.
  const barsFrom = meterMap ?? s.meterMap;
  let tempoMap: TempoEvent[] | null = null;
  if (hasTempo) {
    if (!Array.isArray(args.tempo_map) || args.tempo_map.length === 0) return fail('set_meter_map: tempo_map must be a non-empty list of {bar, beat?, bpm, curve?}');
    const events: TempoEvent[] = [];
    for (let i = 0; i < args.tempo_map.length; i += 1) {
      const raw = asRecord(args.tempo_map[i]);
      if (!raw) return fail(`set_meter_map: tempo_map[${i}] must be an object`);
      const bar = numArg(raw.bar);
      if (bar === undefined || !Number.isInteger(bar) || bar < 1) return fail(`set_meter_map: tempo_map[${i}] needs a whole bar >= 1`);
      const beatInBar = numArg(raw.beat) ?? 0;
      if (beatInBar < 0) return fail(`set_meter_map: tempo_map[${i}] beat must be 0 or more quarter notes into the bar`);
      const beat = editBarPosToBeat(barsFrom, bar, beatInBar);
      const fermata = asRecord(raw.fermata);
      if (fermata) {
        const beats = numArg(fermata.beats);
        const stretch = numArg(fermata.stretch);
        if (beats === undefined || beats <= 0 || stretch === undefined || stretch < FERMATA_STRETCH_MIN || stretch > FERMATA_STRETCH_MAX) {
          return fail(`set_meter_map: tempo_map[${i}] fermata needs beats > 0 and stretch ${FERMATA_STRETCH_MIN}-${FERMATA_STRETCH_MAX}`);
        }
        events.push({ beat, bpm: s.bpm, fermata: { beats, stretch } });
        continue;
      }
      const bpm = numArg(raw.bpm);
      if (bpm === undefined || bpm < TEMPO_BPM_MIN || bpm > TEMPO_BPM_MAX) return fail(`set_meter_map: tempo_map[${i}] needs a bpm of ${TEMPO_BPM_MIN}-${TEMPO_BPM_MAX}`);
      const curve = strArg(raw.curve);
      if (curve !== undefined && curve !== 'step' && curve !== 'linear') return fail(`set_meter_map: tempo_map[${i}] curve is "step" (hold) or "linear" (ramp to the next tempo)`);
      events.push({ beat, bpm, curve: curve === 'linear' ? 'linear' : 'step' });
    }
    if (!events.some((e) => !e.fermata && e.beat === 0)) events.push({ beat: 0, bpm: s.bpm, curve: s.tempoMap[0]?.curve ?? 'step' });
    tempoMap = events;
  }

  oneStep(() => {
    if (meterMap) store().setMeterMap(meterMap);
    if (tempoMap) store().setTempoMap(tempoMap);
  });
  return done(`Arrangement time: ${timeMapsText()}`, { meter_map: meterMapOut(), tempo_map: tempoMapOut() });
}

export interface GetMeterMapArgs {
  /** 1-based bars to read from and to (inclusive). */
  from_bar?: unknown;
  to_bar?: unknown;
}

/** The most entries of each map one read returns; from_bar / to_bar page through more. */
const MAX_MAP_ENTRIES = 2000;

/**
 * Read the arrangement's meter map and tempo map back, bars 1-based, in full
 * (the assistant's editor state lists only the first 64 entries of each). A
 * range lists what changes inside it, led by the meter and the tempo event in
 * force where it starts, so a read of bars 200-240 says what bar 200 is in.
 */
export function getMeterMap(args: GetMeterMapArgs = {}): ToolResult {
  const fromBar = numArg(args.from_bar);
  const toBar = numArg(args.to_bar);
  if (fromBar !== undefined && (!Number.isInteger(fromBar) || fromBar < 1)) return fail('get_meter_map: from_bar is a whole bar >= 1');
  if (toBar !== undefined && (!Number.isInteger(toBar) || toBar < (fromBar ?? 1))) return fail('get_meter_map: to_bar is a whole bar at or after from_bar');
  const inRange = (bar: number): boolean => (fromBar === undefined || bar >= fromBar) && (toBar === undefined || bar <= toBar);
  const allMeters = meterMapOut();
  const allTempos = tempoMapOut();
  // What is in force where the range starts: the last change at or before it.
  const leadOf = <T extends { bar: number }>(list: T[]): T[] => {
    if (fromBar === undefined) return [];
    const before = list.filter((e) => e.bar < fromBar);
    return before.length && !list.some((e) => e.bar === fromBar) ? [before[before.length - 1]] : [];
  };
  const meters = [...leadOf(allMeters), ...allMeters.filter((m) => inRange(m.bar))];
  const tempoLead = fromBar === undefined ? [] : allTempos.filter((e) => e.bar < fromBar && !('fermata' in e && e.fermata)).slice(-1);
  const tempos = [...tempoLead, ...allTempos.filter((e) => inRange(e.bar))];
  const s = store();
  const end = s.clips.reduce((m, c) => Math.max(m, c.startSec + c.durationSec), 0);
  const lastBar = end > 0 ? editBarAtSec(timeMaps(), Math.max(0, end - 1e-6)).bar + 1 : 0;
  const shownMeters = meters.slice(0, MAX_MAP_ENTRIES);
  const shownTempos = tempos.slice(0, MAX_MAP_ENTRIES);
  const truncated = shownMeters.length < meters.length || shownTempos.length < tempos.length;
  const range = fromBar !== undefined || toBar !== undefined ? ` in bars ${fromBar ?? 1}-${toBar ?? 'end'}` : '';
  const sample = shownMeters.slice(0, 12).map((m) => `${m.label} from bar ${m.bar}`).join(', ');
  return done(
    `${meters.length} meter entr${meters.length === 1 ? 'y' : 'ies'} and ${tempos.length} tempo event(s)${range}; the clips span ${lastBar} bar(s) at a start tempo of ${editBpmText(s.bpm)} BPM. Meters: ${sample}${shownMeters.length > 12 ? ', …' : ''}${truncated ? `. First ${MAX_MAP_ENTRIES} of each listed; pass from_bar for more` : ''}`,
    {
      meter_map: shownMeters,
      tempo_map: shownTempos,
      meter_changes: allMeters.length,
      tempo_events: allTempos.length,
      start_bpm: s.bpm,
      last_bar: lastBar,
      truncated,
    },
  );
}

export interface NudgeClipArgs extends ClipArgs {
  delta_sec?: unknown;
  beats?: unknown;
  bars?: unknown;
}

/** Move a clip along the timeline. Exactly one unit of distance. */
export function nudgeClip(args: NudgeClipArgs): ToolResult {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);

  const s = store();
  // Beats are the meter's own unit where the clip starts and bars are whole bars
  // of the meter map, both through the tempo map, so "2 bars" from inside a 7/8
  // passage lands two 7/8 bars on, however the tempo moves.
  const at = found.value.startSec;
  const units: Array<[string, number | undefined, (n: number) => number]> = [
    ['delta_sec', numArg(args.delta_sec), (n) => n],
    ['beats', numArg(args.beats), (n) => editMoveByBeats(timeMaps(), at, n) - at],
    ['bars', numArg(args.bars), (n) => editMoveByBars(timeMaps(), at, n) - at],
  ];
  const given = units.filter(([, v]) => v !== undefined);
  if (given.length !== 1) {
    return fail(`nudge_clip: expected exactly one of delta_sec/beats/bars, got ${given.length === 0 ? 'none' : given.map(([k]) => k).join(' and ')}`);
  }

  const [unit, amount, toSec] = given[0];
  const moved = nudgeClipPure(found.value, toSec(amount));
  oneStep(() => s.updateClip(found.value.id, { startSec: moved.startSec }));
  return done(`Moved "${found.value.label}" ${amount} ${unit === 'delta_sec' ? 'second(s)' : unit} to ${n2(moved.startSec)}s`);
}

const TRANSPORT_MISS =
  'the EDIT timeline is not open, so there is no transport to drive — switch to the EDIT workspace and try again';

/** Start playback on the EDIT timeline. */
export function play(): ToolResult {
  if (!isEditorPlaybackRegistered()) return fail(`play: ${TRANSPORT_MISS}`);
  callEditorPlay();
  return done(`Playing from ${n2(store().playheadSec)}s`);
}

/** Stop playback on the EDIT timeline. */
export function stop(): ToolResult {
  if (!isEditorPlaybackRegistered()) return fail(`stop: ${TRANSPORT_MISS}`);
  callEditorStop();
  return done('Stopped');
}

export interface SeekBarArgs {
  bar?: unknown;
}

/** Put the playhead at the top of a bar. Bars are 1-based, as they are on screen. */
export function seekBar(args: SeekBarArgs): ToolResult {
  const bar = numArg(args.bar);
  if (bar === undefined || bar < 1) return fail('seek_bar: pass bar >= 1 (bar 1 is the start of the song)');
  const s = store();
  // The bar's start under the meter map and the tempo map: bar 17 after eight
  // bars of 7/8 is not where sixteen bars of 4/4 would put it.
  const sec = editBarStartSec(timeMaps(), Math.floor(bar) - 1);
  s.setPlayhead(sec);
  const here = editBarAtSec(timeMaps(), sec);
  return done(`Playhead at bar ${bar} (${n2(sec)}s, ${editMeterLabel(here.meter)} at ${editBpmText(editTempoAtSec(s.tempoMap, sec))} bpm)`);
}

export interface LoopSelectionArgs {
  clip_ids?: unknown;
}

/** Set the loop region to span the selected clips. */
export function loopSelection(args: LoopSelectionArgs = {}): ToolResult {
  const s = store();
  let ids: string[];
  if (Array.isArray(args.clip_ids) && args.clip_ids.length) {
    const resolved: string[] = [];
    for (const ref of args.clip_ids) {
      const found = resolveClip(ref);
      if (!found.ok) return fail(found.error);
      resolved.push(found.value.id);
    }
    ids = resolved;
  } else {
    ids = s.selectedClipIds.length ? s.selectedClipIds : (s.selectedClipId ? [s.selectedClipId] : []);
  }
  if (ids.length === 0) return fail('loop_selection: nothing is selected — select clips first, or pass clip_ids');

  const clips = s.clips.filter((c) => ids.includes(c.id));
  if (clips.length === 0) return fail('loop_selection: the selection no longer matches any clip on the timeline');

  const start = Math.min(...clips.map((c) => c.startSec));
  const end = Math.max(...clips.map((c) => c.startSec + c.durationSec));
  s.setLoopRegion(start, end);
  return done(`Looping ${n2(start)}s–${n2(end)}s over ${clips.length} clip(s)`);
}

/* ── clip geometry ───────────────────────────────────────────────────────── */

export interface SetClipArgs extends ClipArgs {
  gain?: unknown;
  fade_in_sec?: unknown;
  fade_out_sec?: unknown;
  muted?: unknown;
  duration_sec?: unknown;
  label?: unknown;
  instrument_program?: unknown;
}

/** Set a clip's playback properties (gain, fades, mute, length, label). */
export function setClip(args: SetClipArgs): ToolResult {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  if (args.instrument_program !== undefined) {
    // Changing the program without re-bouncing would leave `audioBlob` playing
    // the old instrument in every offline export, which is the exact divergence
    // `renderedProgram` exists to prevent.
    return fail('set_clip: use set_clip_instrument for instrument_program — it re-renders the clip audio so exports match playback');
  }

  const patch = {
    gain: numArg(args.gain),
    fadeInSec: numArg(args.fade_in_sec),
    fadeOutSec: numArg(args.fade_out_sec),
    muted: boolArg(args.muted),
    durationSec: numArg(args.duration_sec),
    label: strArg(args.label),
  };
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return fail('set_clip: nothing to change (pass gain, fade_in_sec, fade_out_sec, muted, duration_sec or label)');

  const res = setClipProps(found.value, patch);
  if (!res.ok) return fail(`set_clip: ${res.error}`);

  const updates: Partial<AudioClip> = {};
  for (const key of keys) updates[key] = res.value[key];
  oneStep(() => store().updateClip(found.value.id, updates));
  return done(`Updated "${found.value.label}": ${keys.map((k) => `${k}=${String(updates[k])}`).join(', ')}`);
}

export interface TrimArgs extends ClipArgs {
  in_sec?: unknown;
  out_sec?: unknown;
}

/** Move a clip's in and/or out point, in timeline seconds. */
export function trimClip(args: TrimArgs): ToolResult {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const inSec = numArg(args.in_sec);
  const outSec = numArg(args.out_sec);
  if (inSec === undefined && outSec === undefined) return fail('trim: pass in_sec and/or out_sec (timeline seconds)');

  const next = trimClipPure(found.value, { inSec, outSec });
  oneStep(() => store().updateClip(found.value.id, {
    startSec: next.startSec,
    durationSec: next.durationSec,
    offsetIntoSource: next.offsetIntoSource,
  }));
  return done(
    `Trimmed "${found.value.label}" to ${n2(next.startSec)}s–${n2(next.startSec + next.durationSec)}s (${n2(next.durationSec)}s long)`,
  );
}

export interface DuplicateClipArgs extends ClipArgs {
  at_sec?: unknown;
}

/** Copy a clip, by default butt-joined onto the end of the original. */
export function duplicateClip(args: DuplicateClipArgs): ToolResult {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const copy = duplicateClipPure(found.value, { newId: uid(), at: numArg(args.at_sec) });
  const id = oneStep(() => store().addClipToTrack(copy));
  return done(`Duplicated "${found.value.label}" to ${n2(copy.startSec)}s`, { clipId: id });
}

export interface MergeArgs extends RenderArgs {
  clip_ids?: unknown;
}

/**
 * Concatenate two or more clips on one track into a single audio clip.
 *
 * Each part is reduced to its audible window with its fades and gain baked in
 * (a muted part contributes silence), because concatenation flattens the clip
 * records away and anything still living on them would be lost.
 */
export async function mergeClips(args: MergeArgs): Promise<ToolResult> {
  if (!Array.isArray(args.clip_ids) || args.clip_ids.length < 2) return fail('merge: pass clip_ids, at least two of them');
  const clips: AudioClip[] = [];
  for (const ref of args.clip_ids) {
    const found = resolveClip(ref);
    if (!found.ok) return fail(found.error);
    if (clips.some((c) => c.id === found.value.id)) return fail(`merge: "${found.value.label}" was listed twice`);
    clips.push(found.value);
  }

  const plan = mergePlan(clips);
  if (!plan.ok) return fail(`merge: ${plan.error}`);

  const ordered = plan.value.order.map((id) => clips.find((c) => c.id === id));
  let merged: { blob: Blob; duration: number };
  try {
    const parts: Blob[] = [];
    for (const clip of ordered) {
      const window = await extractWindow(clip, args);
      const baked = await applyFadesToBlob(
        window,
        { fadeInSec: clip.fadeInSec, fadeOutSec: clip.fadeOutSec, gain: clip.muted ? 0 : clipPeakGain(clip) },
        args.ctxFactory,
        { sampleRate: rateOf(args) },
      );
      parts.push(baked.blob);
    }
    merged = await concatBlobs(parts, plan.value.gaps, args.ctxFactory, { sampleRate: rateOf(args) });
  } catch (e) {
    return fail(`merge: ${reason(e)}`);
  }

  // Every part is rechecked before ANY of them is consumed: a merge that ate
  // two parts and then found the third had moved could not be undone cleanly.
  const currentParts: AudioClip[] = [];
  for (const part of ordered) {
    const current = recheck(part, MERGE_INPUTS);
    if (!current.ok) return fail(`merge: ${current.error}`);
    currentParts.push(current.value);
  }

  const first = currentParts[0];
  const s = store();
  // ONE UNDO STEP: N removes and one add, grouped (see oneStep).
  const id = oneStep(() => {
    for (const clip of currentParts) s.removeClip(clip.id);
    return s.addClipToTrack({
      trackId: plan.value.trackId,
      label: `${first.label} (merged)`,
      audioBlob: merged.blob,
      mimeType: 'audio/wav',
      sourceDuration: merged.duration,
      offsetIntoSource: 0,
      durationSec: merged.duration,
      startSec: first.startSec,
      color: first.color,
    });
  });
  return done(
    `Merged ${ordered.length} clips into "${first.label} (merged)" — ${n2(merged.duration)}s from ${n2(first.startSec)}s`,
    { clipId: id },
  );
}

export interface CrossfadeArgs {
  clip_a?: unknown;
  clip_b?: unknown;
  overlap_sec?: unknown;
}

/**
 * Crossfade two touching or overlapping clips. Symmetric fades across the
 * overlap; the later clip slides back to where the overlap begins.
 */
export function crossfadeClips(args: CrossfadeArgs): ToolResult {
  const a = resolveClip(args.clip_a);
  if (!a.ok) return fail(a.error);
  const b = resolveClip(args.clip_b);
  if (!b.ok) return fail(b.error);
  // Checked before anything else: clips on two tracks can abut perfectly on the
  // timeline and still be heard SIMULTANEOUSLY rather than in sequence, so
  // `crossfadePlan`'s gap test passes and would happily fade and slide them.
  if (a.value.trackId !== b.value.trackId) return fail('both clips must be on the same track to crossfade');
  const overlapSec = numArg(args.overlap_sec);
  if (overlapSec === undefined) return fail('crossfade: pass overlap_sec');

  const plan = crossfadePlan(a.value, b.value, { overlapSec });
  if (!plan.ok) return fail(`crossfade: ${plan.error}`);

  const s = store();
  // ONE UNDO STEP: both clips, grouped (see oneStep).
  oneStep(() => {
    s.updateClip(plan.value.first.id, { fadeOutSec: plan.value.first.fadeOutSec });
    s.updateClip(plan.value.second.id, {
      fadeInSec: plan.value.second.fadeInSec,
      startSec: plan.value.second.startSec,
    });
  });
  return done(`Crossfaded over ${n2(plan.value.overlapSec)}s at ${n2(plan.value.second.startSec)}s`);
}

/** A clip whose audio may be edited in the sample domain. */
const resolveAudioEditable = (ref: unknown, what: string): Found<AudioClip> => {
  const found = resolveClip(ref);
  if (!found.ok) return found;
  const clip = found.value;
  if (clip.sourceKind === 'piano-roll' && clip.sourcePianoRoll?.length) {
    return {
      ok: false,
      error: `"${clip.label}" is a MIDI clip: live playback re-synthesises it from its notes, so ${what} the rendered audio would only change exports. Bounce it first (bounce with flatten) to make it a plain audio clip.`,
    };
  }
  return { ok: true, value: clip };
};

/** Play a clip's audio backwards. */
export async function reverseClip(args: ClipArgs & RenderArgs): Promise<ToolResult> {
  const found = resolveAudioEditable(clipRef(args), 'reversing');
  if (!found.ok) return fail(found.error);
  const clip = found.value;
  try {
    const window = await extractWindow(clip, args);
    const rendered = await reverseBlob(window, args.ctxFactory, { sampleRate: rateOf(args) });
    const current = recheck(clip, AUDIO_INPUTS);
    if (!current.ok) return fail(current.error);
    commitAudio(current.value, rendered.blob, rendered.duration);
    return done(`Reversed "${clip.label}" (${n2(rendered.duration)}s)`);
  } catch (e) {
    return fail(`reverse: ${reason(e)}`);
  }
}

export interface NormalizeArgs extends ClipArgs, RenderArgs {
  peak_db?: unknown;
}

/** Scale a clip so its loudest sample lands on `peak_db` (default -1 dBFS). */
export async function normalizeClip(args: NormalizeArgs): Promise<ToolResult> {
  const found = resolveAudioEditable(clipRef(args), 'normalizing');
  if (!found.ok) return fail(found.error);
  const peakDb = numArg(args.peak_db) ?? -1;
  if (peakDb > 0) return fail('normalize: peak_db must be <= 0 (it is dBFS; 0 is full scale)');

  const clip = found.value;
  try {
    const window = await extractWindow(clip, args);
    const rendered = await normalizeBlob(window, { peakDb }, args.ctxFactory, { sampleRate: rateOf(args) });
    const current = recheck(clip, AUDIO_INPUTS);
    if (!current.ok) return fail(current.error);
    commitAudio(current.value, rendered.blob, rendered.duration);
    return done(`Normalized "${clip.label}" to ${peakDb} dBFS`);
  } catch (e) {
    return fail(`normalize: ${reason(e)}`);
  }
}

export interface BounceArgs extends ClipArgs, RenderArgs {
  /** Also drop the note list, turning a MIDI clip into a plain audio clip. */
  flatten?: unknown;
}

/**
 * Make a clip's `audioBlob` equal what the clip actually sounds like.
 *
 * For a MIDI clip that is a re-synthesis of its notes; for an audio clip it
 * bakes the fade envelope and clip gain into the samples and resets them to
 * neutral. Either way the blob every offline export path reads stops needing
 * anything else applied on top of it.
 */
export async function bounceClip(args: BounceArgs): Promise<ToolResult> {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;
  const flatten = boolArg(args.flatten) ?? false;

  if (clip.sourceKind === 'piano-roll' && clip.sourcePianoRoll?.length) {
    // Flatten rides in the re-bounce's own updateClip rather than a second write
    // after it: one write is one undo step by construction, instead of relying
    // on two writes landing inside the store's coalescing window.
    const written = await commitNotes(
      clip,
      clip.sourcePianoRoll.map((n) => ({ ...n })),
      args,
      undefined,
      flatten ? { sourceKind: 'audio', sourcePianoRoll: undefined, sourceTotalSteps: undefined } : {},
      { render: 'always' },
    );
    if (!written.ok) return fail(written.error);
    return done(
      `Bounced "${clip.label}" — ${clip.sourcePianoRoll.length} notes rendered to ${n2(written.value.duration)}s of audio${flatten ? ', now a plain audio clip' : ''}${written.value.lengthNote}`,
    );
  }

  try {
    const window = await extractWindow(clip, args);
    const rendered = await applyFadesToBlob(
      window,
      { fadeInSec: clip.fadeInSec, fadeOutSec: clip.fadeOutSec, gain: clipPeakGain(clip) },
      args.ctxFactory,
      { sampleRate: rateOf(args) },
    );
    const current = recheck(clip, BOUNCE_INPUTS);
    if (!current.ok) return fail(current.error);
    commitAudio(current.value, rendered.blob, rendered.duration, { fadeInSec: 0, fadeOutSec: 0, gain: 1 });
    return done(`Bounced "${clip.label}" — fades and gain printed into ${n2(rendered.duration)}s of audio`);
  } catch (e) {
    return fail(`bounce: ${reason(e)}`);
  }
}

/* ── selection + tools ───────────────────────────────────────────────────── */

export interface SelectClipsArgs {
  clip_ids?: unknown;
}

/** Replace the timeline's clip selection. */
export function selectClips(args: SelectClipsArgs): ToolResult {
  if (!Array.isArray(args.clip_ids)) return fail('select_clips: pass clip_ids as an array (an empty array clears the selection)');
  const ids: string[] = [];
  const labels: string[] = [];
  for (const ref of args.clip_ids) {
    const found = resolveClip(ref);
    if (!found.ok) return fail(found.error);
    ids.push(found.value.id);
    labels.push(found.value.label);
  }
  store().setSelectedClips(ids);
  publishSelectedClips(store().selectedClipIds);
  return done(ids.length ? `Selected ${ids.length} clip(s): ${labels.join(', ')}` : 'Cleared the clip selection', { clipIds: store().selectedClipIds });
}

export interface SelectRangeArgs {
  start_sec?: unknown;
  end_sec?: unknown;
  track_ids?: unknown;
}

/** Select every clip that overlaps a span of the timeline. */
export function selectRange(args: SelectRangeArgs): ToolResult {
  const startSec = numArg(args.start_sec);
  const endSec = numArg(args.end_sec);
  if (startSec === undefined || endSec === undefined) return fail('select_range: pass start_sec and end_sec');

  let trackIds: string[] | undefined;
  if (Array.isArray(args.track_ids)) {
    trackIds = [];
    for (const ref of args.track_ids) {
      const found = resolveTrack(ref);
      if (!found.ok) return fail(found.error);
      trackIds.push(found.value.id);
    }
  }

  const ids = selectRangePure(store().clips, { startSec, endSec, trackIds });
  store().setSelectedClips(ids);
  publishSelectedClips(ids);
  return done(`Selected ${ids.length} clip(s) between ${n2(Math.min(startSec, endSec))}s and ${n2(Math.max(startSec, endSec))}s`, { clipIds: ids });
}

/**
 * Note selection lives here rather than in the store: no part of the app renders
 * it yet (the piano roll has its own single-note field), so putting it in the
 * document would be inventing state nothing reads. Tools that operate on "the
 * selected notes" read it back through {@link getSelectedNotes}.
 */
let selectedNotes: { clipId: string | null; noteIds: string[] } = { clipId: null, noteIds: [] };

export const getSelectedNotes = (): { clipId: string | null; noteIds: string[] } => ({
  clipId: selectedNotes.clipId,
  noteIds: selectedNotes.noteIds.slice(),
});

export interface SelectNotesArgs extends ClipArgs {
  note_ids?: unknown;
  min_pitch?: unknown;
  max_pitch?: unknown;
  start_step?: unknown;
  end_step?: unknown;
}

/** Select notes inside a MIDI clip, by id or by pitch/step window. */
export function selectNotes(args: SelectNotesArgs): ToolResult {
  const found = resolveMidiClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;

  if (Array.isArray(args.note_ids)) {
    const ids: string[] = [];
    for (const ref of args.note_ids) {
      const id = strArg(ref);
      if (!id || !clip.sourcePianoRoll.some((n) => n.id === id)) {
        return fail(`select_notes: "${String(ref)}" is not a note in "${clip.label}"`);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    selectedNotes = { clipId: clip.id, noteIds: ids };
    return done(`Selected ${ids.length} note(s) in "${clip.label}"`, { clipId: clip.id, noteIds: ids });
  }

  const minPitch = numArg(args.min_pitch);
  const maxPitch = numArg(args.max_pitch);
  const startStep = numArg(args.start_step);
  const endStep = numArg(args.end_step);
  if (minPitch === undefined && maxPitch === undefined && startStep === undefined && endStep === undefined) {
    return fail('select_notes: pass note_ids, or a filter (min_pitch, max_pitch, start_step, end_step)');
  }

  const ids = clip.sourcePianoRoll
    .filter((n) => {
      if (minPitch !== undefined && n.note < minPitch) return false;
      if (maxPitch !== undefined && n.note > maxPitch) return false;
      // Half-open in step space: a note that ends exactly where the window
      // begins shares an instant with it, not a span.
      if (startStep !== undefined && n.step + n.length <= startStep) return false;
      if (endStep !== undefined && n.step >= endStep) return false;
      return true;
    })
    .map((n) => n.id);

  selectedNotes = { clipId: clip.id, noteIds: ids };
  return done(`Selected ${ids.length} of ${clip.sourcePianoRoll.length} note(s) in "${clip.label}"`, { clipId: clip.id, noteIds: ids });
}

export interface SnapArgs {
  snap?: unknown;
  grid?: unknown;
}

/** Set the timeline's snap division. */
export function setSnap(args: SnapArgs): ToolResult {
  const snap = strArg(args.snap ?? args.grid) as SnapDivision;
  if (!snap || !SNAP_DIVISIONS.includes(snap)) {
    return fail(`set_snap: "${strArg(args.snap ?? args.grid) ?? ''}" is not a snap division. Use one of: ${SNAP_DIVISIONS.join(', ')}`);
  }
  store().setSnap(snap);
  return done(`Snap is now ${snap}`);
}

export interface ToolArgs {
  tool?: unknown;
}

const TOOL_MODES: ToolMode[] = ['move', 'cut', 'split'];

/** Set the timeline's active mouse tool. */
export function setTool(args: ToolArgs): ToolResult {
  const tool = strArg(args.tool) as ToolMode;
  if (!tool || !TOOL_MODES.includes(tool)) return fail(`set_tool: tool must be one of ${TOOL_MODES.join(', ')}`);
  store().setTool(tool);
  return done(`Tool is now "${tool}"`);
}

/* ── tracks ──────────────────────────────────────────────────────────────── */

const FREEZE_PATH =
  'freezing prints a track to a stem through the offline renderer that lives in the EDIT timeline, which this layer cannot reach — use the freeze button in the EDIT track header (next to the "F" insert-FX button; it appears once the track has a VST3 insert)';

export interface SetTrackArgs {
  track_id?: unknown;
  track?: unknown;
  name?: unknown;
  volume?: unknown;
  pan?: unknown;
  mute?: unknown;
  solo?: unknown;
  armed?: unknown;
  frozen?: unknown;
  instrument_program?: unknown;
  /** true: a drum track (instrument_program is a kit), false: melodic (a GM program). Omitted: the track's kind. */
  drums?: unknown;
}

/** Set a track's mixer state, arm, default instrument (and its kind: drums or melodic), or unfreeze it. */
export function setTrack(args: SetTrackArgs): ToolResult {
  const found = resolveTrack(args.track_id ?? args.track);
  if (!found.ok) return fail(found.error);
  const track = found.value;
  const s = store();

  const updates: Partial<EditorTrack> = {};
  const changed: string[] = [];

  const name = strArg(args.name);
  if (name !== undefined) {
    updates.name = name;
    updates.nameAutoGenerated = false;
    changed.push(`name="${name}"`);
  }

  const volume = numArg(args.volume);
  if (volume !== undefined) {
    if (volume < 0 || volume > 1) return fail('set_track: volume must be between 0 and 1');
    updates.volume = volume;
    changed.push(`volume=${volume}`);
  }

  const pan = numArg(args.pan);
  if (pan !== undefined) {
    if (pan < -1 || pan > 1) return fail('set_track: pan must be between -1 and 1');
    updates.pan = pan;
    changed.push(`pan=${pan}`);
  }

  const mute = boolArg(args.mute);
  if (mute !== undefined) {
    updates.mute = mute;
    changed.push(`mute=${mute}`);
  }

  const armed = boolArg(args.armed);
  if (armed !== undefined) {
    updates.armed = armed;
    changed.push(`armed=${armed}`);
  }

  const program = numArg(args.instrument_program);
  if (program !== undefined && (!Number.isInteger(program) || program < 0 || program > 127)) {
    return fail('set_track: instrument_program must be an integer 0-127 (a GM program, or a drum kit number on a drum track)');
  }
  // `drums` names the kind of the choice, so the program and the drum flag land together (editorStore
  // setTrackVoice: a flip clears the clips' own programs, logs a LOG line). Without it the program is
  // read in the track's own kind, as it always was: a kit number on a drum track, a GM program otherwise.
  const drums = boolArg(args.drums);
  let voice: { program: number | undefined; drums: boolean } | null = null;
  if (drums !== undefined) {
    const sameKind = (track.isPercussion === true) === drums;
    voice = { program: program ?? (sameKind ? track.instrumentProgram : undefined), drums };
    changed.push(`drums=${drums}`);
    if (program !== undefined) changed.push(`instrument_program=${program}`);
  } else if (program !== undefined) {
    updates.instrumentProgram = program;
    changed.push(`instrument_program=${program}`);
  }

  const frozen = boolArg(args.frozen);
  // Without this the call falls through with nothing to change and reports
  // "Updated track ...:" with an empty list, which reads as work done.
  if (frozen === true && track.frozenOriginal) return fail(`set_track: "${track.name}" is already frozen`);
  if (frozen === true && !track.frozenOriginal) return fail(`set_track: ${FREEZE_PATH}`);
  if (frozen === false && !track.frozenOriginal) return fail(`set_track: "${track.name}" is not frozen`);

  const solo = boolArg(args.solo);
  if (solo === undefined && frozen === undefined && changed.length === 0) {
    return fail('set_track: nothing to change (pass name, volume, pan, mute, solo, armed, frozen, instrument_program or drums)');
  }

  // ONE UNDO STEP: updateTrack, setTrackVoice, toggleSolo and unfreezeTrack, grouped (see oneStep).
  oneStep(() => {
    if (Object.keys(updates).length) s.updateTrack(track.id, updates);
    if (voice) s.setTrackVoice(track.id, voice.program, voice.drums);
    // Solo is exclusive in this store, so it has to go through toggleSolo rather
    // than a plain field write — otherwise two tracks could both claim it.
    if (solo !== undefined && solo !== track.solo) {
      s.toggleSolo(track.id);
      changed.push(`solo=${solo}`);
    }
    if (frozen === false) {
      s.unfreezeTrack(track.id);
      changed.push('unfrozen');
    }
  });
  return done(`Updated track "${track.name}": ${changed.join(', ')}`);
}

export interface ReorderTracksArgs {
  track_ids?: unknown;
}

/** Reorder tracks. A partial list moves those tracks to the top, in that order. */
export function reorderTracks(args: ReorderTracksArgs): ToolResult {
  if (!Array.isArray(args.track_ids) || args.track_ids.length === 0) {
    return fail('reorder_tracks: pass track_ids, top first (a partial list moves those tracks to the top)');
  }
  const ids: string[] = [];
  const names: string[] = [];
  for (const ref of args.track_ids) {
    const found = resolveTrack(ref);
    if (!found.ok) return fail(found.error);
    if (ids.includes(found.value.id)) return fail(`reorder_tracks: "${found.value.name}" was listed twice`);
    ids.push(found.value.id);
    names.push(found.value.name);
  }
  oneStep(() => store().reorderTracks(ids));
  return done(`Track order is now: ${store().tracks.map((t) => t.name).join(', ')}`, { order: store().tracks.map((t) => t.id) });
}

export interface TrackArgs {
  track_id?: unknown;
  track?: unknown;
}

/** Copy a track and its clips. */
export function duplicateTrack(args: TrackArgs): ToolResult {
  const found = resolveTrack(args.track_id ?? args.track);
  if (!found.ok) return fail(found.error);
  const id = oneStep(() => store().duplicateTrack(found.value.id));
  if (!id) return fail(`duplicate_track: "${found.value.name}" could not be copied`);
  const copies = store().clips.filter((c) => c.trackId === id).length;
  return done(`Duplicated track "${found.value.name}" with ${copies} clip(s)`, { trackId: id });
}

/** Freezing needs the timeline's offline renderer; this layer cannot do it. */
export function freezeTrack(args: TrackArgs): ToolResult {
  const found = resolveTrack(args.track_id ?? args.track);
  if (!found.ok) return fail(found.error);
  if (found.value.frozenOriginal) return fail(`freeze_track: "${found.value.name}" is already frozen (set_track with frozen=false unfreezes it)`);
  return fail(`freeze_track: ${FREEZE_PATH}`);
}

/* ── markers ─────────────────────────────────────────────────────────────── */

export interface MarkerArgs {
  marker_id?: unknown;
  marker?: unknown;
  name?: unknown;
  label?: unknown;
}

const resolveMarker = (args: MarkerArgs) =>
  resolveOne(
    args.marker_id ?? args.marker ?? args.name,
    store().markers,
    (m) => m.id,
    (m) => m.label,
    'marker',
  );

/** Delete a timeline marker. */
export function removeMarker(args: MarkerArgs): ToolResult {
  const found = resolveMarker(args);
  if (!found.ok) return fail(found.error);
  oneStep(() => store().removeMarker(found.value.id));
  return done(`Removed marker "${found.value.label}" at ${n2(found.value.t)}s`);
}

/** Rename a timeline marker. */
export function renameMarker(args: MarkerArgs): ToolResult {
  const found = resolveMarker(args);
  if (!found.ok) return fail(found.error);
  const label = strArg(args.label);
  if (!label) return fail('rename_marker: pass label');
  oneStep(() => store().renameMarker(found.value.id, label));
  return done(`Renamed marker "${found.value.label}" to "${label}"`);
}

/* ── automation ──────────────────────────────────────────────────────────── */

const AUTOMATION_KINDS: AutomationTargetKind[] = ['trackVolume', 'trackPan', 'trackFx', 'masterFx', 'trackMidiCc'];

export interface AutomationTargetArgs {
  lane_id?: unknown;
  kind?: unknown;
  track_id?: unknown;
  track?: unknown;
  entry_id?: unknown;
  param_key?: unknown;
}

/** Resolve a lane target AND the parameter's current value, so a new lane can
 *  start by holding what the parameter is set to right now. */
function resolveTarget(args: AutomationTargetArgs): Found<{ target: AutomationTarget; current: number; label: string }> {
  const kind = strArg(args.kind) as AutomationTargetKind;
  if (!kind || !AUTOMATION_KINDS.includes(kind)) {
    return { ok: false, error: `automation: kind must be one of ${AUTOMATION_KINDS.join(', ')}` };
  }

  if (kind === 'trackVolume' || kind === 'trackPan') {
    const found = resolveTrack(args.track_id ?? args.track);
    if (!found.ok) return { ok: false, error: found.error };
    const current = kind === 'trackVolume' ? found.value.volume : found.value.pan;
    return {
      ok: true,
      value: { target: { kind, trackId: found.value.id }, current, label: `${found.value.name} ${kind === 'trackVolume' ? 'volume' : 'pan'}` },
    };
  }

  if (kind === 'trackMidiCc') {
    // param_key is the controller number: one a roll part keeps, 0-127 values.
    const found = resolveTrack(args.track_id ?? args.track);
    if (!found.ok) return { ok: false, error: found.error };
    const cc = midiCcOfTarget({ kind, trackId: found.value.id, paramKey: strArg(args.param_key) ?? String(numArg(args.param_key) ?? '') });
    if (cc === null) {
      return { ok: false, error: `automation: trackMidiCc needs param_key, one of the controllers ${PART_CONTROLLERS.map((c) => `${c.controller} (${c.name})`).join(', ')}` };
    }
    return {
      ok: true,
      value: { target: midiCcTarget(found.value.id, cc), current: partController(cc)?.initial ?? 0, label: `${found.value.name} MIDI CC ${cc} ${partController(cc)?.name ?? ''}`.trim() },
    };
  }

  const entryId = strArg(args.entry_id);
  const paramKey = strArg(args.param_key);
  if (!entryId || !paramKey) return { ok: false, error: `automation: ${kind} needs entry_id and param_key` };

  let chain = store().masterFxChain;
  let trackId: string | undefined;
  let owner = 'the master bus';
  if (kind === 'trackFx') {
    const found = resolveTrack(args.track_id ?? args.track);
    if (!found.ok) return { ok: false, error: found.error };
    chain = found.value.fxChain ?? [];
    trackId = found.value.id;
    owner = `track "${found.value.name}"`;
  }

  const entry = chain.find((e) => e.id === entryId);
  if (!entry) {
    return { ok: false, error: `automation: ${owner} has no FX entry "${entryId}". Entries: ${chain.map((e) => `${e.effect} (${e.id})`).join(', ') || 'none'}` };
  }
  const current = entry.params?.[paramKey];
  if (typeof current !== 'number') {
    return { ok: false, error: `automation: "${entry.effect}" has no numeric param "${paramKey}". Params: ${Object.keys(entry.params ?? {}).join(', ') || 'none'}` };
  }
  return { ok: true, value: { target: { kind, trackId, entryId, paramKey }, current, label: `${owner} ${entry.effect}.${paramKey}` } };
}

/**
 * Create an automation lane for a parameter (or report the one that exists).
 *
 * The store has no "empty lane" action — `recordAutomationPoint` is what mints a
 * lane — so a new lane is born holding the parameter's CURRENT value. That is
 * also the only starting shape that does not change what the mix sounds like
 * the moment the lane appears.
 */
export function addAutomationLane(args: AutomationTargetArgs): ToolResult {
  const resolved = resolveTarget(args);
  if (!resolved.ok) return fail(resolved.error);
  const s = store();

  const existing = s.getLaneForTarget(resolved.value.target);
  if (existing) return done(`${resolved.value.label} already has an automation lane (${existing.points.length} point(s))`, { laneId: existing.id });

  oneStep(() => s.recordAutomationPoint(resolved.value.target, 0, resolved.value.current));
  const lane = store().getLaneForTarget(resolved.value.target);
  if (!lane) return fail(`add_automation_lane: the lane for ${resolved.value.label} was not created`);
  return done(`Added an automation lane for ${resolved.value.label}, holding its current value (${resolved.value.current})`, { laneId: lane.id });
}

export interface SetAutomationPointsArgs extends AutomationTargetArgs {
  points?: unknown;
}

/** Replace a lane's breakpoints. */
export function setAutomationPoints(args: SetAutomationPointsArgs): ToolResult {
  const s = store();
  let lane: AutomationLane | undefined;
  let label: string;

  const laneId = strArg(args.lane_id);
  if (laneId) {
    lane = s.automationLanes.find((l) => l.id === laneId);
    if (!lane) {
      return fail(`set_automation_points: no lane "${laneId}". Lanes: ${s.automationLanes.map((l) => `${l.target.kind} (${l.id})`).join(', ') || 'none'}`);
    }
    label = `${lane.target.kind} lane ${lane.id}`;
  } else {
    const resolved = resolveTarget(args);
    if (!resolved.ok) return fail(resolved.error);
    lane = s.getLaneForTarget(resolved.value.target);
    if (!lane) return fail(`set_automation_points: ${resolved.value.label} has no automation lane yet — add_automation_lane first`);
    label = resolved.value.label;
  }

  if (!Array.isArray(args.points) || args.points.length === 0) {
    return fail('set_automation_points: pass points as a non-empty array of { t, v }');
  }
  const points: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < args.points.length; i += 1) {
    const raw = args.points[i] as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return fail(`set_automation_points: point ${i} is not an object`);
    const t = numArg(raw.t ?? raw.time ?? raw.sec);
    const v = numArg(raw.v ?? raw.value);
    if (t === undefined || t < 0) return fail(`set_automation_points: point ${i} needs t >= 0 (timeline seconds)`);
    if (v === undefined) return fail(`set_automation_points: point ${i} needs a finite v`);
    points.push({ t, v });
  }
  points.sort((a, b) => a.t - b.t);

  // ONE UNDO STEP: the clear and every breakpoint, grouped (see oneStep).
  oneStep(() => {
    s.clearAutomationLane(lane.id);
    for (const p of points) s.addAutomationPoint(lane.id, p.t, p.v);
  });

  // The store thins breakpoints closer together than MIN_POINT_DT, so report
  // what actually landed rather than what was asked for.
  const written = store().automationLanes.find((l) => l.id === lane.id)?.points.length ?? 0;
  const thinned = points.length - written;
  return done(
    `Wrote ${written} breakpoint(s) to ${label}${thinned > 0 ? ` (${thinned} were closer than the 20ms minimum and merged)` : ''}`,
    { laneId: lane.id, points: written },
  );
}

/* ── history ─────────────────────────────────────────────────────────────── */

/** Step one edit backwards. */
export function undo(): ToolResult {
  const before = store()._undo.length;
  if (before === 0) return fail('undo: there is nothing left to undo');
  store().undo();
  return done(`Undone. ${store()._undo.length} step(s) of history left.`);
}

/** Step one edit forwards again. */
export function redo(): ToolResult {
  if (store()._redo.length === 0) return fail('redo: there is nothing to redo');
  store().redo();
  return done(`Redone. ${store()._redo.length} step(s) still ahead.`);
}

export interface SnapshotArgs {
  name?: unknown;
}

/** Bookmark the whole document under a name, outside undo history. */
export function snapshot(args: SnapshotArgs): ToolResult {
  const name = strArg(args.name);
  if (!name) return fail('snapshot: pass a name');
  const s = store();
  const replacing = name in s.snapshots;
  s.takeSnapshot(name);
  return done(
    `${replacing ? 'Replaced' : 'Took'} snapshot "${name}" — ${s.tracks.length} track(s), ${s.clips.length} clip(s) at ${s.bpm} bpm`,
    { snapshots: store().listSnapshots() },
  );
}

/** Put a named snapshot back. Undoable. */
export function restore(args: SnapshotArgs): ToolResult {
  const name = strArg(args.name);
  if (!name) return fail('restore: pass a name');
  const known = store().listSnapshots();
  if (!oneStep(() => store().restoreSnapshot(name))) {
    return fail(`restore: no snapshot called "${name}". Snapshots: ${known.join(', ') || 'none'}`);
  }
  const s = store();
  return done(`Restored snapshot "${name}" — ${s.tracks.length} track(s), ${s.clips.length} clip(s) at ${s.bpm} bpm`);
}

/** The names of every snapshot taken this session. */
export function listSnapshots(): ToolResult {
  const names = store().listSnapshots();
  return done(names.length ? `Snapshots: ${names.join(', ')}` : 'No snapshots have been taken yet', { snapshots: names });
}

/* ── roll parts ──────────────────────────────────────────────────────────────
   An EDIT MIDI clip is one part of a score: one instrument, its notes with
   their polymeter lanes, its meter map, pickup and grid. These tools make a
   part, list the parts, read one whole and write one back, so the assistant
   can write an orchestra part by part. Bars are 1-based, as on screen. A part
   plays live on EDIT's synths and renders when an export needs its audio
   (lib/midiRender). */

/** The longest part a tool makes or sets, in bars. */
const MAX_PART_BARS = 4096;
/** The most notes one read returns; `from_bar` / `to_bar` page through more. */
const MAX_PART_NOTES = 4000;

const gmName = (program: number): string => GM_NAMES[program] ?? `Program ${program + 1}`;

/**
 * How many bars a part's grid of `totalSteps` covers after its pickup: the bar
 * that holds its last quarter step, counted from 1 (a grid that ends inside a
 * bar counts that bar). A quarter step is shorter than the shortest bar (1/32,
 * half a step) and far wider than meterMap's float tolerance, which a
 * `totalSteps - 1e-9` probe fell inside, counting the bar after the end.
 */
const partBars = (meterMap: readonly MeterSegment[], totalSteps: number, pickup: number): number =>
  totalSteps <= pickup + 1e-9 ? 0 : barAt(meterMap, Math.max(pickup, totalSteps - 0.25), pickup).bar + 1;

/**
 * The render state of a part, in the words its menu uses: whether it plays
 * live when heard (the plan play() makes, a muted part read as if unmuted, as
 * EDIT's clip header reads it) and why it holds a render.
 */
const partRender = (clip: AudioClip): { state: string; text: string } => {
  const state = partRenderState(clip);
  return { state, text: midiRenderStateText(state, playsLiveAs(clip), clip.renderAuto === true && !!clip.audioBlob) };
};

/** A part's render state alone: 'none', 'current' or 'stale' (lib/midiRender). */
const partRenderState = (clip: AudioClip) =>
  midiRenderState(clip, store().tracks.find((t) => t.id === clip.trackId), midiGlobalVoice());

export interface CreateMidiClipArgs {
  /** The track to put the part on (id or name). Absent: a new track for it. */
  track_id?: unknown;
  /** The new track's name; defaults to the instrument's. */
  track_name?: unknown;
  /** GM program 0-127; on a percussion part the kit. Default: the instrument of the track `track_id` names. */
  program?: unknown;
  /** A drum part: the new track plays on the drum channel. With `track_id` it
   *  must agree with that track (a drum track holds drum parts only). */
  percussion?: unknown;
  /** 1-based arrangement bar the part starts on (default 1). */
  start_bar?: unknown;
  /** Or the timeline second it starts at. */
  start_sec?: unknown;
  /** Length in bars (default 4). */
  bars?: unknown;
  label?: unknown;
}

/**
 * Make an empty MIDI clip: a part with an instrument, the arrangement's meters
 * and tempo from where it starts, `bars` bars long. It plays live on its
 * instrument, so nothing is rendered. One undo step (a new track included).
 *
 * Whether the part plays on the drum channel is the track's to say
 * (lib/clipProgram clipVoice reads `isPercussion` off the track), so a part on
 * `track_id` is a drum part exactly when that track is a drum track. A
 * `percussion` that disagrees with the track is refused with the reason: on a
 * melodic track the part would play a melodic program under a kit's name, and
 * the drum pitches written into it would sound as notes.
 */
export function createMidiClip(args: CreateMidiClipArgs): ToolResult {
  const percussionArg = boolArg(args.percussion);
  const programArg = numArg(args.program);
  if (programArg !== undefined && (!Number.isInteger(programArg) || programArg < 0 || programArg > 127)) {
    return fail('create_midi_clip: program must be a whole GM program 0-127');
  }
  const bars = numArg(args.bars) ?? 4;
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_PART_BARS) return fail(`create_midi_clip: bars must be a whole number 1-${MAX_PART_BARS}`);
  const startBar = numArg(args.start_bar);
  const startSecArg = numArg(args.start_sec);
  if (startBar !== undefined && startSecArg !== undefined) return fail('create_midi_clip: pass start_bar or start_sec, not both');
  if (startBar !== undefined && (!Number.isInteger(startBar) || startBar < 1)) return fail('create_midi_clip: start_bar is a whole bar >= 1 (bar 1 is the start)');
  if (startSecArg !== undefined && startSecArg < 0) return fail('create_midi_clip: start_sec must be 0 or more');

  let track: EditorTrack | undefined;
  if (args.track_id !== undefined && args.track_id !== null && args.track_id !== '') {
    const found = resolveTrack(args.track_id);
    if (!found.ok) return fail(found.error);
    track = found.value;
  }
  if (track && percussionArg === true && !isPercussionTrack(track)) {
    return fail(`create_midi_clip: "${track.name}" is a melodic track, so a part on it plays its instrument and not a kit. Leave out track_id to put the drum part on a new drum track, or pass a drum track`);
  }
  if (track && percussionArg === false && isPercussionTrack(track)) {
    return fail(`create_midi_clip: "${track.name}" is a drum track, so a part on it plays a kit. Leave out track_id to put the part on a new track of its own, or pass a melodic track`);
  }
  // The track that holds the part decides the drum channel; a new track is a drum track when asked.
  const drums = track ? isPercussionTrack(track) : percussionArg === true;
  // The program named, else the target track's instrument, else (a drum part) the Standard kit.
  const program = programArg ?? track?.instrumentProgram ?? (drums ? GM_STANDARD_KIT : undefined);
  if (program === undefined) {
    return fail(`create_midi_clip: pass program, a GM program 0-127 (0 = Acoustic Grand Piano, 40 = Violin, 48 = String Ensemble 1)${track ? `; "${track.name}" has no instrument of its own` : ''}`);
  }

  // The part's time: the arrangement's bars and tempo from its first bar, so
  // its bar lines and seconds are the arrangement's (lib/editTimeMap).
  const maps = timeMaps();
  const at = startSecArg !== undefined
    ? arrangementClipTimeAtSec(maps, startSecArg, bars)
    : arrangementClipTime(maps, (startBar ?? 1) - 1, bars);
  const partFields = {
    sourceKind: 'piano-roll' as const,
    sourcePianoRoll: [] as PianoNote[],
    sourceRollNotes: [] as PianoNote[],
    sourceBpm: at.sourceBpm,
    sourceTempoMap: at.sourceTempoMap,
    sourceTotalSteps: at.sourceTotalSteps,
    sourceMeterMap: at.sourceMeterMap,
    sourcePickupSteps: 0,
    sourceLanes: [{ id: 0, name: 'A', cycleSteps: null }],
    sourceBends: [],
  };
  const nominal = midiClipNominalSec(partFields, store().bpm);
  const instrumentName = drums ? `${drumKitName(program)} kit` : gmName(program);
  const label = strArg(args.label) ?? instrumentName;

  const ids = oneStep(() => {
    const s = store();
    const trackId = track?.id ?? s.addTrack({
      name: strArg(args.track_name) ?? instrumentName,
      nameAutoGenerated: false,
      instrumentProgram: program,
      ...(drums ? { isPercussion: true } : {}),
    });
    const trk = store().tracks.find((t) => t.id === trackId);
    const clipId = s.addClipToTrack({
      trackId,
      label,
      mimeType: 'audio/wav',
      sourceDuration: nominal,
      offsetIntoSource: 0,
      durationSec: nominal,
      startSec: at.startSec,
      color: trk?.color ?? '#a855f7',
      ...partFields,
      // A part on a track that holds its instrument follows the track; on a
      // track holding another one it carries its own, which plays first
      // (lib/clipProgram effectiveProgramFor).
      ...(trk?.instrumentProgram === program ? {} : { instrumentProgram: program }),
    });
    return { trackId, clipId };
  });
  const bar = editBarAtSec(maps, at.startSec).bar + 1;
  return done(
    `Made "${label}", an empty ${bars}-bar ${instrumentName} part at bar ${bar} (${n2(at.startSec)}s, ${n2(nominal)}s long, ${editMeterLabel(at.sourceMeterMap[0].meter)} at ${editBpmText(at.sourceBpm)} BPM). It plays live; fill it with editor_set_notes or editor_set_roll_part`,
    { clipId: ids.clipId, trackId: ids.trackId, startSec: at.startSec, startBar: bar, bars, totalSteps: at.sourceTotalSteps, program, percussion: drums },
  );
}

export interface RollPartArgs extends ClipArgs {
  /** 1-based bars of the part to list notes from and to (inclusive). */
  from_bar?: unknown;
  to_bar?: unknown;
}

/** A part's lanes in the tool's words. */
const lanesOut = (lanes: readonly PolyLane[]) => lanes.map((l) => ({
  id: l.id,
  name: l.name,
  cycle_steps: l.cycleSteps ?? null,
  ...(l.span ? { span_start: l.span.start, span_end: l.span.end ?? null } : {}),
  ...(l.meterMap?.length ? { meter_map: l.meterMap.map((sg) => ({ bar: sg.bar + 1, num: sg.meter.num, den: sg.meter.den, groups: [...sg.meter.groups] })) } : {}),
  ...(l.tuplet ? { tuplet: { n: l.tuplet.n, m: l.tuplet.m } } : {}),
}));

/**
 * Read a whole part: its instrument, tempo, meter map (1-based bars), pickup,
 * grid, polymeter lanes, bends, and its own notes with their lanes (the notes
 * the piano roll opens with), plus whether it plays live or from a render.
 */
export function getRollPart(args: RollPartArgs): ToolResult {
  const found = resolveMidiClip(clipRef(args), true);
  if (!found.ok) return fail(found.error);
  const clip = found.value;
  const track = store().tracks.find((t) => t.id === clip.trackId);
  const voice = voiceFor(clip);
  const meterMap = normalizeMeterMap(clip.sourceMeterMap);
  const pickup = clip.sourcePickupSteps ?? 0;
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  const totalSteps = clip.sourceTotalSteps ?? roundUpToBar(meterMap, noteEndStep(clip.sourcePianoRoll ?? [], 1), pickup);
  const own = clip.sourceRollNotes?.length ? clip.sourceRollNotes : clip.sourcePianoRoll ?? [];
  const fromBar = numArg(args.from_bar);
  const toBar = numArg(args.to_bar);
  if (fromBar !== undefined && (!Number.isInteger(fromBar) || fromBar < 1)) return fail('get_roll_part: from_bar is a whole bar >= 1');
  if (toBar !== undefined && (!Number.isInteger(toBar) || toBar < (fromBar ?? 1))) return fail('get_roll_part: to_bar is a whole bar at or after from_bar');
  const lo = fromBar !== undefined ? barStartStep(meterMap, fromBar - 1, pickup) : 0;
  const hi = toBar !== undefined ? barStartStep(meterMap, toBar, pickup) : Infinity;
  const inRange = own.filter((n) => n.step >= lo - 1e-9 && n.step < hi - 1e-9);
  const notes = inRange.slice(0, MAX_PART_NOTES).map((n) => ({
    id: n.id,
    note: n.note,
    step: n.step,
    length: n.length,
    velocity: n.velocity,
    ...(typeof (n as PianoNote & { lane?: number }).lane === 'number' ? { lane: (n as PianoNote & { lane?: number }).lane } : {}),
  }));
  const bars = partBars(meterMap, totalSteps, pickup);
  const render = partRender(clip);
  const tempoMap = playedTempoMap(clip.sourceBpm ?? store().bpm, clip.sourceTempoMap ?? null).map((e) => (e.fermata
    ? { beat: e.beat, fermata: { beats: e.fermata.beats, stretch: e.fermata.stretch } }
    : { beat: e.beat, bpm: Math.round(e.bpm * 100) / 100, curve: e.curve === 'linear' ? 'linear' : 'step' }));
  const data = {
    clip_id: clip.id,
    label: clip.label,
    track_id: clip.trackId,
    track: track?.name ?? null,
    program: voice.program ?? null,
    instrument: voice.program === undefined ? null : voice.percussion ? `${drumKitName(voice.program)} kit` : gmName(voice.program),
    percussion: voice.percussion,
    start_sec: clip.startSec,
    start_bar: editBarAtSec(timeMaps(), clip.startSec).bar + 1,
    bpm: clip.sourceBpm ?? store().bpm,
    tempo_map: tempoMap,
    meter_map: meterMap.map((sg) => ({ bar: sg.bar + 1, num: sg.meter.num, den: sg.meter.den, groups: [...sg.meter.groups], label: editMeterLabel(sg.meter) })),
    pickup_steps: pickup,
    total_steps: totalSteps,
    bars,
    lanes: lanesOut(lanes),
    bends: sanitizeBends(clip.sourceBends ?? []).map((b) => ({ lane: b.lane, range: b.range, points: b.points.map((p) => ({ step: p.step, value: p.value, shape: p.shape })) })),
    notes,
    note_count: own.length,
    played_note_count: clip.sourcePianoRoll?.length ?? 0,
    truncated: inRange.length > notes.length,
    render: render.state,
    render_text: render.text,
  };
  const range = fromBar !== undefined || toBar !== undefined ? ` (bars ${fromBar ?? 1}-${toBar ?? bars}: ${inRange.length})` : '';
  return done(
    `"${clip.label}": ${data.instrument ?? 'no instrument'}, ${bars} bar(s) in ${data.meter_map.map((m) => `${m.label} from bar ${m.bar}`).join(', ')}, ${lanes.length} lane(s), ${own.length} note(s)${range}${data.truncated ? `, first ${notes.length} listed` : ''}. ${render.text}`,
    data,
  );
}

export interface SetRollPartArgs extends ClipArgs, RenderArgs {
  /** The part's own notes, each {note, step, length, velocity, lane?, id?}. Replaces them all; [] empties the part. */
  notes?: unknown;
  /** The polymeter lanes, each {id, name?, cycle_steps?, span_start?, span_end?, meter_map?, tuplet?}. Lane 0 (A) is always there. */
  lanes?: unknown;
  /** The part's meter map, 1-based bars; without a bar-1 entry bar 1 keeps its meter. */
  meter_map?: unknown;
  /** 16ths before the part's bar 1. */
  pickup_steps?: unknown;
  /** The grid length in bars (after the pickup), or in 16ths. */
  bars?: unknown;
  total_steps?: unknown;
  /** GM program 0-127 for the part. */
  program?: unknown;
}

/**
 * Write a part back: any of its notes (with their lanes), lanes, meter map,
 * pickup, grid length and program. The notes it plays are derived from the
 * roll's notes and lanes the way the roll's EDIT key derives them, and the
 * whole write is one undo step. A part holding a render is re-rendered.
 */
export async function setRollPart(args: SetRollPartArgs): Promise<ToolResult> {
  const found = resolveMidiClip(clipRef(args), true);
  if (!found.ok) return fail(found.error);
  const clip = found.value;
  const given = ['notes', 'lanes', 'meter_map', 'pickup_steps', 'bars', 'total_steps', 'program']
    .filter((k) => (args as Record<string, unknown>)[k] !== undefined && (args as Record<string, unknown>)[k] !== null);
  if (given.length === 0) return fail('set_roll_part: pass at least one of notes, lanes, meter_map, pickup_steps, bars, total_steps, program');
  if (args.bars !== undefined && args.total_steps !== undefined) return fail('set_roll_part: pass bars or total_steps, not both');

  let program: number | undefined;
  if (args.program !== undefined && args.program !== null) {
    program = numArg(args.program);
    if (program === undefined || !Number.isInteger(program) || program < 0 || program > 127) return fail('set_roll_part: program must be a whole GM program 0-127');
  }

  let meterMap = normalizeMeterMap(clip.sourceMeterMap);
  if (args.meter_map !== undefined && args.meter_map !== null) {
    const parsed = parseMeterMapArg(args.meter_map, 'set_roll_part');
    if (!parsed.ok) return fail(parsed.error);
    const segs = parsed.value;
    if (!segs.some((sg) => sg.bar === 0)) segs.push({ bar: 0, meter: { ...meterMap[0].meter, groups: [...meterMap[0].meter.groups] } });
    meterMap = normalizeMeterMap(segs);
  }

  let pickup = clip.sourcePickupSteps ?? 0;
  if (args.pickup_steps !== undefined && args.pickup_steps !== null) {
    const p = numArg(args.pickup_steps);
    if (p === undefined || p < 0 || p > 64 || Math.round(p * 2) / 2 !== p) return fail('set_roll_part: pickup_steps is 0-64 16ths, in halves');
    pickup = p;
  }

  let lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  if (args.lanes !== undefined && args.lanes !== null) {
    if (!Array.isArray(args.lanes)) return fail('set_roll_part: lanes must be a list of {id, name?, cycle_steps?, span_start?, span_end?, meter_map?, tuplet?}');
    const raw: PolyLane[] = [];
    for (let i = 0; i < args.lanes.length; i += 1) {
      const l = asRecord(args.lanes[i]);
      if (!l) return fail(`set_roll_part: lanes[${i}] must be an object`);
      const id = numArg(l.id);
      if (id === undefined || !Number.isInteger(id) || id < 0) return fail(`set_roll_part: lanes[${i}] needs a whole id >= 0 (0 is lane A)`);
      const cycle = l.cycle_steps === null || l.cycle_steps === undefined ? null : numArg(l.cycle_steps);
      if (cycle !== null && (cycle === undefined || cycle < 1)) return fail(`set_roll_part: lanes[${i}] cycle_steps is a length in 16ths >= 1, or null for a lane that does not loop`);
      let laneMeter: MeterSegment[] | undefined;
      if (l.meter_map !== undefined && l.meter_map !== null) {
        const parsed = parseMeterMapArg(l.meter_map, `set_roll_part lanes[${i}]`);
        if (!parsed.ok) return fail(parsed.error);
        laneMeter = parsed.value;
      }
      const tuplet = asRecord(l.tuplet);
      const spanStart = numArg(l.span_start);
      const spanEnd = numArg(l.span_end);
      raw.push({
        id,
        name: strArg(l.name) ?? '',
        cycleSteps: cycle,
        ...(spanStart !== undefined ? { span: { start: spanStart, end: spanEnd ?? null } } : {}),
        ...(laneMeter ? { meterMap: laneMeter } : {}),
        ...(tuplet ? { tuplet: { n: Number(tuplet.n), m: Number(tuplet.m) } } : {}),
      });
    }
    lanes = sanitizeLanes(raw);
  }
  const laneIds = new Set(lanes.map((l) => l.id));

  let own: PianoNote[] = (clip.sourceRollNotes?.length ? clip.sourceRollNotes : clip.sourcePianoRoll ?? []).map((n) => ({ ...n }));
  if (args.notes !== undefined && args.notes !== null) {
    if (!Array.isArray(args.notes)) return fail('set_roll_part: notes must be a list of {note, step, length, velocity, lane?, id?}');
    own = [];
    for (let i = 0; i < args.notes.length; i += 1) {
      const raw = asRecord(args.notes[i]);
      if (!raw) return fail(`set_roll_part: note ${i} is not an object`);
      const note = numArg(raw.note);
      const step = numArg(raw.step);
      const length = numArg(raw.length);
      const velocity = numArg(raw.velocity);
      const lane = numArg(raw.lane);
      if (note === undefined || note < 0 || note > 127) return fail(`set_roll_part: note ${i} needs a pitch 0-127`);
      if (step === undefined || step < 0) return fail(`set_roll_part: note ${i} needs a step >= 0`);
      if (length === undefined || length <= 0) return fail(`set_roll_part: note ${i} needs a length > 0`);
      if (velocity === undefined || velocity < 1 || velocity > 127) return fail(`set_roll_part: note ${i} needs a velocity 1-127`);
      if (lane !== undefined && !laneIds.has(lane)) return fail(`set_roll_part: note ${i} is in lane ${lane}, which the part does not have (lanes: ${[...laneIds].join(', ')})`);
      own.push(withTicks({
        id: strArg(raw.id) ?? uid(),
        note: Math.round(note),
        step,
        length,
        velocity: Math.round(velocity),
        ...(lane !== undefined && lane !== 0 ? { lane } : {}),
      } as PianoNote));
    }
  } else {
    // Notes in a lane that is gone move to lane A.
    own = own.map((n) => {
      const lane = (n as PianoNote & { lane?: number }).lane;
      if (lane === undefined || laneIds.has(lane)) return n;
      const { lane: _gone, ...rest } = n as PianoNote & { lane?: number };
      return rest;
    });
  }

  const noteEnd = noteEndStep(own, 1);
  let totalSteps: number;
  if (args.bars !== undefined && args.bars !== null) {
    const bars = numArg(args.bars);
    if (bars === undefined || !Number.isInteger(bars) || bars < 1 || bars > MAX_PART_BARS) return fail(`set_roll_part: bars must be a whole number 1-${MAX_PART_BARS}`);
    totalSteps = barStartStep(meterMap, bars, pickup);
  } else if (args.total_steps !== undefined && args.total_steps !== null) {
    const t = numArg(args.total_steps);
    if (t === undefined || t <= 0) return fail('set_roll_part: total_steps must be more than 0');
    totalSteps = t;
  } else {
    totalSteps = Math.max(clip.sourceTotalSteps ?? 0, roundUpToBar(meterMap, noteEnd, pickup));
  }
  if (noteEnd > totalSteps + 1e-9) {
    return fail(`set_roll_part: the notes run to step ${n2(noteEnd)}, past the part's end at ${n2(totalSteps)}; pass more bars`);
  }

  const bends = sanitizeBends(clip.sourceBends ?? []).filter((b) => laneIds.has(b.lane));
  const played = playedRollNotes(own, lanes, totalSteps);
  const written = await commitMidiFields(clip, {
    sourcePianoRoll: played,
    sourceRollNotes: own,
    sourceLanes: lanes,
    sourceMeterMap: meterMap,
    sourcePickupSteps: pickup,
    sourceTotalSteps: totalSteps,
    sourceBends: bends,
    // A program set here drops the bank the old program was chosen in (lib/clipProgram clipBank).
    ...(program !== undefined ? { instrumentProgram: program, instrumentBank: undefined } : {}),
  }, args);
  if (!written.ok) return fail(`set_roll_part: ${written.error}`);
  const bars = partBars(meterMap, totalSteps, pickup);
  return done(
    `Wrote "${clip.label}" (${given.join(', ')}): ${own.length} note(s), ${played.length} played, ${bars} bar(s) in ${meterMap.map((sg) => `${editMeterLabel(sg.meter)} from bar ${sg.bar + 1}`).join(', ')}, ${lanes.length} lane(s)${written.value.rendered ? `; its audio was re-rendered (${n2(written.value.duration)}s)` : '; it plays live'}${written.value.lengthNote}`,
    { clipId: clip.id, notes: own.length, played: played.length, totalSteps, bars },
  );
}

/** Every MIDI clip as a part: its instrument, where it sits, its length and notes, and its render state. */
export function listRollParts(): ToolResult {
  const s = store();
  const parts = s.clips.filter((c) => isMidiClip(c)).map((c) => {
    const voice = voiceFor(c);
    const track = s.tracks.find((t) => t.id === c.trackId);
    const meterMap = normalizeMeterMap(c.sourceMeterMap);
    const total = c.sourceTotalSteps ?? roundUpToBar(meterMap, noteEndStep(c.sourcePianoRoll ?? [], 1), c.sourcePickupSteps ?? 0);
    return {
      clip_id: c.id,
      label: c.label,
      track_id: c.trackId,
      track: track?.name ?? null,
      program: voice.program ?? null,
      instrument: voice.program === undefined ? null : voice.percussion ? `${drumKitName(voice.program)} kit` : gmName(voice.program),
      percussion: voice.percussion,
      start_sec: c.startSec,
      start_bar: editBarAtSec(timeMaps(), c.startSec).bar + 1,
      bars: partBars(meterMap, total, c.sourcePickupSteps ?? 0),
      notes: c.sourceRollNotes?.length || c.sourcePianoRoll?.length || 0,
      lanes: sanitizeLanes(c.sourceLanes?.length ? c.sourceLanes : DEFAULT_LANES).length,
      render: partRenderState(c),
      muted: !!c.muted,
    };
  });
  return done(
    parts.length
      ? `${parts.length} part(s): ${parts.slice(0, 24).map((p) => `${p.label} (${p.instrument ?? 'no instrument'}, bar ${p.start_bar}, ${p.bars} bars, ${p.notes} notes)`).join('; ')}${parts.length > 24 ? '; …' : ''}`
      : 'No MIDI parts on the timeline yet; editor_create_midi_clip makes one',
    { parts },
  );
}

/* ── MIDI export ─────────────────────────────────────────────────────────── */

export interface ExportMidiArgs extends ArrangementMidiSeams {
  /** Tracks to take (ids or names); left out with no clip_ids, every track as the mix plays them. */
  track_ids?: unknown;
  /** Clips to take (ids or labels). */
  clip_ids?: unknown;
  /** A span of the timeline in seconds; both or neither. */
  start_sec?: unknown;
  end_sec?: unknown;
  /** The file's name. */
  name?: unknown;
}

/** A list argument as an array: an array as it is, one string or number as a list of one. */
const listArg = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

/**
 * Write the arrangement's MIDI notes as one type-1 file (lib/arrangementMidi)
 * and save it where the user chooses: every track as the mix plays it, or the
 * tracks or clips named, over the whole arrangement or a span of it. Changes
 * nothing in the arrangement, so it records no undo step.
 */
export async function exportMidi(args: ExportMidiArgs = {}): Promise<ToolResult> {
  const trackRefs = listArg(args.track_ids);
  const clipRefs = listArg(args.clip_ids);
  if (trackRefs.length && clipRefs.length) return fail('export_midi: pass track_ids or clip_ids, not both');
  let scope: ArrangementMidiScope = { kind: 'all' };
  if (trackRefs.length) {
    const ids: string[] = [];
    for (const ref of trackRefs) {
      const t = resolveTrack(ref);
      if (!t.ok) return fail(`export_midi: ${t.error}`);
      ids.push(t.value.id);
    }
    scope = { kind: 'tracks', trackIds: ids };
  } else if (clipRefs.length) {
    const ids: string[] = [];
    for (const ref of clipRefs) {
      const c = resolveClip(ref);
      if (!c.ok) return fail(`export_midi: ${c.error}`);
      if (c.value.sourceKind !== 'piano-roll') return fail(`export_midi: "${c.value.label}" is an audio clip; only MIDI clips hold notes`);
      ids.push(c.value.id);
    }
    scope = { kind: 'clips', clipIds: ids };
  }
  const start = numArg(args.start_sec);
  const end = numArg(args.end_sec);
  if ((start === undefined) !== (end === undefined)) return fail('export_midi: pass both start_sec and end_sec, or neither');
  if (start !== undefined && end !== undefined && !(end > start && start >= 0)) {
    return fail(`export_midi: the span ${n2(start)}s to ${n2(end)}s is empty; end_sec must come after start_sec`);
  }
  const range = start !== undefined && end !== undefined ? { startSec: start, endSec: end } : null;
  const outcome = await exportArrangementMidi(
    { scope, range, name: strArg(args.name) },
    { ...(args.save ? { save: args.save } : {}), ...(args.global ? { global: args.global } : {}) },
  );
  if (!outcome.ok) return fail(`export_midi: ${outcome.error}`);
  const r = outcome.result;
  return done(outcome.message, {
    file: outcome.fileName,
    path: outcome.path,
    notes: r.noteCount,
    tracks: r.file.tracks.map((t) => t.name),
    shared_channels: r.sharedTracks,
    articulation_fallback: r.articulationFallback,
    starts_at_sec: r.startSec,
  });
}

/* ── operations this layer deliberately does not have ────────────────────── */

/**
 * Tool names the assistant's wishlist asked for that have NO implementation
 * here, with the reason. T13 should either leave them out of the catalog or
 * register them to return the reason verbatim — what it must not do is register
 * a handler that pretends.
 */
export const UNSUPPORTED_OPERATIONS: Record<string, string> = {
  set_metronome:
    "the assistant has no tool for EDIT's click yet. The user switches it with the metronome key in the footer (right-click it for the level and the Beat: quarters, groups or dotted quarters), and sets the count-in with the count-in select beside it (the piano roll's Count field is the same setting); all of them are saved in metronomeStore.",
  tempo_map:
    'there is no separate tempo_map tool: the arrangement\'s tempo map is written by editor_set_meter_map (its tempo_map argument, bars 1-based, with ramps and fermatas), beside the meter map, and read back in full by editor_get_meter_map (editor_get_state lists the first 64 entries). A piano-roll clip keeps its own tempo map in the TEMPO lane of the MIDI tab, and editor_get_roll_part reads it.',
  editor_stretch_audio:
    'a pitch-preserving audio stretch runs on the backend (/api/studio/process, time_pitch). stretchClip handles MIDI clips locally and refuses audio ones by name.',
  editor_freeze_track:
    'freezing renders a track (with its backend-hosted VST3) to a printed stem through the offline renderer inside the EDIT timeline component. This layer has no access to it; unfreeze IS supported.',
};
