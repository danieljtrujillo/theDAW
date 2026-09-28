/**
 * midiRenderQueue — renders piano-roll clips' audio one clip at a time.
 *
 * A piano-roll clip's `audioBlob` is an optional cached render (lib/midiRender).
 * Everything that needs a clip's audio asks through here, so no two soundfont
 * renders ever run at once:
 *
 *   - 'cache': keep a clip's cached render current. EDIT asks for it when a
 *     clip's cache goes stale (a note edit, an instrument change), when a clip
 *     with no render cannot play live (no program, or past the last live
 *     channel), when an audio edit needs samples, and when the user picks
 *     "Keep rendered audio". The render is written onto the clip as derived
 *     audio (applyClipRender: no undo step).
 *   - 'export': an offline bounce (mixdown, export, stem, freeze, send to MAKE)
 *     needs the clip's audio. A clip with a current render hands it over as it
 *     is; a clip with a stale cache is re-rendered and the cache written; a clip
 *     with no render is rendered for this bounce only and stays without one
 *     (clipsWithMidiAudio hands the render to the bounce and releases it after).
 *
 * Requests for the same clip and mode that are still waiting share one job. A
 * render whose clip changed while it ran (its notes, tempo, lanes, bends or
 * voice) is thrown away and run again from the clip as it is now, so a result
 * never lands on a clip it was not made from.
 *
 * The renderer, the peak scan, the picker and the soundfont warm-up are
 * configured once (WaveformEditor configures the real ones), so node tests
 * replay the queue against the real editor store with a stand-in synth.
 */
import { create } from 'zustand';
import { useEditorStore, type AudioClip } from './editorStore';
import { clipVoice, type GlobalVoice } from '../lib/clipProgram';
import { releaseDecoded } from '../lib/decodeCache';
import {
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
}

export type MidiRenderMode = 'cache' | 'export';

/** What a request came to. `clip` is the clip with its audio: for 'rendered', a copy the store never saw. */
export type MidiRenderOutcome =
  | { kind: 'written'; clip: AudioClip }
  | { kind: 'rendered'; clip: AudioClip }
  | { kind: 'current'; clip: AudioClip }
  | { kind: 'skipped'; reason: string; clip?: AudioClip };

interface Job {
  clipId: string;
  label: string;
  mode: MidiRenderMode;
  promise: Promise<MidiRenderOutcome>;
  resolve: (o: MidiRenderOutcome) => void;
  reject: (e: unknown) => void;
}

/** The queue as the UI reads it. */
export interface MidiRenderQueueState {
  /** The clip rendering now, or null. */
  running: { clipId: string; label: string; mode: MidiRenderMode } | null;
  /** Clips waiting, in order. */
  waiting: Array<{ clipId: string; label: string; mode: MidiRenderMode }>;
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

/** Hand the queue its renderer, peak scan, picker and warm-up. */
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
 * The configured renderer, or the app's own (lib/midiSynth, soundfontEngine,
 * editorStore computePeaks) loaded on first use, so an assistant tool that
 * needs a clip's audio before EDIT ever opened still gets one. Node tests
 * configure a stand-in first and never reach the imports.
 */
async function resolvedDeps(): Promise<MidiRenderDeps> {
  if (deps) return deps;
  const [synth, sf, store] = await Promise.all([
    import('../lib/midiSynth'),
    import('../lib/soundfontEngine'),
    import('./editorStore'),
  ]);
  deps ??= {
    render: synth.renderStepNotesToBlob,
    computePeaks: store.computePeaks,
    global: sf.getGlobalVoice,
    ensureReady: sf.ensureSoundfontReady,
  };
  return deps;
}

const publish = (running: MidiRenderQueueState['running']): void => {
  useMidiRenderQueue.setState({
    running,
    waiting: jobs.map((j) => ({ clipId: j.clipId, label: j.label, mode: j.mode })),
  });
};

const liveClip = (id: string): AudioClip | undefined => useEditorStore.getState().clips.find((c) => c.id === id);
const trackOf = (clip: AudioClip) => useEditorStore.getState().tracks.find((t) => t.id === clip.trackId);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Ask for `clipId`'s audio. Resolves when this clip's turn has come and gone;
 * rejects when the render fails. A request for a clip and mode already waiting
 * shares that job.
 */
export function requestMidiRender(clipId: string, mode: MidiRenderMode = 'cache'): Promise<MidiRenderOutcome> {
  const waiting = jobs.find((j) => j.clipId === clipId && j.mode === mode);
  if (waiting) return waiting.promise;
  let resolve!: (o: MidiRenderOutcome) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<MidiRenderOutcome>((res, rej) => { resolve = res; reject = rej; });
  jobs.push({ clipId, label: liveClip(clipId)?.label ?? clipId, mode, promise, resolve, reject });
  publish(useMidiRenderQueue.getState().running);
  void pump();
  return promise;
}

/** Drop every waiting job (each resolves as skipped). The render running now finishes. */
export function clearMidiRenderQueue(reason = 'the queue was cleared'): void {
  const dropped = jobs.splice(0, jobs.length);
  for (const j of dropped) j.resolve({ kind: 'skipped', reason });
  publish(useMidiRenderQueue.getState().running);
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.length > 0) {
      const job = jobs.shift() as Job;
      publish({ clipId: job.clipId, label: job.label, mode: job.mode });
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

async function runJob(job: Job): Promise<MidiRenderOutcome> {
  const d = await resolvedDeps();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const clip = liveClip(job.clipId);
    if (!clip) return { kind: 'skipped', reason: 'the clip is gone' };
    if (!hasMidiNotes(clip)) return { kind: 'current', clip };
    const global = d.global();
    const state = midiRenderState(clip, trackOf(clip), global);
    if (state === 'current') return { kind: 'current', clip };
    const voice = clipVoice(clip, trackOf(clip), global);
    const sig = midiRenderSig(clip);
    await d.ensureReady();
    const rendered = await renderMidiClipAudio(clip, voice, d.render, useEditorStore.getState().bpm);
    // Re-read: the clip may have been edited, re-voiced or deleted mid-render.
    const now = liveClip(job.clipId);
    if (!now) return { kind: 'skipped', reason: 'the clip was removed while it rendered' };
    if (!stillMatches(now, sig, voice, d)) continue; // made from what the clip was; render what it is
    // A clip that holds a render keeps it current, and 'cache' asks for one. An
    // export of a clip with none renders a copy and leaves the clip without one.
    if (job.mode === 'cache' || state === 'stale') {
      const { peaks } = await d.computePeaks(rendered.blob, 240);
      const after = liveClip(job.clipId);
      if (!after) return { kind: 'skipped', reason: 'the clip was removed while it rendered' };
      if (!stillMatches(after, sig, voice, d)) continue;
      // The window is worked out from the clip as it is now, so a trim made
      // while the render ran is kept (lib/clipRenderWindow).
      useEditorStore.getState().applyClipRender(job.clipId, midiRenderFields(after, rendered, voice), peaks);
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
 * they are, since every bounce skips them, and so are clips `wanted` turns
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
  // A bounce with no MIDI clip in it never loads the renderer.
  if (!useEditorStore.getState().clips.some((c) => wanted(c) && !c.muted && hasMidiNotes(c))) {
    return result(useEditorStore.getState().clips);
  }
  const d = await resolvedDeps();
  const needsRender = (c: AudioClip): boolean => {
    if (!wanted(c) || c.muted || !hasMidiNotes(c)) return false;
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
        outcome = await requestMidiRender(clip.id, mode);
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
 * stretch, an inpaint crop, a preview, a granular bleed, a drag out, reverse,
 * normalize). An audio clip, or a MIDI clip holding a current render, comes
 * back as it is. A MIDI clip with no render, or a stale one, is rendered
 * through the queue first and keeps the render: the edit asked for audio.
 * Rejects when there is none to be had (an empty roll) or the render fails.
 */
export async function clipWithAudio(clipId: string): Promise<AudioClip> {
  const clip = liveClip(clipId);
  if (!clip) throw new Error('the clip is gone');
  if (clip.audioBlob instanceof Blob) {
    if (!hasMidiNotes(clip)) return clip;
    // A stale cache is brought up to date first, so the edit works on what the clip sounds like.
    const d = await resolvedDeps();
    if (midiRenderState(clip, trackOf(clip), d.global()) === 'current') return clip;
  }
  if (!hasMidiNotes(clip)) throw new Error(`"${clip.label}" is an empty MIDI clip, so it has no audio`);
  const outcome = await requestMidiRender(clipId, 'cache');
  if (outcome.kind === 'skipped') throw new Error(`"${clip.label}" could not be rendered: ${outcome.reason}`);
  const now = liveClip(clipId);
  if (!now || !(now.audioBlob instanceof Blob)) throw new Error(`"${clip.label}" has no rendered audio`);
  return now;
}
