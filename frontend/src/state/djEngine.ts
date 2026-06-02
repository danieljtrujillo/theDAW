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
 * Memory: a decoded full song is ~100 MB. We decode ONLY a loaded deck and free
 * the buffer the moment the deck is cleared, so at most ~2 are resident — bounded
 * and released on unload. Browsing/preview elsewhere still streams (wavesurfer
 * fetches its own peaks); the deck engine itself is pure Web Audio.
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
import { getEngineCtx, getMasterGain } from './playerStore';
import { logError } from './logStore';

export type DeckId = 'A' | 'B';

export interface DeckStatus {
  loadedUrl: string | null;
  label: string | null;
  playing: boolean;
  decoding: boolean;
  hasBuffer: boolean;
  currentTime: number;
  duration: number;
  loopActive: boolean;
  loopIn: number | null;
  loopOut: number | null;
  slip: boolean;
  pitchPct: number;
}

interface Deck {
  trim: GainNode; // auto-gain / leveling trim (independent of crossfader)
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  gain: GainNode; // crossfader-controlled
  buffer: AudioBuffer | null;
  src: AudioBufferSourceNode | null; // current playing source (recreated per start)
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
}

const RAMP_TC = 0.012;

let djMaster: GainNode | null = null;
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
  djMaster.connect(getMasterGain());
  return djMaster;
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
  const gain = ctx.createGain();
  const trim = ctx.createGain(); // auto-gain / leveling, before EQ + crossfader
  trim.gain.value = 1;

  const cg = crossGains(crossfade);
  gain.gain.value = id === 'A' ? cg.a : cg.b;

  // src → trim → low → mid → high → gain(crossfader) → djMaster
  trim.connect(low);
  low.connect(mid).connect(high).connect(gain).connect(master);

  const deck: Deck = {
    trim, low, mid, high, gain,
    buffer: null, src: null, playing: false, startCtxTime: 0, startOffset: 0, rate: 1,
    loadedUrl: null, label: null, pitchPct: 0, decoding: false,
    loopActive: false, loopIn: 0, loopOut: 0, rollResume: false,
    slip: false, virtualBase: 0, virtualStart: 0,
  };
  decks[id] = deck;
  return deck;
}

function getDeck(id: DeckId): Deck {
  return decks[id] ?? buildDeck(id);
}

/** Current audible buffer position (sec), mirroring native loop wrap. */
function audiblePos(d: Deck): number {
  const dur = d.buffer?.duration ?? 0;
  if (!d.playing) return clamp(d.startOffset, 0, dur);
  let pos = d.startOffset + (ctxNow() - d.startCtxTime) * d.rate;
  if (d.loopActive && d.loopOut > d.loopIn && pos >= d.loopOut) {
    const span = d.loopOut - d.loopIn;
    pos = d.loopIn + ((pos - d.loopIn) % span);
  }
  return clamp(pos, 0, dur);
}

/** Virtual (slip) position — where playback would be if no loop were engaged. */
function virtualPos(d: Deck): number {
  const dur = d.buffer?.duration ?? 0;
  if (!d.loopActive) return audiblePos(d);
  return clamp(d.virtualBase + (ctxNow() - d.virtualStart) * d.rate, 0, dur);
}

function stopSource(d: Deck): void {
  const s = d.src;
  if (!s) return;
  d.src = null;
  try {
    s.onended = null;
    s.stop();
  } catch { /* already stopped */ }
  try { s.disconnect(); } catch { /* gone */ }
}

/** (Re)start a source playing from `offset`, honoring the deck's loop state. */
function startSource(d: Deck, offset: number): void {
  if (!d.buffer) return;
  stopSource(d);
  const ctx = getEngineCtx();
  const src = ctx.createBufferSource();
  src.buffer = d.buffer;
  src.playbackRate.value = d.rate;
  if (d.loopActive && d.loopOut > d.loopIn) {
    src.loop = true;
    src.loopStart = d.loopIn;
    src.loopEnd = d.loopOut;
  }
  src.connect(d.trim);
  src.onended = () => {
    // Only a NATURAL end (not our stop/restart, not a loop) parks the deck.
    if (d.src === src && !d.loopActive) {
      d.src = null;
      d.playing = false;
      d.startOffset = d.buffer?.duration ?? 0;
      emit();
    }
  };
  const start = clamp(offset, 0, d.buffer.duration);
  src.start(0, start);
  d.src = src;
  d.startCtxTime = ctx.currentTime;
  d.startOffset = start;
  d.playing = true;
}

function statusOf(id: DeckId): DeckStatus {
  const d = decks[id];
  if (!d) {
    return {
      loadedUrl: null, label: null, playing: false, decoding: false, hasBuffer: false,
      currentTime: 0, duration: 0, loopActive: false, loopIn: null, loopOut: null,
      slip: false, pitchPct: 0,
    };
  }
  return {
    loadedUrl: d.loadedUrl,
    label: d.label,
    playing: d.playing,
    decoding: d.decoding,
    hasBuffer: !!d.buffer,
    currentTime: audiblePos(d),
    duration: d.buffer?.duration ?? 0,
    loopActive: d.loopActive,
    loopIn: d.loopActive ? d.loopIn : null,
    loopOut: d.loopActive ? d.loopOut : null,
    slip: d.slip,
    pitchPct: d.pitchPct,
  };
}

function emit(): void {
  const a = statusOf('A');
  const b = statusOf('B');
  for (const cb of listeners) cb(a, b);
  const anyPlaying = a.playing || b.playing;
  if (anyPlaying && !rafId) rafId = requestAnimationFrame(tick);
  if (!anyPlaying && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function tick(): void {
  const a = statusOf('A');
  const b = statusOf('B');
  for (const cb of listeners) cb(a, b);
  if (a.playing || b.playing) rafId = requestAnimationFrame(tick);
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

/** Load a track URL into a deck: fetch + decode to an AudioBuffer (frees the
 *  prior one). Pass null to clear + free. */
export async function loadDeck(id: DeckId, url: string | null, label: string | null): Promise<void> {
  const d = getDeck(id);
  stopSource(d);
  d.playing = false;
  d.startOffset = 0;
  d.loopActive = false;
  d.rollResume = false;

  if (!url) {
    d.buffer = null; // free decoded audio
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
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const arr = await resp.arrayBuffer();
    const ctx = getEngineCtx();
    const buf = await ctx.decodeAudioData(arr);
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

export function playDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.buffer || d.playing) return;
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* retry next gesture */ });
  startSource(d, d.startOffset);
  emit();
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

export function toggleDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.buffer) return;
  if (d.playing) pauseDeck(id);
  else playDeck(id);
}

/** Cue back to the start (keeps playing if it was). */
export function cueDeck(id: DeckId): void {
  seekDeck(id, 0);
}

export function seekDeck(id: DeckId, sec: number): void {
  const d = decks[id];
  if (!d || !d.buffer || !Number.isFinite(sec)) return;
  const pos = clamp(sec, 0, d.buffer.duration);
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
    const pos = audiblePos(d);
    if (d.loopActive) {
      const vp = virtualPos(d);
      d.virtualBase = vp;
      d.virtualStart = ctxNow();
    }
    d.startOffset = pos;
    d.startCtxTime = ctxNow();
    if (d.src) d.src.playbackRate.setValueAtTime(rate, ctxNow());
  }
  d.rate = rate;
  d.pitchPct = pct;
}

export function setDeckEq(id: DeckId, band: 'low' | 'mid' | 'high', db: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const node = band === 'low' ? d.low : band === 'mid' ? d.mid : d.high;
  node.gain.setTargetAtTime(clamp(db, -24, 24), ctx.currentTime, RAMP_TC);
}

/** Auto-gain / leveling trim in dB (independent of the crossfader). 0 = unity. */
export function setDeckTrim(id: DeckId, db: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const lin = Math.pow(10, clamp(db, -15, 15) / 20);
  d.trim.gain.setTargetAtTime(lin, ctx.currentTime, RAMP_TC);
}

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
  const dur = d.buffer?.duration ?? 0;
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
  if (!d || !d.buffer) return;
  engageLoop(d, inSec, outSec, false);
}

/** Engage a momentary loop-roll of `lengthSec` from the current position.
 *  Always slip-resumes on end (jumps to where playback would have reached). */
export function startLoopRoll(id: DeckId, lengthSec: number): void {
  const d = decks[id];
  if (!d || !d.buffer || lengthSec <= 0) return;
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

/** Tear everything down (DJ tab unmount). Rarely called — the tab is warmed. */
export function dispose(): void {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  for (const id of ['A', 'B'] as DeckId[]) {
    const d = decks[id];
    if (!d) continue;
    try {
      stopSource(d);
      d.trim.disconnect();
      d.low.disconnect();
      d.mid.disconnect();
      d.high.disconnect();
      d.gain.disconnect();
    } catch { /* already gone */ }
    d.buffer = null;
    delete decks[id];
  }
  if (djMaster) { try { djMaster.disconnect(); } catch { /* gone */ } djMaster = null; }
  listeners.clear();
}
