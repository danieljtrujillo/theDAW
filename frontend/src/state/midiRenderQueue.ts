/**
 * midiRenderQueue — renders piano-roll clips' audio one clip at a time.
 *
 * A piano-roll clip's `audioBlob` is an optional cached render (lib/midiRender).
 * Everything that needs a clip's audio asks through here, so no two soundfont
 * renders ever run at once:
 *
 *   - 'cache': EDIT's own upkeep. A clip whose render went stale (a note edit,
 *     an instrument change) is re-rendered and keeps the reason it had a render;
 *     a clip with no render that cannot play live (no program, or past the last
 *     live channel) is rendered so it can be heard, and that render is marked
 *     as made for that reason (AudioClip renderAuto). A clip that plays live
 *     needs neither: the request is skipped, and a render made only so it could
 *     be heard is dropped (dropAutoRender). The render is written onto the clip
 *     as derived audio (applyClipRender: no undo step).
 *   - 'keep': someone asked for the clip's audio (Keep rendered audio, an audio
 *     edit through clipWithAudio). The clip is rendered when it holds no current
 *     render, and the render is kept from then on (its auto mark cleared).
 *   - 'export': an offline bounce (mixdown, export, stem, freeze, send to MAKE,
 *     a drag out) needs the clip's audio. A clip with a current render hands it
 *     over as it is; a clip with a stale cache is re-rendered and the cache
 *     written; a clip with no render is rendered for this bounce only and stays
 *     without one (clipsWithMidiAudio hands the render to the bounce and
 *     releases it after).
 *
 * A render made outside a clip's cache (an assistant note tool's atomic
 * re-render, a stretch, a MIDI take's first render) takes its turn here too,
 * through withRenderTurn, so it never overlaps a clip render.
 *
 * Requests for the same clip and mode that are still waiting share one job. A
 * render whose clip changed while it ran (its notes, tempo, lanes, bends or
 * voice) is thrown away and run again from the clip as it is now, so a result
 * never lands on a clip it was not made from.
 *
 * The renderer, the peak scan, the picker, the soundfont warm-up and the live
 * plan are configured once (WaveformEditor configures the real ones), so node
 * tests replay the queue against the real editor store with a stand-in synth.
 */
import { create } from 'zustand';
import { useEditorStore, type AudioClip, type EditorTrack } from './editorStore';
import { clipVoice, type GlobalVoice } from '../lib/clipProgram';
import { releaseDecoded } from '../lib/decodeCache';
import {
  DROP_RENDER_FIELDS,
  hasMidiNotes,
  midiRenderFields,
  midiRenderSig,
  midiRenderState,
  renderMidiClipAudio,
  type MidiStepRender,
} from '../lib/midiRender';

export interface MidiRenderDeps {
  render: MidiStepRender;
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array }>;
  global: () => GlobalVoice;
  /** Awaited before each render (soundfontEngine ensureSoundfontReady). */
  ensureReady: () => Promise<unknown>;
  /**
   * liveMixer liveMidiIfHeard: the ids of the MIDI clips of `clips` that play
   * live when heard, mute ignored. A 'cache' request for a clip in it renders
   * nothing, and the assistant's note tools read it through midiLiveIfHeard.
   * Left out, every clip counts as unable to play live, which is how a queue
   * with no live plan behaved.
   */
  livePlan?: (clips: readonly AudioClip[], tracks: readonly EditorTrack[], global: GlobalVoice) => ReadonlySet<string>;
}

export type MidiRenderMode = 'cache' | 'keep' | 'export';

/**
 * What a render is for, as the queue's status line says it: an export (every
 * bounce job) or a drag of EDIT clips to another surface. Left out for EDIT's
 * own upkeep and for edits.
 */
export type MidiRenderPurpose = 'export' | 'drag-out';

/** What a request came to. `clip` is the clip with its audio: for 'rendered', a copy the store never saw. */
export type MidiRenderOutcome =
  | { kind: 'written'; clip: AudioClip }
  | { kind: 'rendered'; clip: AudioClip }
  | { kind: 'current'; clip: AudioClip }
  | { kind: 'skipped'; reason: string; clip?: AudioClip };

interface ClipJob {
  kind: 'clip';
  clipId: string;
  label: string;
  mode: MidiRenderMode;
  purpose?: MidiRenderPurpose;
  promise: Promise<MidiRenderOutcome>;
  resolve: (o: MidiRenderOutcome) => void;
  reject: (e: unknown) => void;
}

/** A render made outside a clip's cache, run in the queue's turn (withRenderTurn). */
interface TurnJob {
  kind: 'turn';
  clipId: string;
  label: string;
  work: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

type Job = ClipJob | TurnJob;

/** The queue as the UI reads it. */
export interface MidiRenderQueueState {
  /** The clip rendering now, or null. A render in another tool's turn names what it renders; its mode is 'keep'. */
  running: { clipId: string; label: string; mode: MidiRenderMode; purpose?: MidiRenderPurpose } | null;
  /** Clips waiting, in order. */
  waiting: Array<{ clipId: string; label: string; mode: MidiRenderMode; purpose?: MidiRenderPurpose }>;
  /** Renders finished this session, and renders that failed. */
  done: number;
  failed: number;
  /** The last failure, in words, until the next render succeeds or it is dismissed. */
  lastError: string | null;
}

export const useMidiRenderQueue = create<MidiRenderQueueState>(() => ({
  running: null,
  waiting: [],
  done: 0,
  failed: 0,
  lastError: null,
}));

let deps: MidiRenderDeps | null = null;
const jobs: Job[] = [];
let pumping = false;
/** Re-renders of one request when its clip keeps changing under it. */
const MAX_ATTEMPTS = 3;

/** Hand the queue its renderer, peak scan, picker, warm-up and live plan. */
export function configureMidiRenderQueue(next: MidiRenderDeps): void {
  deps = next;
}

/** True once a renderer is configured. */
export const midiRenderQueueReady = (): boolean => deps !== null;

/**
 * The instrument picker as the configured renderer reads it (soundfontEngine
 * getGlobalVoice), or soundfonts off before one is configured. A MIDI clip
 * with no program of its own or on its track plays and renders through it.
 */
export const midiGlobalVoice = (): GlobalVoice => deps?.global() ?? { useSoundfont: false, activeProgram: 0 };

/**
 * The clips of `clips` (the store's, by default) that play live when heard,
 * by the configured live plan (liveMixer liveMidiIfHeard, which WaveformEditor
 * configures). None before a plan is configured: every clip then counts as
 * unable to play live, and an automatic render is kept until EDIT's upkeep
 * sees the clip play live.
 */
export function midiLiveIfHeard(clips: readonly AudioClip[] = useEditorStore.getState().clips): ReadonlySet<string> {
  const plan = deps?.livePlan;
  return plan ? plan(clips, useEditorStore.getState().tracks, midiGlobalVoice()) : new Set<string>();
}

/**
 * The configured renderer, or the app's own (lib/midiSynth, soundfontEngine,
 * editorStore computePeaks, liveMixer's plan) loaded on first use, so an
 * assistant tool that needs a clip's audio before EDIT ever opened still gets
 * one. Node tests configure a stand-in first and never reach the imports.
 */
async function resolvedDeps(): Promise<MidiRenderDeps> {
  if (deps) return deps;
  const [synth, sf, store, mixer] = await Promise.all([
    import('../lib/midiSynth'),
    import('../lib/soundfontEngine'),
    import('./editorStore'),
    import('./liveMixer'),
  ]);
  deps ??= {
    render: synth.renderStepNotesToBlob,
    computePeaks: store.computePeaks,
    global: sf.getGlobalVoice,
    ensureReady: sf.ensureSoundfontReady,
    livePlan: mixer.liveMidiIfHeard,
  };
  return deps;
}

/** A job as the queue's state shows it. */
const shown = (j: Job): { clipId: string; label: string; mode: MidiRenderMode; purpose?: MidiRenderPurpose } =>
  j.kind === 'clip'
    ? { clipId: j.clipId, label: j.label, mode: j.mode, ...(j.purpose ? { purpose: j.purpose } : {}) }
    : { clipId: j.clipId, label: j.label, mode: 'keep' };

const publish = (running: MidiRenderQueueState['running']): void => {
  useMidiRenderQueue.setState({ running, waiting: jobs.map(shown) });
};

/**
 * The status line for the render running now, as EDIT's render bar prints it:
 * "Rendering MIDI audio for the drag out: Violin I · 3 waiting". An export's
 * renders say "for the export"; EDIT's own renders name no purpose.
 */
export function midiRenderStatusText(running: NonNullable<MidiRenderQueueState['running']>, waiting: number): string {
  const purpose = running.purpose ?? (running.mode === 'export' ? 'export' : undefined);
  const why = purpose === 'drag-out' ? ' for the drag out' : purpose === 'export' ? ' for the export' : '';
  return `Rendering MIDI audio${why}: ${running.label}${waiting ? ` · ${waiting} waiting` : ''}`;
}

const liveClip = (id: string): AudioClip | undefined => useEditorStore.getState().clips.find((c) => c.id === id);
const trackOf = (clip: AudioClip) => useEditorStore.getState().tracks.find((t) => t.id === clip.trackId);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Ask for `clipId`'s audio. Resolves when this clip's turn has come and gone;
 * rejects when the render fails. A request for a clip and mode already waiting
 * shares that job (and names its purpose when the waiting one named none).
 * `purpose` is what the status line says the render is for.
 */
export function requestMidiRender(clipId: string, mode: MidiRenderMode = 'cache', purpose?: MidiRenderPurpose): Promise<MidiRenderOutcome> {
  const waiting = jobs.find((j): j is ClipJob => j.kind === 'clip' && j.clipId === clipId && j.mode === mode);
  if (waiting) {
    if (purpose && !waiting.purpose) {
      waiting.purpose = purpose;
      publish(useMidiRenderQueue.getState().running);
    }
    return waiting.promise;
  }
  let resolve!: (o: MidiRenderOutcome) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<MidiRenderOutcome>((res, rej) => { resolve = res; reject = rej; });
  jobs.push({ kind: 'clip', clipId, label: liveClip(clipId)?.label ?? clipId, mode, ...(purpose ? { purpose } : {}), promise, resolve, reject });
  publish(useMidiRenderQueue.getState().running);
  void pump();
  return promise;
}

/**
 * Run `work`, a render made outside a clip's cache, in the queue's turn: after
 * every render already waiting and before any asked for later, so no two
 * soundfont renders overlap. `clipId` and `label` name it in the queue's
 * status. Resolves or rejects with `work`; a failure is the caller's to report
 * and is not counted as a failed clip render.
 */
export function withRenderTurn<T>(clipId: string, label: string, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    jobs.push({ kind: 'turn', clipId, label, work, resolve: resolve as (v: unknown) => void, reject });
    publish(useMidiRenderQueue.getState().running);
    void pump();
  });
}

/** Drop every waiting job (each resolves as skipped). The render running now finishes. */
export function clearMidiRenderQueue(reason = 'the queue was cleared'): void {
  const dropped = jobs.splice(0, jobs.length);
  for (const j of dropped) {
    if (j.kind === 'clip') j.resolve({ kind: 'skipped', reason });
    else j.reject(new Error(reason));
  }
  publish(useMidiRenderQueue.getState().running);
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.length > 0) {
      const job = jobs.shift() as Job;
      publish(shown(job));
      if (job.kind === 'turn') {
        try {
          job.resolve(await job.work());
        } catch (e) {
          job.reject(e);
        }
        continue;
      }
      try {
        const outcome = await runJob(job);
        const rendered = outcome.kind === 'written' || outcome.kind === 'rendered';
        useMidiRenderQueue.setState((s) => ({ done: s.done + (rendered ? 1 : 0), lastError: rendered ? null : s.lastError }));
        job.resolve(outcome);
      } catch (e) {
        useMidiRenderQueue.setState((s) => ({ failed: s.failed + 1, lastError: `${job.label}: ${message(e)}` }));
        job.reject(e);
      }
    }
  } finally {
    pumping = false;
    publish(null);
  }
}

/** True when `clip` still has the notes (`sig`) and voice a render was made from. */
const stillMatches = (clip: AudioClip | undefined, sig: string, voice: { program: number | undefined; percussion: boolean }, d: MidiRenderDeps): clip is AudioClip => {
  if (!clip || midiRenderSig(clip) !== sig) return false;
  const now = clipVoice(clip, trackOf(clip), d.global());
  return now.program === voice.program && now.percussion === voice.percussion;
};

/** True when the configured live plan plays `clipId` live when it is heard. */
const playsLiveNow = (d: MidiRenderDeps, clipId: string): boolean => {
  const s = useEditorStore.getState();
  return d.livePlan?.(s.clips, s.tracks, d.global()).has(clipId) ?? false;
};

/**
 * Take away a render EDIT made only so `clipId` could be heard, now that the
 * clip plays live: its audio, peaks, signature, voice stamp and mark go (the
 * window stays), as derived audio with no undo step, and the decoded audio is
 * freed unless another clip plays it. A render kept on purpose is left alone.
 * True when a render was dropped.
 */
export function dropAutoRender(clipId: string): boolean {
  const clip = liveClip(clipId);
  if (!clip || !(clip.audioBlob instanceof Blob) || clip.renderAuto !== true) return false;
  useEditorStore.getState().applyClipRender(clipId, { ...DROP_RENDER_FIELDS });
  return true;
}

async function runJob(job: ClipJob): Promise<MidiRenderOutcome> {
  const d = await resolvedDeps();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const clip = liveClip(job.clipId);
    if (!clip) return { kind: 'skipped', reason: 'the clip is gone' };
    if (!hasMidiNotes(clip)) return { kind: 'current', clip };
    const holds = clip.audioBlob instanceof Blob;
    // EDIT's upkeep renders nothing for a clip that plays live, unless it keeps
    // a render on purpose; a render made only so it could be heard goes.
    if (job.mode === 'cache' && (!holds || clip.renderAuto === true) && playsLiveNow(d, clip.id)) {
      if (dropAutoRender(clip.id)) return { kind: 'skipped', reason: 'it plays live, so the render made for it to be heard was dropped', clip: liveClip(clip.id) };
      return { kind: 'skipped', reason: 'it plays live', clip };
    }
    const global = d.global();
    const state = midiRenderState(clip, trackOf(clip), global);
    if (state === 'current') {
      // Asked to keep a render EDIT made on its own: it is kept from now on.
      if (job.mode === 'keep' && clip.renderAuto === true) useEditorStore.getState().applyClipRender(clip.id, { renderAuto: undefined });
      return { kind: 'current', clip: liveClip(clip.id) ?? clip };
    }
    const voice = clipVoice(clip, trackOf(clip), global);
    const sig = midiRenderSig(clip);
    await d.ensureReady();
    const rendered = await renderMidiClipAudio(clip, voice, d.render, useEditorStore.getState().bpm);
    // Re-read: the clip may have been edited, re-voiced or deleted mid-render.
    const now = liveClip(job.clipId);
    if (!now) return { kind: 'skipped', reason: 'the clip was removed while it rendered' };
    if (!stillMatches(now, sig, voice, d)) continue; // made from what the clip was; render what it is
    // A clip that holds a render keeps it current; 'cache' and 'keep' write one.
    // An export of a clip with none (or whose automatic render EDIT dropped
    // while this one ran) renders a copy and leaves the clip without one.
    if (job.mode !== 'export' || now.audioBlob instanceof Blob) {
      const { peaks } = await d.computePeaks(rendered.blob, 240);
      const after = liveClip(job.clipId);
      if (!after) return { kind: 'skipped', reason: 'the clip was removed while it rendered' };
      if (!stillMatches(after, sig, voice, d)) continue;
      // Why the clip holds this render: asked for ('keep'), or EDIT's upkeep of a
      // render the clip already held (it keeps its reason), or a clip that could
      // not play live and held none (made so it can be heard).
      const auto = job.mode === 'keep' ? false : after.audioBlob instanceof Blob ? after.renderAuto === true : job.mode === 'cache';
      // The window is worked out from the clip as it is now, after the peak
      // scan, so a trim made while the render or the scan ran is kept
      // (lib/clipRenderWindow).
      useEditorStore.getState().applyClipRender(job.clipId, midiRenderFields(after, rendered, voice, auto), peaks);
      return { kind: 'written', clip: liveClip(job.clipId) as AudioClip };
    }
    return { kind: 'rendered', clip: { ...now, ...midiRenderFields(now, rendered, voice) } };
  }
  throw new Error(`the clip kept changing while it rendered (${MAX_ATTEMPTS} tries)`);
}

/** What an offline bounce reads: its clips, each MIDI clip with its audio, and the renders made for it alone. */
export interface MidiBounceClips {
  clips: AudioClip[];
  /** Renders made for this bounce only (their clips hold no render). */
  transient: Blob[];
  /** Free the decoded audio of the renders made for this bounce only. Call it once the bounce is done. */
  release: () => void;
}

/**
 * The clips an offline bounce reads, each with its audio: every piano-roll
 * clip with notes that has no current render is rendered through the queue,
 * one at a time, before the bounce builds its graph. Muted clips are left as
 * they are, since every bounce skips them (`includeMuted` renders them too,
 * for a drag that hands a muted part over), and so are clips `wanted` turns
 * down (outside the bounce's scope).
 *
 * A clip that plays live (it has a program) and holds no render is rendered
 * for this bounce only and stays without one; `release` frees that render's
 * decoded audio once the bounce is done, since nothing else will ever ask for
 * it. A clip with no program cannot play live and needs audio to be heard at
 * all, so its render is kept on it (the same render EDIT would queue for it).
 *
 * `onProgress` hears each clip as it finishes. `shouldStop` is asked before
 * each render; once it says yes no more renders start and the list is returned
 * as it stands (the caller is being called off). The list is the store's as it
 * stands after the renders, so an edit made meanwhile is what prints, and a
 * render made for this bounce rides on its clip while the clip still matches
 * it. Rejects, naming the clip, when one cannot be rendered, so an export never
 * prints silence where a part should sound.
 */
export async function clipsWithMidiAudio(
  wanted: (clip: AudioClip) => boolean = () => true,
  onProgress?: (doneCount: number, total: number, label: string) => void,
  shouldStop: () => boolean = () => false,
  opts: { includeMuted?: boolean; purpose?: MidiRenderPurpose } = {},
): Promise<MidiBounceClips> {
  const transient = new Map<string, Partial<AudioClip>>();
  const release = (): void => {
    const live = new Set(useEditorStore.getState().clips.map((c) => c.audioBlob).filter((b): b is Blob => !!b));
    for (const fields of transient.values()) {
      if (fields.audioBlob && !live.has(fields.audioBlob)) releaseDecoded(fields.audioBlob);
    }
    transient.clear();
  };
  const result = (clips: readonly AudioClip[]): MidiBounceClips => {
    const out = clips.map(withTransient);
    return {
      clips: out,
      transient: [...transient.values()].map((f) => f.audioBlob).filter((b): b is Blob => !!b),
      release,
    };
  };
  // A render made for this bounce rides on its clip while the clip holds no render of its own.
  const withTransient = (c: AudioClip): AudioClip => {
    const fields = transient.get(c.id);
    if (!fields || c.audioBlob instanceof Blob) return c;
    return { ...c, ...fields };
  };
  const heard = (c: AudioClip): boolean => opts.includeMuted === true || !c.muted;
  // A bounce with no MIDI clip in it never loads the renderer.
  if (!useEditorStore.getState().clips.some((c) => wanted(c) && heard(c) && hasMidiNotes(c))) {
    return result(useEditorStore.getState().clips);
  }
  const d = await resolvedDeps();
  const needsRender = (c: AudioClip): boolean => {
    if (!wanted(c) || !heard(c) || !hasMidiNotes(c)) return false;
    return midiRenderState(withTransient(c), trackOf(c), d.global()) !== 'current';
  };
  let count = 0;
  for (let pass = 0; pass < MAX_ATTEMPTS; pass += 1) {
    const clips = useEditorStore.getState().clips;
    const need = clips.filter(needsRender);
    if (need.length === 0) return result(clips);
    const total = count + need.length;
    for (const clip of need) {
      if (shouldStop()) return result(useEditorStore.getState().clips);
      // A clip that cannot play live keeps its render; one that plays live renders for this bounce.
      const live = liveClip(clip.id) ?? clip;
      const mode: MidiRenderMode = clipVoice(live, trackOf(live), d.global()).program === undefined ? 'cache' : 'export';
      let outcome: MidiRenderOutcome;
      try {
        outcome = await requestMidiRender(clip.id, mode, opts.purpose ?? 'export');
      } catch (e) {
        release();
        throw new Error(`MIDI clip "${clip.label}" could not be rendered: ${message(e)}`);
      }
      count += 1;
      onProgress?.(count, total, clip.label);
      if (outcome.kind === 'rendered') transient.set(clip.id, pickRender(outcome.clip));
    }
  }
  const still = useEditorStore.getState().clips.filter(needsRender);
  if (still.length === 0) return result(useEditorStore.getState().clips);
  release();
  throw new Error(`MIDI clip "${still[0].label}" kept changing while the export rendered it`);
}

/** The fields a render writes, taken off a rendered copy. */
function pickRender(r: AudioClip): Partial<AudioClip> {
  return {
    audioBlob: r.audioBlob,
    mimeType: r.mimeType,
    sourceDuration: r.sourceDuration,
    durationSec: r.durationSec,
    offsetIntoSource: r.offsetIntoSource,
    renderedProgram: r.renderedProgram,
    renderedPercussion: r.renderedPercussion,
    renderSig: r.renderSig,
  };
}

/**
 * `clipId` with its audio, for an edit that works on samples (a stem split, a
 * stretch, an inpaint crop, a preview, a granular bleed, reverse, normalize).
 * An audio clip, or a MIDI clip holding a current render, comes back as it is.
 * A MIDI clip with no render, or a stale one, is rendered through the queue
 * first ('keep'), and keeps the render: the edit asked for audio. A render EDIT
 * made only so the clip could be heard is kept from then on too. Rejects when
 * there is none to be had (an empty roll) or the render fails.
 */
export async function clipWithAudio(clipId: string): Promise<AudioClip> {
  const clip = liveClip(clipId);
  if (!clip) throw new Error('the clip is gone');
  if (clip.audioBlob instanceof Blob) {
    if (!hasMidiNotes(clip)) return clip;
    // A stale cache is brought up to date first, so the edit works on what the clip sounds like.
    const d = await resolvedDeps();
    if (midiRenderState(clip, trackOf(clip), d.global()) === 'current' && clip.renderAuto !== true) return clip;
  }
  if (!hasMidiNotes(clip)) throw new Error(`"${clip.label}" is an empty MIDI clip, so it has no audio`);
  const outcome = await requestMidiRender(clipId, 'keep');
  if (outcome.kind === 'skipped') throw new Error(`"${clip.label}" could not be rendered: ${outcome.reason}`);
  const now = liveClip(clipId);
  if (!now || !(now.audioBlob instanceof Blob)) throw new Error(`"${clip.label}" has no rendered audio`);
  return now;
}
