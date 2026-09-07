/**
 * shardEngine — launch any shard on the grid, tempo- and key-matched, into a
 * named lane (docs/design/loom.md §3).
 *
 * Audio arrives from `/api/shards/{id}/audio?bpm=&semitones=` already conformed
 * to the target tempo (octave-folded) and transposed, so `playbackRate` stays
 * 1 and pitch is right by construction. Buffers are decoded once per
 * (shard, bpm, semitones) and LRU-cached. Each lane is
 * `input → lowpass → panner → gain → [stretch] → loom bus → master`, the
 * stretch insert (Signalsmith) appearing only when a lane is transposed live.
 *
 * Twenty-four voices are shared across lanes; an arriving voice steals the
 * quietest sounding one, and a voice quieter than everything already sounding
 * is dropped rather than stealing (Jacquard's rule). Voice level is estimated
 * from the shard's rms and the launch gain — no analyser per voice.
 */
import { getEngineCtx, getMasterGain } from '../state/playerStore';
import { logError, logInfo } from '../state/logStore';
import type { ShardRow } from '../state/shardIndexStore';
import { createStretchNode, type StretchNode } from './stretchWorklet';

export const MAX_VOICES = 24;
const CACHE_MAX = 192;

export interface LaneParams {
  gainDb: number;
  pan: number;
  /** 0..1 → 60 Hz … 20 kHz (log). ≥ 0.999 opens the filter fully. */
  cutoff: number;
  resonance: number;
  transpose: number;
}

export const DEFAULT_LANE_PARAMS: LaneParams = { gainDb: 0, pan: 0, cutoff: 1, resonance: 0.7, transpose: 0 };

interface Lane {
  name: string;
  input: GainNode;
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  gain: GainNode;
  stretch: StretchNode | null;
  stretchPending: boolean;
  params: LaneParams;
}

export interface Voice {
  id: number;
  lane: string;
  shard: ShardRow;
  when: number;
  end: number;
  /** Linear level estimate used for stealing. */
  level: number;
  src: AudioBufferSourceNode;
  env: GainNode;
}

let bus: GainNode | null = null;
const lanes = new Map<string, Lane>();
const voices: Voice[] = [];
let voiceSeq = 0;
const voiceListeners = new Set<(v: Voice[]) => void>();
const emitVoices = () => { for (const l of voiceListeners) l([...voices]); };

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const dbToLin = (db: number) => Math.pow(10, db / 20);
const cutoffHz = (x: number) => (x >= 0.999 ? 22000 : 60 * Math.pow(20000 / 60, clamp(x, 0, 1)));

function ensureBus(): GainNode {
  if (bus) return bus;
  const ctx = getEngineCtx();
  bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(getMasterGain());
  return bus;
}

export function ensureLane(name: string): Lane {
  const have = lanes.get(name);
  if (have) return have;
  const ctx = getEngineCtx();
  const input = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoffHz(1);
  filter.Q.value = 0.7;
  const panner = ctx.createStereoPanner();
  const gain = ctx.createGain();
  input.connect(filter).connect(panner).connect(gain).connect(ensureBus());
  const lane: Lane = { name, input, filter, panner, gain, stretch: null, stretchPending: false, params: { ...DEFAULT_LANE_PARAMS } };
  lanes.set(name, lane);
  return lane;
}

/** Route `gain → stretch → bus` once the WASM node exists (lazy, once per lane). */
async function ensureLaneStretch(lane: Lane): Promise<void> {
  if (lane.stretch || lane.stretchPending) return;
  lane.stretchPending = true;
  try {
    const node = await createStretchNode(getEngineCtx());
    try { lane.gain.disconnect(); } catch { /* not connected */ }
    lane.gain.connect(node);
    node.connect(ensureBus());
    void node.start();
    lane.stretch = node;
  } catch (e) {
    logError('loom', `Lane "${lane.name}": live transpose unavailable (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    lane.stretchPending = false;
  }
}

/** Set lane params, at `at` (ctx time) or now; smoothed. */
export function setLaneParams(name: string, p: Partial<LaneParams>, at?: number): void {
  const lane = ensureLane(name);
  const ctx = getEngineCtx();
  const t = Math.max(ctx.currentTime, at ?? ctx.currentTime);
  const next = { ...lane.params, ...p };
  if (p.gainDb !== undefined) lane.gain.gain.setTargetAtTime(dbToLin(clamp(next.gainDb, -60, 12)), t, 0.01);
  if (p.pan !== undefined) lane.panner.pan.setTargetAtTime(clamp(next.pan, -1, 1), t, 0.01);
  if (p.cutoff !== undefined) lane.filter.frequency.setTargetAtTime(cutoffHz(next.cutoff), t, 0.01);
  if (p.resonance !== undefined) lane.filter.Q.setTargetAtTime(clamp(next.resonance, 0.1, 18), t, 0.01);
  if (p.transpose !== undefined) {
    const st = clamp(next.transpose, -24, 24);
    if (Math.abs(st) > 0.01 || lane.stretch) {
      if (!lane.stretch) void ensureLaneStretch(lane).then(() => { lane.stretch?.schedule({ semitones: st }); });
      else void lane.stretch.schedule({ semitones: st });
    }
  }
  lane.params = next;
}

export function laneParams(name: string): LaneParams {
  return { ...(lanes.get(name)?.params ?? DEFAULT_LANE_PARAMS) };
}

/* ── buffers ─────────────────────────────────────────────────────────────── */

const cache = new Map<string, Promise<AudioBuffer>>();

const bpmKey = (bpm: number) => Math.round(bpm * 2) / 2;
const stKey = (st: number) => Math.round(st * 2) / 2;

export function shardAudioUrl(shard: ShardRow, bpm: number, semitones = 0): string {
  const q = new URLSearchParams();
  q.set('bpm', String(bpmKey(bpm)));
  if (Math.abs(semitones) > 0.01) q.set('semitones', String(stKey(semitones)));
  return `/api/shards/${encodeURIComponent(shard.id)}/audio?${q.toString()}`;
}

export function getShardBuffer(shard: ShardRow, bpm: number, semitones = 0): Promise<AudioBuffer> {
  const key = `${shard.id}@${bpmKey(bpm)}@${stKey(semitones)}`;
  const have = cache.get(key);
  if (have) return have;
  const p = (async () => {
    const r = await fetch(shardAudioUrl(shard, bpm, semitones));
    if (!r.ok) throw new Error(`shard audio ${r.status}`);
    const ab = await r.arrayBuffer();
    return getEngineCtx().decodeAudioData(ab);
  })().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, p);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return p;
}

export function isBuffered(shard: ShardRow, bpm: number, semitones = 0): boolean {
  return cache.has(`${shard.id}@${bpmKey(bpm)}@${stKey(semitones)}`);
}

export function prefetch(shards: ShardRow[], bpm: number, semitones: (s: ShardRow) => number = () => 0): void {
  for (const s of shards) void getShardBuffer(s, bpm, semitones(s)).catch(() => { /* reported at launch */ });
}

/* ── voices ──────────────────────────────────────────────────────────────── */

export interface LaunchOpts {
  when: number;
  durationSec: number;
  lane: string;
  bpm: number;
  gainDb?: number;
  semitones?: number;
  attackSec?: number;
  releaseSec?: number;
}

function removeVoice(v: Voice): void {
  const i = voices.indexOf(v);
  if (i >= 0) voices.splice(i, 1);
}

function fadeOut(v: Voice, at: number, sec: number): void {
  try {
    v.env.gain.cancelScheduledValues(at);
    v.env.gain.setValueAtTime(v.env.gain.value, at);
    v.env.gain.linearRampToValueAtTime(0, at + Math.max(0.003, sec));
    v.src.stop(at + Math.max(0.003, sec) + 0.01);
  } catch { /* already stopped */ }
}

/** Launch a shard. Resolves once the buffer is ready (usually instantly from
 *  cache); returns null when the buffer could not be fetched or the voice was
 *  dropped by the pool rule. */
export async function launch(shard: ShardRow, opts: LaunchOpts): Promise<Voice | null> {
  let buffer: AudioBuffer;
  try {
    buffer = await getShardBuffer(shard, opts.bpm, opts.semitones ?? 0);
  } catch (e) {
    logError('loom', `Could not fetch shard ${shard.id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const ctx = getEngineCtx();
  const lane = ensureLane(opts.lane);
  const when = Math.max(opts.when, ctx.currentTime + 0.003);
  const attack = Math.max(0.003, opts.attackSec ?? 0.004);
  const release = Math.max(0.003, opts.releaseSec ?? 0.012);
  const g = dbToLin(clamp(opts.gainDb ?? 0, -60, 12));
  const end = when + Math.max(0.02, opts.durationSec);
  const level = g * Math.pow(10, clamp(shard.rms_db, -90, 0) / 20);

  // Pool rule before allocating audio nodes.
  if (voices.length >= MAX_VOICES) {
    const sorted = [...voices].sort((a, b) => a.level - b.level);
    const quietest = sorted[0];
    if (quietest && quietest.level > level) return null; // quieter than everything sounding
    if (quietest) { fadeOut(quietest, ctx.currentTime, 0.006); removeVoice(quietest); }
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  if (opts.durationSec > buffer.duration + 0.005) {
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
  }
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(g, when + attack);
  env.gain.setValueAtTime(g, Math.max(when + attack, end - release));
  env.gain.linearRampToValueAtTime(0, end);
  src.connect(env).connect(lane.input);
  src.start(when);
  src.stop(end + 0.02);

  const voice: Voice = { id: ++voiceSeq, lane: opts.lane, shard, when, end, level, src, env };
  voices.push(voice);
  emitVoices();
  src.onended = () => {
    removeVoice(voice);
    try { env.disconnect(); } catch { /* gone */ }
    emitVoices();
  };
  return voice;
}

/** Release every voice on a lane that would still be sounding at `at`, over `sec`. */
export function releaseLane(name: string, at: number, sec: number): void {
  for (const v of voices) {
    if (v.lane === name && v.end > at + 0.001) {
      fadeOut(v, at, sec);
      v.end = at + sec;
    }
  }
}

export function stopAll(fadeSec = 0.02): void {
  let ctx: AudioContext;
  try { ctx = getEngineCtx(); } catch { return; }
  const now = ctx.currentTime;
  for (const v of [...voices]) { fadeOut(v, now, fadeSec); removeVoice(v); }
  emitVoices();
  logInfo('loom', 'Stopped');
}

export function activeVoices(): Voice[] { return [...voices]; }

export function subscribeVoices(fn: (v: Voice[]) => void): () => void {
  voiceListeners.add(fn);
  return () => { voiceListeners.delete(fn); };
}

export function laneNames(): string[] { return [...lanes.keys()]; }
