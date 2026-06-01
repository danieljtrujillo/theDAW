/**
 * djEngine — a real, independent 2-deck DJ audio engine.
 *
 * The DJ tab's decks + crossfader used to be cosmetic (local useState that
 * applied no audio). This module makes them play for real:
 *
 *   <audio> A ─▶ srcA ─▶ lowA ─▶ midA ─▶ highA ─▶ gainA ─┐
 *                                                        ├▶ djMaster ─▶ engine master
 *   <audio> B ─▶ srcB ─▶ lowB ─▶ midB ─▶ highB ─▶ gainB ─┘        (shared: playerStore)
 *
 * Why HTMLAudioElement (not decoded AudioBuffer): DJ tracks are full-length
 * songs; decoding each into an AudioBuffer would burn hundreds of MB of RAM
 * (bad on the 6 GB-VRAM laptop). A media element streams from the URL, gives
 * native currentTime/seek/loop, and `playbackRate` doubles as the turntable
 * pitch control (speed+pitch together, like a real deck's pitch fader).
 *
 * It is INDEPENDENT of the footer player: both mix at the shared engine master,
 * so the visualizer/HUD see DJ audio and the global volume/mute still apply, but
 * the footer's single-track transport is untouched. (Decided with the user:
 * "independent DJ engine".)
 *
 * Crossfader uses an equal-power curve so the perceived loudness stays constant
 * across the sweep (center = both at ~-3 dB, not full).
 */
import { getEngineCtx, getMasterGain } from './playerStore';
import { logError } from './logStore';

export type DeckId = 'A' | 'B';

export interface DeckStatus {
  loadedUrl: string | null;
  label: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
}

interface Deck {
  el: HTMLAudioElement;
  src: MediaElementAudioSourceNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  gain: GainNode; // crossfader-controlled
  loadedUrl: string | null;
  label: string | null;
  pitchPct: number;
}

const RAMP_TC = 0.012;

let djMaster: GainNode | null = null;
const decks: Partial<Record<DeckId, Deck>> = {};
let crossfade = 0; // -1 = full A, 0 = center, +1 = full B
let rafId = 0;

const listeners = new Set<(a: DeckStatus, b: DeckStatus) => void>();

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

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

  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.preload = 'auto';

  const src = ctx.createMediaElementSource(el);
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

  // Initial crossfader gain for this deck.
  const cg = crossGains(crossfade);
  gain.gain.value = id === 'A' ? cg.a : cg.b;

  src.connect(low).connect(mid).connect(high).connect(gain).connect(master);

  const deck: Deck = { el, src, low, mid, high, gain, loadedUrl: null, label: null, pitchPct: 0 };

  // Status pushes on native transport events.
  el.addEventListener('play', emit);
  el.addEventListener('pause', emit);
  el.addEventListener('ended', emit);
  el.addEventListener('loadedmetadata', emit);

  decks[id] = deck;
  return deck;
}

function getDeck(id: DeckId): Deck {
  return decks[id] ?? buildDeck(id);
}

function statusOf(id: DeckId): DeckStatus {
  const d = decks[id];
  if (!d) return { loadedUrl: null, label: null, playing: false, currentTime: 0, duration: 0 };
  return {
    loadedUrl: d.loadedUrl,
    label: d.label,
    playing: !d.el.paused && !d.el.ended,
    currentTime: d.el.currentTime,
    duration: Number.isFinite(d.el.duration) ? d.el.duration : 0,
  };
}

function emit(): void {
  const a = statusOf('A');
  const b = statusOf('B');
  for (const cb of listeners) cb(a, b);
  // Run a time-update clock only while at least one deck is playing.
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

/** Load a track URL into a deck (pauses + rewinds first). Pass null to clear. */
export async function loadDeck(id: DeckId, url: string | null, label: string | null): Promise<void> {
  const d = getDeck(id);
  d.el.pause();
  if (!url) {
    d.el.removeAttribute('src');
    d.el.load();
    d.loadedUrl = null;
    d.label = null;
    emit();
    return;
  }
  d.loadedUrl = url;
  d.label = label;
  d.el.src = url;
  d.el.currentTime = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error(d.el.error?.message ?? 'load failed')); };
      const cleanup = () => {
        d.el.removeEventListener('loadedmetadata', onLoaded);
        d.el.removeEventListener('error', onErr);
      };
      d.el.addEventListener('loadedmetadata', onLoaded);
      d.el.addEventListener('error', onErr);
    });
  } catch (e) {
    logError('dj', `Deck ${id} load failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  emit();
}

export function playDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.loadedUrl) return;
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* retry next gesture */ });
  void d.el.play().catch((err) => {
    logError('dj', `Deck ${id} play rejected: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function pauseDeck(id: DeckId): void {
  decks[id]?.el.pause();
}

export function toggleDeck(id: DeckId): void {
  const d = decks[id];
  if (!d || !d.loadedUrl) return;
  if (d.el.paused) playDeck(id);
  else pauseDeck(id);
}

/** Cue back to the start (and keep playing if it was). */
export function cueDeck(id: DeckId): void {
  const d = decks[id];
  if (!d) return;
  d.el.currentTime = 0;
  emit();
}

export function seekDeck(id: DeckId, sec: number): void {
  const d = decks[id];
  if (!d || !Number.isFinite(sec)) return;
  d.el.currentTime = clamp(sec, 0, d.el.duration || 0);
  emit();
}

/** Turntable pitch in percent (±). Drives playbackRate (speed+pitch together). */
export function setDeckPitch(id: DeckId, pct: number): void {
  const d = getDeck(id);
  d.pitchPct = pct;
  d.el.playbackRate = clamp(1 + pct / 100, 0.25, 4);
}

export function setDeckEq(id: DeckId, band: 'low' | 'mid' | 'high', db: number): void {
  const d = getDeck(id);
  const ctx = getEngineCtx();
  const node = band === 'low' ? d.low : band === 'mid' ? d.mid : d.high;
  node.gain.setTargetAtTime(clamp(db, -24, 24), ctx.currentTime, RAMP_TC);
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

/** Tear everything down (DJ tab unmount). Rarely called — the tab is warmed. */
export function dispose(): void {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  for (const id of ['A', 'B'] as DeckId[]) {
    const d = decks[id];
    if (!d) continue;
    try {
      d.el.pause();
      d.src.disconnect();
      d.low.disconnect();
      d.mid.disconnect();
      d.high.disconnect();
      d.gain.disconnect();
    } catch { /* already gone */ }
    delete decks[id];
  }
  if (djMaster) { try { djMaster.disconnect(); } catch { /* gone */ } djMaster = null; }
  listeners.clear();
}
