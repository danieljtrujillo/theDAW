/**
 * djEngine — a real, independent 2-deck DJ audio engine (AudioBuffer hybrid).
 *
 * Performance decks decode their track to an AudioBuffer and play through an
 * AudioBufferSourceNode, so loops / hotcues / slip are SAMPLE-ACCURATE (the
 * source node's native loopStart/loopEnd wrap on the audio thread, click-free):
 *
 *   bufSrc A ─▶ lowA ─▶ midA ─▶ highA ─▶ gainA ─┐
 *                                               ├▶ djMaster ─▶ engine master
 *   bufSrc B ─▶ lowB ─▶ midB ─▶ highB ─▶ gainB ─┘        (shared: playerStore)
 *
 * Memory: a decoded full song is ~100 MB. A deck's audio comes from the DJ-wide
 * decode cache (`lib/djAudioCache`), the same buffers the deck waveform lanes
 * draw from, so a loaded track is fetched and decoded once for the deck and its
 * lanes together. That cache holds at most `DJ_AUDIO_CACHE_MAX` buffers (both
 * decks plus the pair either side of a transition); a cleared deck drops its
 * reference and the cache's LRU decides when the memory goes. Browsing/preview
 * elsewhere still streams (wavesurfer fetches its own peaks); the deck engine
 * itself is pure Web Audio.
 *
 * `playbackRate` on the source doubles as the turntable pitch (speed+pitch
 * together, like a real deck's pitch fader).
 *
 * INDEPENDENT of the footer player: both mix at the shared engine master, so the
 * visualizer/HUD see DJ audio and the global volume/mute still apply, but the
 * footer's single-track transport is untouched ("independent DJ engine").
 *
 * Crossfader uses an equal-power curve so perceived loudness stays constant
 * across the sweep (center = both at ~-3 dB).
 *
 * SLIP: while a loop (or loop-roll) is engaged, a virtual clock keeps advancing
 * underneath. On loop exit with slip on, playback jumps to where it WOULD be —
 * as if the loop never happened. Loop-roll always slip-resumes.
 */
import type { StretchNode } from 'signalsmith-stretch';
import { getEngineCtx, getMasterGain } from './playerStore';
import { logError } from './logStore';
import { summingDelaysSec } from '../lib/rackEffects';
import { addWorkletModule } from '../lib/audioWorkletSupport';
import { getDecodedAudio, setDecodeContext } from '../lib/djAudioCache';

export type DeckId = 'A' | 'B';

export interface DeckStatus {
  loadedUrl: string | null;
  label: string | null;
  playing: boolean;
  decoding: boolean;
  hasBuffer: boolean;
  currentTime: number;
  duration: number;
  /** The engine AudioContext's clock at the moment this status was built.
   *  The only monotonic, audio-rate clock a subscriber can see — anything
   *  timing a musical process (the automix crossfade) must run off this and
   *  not `performance.now()`, which a throttled/background tab skews. */
  ctxTime: number;
  loopActive: boolean;
  loopIn: number | null;
  loopOut: number | null;
  slip: boolean;
  pitchPct: number;
  keylock: boolean;
  /** Seconds between the source position (`currentTime`) and what reaches the
   *  speakers: this deck's latency-match delay plus its key-lock insert.
   *  Anything lining two decks up by ear (phase sync) must compare
   *  `currentTime - latencySec * rate`, since a key-locked deck plays late by
   *  its insert's latency whenever the delay line cannot make up the rest. */
  latencySec: number;
  // Readonly: the no-stems case hands back one shared frozen empty rather
  // than allocating per frame (see statusOf), so the type must not let a
  // caller write into what every other deck/frame is also reading.
  stems: readonly string[]; // loaded stem names (D4); empty = full-track mode
  stemLevels: Readonly<Record<string, number>>; // per-stem live gains, 0 = muted, 1 = full
}

export type DjFx = 'flanger' | 'reverb' | 'wahwah';

/** Per-deck FX rack (lazy-built on first use): a dry path plus parallel
 *  flanger / wah / reverb branches, each summed at `out` via its own wet gain. */
interface DeckFx {
  input: GainNode;
  out: GainNode;
  flangerWet: GainNode;
  reverbWet: GainNode;
  wahWet: GainNode;
  lfoFlanger: OscillatorNode;
  lfoWah: OscillatorNode;
  nodes: AudioNode[];
}

/** One separated stem playing in sync on a deck (D4): its own gain (live fader)
 *  feeds the deck's srcBus alongside the other stems. */
interface DeckStem {
  name: string;
  buffer: AudioBuffer;
  gain: GainNode;
  level: number;
}

interface Deck {
  delayComp: DelayNode; // A/B latency match when one deck is key-locked
  delaySec: number; // the delay last asked of delayComp (sec)
  trim: GainNode; // auto-gain / leveling trim (independent of crossfader)
  vol: GainNode; // channel volume fader (manual), post-trim
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  filter: BiquadFilterNode; // single-knob DJ filter (LP↔HP sweep), post-EQ
  gain: GainNode; // crossfader-controlled
  // Key-lock (master tempo): a Signalsmith Stretch node inserted as a LIVE pitch
  // corrector. The source still rides playbackRate for speed; the insert shifts
  // pitch by -12·log2(rate) to cancel the resulting pitch change. Lazily created
  // on first enable; bypassed (source → delayComp directly) when off.
  stretch: StretchNode | null;
  stretchLatency: number; // live-input latency (sec) of the stretch node
  keylock: boolean;
  buffer: AudioBuffer | null;
  srcBus: GainNode; // fixed sum node all sources feed → [stretch?] → delayComp
  srcs: AudioBufferSourceNode[]; // current playing source(s): 1 full / N stems, recreated per start
  stems: DeckStem[] | null; // D4 live stems (per-stem gain → srcBus); null = full-track mode
  stemMode: boolean;
  playing: boolean;
  startCtxTime: number; // ctx.currentTime when src started
  startOffset: number; // buffer position (sec) at that start / paused position
  rate: number; // playbackRate (speed+pitch)
  loadedUrl: string | null;
  label: string | null;
  pitchPct: number;
  decoding: boolean;
  // loop
  loopActive: boolean;
  loopIn: number;
  loopOut: number;
  rollResume: boolean; // a loop-roll: always slip-resume on exit
  // slip virtual clock (valid while loopActive)
  slip: boolean;
  virtualBase: number;
  virtualStart: number;
  // FX rack (D5) — lazily built on first setDeckFx; spliced filter → fx → gain.
  fx: DeckFx | null;
  // Cue/headphone send (D6): filter → cueSend → cueBus → headphone sink. 0 = off.
  cueSend: GainNode;
  // Vinyl/scratch mode (jog wheel): a worklet that reads the full-track buffer
  // at a hand-driven velocity (forward/reverse), feeding delayComp directly so
  // it rides the EQ/filter/crossfader but bypasses key-lock (scratch must pitch-
  // bend). Lazily created; null when never scratched.
  vinyl: AudioWorkletNode | null;
  vinylActive: boolean;
  vinylPos: number; // last read-head position (sec) the worklet reported
  vinylWasPlaying: boolean; // deck playing state captured on grab, to restore
  vinylLoadedUrl: string | null; // which track's samples the worklet holds
  transportRamp: { kind: 'spinUp' | 'windDown' | 'bend'; start: number; end: number; fromRate: number; toRate: number; targetOffset: number } | null;
  transportRampTimer: number | null;
}

const RAMP_TC = 0.012;
const VINYL_SPINUP_SEC = 0.55;
const VINYL_WINDDOWN_SEC = 1.15;
const MIN_TRANSPORT_RATE = 0.001;

let djMaster: GainNode | null = null;
let limiter: DynamicsCompressorNode | null = null;
let limiterEnabled = true; // brickwall on the DJ bus for clip safety (D5)
// Cue/headphone bus (D6): per-deck cueSend → cueBus → MediaStreamDestination →
// a hidden <audio> whose setSinkId routes pre-listen to a second (headphone) output.
let cueBus: GainNode | null = null;
let cueDest: MediaStreamAudioDestinationNode | null = null;
let cueAudioEl: HTMLAudioElement | null = null;
// Cached choice, NOT the source of truth: the global I/O menu owns it
// (settings io.cue_output) and pushes it here. Cached so a cue bus built after
// the preference loaded is already routed to the headphones.
let cueSinkId = '';
// Sampler bank (D7): one-shot pads routed through djMaster (so they ride the DJ
// mix + limiter + visualizer). Decoded buffers keyed by pad id.
const samples = new Map<string, AudioBuffer>();
let samplerGain: GainNode | null = null;
const decks: Partial<Record<DeckId, Deck>> = {};
let crossfade = 0; // -1 = full A, 0 = center, +1 = full B
let rafId = 0;

const listeners = new Set<(a: DeckStatus, b: DeckStatus) => void>();

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const ctxNow = () => getEngineCtx().currentTime;

function ensureMaster(): GainNode {
  if (djMaster) return djMaster;
  const ctx = getEngineCtx();
  djMaster = ctx.createGain();
  djMaster.gain.value = 1;
  // Brickwall limiter on the DJ bus (clip safety). Bypassable via setLimiter().
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.08;
  limiter.connect(getMasterGain());
  djMaster.connect(limiterEnabled ? limiter : getMasterGain());
  return djMaster;
}

/** The cue (headphone) bus: a MediaStreamDestination fed by per-deck cue sends,
 *  played through a hidden <audio> we can route to a 2nd output via setSinkId. */
function ensureCueBus(): GainNode {
  if (cueBus) return cueBus;
  const ctx = getEngineCtx();
  cueBus = ctx.createGain();
  cueDest = ctx.createMediaStreamDestination();
  cueBus.connect(cueDest);
  cueAudioEl = new Audio();
  cueAudioEl.srcObject = cueDest.stream;
  // The MediaStreamDestination does NOT follow the context's sinkId, which is
  // exactly why cue works: the mains and the headphones stay independent by
  // construction. Apply whatever the I/O menu already chose.
  if (cueSinkId) void applyCueSink();
  return cueBus;
}

function ensureSamplerGain(): GainNode {
  if (samplerGain) return samplerGain;
  samplerGain = getEngineCtx().createGain();
  samplerGain.connect(ensureMaster());
  return samplerGain;
}

/** The node a playing source feeds into: the key-lock pitch insert when engaged,
 *  else the deck's delay-comp input (insert bypassed). */
function deckInputNode(d: Deck): AudioNode {
  return d.keylock && d.stretch ? d.stretch : d.delayComp;
}

/** The latency a deck's key-lock insert adds while it is engaged (sec). */
function ownLatency(d: Deck): number {
  return d.keylock && d.stretch ? d.stretchLatency : 0;
}

function setDelay(d: Deck, sec: number): void {
  const v = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  d.delaySec = v;
  d.delayComp.delayTime.setTargetAtTime(v, getEngineCtx().currentTime, 0.01);
}

/** Re-balance the two decks' output latency after `changed` engaged or
 *  released key-lock, so a key-locked deck (which adds the stretch node's
 *  latency) stays beat-aligned with a non-key-locked one.
 *
 *  With nothing playing on the other deck this is the general summing rule
 *  at N = 2 — delay each deck up to the larger of the two engaged latencies —
 *  so it runs on the shared one (`lib/rackEffects.summingDelaysSec`), the
 *  same function the EDIT mixer aligns its tracks with.
 *
 *  While the OTHER deck is playing, its delay is never touched. Moving a
 *  delay line under a playing deck sweeps it in about 50 ms, an audible
 *  warble on the track the audience is hearing, and automix engaged key-lock
 *  on the incoming deck mid-blend, so every automatic engage or release
 *  swept the loud outgoing deck. The deck that changed absorbs the
 *  difference instead; what the delay cannot make up (its insert adds more
 *  latency than the playing deck has) shows as `DeckStatus.latencySec`,
 *  which phase sync compares by. */
function updateLatencyComp(changed: DeckId): void {
  const dc = decks[changed];
  const other = decks[changed === 'A' ? 'B' : 'A'];
  if (dc && other?.playing) {
    setDelay(dc, other.delaySec + ownLatency(other) - ownLatency(dc));
    return;
  }
  const da = decks['A'];
  const db = decks['B'];
  const [ca, cb] = summingDelaysSec([da ? ownLatency(da) : 0, db ? ownLatency(db) : 0]);
  if (da) setDelay(da, ca);
  if (db) setDelay(db, cb);
}

/** Spacing of the key-lock corrections scheduled along a phase bend (sec). */
const KEYLOCK_BEND_STEP_SEC = 0.025;

/**
 * The playback rates a phase bend passes through, sampled every
 * `stepSec` from `now` to the bend's end (inclusive), for the key-lock insert
 * to cancel one by one. A bend is a linear `playbackRate` ramp from `fromRate`
 * to `toRate`; correcting only for the deck's own rate left the bend's pitch
 * in the output, up to 1.3 semitones at the full 8 %.
 */
export function bendRateSteps(
  ramp: { start: number; end: number; fromRate: number; toRate: number },
  now: number,
  stepSec = KEYLOCK_BEND_STEP_SEC,
): Array<{ at: number; rate: number }> {
  const span = ramp.end - ramp.start;
  if (!(span > 0) || !(stepSec > 0) || !Number.isFinite(now)) return [{ at: now, rate: ramp.toRate }];
  const rateAt = (t: number) => ramp.fromRate + (ramp.toRate - ramp.fromRate) * clamp((t - ramp.start) / span, 0, 1);
  const out: Array<{ at: number; rate: number }> = [];
  const from = Math.max(now, ramp.start);
  for (let t = from; t < ramp.end; t += stepSec) out.push({ at: t, rate: rateAt(t) });
  out.push({ at: Math.max(from, ramp.end), rate: ramp.toRate });
  return out;
}

/** Push the key-lock pitch correction (cancel the playbackRate pitch shift).
 *  During a phase bend the correction follows the bend's rate. Each change
 *  is scheduled for when the audio it corrects leaves the insert (its own
 *  latency later), and scheduling one drops every change queued after it. */
function applyKeylockPitch(d: Deck): void {
  if (!d.keylock || !d.stretch) return;
  const now = ctxNow();
  const lat = d.stretchLatency;
  const ramp = d.transportRamp;
  if (ramp?.kind === 'bend' && ramp.end > now) {
    for (const step of bendRateSteps(ramp, now)) {
      void d.stretch.schedule({ output: step.at + lat, semitones: -12 * Math.log2(step.rate) });
    }
    return;
  }
  void d.stretch.schedule({ output: now + lat, semitones: -12 * Math.log2(d.rate) });
}

/** Equal-power crossfader gains for a position in [-1, 1]. */
function crossGains(x: number): { a: number; b: number } {
  const t = (clamp(x, -1, 1) + 1) / 2; // 0 (A) … 1 (B)
  return { a: Math.cos(t * Math.PI * 0.5), b: Math.sin(t * Math.PI * 0.5) };
}

function buildDeck(id: DeckId): Deck {
  const ctx = getEngineCtx();
  const master = ensureMaster();

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 1;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 3200;
  // Single-knob DJ filter: flat (allpass) at center, sweeps to LP / HP.
  const filter = ctx.createBiquadFilter();
  filter.type = 'allpass';
  filter.frequency.value = 1000;
  filter.Q.value = 0.0001;
  const gain = ctx.createGain();
  const trim = ctx.createGain(); // auto-gain / leveling, before the channel fader
  trim.gain.value = 1;
  const vol = ctx.createGain(); // channel volume fader (manual), post-trim
  vol.gain.value = 1;
  const delayComp = ctx.createDelay(1.0); // 0 normally; matches A/B key-lock latency
  const srcBus = ctx.createGain(); // all sources (full or stems) sum here → insert → delayComp
  const cueSend = ctx.createGain(); // pre-listen send → cue bus (headphones); 0 = off
  cueSend.gain.value = 0;

  const cg = crossGains(crossfade);
  gain.gain.value = id === 'A' ? cg.a : cg.b;

  // srcBus → [stretch?] → delayComp → trim → vol → low → mid → high → filter → [fx?] → gain(crossfader) → djMaster
  srcBus.connect(delayComp);
  delayComp.connect(trim);
  trim.connect(vol);
  vol.connect(low);
  low.connect(mid).connect(high).connect(filter).connect(gain).connect(master);
  filter.connect(cueSend); // post-EQ/filter pre-listen tap (survives the FX splice)
  cueSend.connect(ensureCueBus());

  const deck: Deck = {
    delayComp, delaySec: 0, trim, vol, low, mid, high, filter, gain, srcBus, cueSend,
    stretch: null, stretchLatency: 0, keylock: false,
    buffer: null, srcs: [], stems: null, stemMode: false, playing: false, startCtxTime: 0, startOffset: 0, rate: 1,
    loadedUrl: null, label: null, pitchPct: 0, decoding: false,
    loopActive: false, loopIn: 0, loopOut: 0, rollResume: false,
    slip: false, virtualBase: 0, virtualStart: 0,
    fx: null,
    vinyl: null, vinylActive: false, vinylPos: 0, vinylWasPlaying: false, vinylLoadedUrl: null,
    transportRamp: null, transportRampTimer: null,
  };
  decks[id] = deck;
  return deck;
}

function getDeck(id: DeckId): Deck {
  return decks[id] ?? buildDeck(id);
}

/** Track duration (sec) — from the loaded stems in stem mode, else the buffer. */
function deckDuration(d: Deck): number {
  if (d.stemMode && d.stems && d.stems[0]) return d.stems[0].buffer.duration;
  return d.buffer?.duration ?? 0;
}

/** Current audible buffer position (sec), mirroring native loop wrap. */
function audiblePos(d: Deck): number {
  const dur = deckDuration(d);
  if (!d.playing) return clamp(d.startOffset, 0, dur);
  const elapsed = ctxNow() - d.startCtxTime;
  let pos = d.startOffset + elapsed * d.rate;
  if (d.transportRamp) {
    // The ramp's area up to now (a linear ramp averages its two ends), and
    // once it is over, the target rate. The old form kept multiplying the
    // whole elapsed time by the ramp's average rate after the ramp ended, so
    // the position drifted until the timer that clears the ramp fired —
    // late whenever the tab was throttled.
    const ramp = d.transportRamp;
    const span = Math.max(0.001, ramp.end - ramp.start);
    const el = Math.max(0, ctxNow() - ramp.start);
    const inRamp = Math.min(el, span);
    const t = inRamp / span;
    pos = d.startOffset
      + inRamp * (ramp.fromRate + (ramp.toRate - ramp.fromRate) * t * 0.5)
      + Math.max(0, el - span) * ramp.toRate;
  }
  if (d.loopActive && d.loopOut > d.loopIn && pos >= d.loopOut) {
    const span = d.loopOut - d.loopIn;
    pos = d.loopIn + ((pos - d.loopIn) % span);
  }
  return clamp(pos, 0, dur);
}

/** Virtual (slip) position — where playback would be if no loop were engaged. */
function virtualPos(d: Deck): number {
  const dur = deckDuration(d);
  if (!d.loopActive) return audiblePos(d);
  return clamp(d.virtualBase + (ctxNow() - d.virtualStart) * d.rate, 0, dur);
}

function stopSource(d: Deck): void {
  clearTransportRamp(d);
  if (d.srcs.length === 0) return;
  const srcs = d.srcs;
  d.srcs = [];
  for (const s of srcs) {
    try { s.onended = null; s.stop(); } catch { /* already stopped */ }
    try { s.disconnect(); } catch { /* gone */ }
  }
}

function clearTransportRamp(d: Deck): void {
  if (d.transportRampTimer != null) {
    window.clearTimeout(d.transportRampTimer);
    d.transportRampTimer = null;
  }
  d.transportRamp = null;
}

/** (Re)start the deck's source(s) from `offset`, honoring loop state. In stem
 *  mode this starts N stem sources in lock-step (each → its stem gain → srcBus);
 *  in full mode a single source → srcBus. */
function startSource(d: Deck, offset: number, spinUp = false): void {
  if ((d.stemMode && (!d.stems || d.stems.length === 0)) || (!d.stemMode && !d.buffer)) return;
  stopSource(d);
  const ctx = getEngineCtx();
  const dur = deckDuration(d);
  const start = clamp(offset, 0, dur);
  const startRate = spinUp ? MIN_TRANSPORT_RATE : d.rate;
  const mk = (buffer: AudioBuffer, dest: AudioNode): AudioBufferSourceNode => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.setValueAtTime(startRate, ctx.currentTime);
    if (spinUp) s.playbackRate.linearRampToValueAtTime(d.rate, ctx.currentTime + VINYL_SPINUP_SEC);
    if (d.loopActive && d.loopOut > d.loopIn) { s.loop = true; s.loopStart = d.loopIn; s.loopEnd = d.loopOut; }
    s.connect(dest);
    s.start(0, start);
    return s;
  };
  d.srcs = d.stemMode && d.stems
    ? d.stems.map((st) => mk(st.buffer, st.gain))
    : d.buffer ? [mk(d.buffer, d.srcBus)] : [];
  // Park on a NATURAL end (not our stop/restart, not a loop). Stems end together,
  // so watch the first source.
  const ender = d.srcs[0];
  if (ender) ender.onended = () => {
    if (d.srcs[0] === ender && !d.loopActive) {
      stopSource(d);
      d.playing = false;
      d.startOffset = deckDuration(d);
      emit();
    }
  };
  d.startCtxTime = ctx.currentTime;
  d.startOffset = start;
  d.playing = true;
  if (spinUp) {
    d.transportRamp = {
      kind: 'spinUp',
      start: ctx.currentTime,
      end: ctx.currentTime + VINYL_SPINUP_SEC,
      fromRate: startRate,
      toRate: d.rate,
      targetOffset: start,
    };
    d.transportRampTimer = window.setTimeout(() => {
      const pos = audiblePos(d);
      d.startOffset = pos;
      d.startCtxTime = ctx.currentTime;
      d.transportRamp = null;
      d.transportRampTimer = null;
    }, VINYL_SPINUP_SEC * 1000);
  }
}

/** Shared empties for the (overwhelmingly common) no-stems case, so a deck in
 *  full-track mode allocates neither an array nor a map per frame. Never
 *  mutated — the stems path below allocates fresh containers instead. */
const NO_STEMS: readonly string[] = Object.freeze([]);
const NO_STEM_LEVELS: Readonly<Record<string, number>> = Object.freeze({});

const blankStatus = (): DeckStatus => ({
  loadedUrl: null, label: null, playing: false, decoding: false, hasBuffer: false,
  currentTime: 0, duration: 0, ctxTime: 0, loopActive: false, loopIn: null, loopOut: null,
  slip: false, pitchPct: 0, keylock: false, latencySec: 0,
  stems: NO_STEMS, stemLevels: NO_STEM_LEVELS,
});

/** One reusable status object per deck, rewritten in place.
 *
 *  `statusOf` runs for BOTH decks on every rAF frame while anything is
 *  playing (`tick`), so the old "build two fresh objects, each with a fresh
 *  stems array and a fresh stemLevels map" cost ~240 short-lived objects a
 *  second for a deck pair that usually has no stems at all. Every subscriber
 *  reads the fields synchronously inside its callback (DJView, JogWheel) and
 *  the only non-primitives any of them retains are `stems` / `stemLevels` —
 *  which are still freshly allocated whenever stems actually exist, so a
 *  retained one can never be mutated underneath its holder. */
const statusCache: Record<DeckId, DeckStatus> = { A: blankStatus(), B: blankStatus() };
/** Reset template for a deck that has not been built yet (no allocation). */
const BLANK_STATUS: Readonly<DeckStatus> = Object.freeze(blankStatus());

function statusOf(id: DeckId): DeckStatus {
  const out = statusCache[id];
  const d = decks[id];
  if (!d) {
    Object.assign(out, BLANK_STATUS);
    return out;
  }
  out.loadedUrl = d.loadedUrl;
  out.label = d.label;
  out.playing = d.playing;
  out.decoding = d.decoding;
  out.hasBuffer = !!d.buffer || (d.stemMode && !!d.stems?.length);
  // During a scratch the worklet drives playback, so the read-head it
  // reports (vinylPos) is the true position for the platter + waveform.
  out.currentTime = d.vinylActive ? clamp(d.vinylPos, 0, deckDuration(d)) : audiblePos(d);
  out.duration = deckDuration(d);
  out.ctxTime = ctxNow();
  out.loopActive = d.loopActive;
  out.loopIn = d.loopActive ? d.loopIn : null;
  out.loopOut = d.loopActive ? d.loopOut : null;
  out.slip = d.slip;
  out.pitchPct = d.pitchPct;
  out.keylock = d.keylock;
  out.latencySec = d.delaySec + ownLatency(d);
  // Skip both containers entirely in full-track mode (the usual case).
  out.stems = d.stems ? d.stems.map((s) => s.name) : NO_STEMS;
  out.stemLevels = d.stems
    ? Object.fromEntries(d.stems.map((s) => [s.name, s.level]))
    : NO_STEM_LEVELS;
  return out;
}

function emit(): void {
  const a = statusOf('A');
  const b = statusOf('B');
  for (const cb of listeners) cb(a, b);
  const anyPlaying = a.playing || b.playing;
  const anyMoving = anyPlaying || !!decks.A?.transportRamp || !!decks.B?.transportRamp;
  if (anyMoving && !rafId) rafId = requestAnimationFrame(tick);
  if (!anyMoving && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function tick(): void {
  const a = statusOf('A');
  const b = statusOf('B');
  for (const cb of listeners) cb(a, b);
  if (a.playing || b.playing || !!decks.A?.transportRamp || !!decks.B?.transportRamp) rafId = requestAnimationFrame(tick);
  else rafId = 0;
}

/* -------------------------------- public API ------------------------------- */

/** Subscribe to deck-status changes (transport + ~rAF time while playing).
 *  Fires immediately with current status. Returns an unsubscribe. */
export function subscribe(cb: (a: DeckStatus, b: DeckStatus) => void): () => void {
  listeners.add(cb);
  cb(statusOf('A'), statusOf('B'));
  return () => { listeners.delete(cb); };
}

export function getStatus(id: DeckId): DeckStatus {
  return statusOf(id);
}

/** Decode deck tracks and waveform lanes through ONE context, the engine's,
 *  so both land on the same `lib/djAudioCache` entry.
 *
 *  The cache keys a buffer on its URL and on the rate it was resampled to, and
 *  a waveform lane asks for its audio without naming a context. Unregistered,
 *  the lanes decode through the cache's 44.1 kHz offline fallback while the
 *  deck decodes at the engine's own rate (48 kHz on most Windows devices): two
 *  keys, so two fetches and two decodes of the same file. With the engine
 *  context registered the lanes resolve to the deck's key. Idempotent. DJView
 *  calls it on mount, before any lane exists; loadDeck calls it before each
 *  decode. */
export function shareDecodeContext(): AudioContext {
  const ctx = getEngineCtx();
  setDecodeContext(ctx);
  return ctx;
}

/** Load a track URL into a deck: its decoded audio comes from the shared
 *  decode cache, and the prior track's reference is dropped. Pass null to
 *  clear.
 *
 *  The same URL again is a no-op while the deck already has it: decoded,
 *  still decoding, or split into stems. DJView re-runs its deck-load effect
 *  whenever the library resolves an entry, and each of those re-runs used to
 *  land here and stop the deck, rewind it to 0:00, drop its stems and decode
 *  the whole file again, so a playing deck cut out every time an unrelated
 *  library lookup landed. A URL whose last load failed (no buffer, nothing in
 *  flight) loads again, so a retry still works. */
export async function loadDeck(id: DeckId, url: string | null, label: string | null): Promise<void> {
  const d = getDeck(id);
  const holdsUrl = d.buffer !== null || d.decoding || (d.stemMode && !!d.stems?.length);
  if (url !== null && d.loadedUrl === url && holdsUrl) {
    if (label !== null && label !== d.label) {
      d.label = label;
      emit();
    }
    return;
  }
  stopSource(d);
  teardownStems(d); // the previous track's stems no longer apply
  d.playing = false;
  d.startOffset = 0;
  d.loopActive = false;
  d.rollResume = false;

  if (!url) {
    d.buffer = null; // drop the deck's reference; the shared cache's LRU frees it
    d.loadedUrl = null;
    d.label = null;
    d.decoding = false;
    emit();
    return;
  }

  d.loadedUrl = url;
  d.label = label;
  d.buffer = null;
  d.decoding = true;
  emit();

  try {
    // One fetch and one decode per URL for the whole DJ tab: the deck's two
    // waveform lanes ask the same cache for the same buffer, and a set that
    // revisits a track still resident finds it decoded. Decoding through the
    // engine's context lands the buffer at the rate playback runs at.
    const buf = await getDecodedAudio(url, shareDecodeContext());
    // Guard: the deck may have been re-loaded with a different track meanwhile.
    if (d.loadedUrl !== url) return;
    d.buffer = buf;
    d.startOffset = 0;
  } catch (e) {
    if (d.loadedUrl === url) d.buffer = null;
    logError('dj', `Deck ${id} load failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (d.loadedUrl === url) d.decoding = false;
  }
  emit();
}

export function playDeck(id: DeckId, opts: { spinUp?: boolean } = {}): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode) || d.playing) return;
  const ctx = getEngineCtx();
  const start = () => {
    const liveDeck = decks[id];
    if (!liveDeck || (!liveDeck.buffer && !liveDeck.stemMode) || liveDeck.playing) return;
    startSource(liveDeck, liveDeck.startOffset, opts.spinUp);
    emit();
  };
  if (ctx.state === 'suspended') {
    void ctx.resume().then(start).catch(() => { /* retry next gesture */ });
    return;
  }
  start();
}

export function pauseDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.playing) return;
  const pos = audiblePos(d);
  stopSource(d);
  d.playing = false;
  d.startOffset = pos;
  emit();
}

/** Stop transport and return the deck to the beginning, optionally with a
 *  turntable motor wind-down before the transport parks. */
export function stopDeck(id: DeckId, opts: { windDown?: boolean; targetOffset?: number } = {}): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode)) return;
  const targetOffset = clamp(opts.targetOffset ?? 0, 0, deckDuration(d));
  if (opts.windDown && d.playing && d.srcs.length > 0) {
    clearTransportRamp(d);
    const ctx = getEngineCtx();
    const start = ctx.currentTime;
    for (const s of d.srcs) {
      try {
        s.playbackRate.cancelScheduledValues(start);
        s.playbackRate.setValueAtTime(Math.max(MIN_TRANSPORT_RATE, d.rate), start);
        s.playbackRate.exponentialRampToValueAtTime(MIN_TRANSPORT_RATE, start + VINYL_WINDDOWN_SEC);
      } catch {
        /* ramp is best-effort; final stop still parks the transport */
      }
    }
    d.transportRamp = {
      kind: 'windDown',
      start,
      end: start + VINYL_WINDDOWN_SEC,
      fromRate: d.rate,
      toRate: MIN_TRANSPORT_RATE,
      targetOffset,
    };
    d.transportRampTimer = window.setTimeout(() => {
      const dd = decks[id];
      if (!dd || dd.transportRamp?.kind !== 'windDown') return;
      stopSource(dd);
      dd.playing = false;
      dd.startOffset = targetOffset;
      dd.loopActive = false;
      dd.rollResume = false;
      dd.transportRamp = null;
      dd.transportRampTimer = null;
      emit();
    }, VINYL_WINDDOWN_SEC * 1000);
  } else {
    stopSource(d);
    d.playing = false;
    d.startOffset = targetOffset;
    d.loopActive = false;
    d.rollResume = false;
  }
  emit();
}

export function toggleDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode)) return;
  if (d.playing) pauseDeck(id);
  else playDeck(id);
}

/** Cue back to the start (keeps playing if it was). */
export function cueDeck(id: DeckId): void {
  seekDeck(id, 0);
}

export function seekDeck(id: DeckId, sec: number): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode) || !Number.isFinite(sec)) return;
  const pos = clamp(sec, 0, deckDuration(d));
  if (d.playing) startSource(d, pos);
  else d.startOffset = pos;
  emit();
}

/** Turntable pitch in percent (±). Drives playbackRate (speed+pitch together). */
export function setDeckPitch(id: DeckId, pct: number): void {
  const d = getDeck(id);
  const rate = clamp(1 + pct / 100, 0.25, 4);
  if (d.playing) {
    // Re-anchor the position + slip clocks so they stay continuous at the new rate.
    // `audiblePos` already accounts for an in-flight ramp, so read it FIRST.
    const pos = audiblePos(d);
    // A phase-nudge bend (see nudgePhase) is a scheduled ramp back to the OLD
    // rate; leaving it running would drag the deck there a moment after the
    // new pitch is set. Cancel just that kind — the vinyl spin-up / wind-down
    // ramps own the transport and must be left alone.
    if (d.transportRamp?.kind === 'bend') {
      for (const s of d.srcs) {
        try { s.playbackRate.cancelScheduledValues(ctxNow()); } catch { /* best effort */ }
      }
      clearTransportRamp(d);
    }
    if (d.loopActive) {
      const vp = virtualPos(d);
      d.virtualBase = vp;
      d.virtualStart = ctxNow();
    }
    d.startOffset = pos;
    d.startCtxTime = ctxNow();
    for (const s of d.srcs) s.playbackRate.setValueAtTime(rate, ctxNow());
  }
  d.rate = rate;
  d.pitchPct = pct;
  // Key-lock: cancel the speed-induced pitch change so only tempo moves.
  applyKeylockPitch(d);
}

/** Hardest a phase nudge is allowed to bend the deck's rate (fraction). ~8 %
 *  is a hand-on-the-platter nudge: clearly a nudge, never a rewind. */
const MAX_PHASE_BEND = 0.08;
/** Shortest / longest a bend window may be (sec). The shortest is what makes
 *  the bend proportional: every shift up to `MIN_BEND_SEC · rate ·
 *  MAX_PHASE_BEND / 2` (40 ms at 1×) is delivered in this window, so a small
 *  error gets a small bend. With a 0.12 s floor every shift over 5 ms took
 *  the full 8 %. */
const MIN_BEND_SEC = 1;
const MAX_BEND_SEC = 4;

/**
 * Shift a deck's playback position by `seconds` WITHOUT restarting its source.
 *
 * Phase-aligning two decks used to go through `seekDeck`, which tears down the
 * `AudioBufferSourceNode` and starts a new one at the new offset — milliseconds
 * after `playDeck`, so the listener heard the incoming track start, stutter,
 * and restart. A DJ nudges the platter instead: run the deck a few percent
 * fast (or slow) for a moment and let it drift into phase. That is what this
 * does — a single linear `playbackRate` ramp from a bent rate back down to the
 * deck's own rate, exactly the shape `audiblePos` already integrates for the
 * vinyl spin-up ramp, so the reported position stays correct throughout.
 *
 * Position gained over a linear ramp from `bent` to `rate` across `W` seconds
 * is `W·(bent − rate)/2`, which is what sizes the window and the bend.
 *
 * @param seconds positive = jump forward (deck is behind), negative = hold back.
 * @returns the shift actually scheduled, in seconds (0 when it could not run).
 */
export function nudgePhase(id: DeckId, seconds: number): number {
  const d = decks[id];
  if (!d || !Number.isFinite(seconds)) return 0;
  // Not playing: there is no source to bend, so just move the parked offset.
  if (!d.playing || d.srcs.length === 0) {
    if (!d.buffer && !d.stemMode) return 0;
    const target = clamp(d.startOffset + seconds, 0, deckDuration(d));
    const moved = target - d.startOffset;
    d.startOffset = target;
    emit();
    return moved;
  }
  // The platter is in someone's hand, or the motor is spinning up/down — both
  // own `playbackRate` and the position clock. Leave them alone.
  if (d.vinylActive || d.transportRamp) return 0;
  if (Math.abs(seconds) < 1e-4) return 0;

  const ctx = getEngineCtx();
  const now = ctx.currentTime;
  const rate = d.rate;
  // Window wide enough to deliver the shift inside the bend limit, bounded so
  // a huge correction becomes a partial one rather than a minute-long drift.
  const want = Math.min(MAX_BEND_SEC, Math.max(MIN_BEND_SEC, (2 * Math.abs(seconds)) / (rate * MAX_PHASE_BEND)));
  const bent = clamp(rate + (2 * seconds) / want, rate * (1 - MAX_PHASE_BEND), rate * (1 + MAX_PHASE_BEND));
  const safeBent = Math.max(MIN_TRANSPORT_RATE, bent);
  const delivered = (want * (safeBent - rate)) / 2;
  if (Math.abs(delivered) < 1e-5) return 0;

  // Anchor the position clock BEFORE the ramp starts, then describe the ramp
  // so `audiblePos` integrates it (same struct the spin-up ramp uses).
  d.startOffset = audiblePos(d);
  d.startCtxTime = now;
  for (const s of d.srcs) {
    try {
      s.playbackRate.cancelScheduledValues(now);
      s.playbackRate.setValueAtTime(safeBent, now);
      s.playbackRate.linearRampToValueAtTime(rate, now + want);
    } catch { /* ramp is best-effort; the deck keeps playing at its own rate */ }
  }
  d.transportRamp = { kind: 'bend', start: now, end: now + want, fromRate: safeBent, toRate: rate, targetOffset: d.startOffset };
  // Key-lock follows the bend: correcting for `d.rate` alone let the bend's
  // pitch through.
  applyKeylockPitch(d);
  d.transportRampTimer = window.setTimeout(() => {
    const dd = decks[id];
    if (!dd || dd.transportRamp?.kind !== 'bend') return;
    dd.startOffset = audiblePos(dd);
    dd.startCtxTime = getEngineCtx().currentTime;
    dd.transportRamp = null;
    dd.transportRampTimer = null;
    emit();
  }, want * 1000);
  emit();
  return delivered;
}

/**
 * True while a phase nudge's rate bend is still scheduled on this deck.
 *
 * `setDeckPitch` cancels a bend — it has to, a ramp back to the OLD rate would
 * drag the deck there a moment after the new pitch is set. That makes the
 * sync-lock PLL (which writes the pitch every 350 ms) lethal to a nudge: a
 * tick landing inside the bend window wipes out most of the correction the
 * nudge was scheduled to deliver. The PLL gates on this instead of guessing.
 */
export function hasPendingBend(id: DeckId): boolean {
  return decks[id]?.transportRamp?.kind === 'bend';
}

const _stretchPending: Partial<Record<DeckId, Promise<boolean>>> = {};
/** The key-lock state last asked for per deck. The stretcher loads
 *  asynchronously on first use, and a release that arrived during that load
 *  used to be dropped (the deck was not locked YET, so "off" looked like a
 *  no-op); the load then finished and engaged a lock nobody owned. The load
 *  now applies whatever was asked for last. */
const _keylockWant: Partial<Record<DeckId, boolean>> = {};

/** Load the deck's stretch insert if it has none. Resolves true once the
 *  deck has one; false when it cannot be loaded. One load per deck at a time. */
function ensureStretch(id: DeckId): Promise<boolean> {
  const d = getDeck(id);
  if (d.stretch) return Promise.resolve(true);
  const pending = _stretchPending[id];
  if (pending) return pending;
  const load = (async () => {
    try {
      // Lazy-load the WASM stretcher only when key-lock is first wanted, so its
      // ~100 KB (embedded WASM) never weighs down initial load for users who
      // don't use it. Cached by the bundler after the first import.
      const { default: SignalsmithStretch } = await import('signalsmith-stretch');
      const node = await SignalsmithStretch(getEngineCtx());
      node.connect(d.delayComp);
      d.stretch = node;
      try {
        d.stretchLatency = await node.latency();
      } catch {
        d.stretchLatency = 0;
      }
      return true;
    } catch (e) {
      logError('dj', `Deck ${id} key-lock unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return false; // leave key-lock off; turntable mode still works
    } finally {
      delete _stretchPending[id];
    }
  })();
  _stretchPending[id] = load;
  return load;
}

/** Load a deck's key-lock insert ahead of need, without engaging it. Automix
 *  calls this for the incoming deck when its match will need key-lock, so the
 *  engage right before that deck starts does not wait on a WASM load and land
 *  after it is already playing. */
export function prepareKeylock(id: DeckId): void {
  void ensureStretch(id);
}

/** Key-lock / master tempo: speed changes (pitch fader / SYNC) keep the original
 *  pitch. Inserts a Signalsmith Stretch node as a live pitch corrector; bypassed
 *  when off. Async because the worklet + WASM load lazily on first enable. */
export async function setDeckKeylock(id: DeckId, on: boolean): Promise<void> {
  const d = getDeck(id);
  _keylockWant[id] = on;
  if (on && !d.stretch) {
    const ok = await ensureStretch(id);
    if (!ok) return;
  }
  // Apply the LATEST request: another call may have come in during the load.
  const want = _keylockWant[id] === true;
  if (d.keylock === want) return;
  if (want && !d.stretch) return;

  d.keylock = want;
  if (want && d.stretch) {
    void d.stretch.start();
    applyKeylockPitch(d);
  } else if (!want && d.stretch) {
    void d.stretch.stop(); // idle the worklet so it costs ~0 CPU while bypassed
  }
  updateLatencyComp(id);
  // Route the source bus through (or around) the stretch insert — no restart needed
  // (works for both full-track and live-stem sources, which all feed srcBus).
  try { d.srcBus.disconnect(); } catch { /* not connected */ }
  d.srcBus.connect(deckInputNode(d));
  emit();
}

/** Deepest cut a deck EQ band takes (dB). Automix's bass swap cuts
 *  `EQ_KILL_DB` (−26) below the DJ's own Lo setting, and the Lo knob goes to
 *  −12, so the floor has to reach −38. A −24 floor clamped every bass swap
 *  short of the kill it asked for. */
export const DECK_EQ_FLOOR_DB = -40;
/** Largest boost a deck EQ band takes (dB). */
export const DECK_EQ_CEIL_DB = 24;

export function setDeckEq(id: DeckId, band: 'low' | 'mid' | 'high', db: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const node = band === 'low' ? d.low : band === 'mid' ? d.mid : d.high;
  node.gain.setTargetAtTime(clamp(db, DECK_EQ_FLOOR_DB, DECK_EQ_CEIL_DB), ctx.currentTime, RAMP_TC);
}

/** Auto-gain / leveling trim in dB (independent of the crossfader). 0 = unity. */
export function setDeckTrim(id: DeckId, db: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const lin = Math.pow(10, clamp(db, -15, 15) / 20);
  d.trim.gain.setTargetAtTime(lin, ctx.currentTime, RAMP_TC);
}

/** Channel volume fader (linear, 0..1). 1 = unity. */
export function setDeckVolume(id: DeckId, level: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  d.vol.gain.setTargetAtTime(clamp(level, 0, 1), ctx.currentTime, RAMP_TC);
}

/** Single-knob DJ filter. amount in [-1, 1]: 0 = bypass (flat), <0 sweeps a
 *  lowpass down toward 200 Hz, >0 sweeps a highpass up toward 8 kHz. Resonance
 *  rises with travel for the classic filter "bite". */
export function setDeckFilter(id: DeckId, amount: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const a = clamp(amount, -1, 1);
  const f = d.filter;
  const now = ctx.currentTime;
  if (Math.abs(a) < 0.02) {
    f.type = 'allpass';
    f.frequency.setTargetAtTime(1000, now, RAMP_TC);
    f.Q.setTargetAtTime(0.0001, now, RAMP_TC);
  } else if (a < 0) {
    f.type = 'lowpass';
    f.frequency.setTargetAtTime(20000 * Math.pow(200 / 20000, -a), now, RAMP_TC);
    f.Q.setTargetAtTime(1 + -a * 6, now, RAMP_TC);
  } else {
    f.type = 'highpass';
    f.frequency.setTargetAtTime(20 * Math.pow(8000 / 20, a), now, RAMP_TC);
    f.Q.setTargetAtTime(1 + a * 6, now, RAMP_TC);
  }
}

/* -------------------------------- FX rack (D5) ----------------------------- */

/** A short decaying-noise impulse response for the reverb convolver — generated
 *  so we don't bundle an IR file. ~1.8 s, exponential decay. */
function makeReverbIR(ctx: BaseAudioContext, seconds = 1.8, decay = 3): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return ir;
}

/** Build the per-deck FX rack on first use and splice it into the chain between
 *  the filter and the crossfader gain: filter → fx.input → (dry + wet) → out → gain. */
function ensureDeckFx(d: Deck): DeckFx {
  if (d.fx) return d.fx;
  const ctx = getEngineCtx();
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1;
  input.connect(dry).connect(out);

  // Flanger: short modulated delay + feedback (comb sweep), summed via wet.
  const flDelay = ctx.createDelay(0.05); flDelay.delayTime.value = 0.003;
  const flFb = ctx.createGain(); flFb.gain.value = 0.35;
  const flDepth = ctx.createGain(); flDepth.gain.value = 0.002;
  const lfoFlanger = ctx.createOscillator(); lfoFlanger.type = 'sine'; lfoFlanger.frequency.value = 0.2;
  lfoFlanger.connect(flDepth).connect(flDelay.delayTime);
  input.connect(flDelay);
  flDelay.connect(flFb).connect(flDelay);
  const flangerWet = ctx.createGain(); flangerWet.gain.value = 0;
  flDelay.connect(flangerWet).connect(out);

  // Wah: LFO-swept resonant bandpass.
  const wahBp = ctx.createBiquadFilter(); wahBp.type = 'bandpass'; wahBp.frequency.value = 800; wahBp.Q.value = 5;
  const wahDepth = ctx.createGain(); wahDepth.gain.value = 600;
  const lfoWah = ctx.createOscillator(); lfoWah.type = 'sine'; lfoWah.frequency.value = 1.2;
  lfoWah.connect(wahDepth).connect(wahBp.frequency);
  input.connect(wahBp);
  const wahWet = ctx.createGain(); wahWet.gain.value = 0;
  wahBp.connect(wahWet).connect(out);

  // Reverb: convolver with a generated IR.
  const conv = ctx.createConvolver(); conv.buffer = makeReverbIR(ctx);
  const reverbWet = ctx.createGain(); reverbWet.gain.value = 0;
  input.connect(conv).connect(reverbWet).connect(out);

  // Splice between the filter and the crossfader gain (one-time; a brief click
  // is possible if done mid-playback — acceptable for a first FX-knob touch).
  try { d.filter.disconnect(d.gain); } catch { /* not connected */ } // keep the filter → cueSend tap
  d.filter.connect(input);
  out.connect(d.gain);

  lfoFlanger.start();
  lfoWah.start();
  const fx: DeckFx = {
    input, out, flangerWet, reverbWet, wahWet, lfoFlanger, lfoWah,
    nodes: [input, out, dry, flDelay, flFb, flDepth, flangerWet, wahBp, wahDepth, wahWet, conv, reverbWet],
  };
  d.fx = fx;
  return fx;
}

/** Set a per-deck FX wet amount in [0, 1] (0 = off). Builds the FX rack lazily. */
export function setDeckFx(id: DeckId, fx: DjFx, amount: number): void {
  const d = getDeck(id);
  const f = ensureDeckFx(d);
  const ctx = getEngineCtx();
  const a = clamp(amount, 0, 1);
  const wet = fx === 'flanger' ? f.flangerWet : fx === 'reverb' ? f.reverbWet : f.wahWet;
  const scale = fx === 'reverb' ? 0.6 : 0.8; // keep a full twist musical, not overpowering
  wet.gain.setTargetAtTime(a * scale, ctx.currentTime, RAMP_TC);
}

/** Master brickwall limiter on the DJ bus (clip safety). On by default. */
export function setLimiter(on: boolean): void {
  limiterEnabled = on;
  ensureMaster();
  if (!djMaster || !limiter) return;
  try { djMaster.disconnect(); } catch { /* gone */ }
  djMaster.connect(on ? limiter : getMasterGain());
}

export function getLimiter(): boolean {
  return limiterEnabled;
}

/* -------------------------------- cue / headphones (D6) -------------------- */

/** Whether the runtime supports per-element output routing (`setSinkId`). */
export function isCueSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** Pre-listen a deck in the cue (headphone) bus — independent of the crossfader. */
export function setDeckCue(id: DeckId, on: boolean): void {
  const d = getDeck(id);
  ensureCueBus();
  d.cueSend.gain.setTargetAtTime(on ? 1 : 0, ctxNow(), RAMP_TC);
  if (on && cueAudioEl) void cueAudioEl.play().catch(() => { /* needs a gesture — the toggle click is one */ });
}

/** Push the cached choice onto the hidden cue element. */
async function applyCueSink(): Promise<void> {
  const el = cueAudioEl as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (!el?.setSinkId) return;
  try { await el.setSinkId(cueSinkId); } catch (e) { logError('dj', `cue setSinkId failed: ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Route the cue bus to a specific output device (headphones). '' = default.
 *
 * Called by the global I/O menu (state/ioDevicesStore), which is the single
 * owner of the choice — the DJ tab's own cue select writes through it too, so
 * both places always agree. Does NOT build the cue bus for an empty id: a user
 * who never picks a cue device should not get an extra MediaStreamDestination
 * (and an AudioContext) constructed at boot on their behalf.
 */
export async function setCueSinkId(deviceId: string): Promise<void> {
  if (!deviceId && !cueBus) {
    cueSinkId = '';
    return;
  }
  ensureCueBus();
  cueSinkId = deviceId;
  await applyCueSink();
}

/* -------------------------------- sampler bank (D7) ------------------------ */

/** Load a one-shot sample into a pad (decode the URL to a buffer). */
export async function loadSample(padId: string, url: string): Promise<void> {
  const ctx = getEngineCtx();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sample fetch ${r.status}`);
  samples.set(padId, await ctx.decodeAudioData(await r.arrayBuffer()));
}

// Live sampler voices per pad (so loops can stop + choke groups can cut).
const sampleVoices = new Map<string, AudioBufferSourceNode[]>();
// Pads currently set to choke (mutually exclusive): firing one cuts the others.
const chokePads = new Set<string>();

export interface TriggerOpts { gain?: number; loop?: boolean; choke?: boolean }

/** Fire a pad's sample through the DJ master. One-shot by default (polyphonic);
 *  a `loop` pad toggles (re-trigger stops it); a `choke` pad cuts every other
 *  choke pad first (monophonic group, e.g. open/closed hat). `gain` is 0..1. */
export function triggerSample(padId: string, opts: TriggerOpts = {}): void {
  const buf = samples.get(padId);
  if (!buf) return;
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* retry next gesture */ });

  // A looping pad that's already playing stops on the next press.
  if (opts.loop && (sampleVoices.get(padId)?.length ?? 0) > 0) { stopSample(padId); return; }

  // Choke: cut every OTHER choke pad's voices before firing this one.
  if (opts.choke) {
    chokePads.add(padId);
    for (const id of chokePads) if (id !== padId) stopSample(id);
  } else {
    chokePads.delete(padId);
  }

  const g = ctx.createGain();
  g.gain.value = clamp(opts.gain ?? 1, 0, 1);
  g.connect(ensureSamplerGain());
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = !!opts.loop;
  s.connect(g);
  const arr = sampleVoices.get(padId) ?? [];
  arr.push(s);
  sampleVoices.set(padId, arr);
  s.onended = () => {
    try { s.disconnect(); g.disconnect(); } catch { /* gone */ }
    const live = sampleVoices.get(padId);
    if (live) { const i = live.indexOf(s); if (i >= 0) live.splice(i, 1); }
  };
  s.start();
}

/** Stop a pad's currently-playing voices (loops, or a long one-shot). */
export function stopSample(padId: string): void {
  const arr = sampleVoices.get(padId);
  if (!arr) return;
  for (const s of [...arr]) { try { s.stop(); } catch { /* already ended */ } }
  sampleVoices.set(padId, []);
}

/** True if a pad has any voice currently sounding (used for loop pad lit state). */
export function sampleIsPlaying(padId: string): boolean {
  return (sampleVoices.get(padId)?.length ?? 0) > 0;
}

export function clearSample(padId: string): void {
  stopSample(padId);
  chokePads.delete(padId);
  samples.delete(padId);
}
export function hasSample(padId: string): boolean { return samples.has(padId); }

/** Crossfader position in [-1, 1] (equal-power). */
export function setCrossfade(x: number): void {
  crossfade = clamp(x, -1, 1);
  const ctx = getEngineCtx();
  const { a, b } = crossGains(crossfade);
  const da = decks['A'];
  const db = decks['B'];
  if (da) da.gain.gain.setTargetAtTime(a, ctx.currentTime, RAMP_TC);
  if (db) db.gain.gain.setTargetAtTime(b, ctx.currentTime, RAMP_TC);
}

export function getCrossfade(): number {
  return crossfade;
}

/* -------------------------- loops / slip / roll ---------------------------- */

function engageLoop(d: Deck, inSec: number, outSec: number, roll: boolean): void {
  const dur = deckDuration(d);
  const lin = clamp(inSec, 0, dur);
  const lout = clamp(outSec, lin + 0.02, dur); // keep a sane minimum span
  // Capture the audible position BEFORE engaging the loop (so it isn't wrapped).
  const cur = audiblePos(d);
  d.virtualBase = cur;
  d.virtualStart = ctxNow();
  d.loopIn = lin;
  d.loopOut = lout;
  d.loopActive = true;
  d.rollResume = roll;
  if (d.playing) {
    // Make sure the loop actually engages: if the head is outside the region
    // (e.g. a short beat-loop whose out-point is already behind us), jump to
    // the in-point so playback loops instead of running straight past loopEnd.
    const startAt = cur >= lin && cur < lout ? cur : lin;
    startSource(d, startAt); // restart with native loop bounds
  }
  emit();
}

/** Engage a sustained loop between two times (sec). */
export function setLoop(id: DeckId, inSec: number, outSec: number): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode)) return;
  engageLoop(d, inSec, outSec, false);
}

/** Engage a momentary loop-roll of `lengthSec` from the current position.
 *  Always slip-resumes on end (jumps to where playback would have reached). */
export function startLoopRoll(id: DeckId, lengthSec: number): void {
  const d = decks[id];
  if (!d || (!d.buffer && !d.stemMode) || lengthSec <= 0) return;
  const inPt = audiblePos(d);
  engageLoop(d, inPt, inPt + lengthSec, true);
}

export function endLoopRoll(id: DeckId): void {
  exitLoop(id);
}

/** Disengage the loop. Slip-aware: with slip on (or a loop-roll), resume where
 *  playback would be; otherwise continue from the current looped position. */
export function exitLoop(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.loopActive) return;
  const resumeSlip = d.slip || d.rollResume;
  const resumePos = resumeSlip ? virtualPos(d) : audiblePos(d);
  d.loopActive = false;
  d.rollResume = false;
  if (d.playing) startSource(d, resumePos);
  else d.startOffset = resumePos;
  emit();
}

export function setSlip(id: DeckId, on: boolean): void {
  const d = getDeck(id);
  d.slip = on;
  emit();
}

export function isLooping(id: DeckId): boolean {
  return !!decks[id]?.loopActive;
}

/* -------------------------------- live stems (D4) -------------------------- */

function teardownStems(d: Deck): void {
  if (d.stems) for (const st of d.stems) { try { st.gain.disconnect(); } catch { /* gone */ } }
  d.stems = null;
  d.stemMode = false;
}

/** Load N separated stems onto a deck and switch it to stem mode: each stem
 *  plays in lock-step through its own gain (the live faders) summed at srcBus.
 *  Frees the full-track buffer (stems are the playback source now). D4 Tier 1 —
 *  the stems must already be separated + cached; `url` = /api/library/stems/…/audio.
 *  Returns the loaded stem names. */
export async function loadDeckStems(id: DeckId, stems: Array<{ name: string; url: string }>): Promise<string[]> {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const decoded = await Promise.all(stems.map(async (s) => {
    const r = await fetch(s.url);
    if (!r.ok) throw new Error(`stem "${s.name}" fetch ${r.status}`);
    return { name: s.name, buffer: await ctx.decodeAudioData(await r.arrayBuffer()) };
  }));
  if (decoded.length === 0) return [];
  const wasPlaying = d.playing;
  const pos = audiblePos(d);
  stopSource(d);
  teardownStems(d);
  d.stems = decoded.map(({ name, buffer }) => {
    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(d.srcBus);
    return { name, buffer, gain: g, level: 1 };
  });
  d.stemMode = true;
  d.buffer = null; // stems replace the full buffer for playback; the shared cache keeps it while resident
  const dur = deckDuration(d);
  if (wasPlaying) startSource(d, clamp(pos, 0, dur));
  else d.startOffset = clamp(pos, 0, dur);
  emit();
  return d.stems.map((s) => s.name);
}

/** Turn stem mode OFF: reload the full-track buffer from the deck's loadedUrl
 *  and restore single-source playback, preserving the playhead. The inverse of
 *  loadDeckStems (which freed the full buffer to play stems). No-op off stems. */
export async function unloadDeckStems(id: DeckId): Promise<void> {
  const d = decks[id];
  if (!d || !d.stemMode) return;
  const url = d.loadedUrl;
  const wasPlaying = d.playing;
  const pos = audiblePos(d);
  if (!url) {
    // Nothing to restore — just drop stem mode (deck goes silent until reload).
    stopSource(d);
    teardownStems(d);
    emit();
    return;
  }
  d.decoding = true;
  emit();
  try {
    // The same shared decode loadDeck uses: the track is usually still
    // resident, so switching stems off costs no download at all.
    const buf = await getDecodedAudio(url, shareDecodeContext());
    if (d.loadedUrl !== url) return; // re-loaded with a different track meanwhile
    stopSource(d);
    teardownStems(d);
    d.buffer = buf;
    const dur = deckDuration(d);
    if (wasPlaying) startSource(d, clamp(pos, 0, dur));
    else d.startOffset = clamp(pos, 0, dur);
  } catch (e) {
    logError('dj', `Deck ${id} stem-off reload failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (d.loadedUrl === url) d.decoding = false;
  }
  emit();
}

/** Set a stem's live gain (0..1). 0 = pulled out (e.g. mute the vocals). */
export function setStemGain(id: DeckId, name: string, level: number): void {
  const st = decks[id]?.stems?.find((s) => s.name === name);
  if (!st) return;
  const next = clamp(level, 0, 1);
  if (Math.abs(st.level - next) < 0.0001) return;
  st.level = next;
  st.gain.gain.setTargetAtTime(st.level, ctxNow(), RAMP_TC);
  emit();
}

export function getStemGain(id: DeckId, name: string): number {
  return decks[id]?.stems?.find((s) => s.name === name)?.level ?? 0;
}

export function getDeckStemNames(id: DeckId): string[] {
  return decks[id]?.stems?.map((s) => s.name) ?? [];
}

export function hasStems(id: DeckId): boolean {
  return !!decks[id]?.stemMode;
}

/* -------------------------------- vinyl / scratch (jog) -------------------- */

let _vinylModule: Promise<void> | null = null;
let _scratchMode: 'classic' | 'cyber' = 'classic';

function ensureVinylModule(ctx: AudioContext): Promise<void> {
  if (!_vinylModule) {
    _vinylModule = addWorkletModule(ctx, '/vinyl-scratch.worklet.js').catch((e) => {
      _vinylModule = null; // allow a later retry
      throw e;
    });
  }
  return _vinylModule;
}

/** Scratch character for all decks: 'classic' (clean turntable) or 'cyber'
 *  (fragmented, bit-crushed glitch). Pushed live to any active vinyl node. */
export function setScratchMode(mode: 'classic' | 'cyber'): void {
  _scratchMode = mode;
  for (const id of ['A', 'B'] as DeckId[]) {
    decks[id]?.vinyl?.port.postMessage({ type: 'mode', mode });
  }
}
export function getScratchMode(): 'classic' | 'cyber' {
  return _scratchMode;
}

/** True when a deck can scratch: it needs a decoded full-track buffer. Stem
 *  mode and empty decks fall back to plain jog-seek. */
export function canScratch(id: DeckId): boolean {
  const d = decks[id];
  return !!d && !!d.buffer && !d.stemMode;
}

/** Grab the platter: hand playback to the scratch worklet at the current
 *  position. The jog then drives velocity via setVinylVelocity; release spins
 *  up and hands back to the normal source (exitVinyl). */
export async function enterVinyl(id: DeckId): Promise<boolean> {
  const d = decks[id];
  if (!d || !d.buffer || d.stemMode || d.vinylActive) return false;
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* retry next gesture */ });
  try {
    await ensureVinylModule(ctx);
  } catch (e) {
    logError('dj', `Deck ${id} scratch unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  // The deck may have been re-loaded / gone to stems while the module loaded.
  if (!d.buffer || d.stemMode || d.vinylActive) return false;
  if (d.vinyl == null) {
    d.vinyl = new AudioWorkletNode(ctx, 'vinyl-scratch', { numberOfInputs: 0, outputChannelCount: [2] });
    d.vinyl.port.onmessage = (e) => { if (e.data?.type === 'pos') d.vinylPos = e.data.sec; };
  }
  // (Re)load the track's samples into the worklet when the track changed.
  if (d.vinylLoadedUrl !== d.loadedUrl) {
    const mono = d.buffer.numberOfChannels <= 1;
    const lc = new Float32Array(d.buffer.getChannelData(0));
    const rc = mono ? lc : new Float32Array(d.buffer.getChannelData(1));
    d.vinyl.port.postMessage(
      { type: 'load', l: lc, r: rc, len: d.buffer.length },
      mono ? [lc.buffer] : [lc.buffer, rc.buffer],
    );
    d.vinylLoadedUrl = d.loadedUrl;
  }
  const pos = audiblePos(d);
  d.vinylWasPlaying = d.playing;
  d.vinylPos = pos;
  stopSource(d); // silence the normal source; the worklet sounds now
  d.vinyl.port.postMessage({ type: 'mode', mode: _scratchMode });
  d.vinyl.port.postMessage({ type: 'pos', sec: pos });
  d.vinyl.port.postMessage({ type: 'vel', vel: d.vinylWasPlaying ? d.rate : 0, immediate: true });
  d.vinyl.port.postMessage({ type: 'ease', ease: 0.4 });
  d.vinyl.port.postMessage({ type: 'play', on: true });
  // Feed straight into delayComp so it rides EQ/filter/crossfader but bypasses
  // the key-lock stretch (a scratch must be allowed to pitch-bend).
  try { d.vinyl.connect(d.delayComp); } catch { /* already connected */ }
  d.vinylActive = true;
  d.playing = true;
  emit();
  return true;
}

/** Drive scratch velocity from the jog: 1 = normal forward, -1 = reverse, 0 =
 *  stopped. `ease` is high for hand scratches (snappy) and low for the
 *  wind-down / spin-up ramps. */
export function setVinylVelocity(id: DeckId, vel: number, ease = 0.4): void {
  const d = decks[id];
  if (!d?.vinyl || !d.vinylActive) return;
  d.vinyl.port.postMessage({ type: 'ease', ease });
  d.vinyl.port.postMessage({ type: 'vel', vel });
}

/** Release the platter: spin back up to speed (if it was playing) then hand
 *  playback back to the normal source at the read-head. `spinUp=false` settles
 *  immediately. */
export function exitVinyl(id: DeckId, spinUp = true): void {
  const d = decks[id];
  if (!d?.vinyl || !d.vinylActive) return;
  const finalize = () => {
    const dd = decks[id];
    if (!dd?.vinyl || !dd.vinylActive) return;
    const pos = clamp(dd.vinylPos, 0, deckDuration(dd));
    dd.vinyl.port.postMessage({ type: 'play', on: false });
    try { dd.vinyl.disconnect(); } catch { /* gone */ }
    dd.vinylActive = false;
    dd.startOffset = pos;
    if (dd.vinylWasPlaying) startSource(dd, pos);
    else dd.playing = false;
    emit();
  };
  if (spinUp && d.vinylWasPlaying) {
    setVinylVelocity(id, d.rate, 0.06); // slow ramp back to speed = spin-up
    setTimeout(finalize, 320);
  } else {
    setVinylVelocity(id, 0, 0.08); // wind down to a stop
    setTimeout(finalize, spinUp ? 240 : 0);
  }
}

/** Tear everything down (DJ tab unmount). Rarely called — the tab is warmed. */
export function dispose(): void {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  for (const id of ['A', 'B'] as DeckId[]) {
    const d = decks[id];
    if (!d) continue;
    try {
      stopSource(d);
      teardownStems(d);
      try { d.srcBus.disconnect(); } catch { /* gone */ }
      try { d.cueSend.disconnect(); } catch { /* gone */ }
      if (d.fx) {
        try { d.fx.lfoFlanger.stop(); } catch { /* gone */ }
        try { d.fx.lfoWah.stop(); } catch { /* gone */ }
        for (const n of d.fx.nodes) { try { n.disconnect(); } catch { /* gone */ } }
        d.fx = null;
      }
      if (d.stretch) { try { void d.stretch.stop(); } catch { /* gone */ } d.stretch.disconnect(); }
      d.delayComp.disconnect();
      d.trim.disconnect();
      d.vol.disconnect();
      d.low.disconnect();
      d.mid.disconnect();
      d.high.disconnect();
      d.filter.disconnect();
      d.gain.disconnect();
    } catch { /* already gone */ }
    d.buffer = null;
    d.stretch = null;
    delete decks[id];
  }
  if (limiter) { try { limiter.disconnect(); } catch { /* gone */ } limiter = null; }
  if (cueBus) { try { cueBus.disconnect(); } catch { /* gone */ } cueBus = null; }
  if (cueAudioEl) { try { cueAudioEl.pause(); cueAudioEl.srcObject = null; } catch { /* gone */ } cueAudioEl = null; }
  cueDest = null;
  if (samplerGain) { try { samplerGain.disconnect(); } catch { /* gone */ } samplerGain = null; }
  samples.clear();
  if (djMaster) { try { djMaster.disconnect(); } catch { /* gone */ } djMaster = null; }
  listeners.clear();
}
