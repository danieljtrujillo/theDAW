/**
 * Blob-in / Blob-out audio operations for clips.
 *
 * Reverse, normalize, concatenate and fade, plus the two MIDI paths that
 * re-render a piano-roll clip's audio. Everything takes a `Blob` and returns a
 * `{ blob, duration }`, so a caller can hand the result straight to
 * `editorStore.updateClip` without knowing how it was produced.
 *
 * Two deliberate choices:
 *
 * 1. The DSP runs over `Float32Array`, not an `AudioNode` graph. Reversal has
 *    no node (a negative `playbackRate` is not a thing), and normalize/concat/
 *    fade are one multiply and one copy each — routing them through a graph
 *    would add a render pass and make the result unprovable outside a browser.
 *    The context is used only for the two things it is actually needed for:
 *    decoding compressed source bytes, and allocating an output buffer.
 *
 * 2. That context arrives through an injected factory. Node has no Web Audio,
 *    so this is what makes the ops testable at all; it is also what lets a
 *    caller pick the sample rate the work happens at.
 *
 * Failures throw. Unlike the pure planners in `./timeline`, these ops fail for
 * reasons that are exceptional rather than expected — undecodable bytes, a
 * missing context — and a caller is going to be inside a `try` for the decode
 * regardless.
 *
 * Encoding is `lib/wavEncode`'s `encodeWav`, the one encoder every bounce path
 * in the app shares; MIDI rendering is `lib/midiSynth`'s `renderStepNotesToBlob`,
 * the one the piano roll and the editor already use, so a clip bounced from here
 * sounds exactly like the same clip bounced from the UI.
 */
import type { AudioClip } from '../../state/editorStore';
import { encodeWav } from '../wavEncode';
import { noteEndStep } from '../clipNotes/units';
import { MAX_BPM, MIN_BPM } from './timeline';
import type { TempoEvent } from '../tempoMap';
import type { RollRenderBends } from '../pitchBend';
import { clipRenderInput } from '../rollClip';
import type { RollControl } from '../../state/pianoRollStore';
import { clipArticulationInstrument, type ArticulationInstrument } from '../articulationMap';

/** The app's working rate; also `encodeWav`'s and the editor's. */
export const DEFAULT_SAMPLE_RATE = 44100;

/** Widest output these ops will produce. Matches the editor's stereo bus. */
const MAX_CHANNELS = 2;

/**
 * The slice of `BaseAudioContext` the ops need. A real `OfflineAudioContext`
 * satisfies this structurally; a test supplies a stub.
 */
export interface AudioOpsContext {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
}

/** Builds a context to decode and allocate in, at the given sample rate. */
export type OfflineCtxFactory = (sampleRate: number) => AudioOpsContext;

export interface RenderedAudio {
  blob: Blob;
  duration: number;
}

/**
 * The real factory. A 1-frame context is enough: nothing is rendered through
 * it, and `decodeAudioData` resamples to the context's rate regardless of the
 * context's length.
 */
export const defaultOfflineCtxFactory: OfflineCtxFactory = (sampleRate) =>
  new OfflineAudioContext(1, 1, sampleRate);

const ctxFor = (factory: OfflineCtxFactory | undefined, sampleRate: number): AudioOpsContext => {
  const make = factory ?? defaultOfflineCtxFactory;
  const ctx = make(sampleRate);
  if (!ctx || typeof ctx.decodeAudioData !== 'function' || typeof ctx.createBuffer !== 'function') {
    throw new Error('clipOps: the audio context factory returned nothing usable');
  }
  return ctx;
};

const decode = async (ctx: AudioOpsContext, blob: Blob): Promise<AudioBuffer> => {
  const bytes = await blob.arrayBuffer();
  // `slice(0)` because decoding detaches the buffer in some engines, and the
  // caller's Blob may be decoded again (peaks, playback) right after.
  return ctx.decodeAudioData(bytes.slice(0));
};

const channelsOf = (buf: AudioBuffer): Float32Array[] => {
  const out: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c += 1) out.push(buf.getChannelData(c));
  return out;
};

const finish = (buf: AudioBuffer): RenderedAudio => ({
  blob: encodeWav(buf),
  duration: buf.length / buf.sampleRate,
});

/** Every op takes this as its last argument. `sampleRate` is the rate the
 *  context is built at — what a real `OfflineAudioContext` decodes TO. The
 *  output buffer always follows the decoded source's own rate, so a factory
 *  that ignores the hint still produces a coherent file. */
export interface IoOptions {
  sampleRate?: number;
}

/* ── reverse ─────────────────────────────────────────────────────────────── */

/** Play the clip backwards. Length, rate and channel count are unchanged. */
export async function reverseBlob(
  blob: Blob,
  ctxFactory?: OfflineCtxFactory,
  opts: IoOptions = {},
): Promise<RenderedAudio> {
  const ctx = ctxFor(ctxFactory, opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const src = await decode(ctx, blob);
  const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  const last = src.length - 1;
  for (let c = 0; c < src.numberOfChannels; c += 1) {
    const from = src.getChannelData(c);
    const to = out.getChannelData(c);
    for (let i = 0; i < src.length; i += 1) to[i] = from[last - i];
  }
  return finish(out);
}

/* ── normalize ───────────────────────────────────────────────────────────── */

export interface NormalizeOptions {
  /** Target peak in dBFS. Negative values leave headroom; anything above 0 is
   *  pulled back to 0, since the 16-bit encoder would clamp it away anyway. */
  peakDb?: number;
}

/**
 * Scale the whole clip so its loudest sample lands on `peakDb`. One gain for
 * every channel, taken from the peak across all of them, so the stereo image
 * does not move. Digital silence is returned unchanged rather than divided by
 * its own zero peak.
 */
export async function normalizeBlob(
  blob: Blob,
  opts: NormalizeOptions = {},
  ctxFactory?: OfflineCtxFactory,
  ioOpts: IoOptions = {},
): Promise<RenderedAudio> {
  const peakDb = typeof opts.peakDb === 'number' && Number.isFinite(opts.peakDb) ? Math.min(0, opts.peakDb) : -1;
  const ctx = ctxFor(ctxFactory, ioOpts.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const src = await decode(ctx, blob);

  let peak = 0;
  for (const data of channelsOf(src)) {
    for (let i = 0; i < data.length; i += 1) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  const gain = peak > 0 ? Math.pow(10, peakDb / 20) / peak : 1;

  const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c += 1) {
    const from = src.getChannelData(c);
    const to = out.getChannelData(c);
    for (let i = 0; i < src.length; i += 1) to[i] = from[i] * gain;
  }
  return finish(out);
}

/* ── concat ──────────────────────────────────────────────────────────────── */

/**
 * Join clips end to end, inserting `gapsSec[i]` seconds of silence between
 * part `i` and part `i + 1`. Pairs with `timeline.mergePlan`, which produces
 * the order and the gaps from the clips' timeline positions.
 *
 * The output is as wide as the widest input; a narrower part is copied across
 * the missing channels so a mono part inside a stereo merge stays centred
 * instead of vanishing from one side.
 */
export async function concatBlobs(
  blobs: readonly Blob[],
  gapsSec: readonly number[] = [],
  ctxFactory?: OfflineCtxFactory,
  opts: IoOptions = {},
): Promise<RenderedAudio> {
  if (blobs.length === 0) throw new Error('concatBlobs: no input blobs');
  const ctx = ctxFor(ctxFactory, opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const parts: AudioBuffer[] = [];
  for (const b of blobs) parts.push(await decode(ctx, b));

  const sampleRate = parts[0].sampleRate;
  // A real `OfflineAudioContext` resamples on decode, so every part comes back
  // at the context's rate and this never fires. A factory that does not — a
  // stub, or a future caller decoding elsewhere — would otherwise have its
  // odd-rate part written into this buffer frame for frame and played at the
  // wrong speed and pitch. That artefact is subtle enough to survive a listen,
  // so it is refused here rather than resampled silently behind the caller.
  const oddIndex = parts.findIndex((p) => p.sampleRate !== sampleRate);
  if (oddIndex > 0) {
    throw new Error(
      `concatBlobs: parts have different sample rates (${sampleRate} Hz for part 1, ` +
        `${parts[oddIndex].sampleRate} Hz for part ${oddIndex + 1}); resample before concatenating`,
    );
  }
  const channels = Math.min(MAX_CHANNELS, Math.max(1, ...parts.map((p) => p.numberOfChannels)));

  const gapFrames = parts.slice(1).map((_, i) => {
    const g = gapsSec[i];
    return typeof g === 'number' && Number.isFinite(g) && g > 0 ? Math.round(g * sampleRate) : 0;
  });
  const total = parts.reduce((n, p) => n + p.length, 0) + gapFrames.reduce((n, g) => n + g, 0);

  const out = ctx.createBuffer(channels, total, sampleRate);
  const dest = channelsOf(out);
  let cursor = 0;
  for (let p = 0; p < parts.length; p += 1) {
    const part = parts[p];
    for (let c = 0; c < channels; c += 1) {
      // Fold narrower sources up: the last channel a part actually has is what
      // the missing ones get.
      const from = part.getChannelData(Math.min(c, part.numberOfChannels - 1));
      const to = dest[c];
      for (let i = 0; i < part.length; i += 1) to[cursor + i] = from[i];
    }
    cursor += part.length + (gapFrames[p] ?? 0);
  }
  return finish(out);
}

/* ── fades ───────────────────────────────────────────────────────────────── */

export interface FadeOptions {
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Linear clip gain applied on top of the fade envelope — the same ordering
   *  `clipPeakGain` has in live playback, where gain scales the envelope's peak
   *  and sits before the track fader. */
  gain?: number;
}

/**
 * Bake a clip's fade envelope and gain into its samples. Needed before a merge:
 * concatenation flattens several clips into one blob, and any fade still living
 * on the individual clip records would be lost at that point.
 *
 * The ramps are linear and mirror each other, so a fade-in and a fade-out of
 * the same length reach the same value the same distance from their own edge.
 * Fades longer than the clip are not an error; they simply never finish.
 */
export async function applyFadesToBlob(
  blob: Blob,
  opts: FadeOptions = {},
  ctxFactory?: OfflineCtxFactory,
  ioOpts: IoOptions = {},
): Promise<RenderedAudio> {
  const ctx = ctxFor(ctxFactory, ioOpts.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const src = await decode(ctx, blob);
  const sr = src.sampleRate;
  const len = src.length;

  const frames = (sec: number | undefined) =>
    typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.max(1, Math.round(sec * sr)) : 0;
  const inFrames = frames(opts.fadeInSec);
  const outFrames = frames(opts.fadeOutSec);
  const gain = typeof opts.gain === 'number' && Number.isFinite(opts.gain) && opts.gain >= 0 ? opts.gain : 1;

  const envelope = (i: number): number => {
    let g = gain;
    if (inFrames > 0) g *= Math.min(1, i / inFrames);
    if (outFrames > 0) g *= Math.min(1, (len - 1 - i) / outFrames);
    return g;
  };

  const out = ctx.createBuffer(src.numberOfChannels, len, sr);
  for (let c = 0; c < src.numberOfChannels; c += 1) {
    const from = src.getChannelData(c);
    const to = out.getChannelData(c);
    for (let i = 0; i < len; i += 1) to[i] = from[i] * envelope(i);
  }
  return finish(out);
}

/* ── MIDI clips ──────────────────────────────────────────────────────────── */

/** One step-grid note, as `renderStepNotesToBlob` wants them. `PianoNote`
 *  satisfies this structurally, so a clip's note list passes straight through. */
export interface StepNote {
  note: number;
  velocity: number;
  step: number;
  length: number;
  /** The roll lane the note plays in, which a bent lane's curve follows. */
  lane?: number;
}

/** The renderer shape. Injected so this module can be exercised without pulling
 *  in the synth (and, through it, the soundfont engine's Vite-only imports). */
export type StepNoteRenderer = (
  notes: StepNote[],
  bpm: number,
  totalSteps: number,
  /** `tempoMap`: the clip's own (lib/rollTempo), scaled by the renderer so it starts at `bpm`.
   *  `bends`: each bending lane's curve (lib/pitchBend rollRenderBends), the notes then carrying their lanes.
   *  `bank`: the bank select sent before the program (lib/clipProgram clipBank).
   *  `controls`: the clip's part controller changes on the roll's 960 PPQ clock (lib/rollClip clipRenderInput).
   *  `articulation`: the instrument the notes' articulations resolve against (lib/articulationRender). */
  opts?: {
    program?: number;
    bank?: number;
    percussion?: boolean;
    tempoMap?: readonly TempoEvent[];
    bends?: RollRenderBends;
    controls?: readonly RollControl[];
    articulation?: ArticulationInstrument;
  },
) => Promise<RenderedAudio>;

/**
 * The real renderer: `lib/midiSynth`'s `renderStepNotesToBlob`, which the piano
 * roll and the editor's own MIDI bounce already go through. Imported lazily so
 * the module graph (soundfont engine, worklet URL) is only paid for by callers
 * that actually render.
 */
export const defaultStepNoteRenderer: StepNoteRenderer = async (notes, bpm, totalSteps, opts) => {
  // Each note played by its articulation, a preset articulation on a channel of its own (lib/articulationRender).
  const { renderArticulatedStepNotes } = await import('../articulationRender');
  return renderArticulatedStepNotes(notes, bpm, totalSteps, opts ?? {});
};

export interface MidiRenderOptions {
  /** Overrides the clip's own `instrumentProgram`. */
  program?: number;
  /** The bank select sent before the program (lib/clipProgram clipBank); left out or 0 is the General MIDI set. */
  bank?: number;
  /** Render on the General MIDI drum channel, where the program is the kit (a percussion track's clip). */
  percussion?: boolean;
  /** Tempo to use when the clip has no `sourceBpm` (e.g. the editor's). */
  bpm?: number;
  render?: StepNoteRenderer;
}

/** The notes, or a refusal. An audio clip has none; so does a piano-roll clip
 *  whose note list was dropped somewhere along the way. */
const notesOf = (clip: AudioClip): StepNote[] => {
  const notes = clip.sourcePianoRoll;
  if (!notes || notes.length === 0) {
    throw new Error(`clip "${clip.label}" is not a MIDI clip: it has no piano roll notes to render`);
  }
  return notes as StepNote[];
};

const tempoOf = (clip: AudioClip, fallback: number | undefined): number => {
  const bpm = clip.sourceBpm ?? fallback;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) {
    throw new Error(`clip "${clip.label}" has no sourceBpm; pass opts.bpm to render it`);
  }
  return bpm;
};

/** The clip's tempo map as a render option, or nothing for a clip at one tempo. */
const tempoOpt = (clip: AudioClip): { tempoMap?: readonly TempoEvent[] } =>
  clip.sourceTempoMap?.length ? { tempoMap: clip.sourceTempoMap } : {};

/** The grid length the clip was written on. Falls back to the end of the last
 *  note, floored at one bar of 16ths — the same fallback the editor uses when
 *  it re-renders a MIDI clip after an instrument change. */
const stepsOf = (clip: AudioClip, notes: StepNote[]): number =>
  clip.sourceTotalSteps ?? noteEndStep(notes, 16);

/** The notes a render plays (lib/rollClip clipRenderInput): a clip whose lanes
 *  bend renders its own notes in their lanes with the bends, so an assistant
 *  re-render keeps the bends live playback plays; any other clip its notes.
 *  The part's controllers (its pedal, volume, pan, expression and modulation)
 *  come with them, so the new audio plays them as the clip's first render did. */
const renderInputOf = (
  clip: AudioClip,
  notes: StepNote[],
): { notes: StepNote[]; steps: number; bends?: RollRenderBends; controls?: readonly RollControl[] } => {
  const steps = stepsOf(clip, notes);
  const input = clipRenderInput(clip, steps);
  return { notes: input.notes as StepNote[], steps, ...(input.bends ? { bends: input.bends } : {}), ...(input.controls ? { controls: input.controls } : {}) };
};

/**
 * Render a piano-roll clip's notes to audio at its own tempo — the "bounce"
 * that turns a MIDI clip into something every export path can read, since the
 * offline bounces all read `audioBlob` rather than re-synthesising.
 */
export async function bounceMidiClip(
  clip: AudioClip,
  opts: MidiRenderOptions = {},
): Promise<RenderedAudio> {
  const notes = notesOf(clip);
  const bpm = tempoOf(clip, opts.bpm);
  const render = opts.render ?? defaultStepNoteRenderer;
  const input = renderInputOf(clip, notes);
  const program = opts.program ?? clip.instrumentProgram;
  return render(input.notes, bpm, input.steps, {
    program,
    ...(opts.bank ? { bank: opts.bank } : {}),
    percussion: opts.percussion,
    ...tempoOpt(clip),
    ...(input.bends && !opts.percussion ? { bends: input.bends } : {}),
    ...(input.controls ? { controls: input.controls } : {}),
    articulation: clipArticulationInstrument(clip, program, opts.percussion === true, opts.bank),
  });
}

/**
 * Re-render a MIDI clip at a new tempo. `ratio` is `timeline.stretchPlan`'s:
 * the new length as a multiple of the old, so the render tempo is
 * `sourceBpm / ratio` — halving the ratio doubles the tempo.
 *
 * This is lossless where an audio stretch is not: the notes are re-synthesised
 * at the new tempo rather than resampled, so nothing is smeared and the pitch
 * never moves. Audio clips have to go to the backend's pitch-preserving stretch
 * instead; `stretchPlan` tags them `'audio'` for exactly that reason.
 */
export async function stretchMidiClip(
  clip: AudioClip,
  ratio: number,
  opts: MidiRenderOptions = {},
): Promise<RenderedAudio> {
  const notes = notesOf(clip);
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
    throw new Error('stretchMidiClip: ratio must be a finite number > 0');
  }
  const bpm = tempoOf(clip, opts.bpm) / ratio;
  if (bpm < MIN_BPM || bpm > MAX_BPM) {
    throw new Error(
      `stretchMidiClip: ratio ${ratio} needs a render tempo of ${bpm.toFixed(1)} bpm, outside the renderable ${MIN_BPM}-${MAX_BPM} range`,
    );
  }
  const render = opts.render ?? defaultStepNoteRenderer;
  const input = renderInputOf(clip, notes);
  // The clip's tempo map scales with it: every change keeps its proportion to the new start tempo,
  // and each controller change stays on its tick.
  const program = opts.program ?? clip.instrumentProgram;
  return render(input.notes, bpm, input.steps, {
    program,
    ...(opts.bank ? { bank: opts.bank } : {}),
    percussion: opts.percussion,
    ...tempoOpt(clip),
    ...(input.bends && !opts.percussion ? { bends: input.bends } : {}),
    ...(input.controls ? { controls: input.controls } : {}),
    articulation: clipArticulationInstrument(clip, program, opts.percussion === true, opts.bank),
  });
}
