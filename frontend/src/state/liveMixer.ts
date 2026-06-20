/**
 * liveMixer — real-time multi-track playback for the EDIT timeline.
 *
 * Until now, pressing Play in the editor did an OFFLINE bounce (mix every clip
 * into one WAV, then play that WAV through the footer's <audio>). That meant a
 * per-track fader / pan / mute / solo only changed the mix on the NEXT play.
 *
 * This module instead schedules each clip as a live Web Audio node graph so
 * track volume / pan / mute / solo are audible MID-playback:
 *
 *     BufferSource ─▶ clipGain (fade in/out) ─▶ trackGain (volume, live)
 *                                                   └▶ panner (pan, live) ─▶ master
 *
 * trackGain + panner are shared per track and updated in place when the EDIT
 * (or SLIDE) faders move — that's the whole point. clipGain carries each clip's
 * fade envelope. Everything routes through the shared engine master → analyser
 * → destination, so the visualizer + HUD keep working.
 *
 * Transport: a rAF clock advances a virtual playhead off the AudioContext
 * clock and mirrors it into playerStore.currentTime (footer time) and
 * editorStore.playheadSec (the moving line). The footer is UNCHANGED — it calls
 * the usual playerStore transport methods, which delegate here while a live
 * editor session is registered (see playerStore.setLiveTransport).
 *
 * The OFFLINE bounce is kept as-is for export / commit / send-to-init — those
 * genuinely need a rendered file. liveMixer only replaces the live PREVIEW.
 *
 * Honesty / scope: live updates cover the MIXER params (volume/pan/mute/solo).
 * Structural clip edits (add/remove/split/move) made WHILE playing take effect
 * on the next play, same as a hardware mixer wouldn't re-cut tape mid-take.
 */
import { useEditorStore, type AudioClip, type EditorTrack } from './editorStore';
import {
  usePlayerStore,
  getEngineCtx,
  getMasterGain,
  setLiveTransport,
} from './playerStore';
import { logError } from './logStore';
import {
  ensureSoundfontReady,
  isLiveSynthReady,
  liveNoteOn,
  liveNoteOff,
  liveAllNotesOff,
  useSoundfontStore,
} from '../lib/soundfontEngine';

const DECODE_TIMEOUT_MS = 15000;
const EDITOR_ENTRY_ID = 'editor-timeline'; // reuse so existing footer/playhead wiring keeps working
const RAMP_TC = 0.015; // setTargetAtTime time-constant for click-free param moves

// Decoded buffers cached by Blob identity. A WeakMap means a clip's buffer is
// reclaimed once its Blob is gone, and an edited clip (new Blob) re-decodes.
const decodeCache = new WeakMap<Blob, AudioBuffer>();

interface TrackNodes {
  gain: GainNode;
  panner: StereoPannerNode;
}

// ---- live session state (module singletons; one editor timeline at a time) --
let trackNodes = new Map<string, TrackNodes>();
let sources: AudioBufferSourceNode[] = [];
let rafId = 0;
let startCtxTime = 0; // ctx.currentTime at the moment playback (re)started
let startOffsetSec = 0; // timeline position playback started from
let totalDur = 0;
let playing = false;
let playToken = 0; // guards against overlapping async play() calls
let unsubEditor: (() => void) | null = null;
let lastMixSig = '';
let lastTimePush = 0; // throttle playerStore.currentTime writes
let midiTimers: number[] = []; // setTimeout handles for scheduled MIDI note on/off
let liveMidiActive = false; // true while MIDI clips play via the live synth (vs their bounce)

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Effective track gain honoring mute + (exclusive) solo. */
function effectiveVol(t: EditorTrack, anySolo: boolean): number {
  if (t.mute) return 0;
  if (anySolo && !t.solo) return 0;
  return clamp(t.volume, 0, 1);
}

/** A short signature of just the mixer-relevant fields, so the editorStore
 *  subscription (which also fires on every playhead tick) only pushes live
 *  node updates when a fader/pan/mute/solo actually moved. */
function mixSignature(tracks: EditorTrack[]): string {
  let s = '';
  for (const t of tracks) s += `${t.id}:${t.volume}:${t.pan}:${t.mute}:${t.solo}|`;
  return s;
}

/** Push current track volume/pan/mute/solo onto the live nodes (click-free). */
function applyMixLive(): void {
  const ctx = getEngineCtx();
  const tracks = useEditorStore.getState().tracks;
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    const n = trackNodes.get(t.id);
    if (!n) continue;
    n.gain.gain.setTargetAtTime(effectiveVol(t, anySolo), ctx.currentTime, RAMP_TC);
    n.panner.pan.setTargetAtTime(clamp(t.pan, -1, 1), ctx.currentTime, RAMP_TC);
  }
}

/** Decode every clip's blob we'll need (cached by Blob identity). */
async function ensureDecoded(clips: AudioClip[]): Promise<void> {
  const ctx = getEngineCtx();
  for (const clip of clips) {
    if (decodeCache.has(clip.audioBlob)) continue;
    const ab = await clip.audioBlob.arrayBuffer();
    const decoded = await Promise.race([
      ctx.decodeAudioData(ab.slice(0)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS),
      ),
    ]);
    decodeCache.set(clip.audioBlob, decoded);
  }
}

/** Build (or rebuild) one shared gain+panner per track that has clips. */
function buildTrackNodes(tracks: EditorTrack[]): void {
  const ctx = getEngineCtx();
  const master = getMasterGain();
  trackNodes = new Map();
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    const gain = ctx.createGain();
    gain.gain.value = effectiveVol(t, anySolo);
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(t.pan, -1, 1);
    gain.connect(panner).connect(master);
    trackNodes.set(t.id, { gain, panner });
  }
}

/** A MIDI clip = a piano-roll clip carrying its editable notes. */
function isMidiClip(clip: AudioClip): boolean {
  return clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll && clip.sourcePianoRoll.length > 0;
}

/** Schedule every clip that is at or after `fromSec` (or straddling it). */
function scheduleClips(clips: AudioClip[], fromSec: number): void {
  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  sources = [];
  for (const clip of clips) {
    // When the live synth drives MIDI, skip the clip's bounced audio so we don't
    // double up; scheduleMidiClips plays its notes instead.
    if (liveMidiActive && isMidiClip(clip)) continue;
    const nodes = trackNodes.get(clip.trackId);
    if (!nodes) continue;
    const buf = decodeCache.get(clip.audioBlob);
    if (!buf) continue;

    const safeOffset = Math.min(clip.offsetIntoSource, Math.max(0, buf.duration - 0.01));
    const safeDur = Math.min(clip.durationSec, buf.duration - safeOffset);
    if (safeDur <= 0) continue;

    const clipEndSec = clip.startSec + safeDur;
    if (clipEndSec <= fromSec) continue; // already finished before the start point

    // How far into this clip the playhead already is (0 if clip is in the future).
    const into = Math.max(0, fromSec - clip.startSec);
    const remaining = safeDur - into;
    if (remaining <= 0) continue;

    const clipStartCtx = now + (clip.startSec - fromSec); // may be < now when straddling
    const when = Math.max(now, clipStartCtx);

    // Per-clip fade envelope on a dedicated gain (track volume lives on trackGain).
    const clipGain = ctx.createGain();
    const fadeIn = clip.fadeInSec ?? 0;
    const fadeOut = clip.fadeOutSec ?? 0;
    const g = clipGain.gain;
    if (clipStartCtx >= now) {
      // Clip begins in the future — full envelope.
      g.setValueAtTime(fadeIn > 0 ? 0 : 1, when);
      if (fadeIn > 0) g.linearRampToValueAtTime(1, when + Math.min(fadeIn, safeDur));
    } else {
      // Starting mid-clip — set the current envelope value now.
      const cur = fadeIn > 0 && into < fadeIn ? into / fadeIn : 1;
      g.setValueAtTime(cur, now);
      if (fadeIn > 0 && into < fadeIn) g.linearRampToValueAtTime(1, clipStartCtx + fadeIn);
    }
    if (fadeOut > 0) {
      const foStartCtx = clipStartCtx + safeDur - Math.min(fadeOut, safeDur);
      if (foStartCtx > now) g.setValueAtTime(1, foStartCtx);
      g.linearRampToValueAtTime(0, clipStartCtx + safeDur);
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(clipGain).connect(nodes.gain);
    src.start(when, safeOffset + into, remaining);
    src.onended = () => {
      try { src.disconnect(); clipGain.disconnect(); } catch { /* already gone */ }
    };
    sources.push(src);
  }
}

/**
 * Schedule live-synth note on/off for every MIDI clip at or after `fromSec`.
 * Notes fire via timers aligned to the transport (preview-accurate); the offline
 * export keeps using the sample-accurate render path. One synth channel per track
 * (16-channel cap); per-track volume/pan are not yet applied to MIDI, but mute and
 * solo are honored by skipping the track.
 */
function scheduleMidiClips(clips: AudioClip[], fromSec: number): void {
  const ed = useEditorStore.getState();
  const tracks = ed.tracks;
  const anySolo = tracks.some((t) => t.solo);
  const trackById = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
  const globalProgram = useSoundfontStore.getState().activeProgram;

  // One synth channel per track that has MIDI clips (16-channel cap).
  const channelOf = new Map<string, number>();
  let nextCh = 0;
  for (const clip of clips) {
    if (!isMidiClip(clip) || channelOf.has(clip.trackId)) continue;
    if (nextCh > 15) break;
    channelOf.set(clip.trackId, nextCh++);
  }

  for (const clip of clips) {
    if (!isMidiClip(clip)) continue;
    const track = trackById.get(clip.trackId);
    if (!track || effectiveVol(track, anySolo) <= 0) continue; // honor mute/solo
    const channel = channelOf.get(clip.trackId);
    if (channel === undefined) continue; // beyond the 16-instrument cap
    const program = clip.instrumentProgram ?? track.instrumentProgram ?? globalProgram;
    const bpm = clip.sourceBpm ?? ed.bpm ?? 120;
    const stepSec = 60 / Math.max(40, bpm) / 4;
    for (const n of clip.sourcePianoRoll ?? []) {
      const onSec = clip.startSec + n.step * stepSec;
      const offSec = onSec + Math.max(1, n.length) * stepSec;
      if (offSec <= fromSec || onSec < fromSec) continue; // finished, or already sounding
      const onDelay = Math.max(0, (onSec - fromSec) * 1000);
      const offDelay = Math.max(onDelay + 10, (offSec - fromSec) * 1000);
      const midi = n.note;
      const vel = n.velocity;
      midiTimers.push(window.setTimeout(() => liveNoteOn(channel, program, midi, vel), onDelay));
      midiTimers.push(window.setTimeout(() => liveNoteOff(channel, midi), offDelay));
    }
  }
}

/** Cancel pending MIDI note timers and silence the synth. */
function clearMidiTimers(): void {
  for (const id of midiTimers) clearTimeout(id);
  midiTimers = [];
  liveAllNotesOff();
}

/** Stop + disconnect every scheduled source (does not tear down track nodes). */
function clearSources(): void {
  for (const s of sources) {
    try { s.onended = null; s.stop(); s.disconnect(); } catch { /* already stopped */ }
  }
  sources = [];
  clearMidiTimers();
}

function stopClock(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/** rAF transport clock — advances the playhead off the AudioContext clock. */
function tick(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const elapsed = startOffsetSec + (ctx.currentTime - startCtxTime);

  if (elapsed >= totalDur) {
    if (usePlayerStore.getState().isLooping) {
      void start(0); // seamless-ish loop from the top
      return;
    }
    finishAtEnd();
    return;
  }

  // Playhead every frame (smooth line); footer time ~10 Hz is plenty.
  useEditorStore.getState().setPlayhead(elapsed);
  if (ctx.currentTime - lastTimePush > 0.1) {
    lastTimePush = ctx.currentTime;
    usePlayerStore.setState({ currentTime: elapsed });
  }
  rafId = requestAnimationFrame(tick);
}

/** Reached the end with looping off — park at end, mark stopped. */
function finishAtEnd(): void {
  clearSources();
  stopClock();
  playing = false;
  usePlayerStore.setState({ isPlaying: false, currentTime: totalDur });
  useEditorStore.getState().setPlayhead(totalDur);
}

/** (Re)start playback from `fromSec`. Decodes, builds nodes, schedules, runs. */
async function start(fromSec: number): Promise<void> {
  const token = ++playToken;
  const ed = useEditorStore.getState();
  const clips = ed.clips;
  if (clips.length === 0) return;

  totalDur = ed.getTotalDurationSec();
  const begin = fromSec >= totalDur - 0.05 ? 0 : Math.max(0, fromSec);

  // Tear down any previous run first.
  clearSources();
  stopClock();

  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* will retry on next gesture */ }
  }

  try {
    await ensureDecoded(clips);
  } catch (e) {
    logError('editor', `Live decode failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (token !== playToken) return; // superseded by a newer start()

  // Decide MIDI playback mode. Drive notes through the live synth only when the
  // user opted into a soundfont (global picker) or assigned an instrument to a
  // clip/track; otherwise keep playing the clip's bounced audio, so users who
  // never touch soundfonts see no behavior change or surprise soundfont load.
  const wantLiveMidi =
    clips.some(isMidiClip) &&
    (useSoundfontStore.getState().useSoundfont ||
      clips.some((c) => isMidiClip(c) && c.instrumentProgram !== undefined) ||
      ed.tracks.some((t) => t.instrumentProgram !== undefined));
  if (wantLiveMidi) {
    liveMidiActive = isLiveSynthReady() ? true : await ensureSoundfontReady();
    if (token !== playToken) return;
  } else {
    liveMidiActive = false;
  }

  // (Re)assert ourselves as the live transport — a library track played in the
  // meantime may have cleared it via playerStore.load().
  setLiveTransport({ play, pause, stop, seek });

  buildTrackNodes(ed.tracks);
  startCtxTime = ctx.currentTime;
  startOffsetSec = begin;
  lastTimePush = 0;
  lastMixSig = mixSignature(ed.tracks);
  scheduleClips(clips, begin);
  if (liveMidiActive) scheduleMidiClips(clips, begin);

  playing = true;
  usePlayerStore.setState({
    isPlaying: true,
    duration: totalDur,
    currentTime: begin,
    currentLabel: 'Editor Timeline',
    currentEntryId: EDITOR_ENTRY_ID,
    hasTrack: true,
  });
  useEditorStore.getState().setPlayhead(begin);

  // Live mixer-param updates (skip the churny playhead-only store ticks).
  if (!unsubEditor) {
    unsubEditor = useEditorStore.subscribe(() => {
      if (!playing) return;
      const sig = mixSignature(useEditorStore.getState().tracks);
      if (sig === lastMixSig) return;
      lastMixSig = sig;
      applyMixLive();
    });
  }

  rafId = requestAnimationFrame(tick);
}

/* ------------------------------- public API ------------------------------- */

/** Begin live playback from the current editor playhead. */
export function play(): void {
  void start(useEditorStore.getState().playheadSec);
}

/** Awaitable play (resolves once decode + scheduling are done) — lets the
 *  editor show a brief "Rendering" state on the first play of new clips. */
export async function playAsync(): Promise<void> {
  await start(useEditorStore.getState().playheadSec);
}

/** Pause in place (keeps the playhead). */
export function pause(): void {
  if (!playing) return;
  const ctx = getEngineCtx();
  const elapsed = clamp(startOffsetSec + (ctx.currentTime - startCtxTime), 0, totalDur);
  clearSources();
  stopClock();
  playing = false;
  useEditorStore.getState().setPlayhead(elapsed);
  usePlayerStore.setState({ isPlaying: false, currentTime: elapsed });
}

/** Stop and rewind to 0. */
export function stop(): void {
  clearSources();
  stopClock();
  playing = false;
  useEditorStore.getState().setPlayhead(0);
  usePlayerStore.setState({ isPlaying: false, currentTime: 0 });
}

/** Seek to `sec`; reschedules from there if currently playing. */
export function seek(sec: number): void {
  const target = clamp(sec, 0, totalDur || useEditorStore.getState().getTotalDurationSec());
  useEditorStore.getState().setPlayhead(target);
  usePlayerStore.setState({ currentTime: target });
  if (playing) void start(target);
}

/** True while live playback is running. */
export function isPlaying(): boolean {
  return playing;
}

/** Register this module as playerStore's live transport so the footer's normal
 *  transport buttons drive it. Call on editor mount. Returns an unregister. */
export function attach(): () => void {
  setLiveTransport({ play, pause, stop, seek });
  return () => {
    dispose();
  };
}

/** Tear everything down (editor unmount, or superseded by a library track). */
export function dispose(): void {
  clearSources();
  stopClock();
  playing = false;
  if (unsubEditor) { unsubEditor(); unsubEditor = null; }
  for (const n of trackNodes.values()) {
    try { n.gain.disconnect(); n.panner.disconnect(); } catch { /* gone */ }
  }
  trackNodes = new Map();
  setLiveTransport(null);
}
