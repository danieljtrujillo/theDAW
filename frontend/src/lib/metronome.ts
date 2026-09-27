/**
 * metronome — theDAW's transport click: tempo- and meter-aware, accented on the
 * downbeat, scheduled sample-accurately on the shared engine AudioContext.
 *
 * Before this the only click in the app was `playAlong/LatencyCalibrator.tsx`'s
 * fixed-period calibration tone. It is not a metronome: its period is a
 * constant, it knows nothing of the tempo map and it exists to be tapped
 * against, not played along with. This module is the real one, and it owns no
 * tempo of its own — beats come from `tempoMap.ts`, bars from `meterMap.ts`,
 * the position from the transport. There is still exactly one bpm owner.
 *
 * The grid
 * --------
 * Clicks sit on QUARTER NOTES measured FROM EACH BAR LINE, not on a single
 * global quarter-note grid. In 4/4 the two are the same thing. In 7/8 a bar is
 * 3.5 quarter notes, and a global grid would walk straight past every second
 * bar line — so the downbeat, the one beat that must always click, would be
 * silent half the time. Laying the grid out per bar puts a click (and the
 * accent) on every downbeat, 3.5 beats apart, and drops the ragged remainder at
 * the bar line instead.
 *
 * That is the `'quarter'` CLICK MODE, the default. Two more count the bar the
 * way odd and compound meters are felt (`barClicks`):
 *   - `'group'` sounds each group start, so 7/8 grouped 3+2+2 clicks three
 *     times, unevenly, on the bar's own accents; 12/8 without groups clicks its
 *     four dotted quarters, and a simple meter without groups its written beat.
 *   - `'dotted'` sounds dotted quarters from each bar line (6/8 twice, 4/4 on
 *     beats 1, 2-and and 4), for practising a dotted-quarter pulse or a metric
 *     modulation.
 * A roll with a pickup counts the pickup's clicks back from its end, as its
 * grid does, and gives it no accent: it has no downbeat.
 *
 * The scheduler
 * -------------
 * A rolling lookahead, not a pre-schedule of the song: every `METRONOME_TICK_MS`
 * a tick schedules the clicks falling in the next `METRONOME_LOOKAHEAD_SEC`, so
 * a tempo edit, a seek or a six-hour session all cost the same. This is the
 * standard Web Audio two-clock pattern (a coarse JS timer deciding what a
 * sample-accurate `AudioParam`/`start(t)` schedule should contain), as described
 * in Chris Wilson's "A Tale of Two Clocks"; the implementation below is written
 * from that description.
 *
 * The scheduler holds an ANCHOR — one (ctx time, transport second) pair — and
 * derives the transport position from `ctx.currentTime` rather than polling.
 * The invariant it protects: *the anchor's prediction of the transport position
 * never diverges from the transport's own report by more than
 * `METRONOME_RESYNC_SEC`.* When it does (a seek, a re-start, a drifting clock),
 * the queued-but-unplayed clicks are stopped, the anchor is retaken and the
 * beat cursor is dropped, which is what makes a seek restart the window. Two
 * further rules hold on every tick: a beat is scheduled at most ONCE (the
 * `lastBeat` cursor only moves forward), and a beat already behind
 * `ctx.currentTime` is skipped rather than fired late.
 *
 * A DIVERGENCE IS NOT ALWAYS A SEEK. `liveMixer.currentTransportSec()` clamps
 * to the project duration, and liveMixer only ends playback from its rAF frame
 * — so when the song runs off its end in a hidden tab (rAF parked, this
 * module's `setInterval` still firing at ~1 Hz) the transport reports the same
 * clamped second forever while `ctx.currentTime` keeps moving. Every tick would
 * trip the resync, drop the cursor and re-schedule the SAME last beats against
 * a fresh anchor: the click repeats a beat once a second, after the song ended,
 * for as long as the tab stays hidden. So a divergence whose reported position
 * has NOT MOVED since the last tick re-anchors (to stop the divergence growing)
 * but keeps the beat cursor and schedules nothing. A frozen transport is a
 * stall, and a stall is silent.
 *
 * Mute policy
 * -----------
 * `setMuteTest` is the extension point for the modes a click track eventually
 * grows — "count while recording only" being the obvious next one. The design
 * reference is Tracktion Engine's `tracktion_ClickNode.cpp` `isMutedAtTime`
 * (GPL-3.0-or-later / commercial): a per-click predicate over the transport
 * position, consulted at schedule time, rather than a flag read once at start.
 * That one-sentence description of its BEHAVIOUR is the whole of what was
 * taken: the file itself was never opened, and no line of it — or of any other
 * copyleft reference under `oss-refs/` — is in this module.
 *
 * The click primitive (a few-ms sine with a ramped gain envelope, started at an
 * absolute context time) is theDAW's own, from `LatencyCalibrator.tsx`.
 */
import { beatToTime, timeToBeat, type TempoEvent } from './tempoMap';
import { barAt, normalizeMeterMap, stepsPerBar, type BarSpan, type MeterSegment } from './meterMap';
import type { Meter } from './colony';

/** How far ahead of `ctx.currentTime` a tick schedules. */
export const METRONOME_LOOKAHEAD_SEC = 0.25;
/** How often the driving timer fires. Comfortably inside the lookahead. */
export const METRONOME_TICK_MS = 100;
/** Transport divergence that counts as a seek rather than as jitter. */
export const METRONOME_RESYNC_SEC = 0.05;
/** Movement below this and the transport's report counts as frozen, not seeking. */
export const METRONOME_STALL_SEC = 1e-6;
/** How often the count-in's release is checked against the AUDIO clock. */
export const COUNT_IN_POLL_MS = 10;
/** A click computed for "now" is scheduled this far ahead, so it is never past. */
export const CLICK_LEAD_SEC = 0.02;
/** Length of one click's envelope. */
export const CLICK_LENGTH_SEC = 0.03;
export const CLICK_HZ = 1000;
export const CLICK_ACCENT_HZ = 1500;

const EPS = 1e-9;
/** Bars are never zero-length, but a corrupt meter must not hang the tick. */
const MAX_CLICKS_PER_WINDOW = 4096;

export interface MetronomeSettings {
  enabled: boolean;
  /** 0..1, applied on the metronome's own gain node. */
  volume: number;
  /** Whether the downbeat gets the accent pitch. */
  accent: boolean;
  /** Bars of clicks before the transport is released. 0 = straight in. */
  countInBars: number;
}

/** One click: its quarter-note beat, its TRANSPORT second, and whether it is a downbeat. */
export interface ClickPlan {
  beat: number;
  sec: number;
  accent: boolean;
}

/** What a bar's clicks fall on. See the header. */
export type ClickMode = 'quarter' | 'group' | 'dotted';
export const CLICK_MODES: readonly ClickMode[] = ['quarter', 'group', 'dotted'];
export const CLICK_MODE_LABEL: Record<ClickMode, string> = { quarter: 'Quarters', group: 'Groups', dotted: 'Dotted quarters' };
export const CLICK_MODE_TITLE: Record<ClickMode, string> = {
  quarter: 'A click on every quarter note from each bar line',
  group: 'A click on each group start: 7/8 3+2+2 clicks three times, 12/8 on its dotted quarters',
  dotted: 'A click on every dotted quarter from each bar line',
};
/** A stored click mode, or the default for anything else. */
export const asClickMode = (v: unknown): ClickMode => ((CLICK_MODES as readonly unknown[]).includes(v) ? (v as ClickMode) : 'quarter');

/** How the grid is counted: the mode, and the steps before bar 0 (a pickup). */
export interface ClickOpts {
  mode?: ClickMode;
  pickupSteps?: number;
}

/** One click inside a full bar: its 16th-note step from the bar line, and whether it is the downbeat. */
export interface BarClick {
  at: number;
  accent: boolean;
}

const barClickCache = new Map<string, BarClick[]>();

/**
 * The clicks of one full bar of `m` in `mode`, in 16th-note steps from the bar
 * line (a 7/8 bar is 14 steps). Group starts are exact: a group of `g` units of
 * `1/den` starts `16 / den` steps per unit in. A meter counts as compound when
 * it has no groups, a unit of an 8th or shorter and a numerator that is a
 * multiple of 3 above 3 (6/8, 9/8, 12/8, 12/16).
 */
export function barClicks(m: Meter, mode: ClickMode = 'quarter'): BarClick[] {
  const key = `${m.num}/${m.den}:${m.groups.join('+')}:${mode}`;
  const hit = barClickCache.get(key);
  if (hit) return hit;
  const len = stepsPerBar(m);
  const unit = 16 / m.den;
  const at: number[] = [];
  if (mode === 'group') {
    if (m.groups.length > 1) {
      let acc = 0;
      for (const g of m.groups) {
        at.push(acc * unit);
        acc += g;
      }
    } else {
      const compound = m.den >= 8 && m.num > 3 && m.num % 3 === 0;
      const pulse = compound ? 3 * unit : unit;
      for (let t = 0; t < len - EPS; t += pulse) at.push(t);
    }
  } else {
    const pulse = mode === 'dotted' ? 6 : 4;
    for (let t = 0; t < len - EPS; t += pulse) at.push(t);
  }
  const out = at.filter((t) => t < len - EPS).map((t, i) => ({ at: t, accent: i === 0 }));
  barClickCache.set(key, out);
  return out;
}

/** The clicks of `span` (a bar of the map) as steps from its start; a pickup keeps the ones in its tail, unaccented. */
export function spanClicks(span: BarSpan, mode: ClickMode): BarClick[] {
  const shift = span.bar < 0 ? stepsPerBar(span.meter) - span.len : 0;
  const out: BarClick[] = [];
  for (const c of barClicks(span.meter, mode)) {
    const at = c.at - shift;
    if (at < -EPS || at >= span.len - EPS) continue;
    out.push({ at: Math.max(0, at), accent: c.accent && span.bar >= 0 });
  }
  return out;
}

/** Everything the scheduler reads from the outside. All are called per tick, so
 *  the caller can hand over live store reads without the scheduler subscribing. */
export interface MetronomeDeps {
  ctx: () => BaseAudioContext | null;
  destination: () => AudioNode | null;
  transportSec: () => number;
  tempoMap: () => readonly TempoEvent[];
  meterMap: () => readonly MeterSegment[];
  settings: () => MetronomeSettings;
  /** The click mode and pickup the grid is counted with. Absent: quarters, no pickup. */
  clickOpts?: () => ClickOpts;
  /**
   * The clicks between two TRANSPORT seconds, in place of `clicksInWindow`
   * over `tempoMap` and `meterMap`. A transport that loops (the piano roll's)
   * plans its own clicks, because its bars repeat while its seconds run on.
   * Each click's `beat` must rise with its seconds: it is the scheduler's cursor.
   */
  plan?: (fromSec: number, untilSec: number) => ClickPlan[];
  /** Seconds each tick schedules ahead. Absent: METRONOME_LOOKAHEAD_SEC. */
  lookaheadSec?: number;
  /** REPEATING timer (setInterval-shaped), used to poll the count-in's release
   *  against the audio clock. Injectable for tests; defaults to the window's. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

/**
 * Every click between `fromSec` and `untilSec` (both TRANSPORT seconds, both
 * ends inclusive), on the per-bar grid described at the top of the file, in
 * `opts.mode` (quarters by default). Pure: same inputs, same array.
 */
export function clicksInWindow(
  tempo: readonly TempoEvent[] | null | undefined,
  meter: readonly MeterSegment[] | null | undefined,
  fromSec: number,
  untilSec: number,
  opts: ClickOpts = {},
): ClickPlan[] {
  const out: ClickPlan[] = [];
  if (!(untilSec >= fromSec)) return out;
  const mode = opts.mode ?? 'quarter';
  const pickup = Math.max(0, opts.pickupSteps ?? 0);
  const map = normalizeMeterMap(meter, false);
  const fromBeat = timeToBeat(tempo, fromSec);
  let span = barAt(map, Math.max(0, fromBeat) * 4, pickup);
  for (let guard = 0; guard < MAX_CLICKS_PER_WINDOW; guard += 1) {
    if (!(span.len > EPS)) return out;
    for (const c of spanClicks(span, mode)) {
      const beat = (span.start + c.at) / 4;
      if (beat < fromBeat - EPS) continue;
      const sec = beatToTime(tempo, beat);
      if (sec > untilSec + EPS) return out;
      if (sec >= fromSec - EPS) out.push({ beat, sec, accent: c.accent });
      if (out.length >= MAX_CLICKS_PER_WINDOW) return out;
    }
    span = barAt(map, span.start + span.len, pickup);
  }
  return out;
}

/**
 * The `bars` bars of clicks that run up to `startSec` and end exactly on it,
 * plus how long they last. The bar is a full bar of the meter in force at the
 * start point, clicked in `opts.mode`, and the grid runs BACKWARDS from there —
 * through beat 0 and into negative beats when the playhead is near the top, so
 * counting in from 0 is still a whole bar rather than a clamped stub.
 */
export function countInClicks(
  tempo: readonly TempoEvent[] | null | undefined,
  meter: readonly MeterSegment[] | null | undefined,
  startSec: number,
  bars: number,
  opts: ClickOpts = {},
): { clicks: ClickPlan[]; durationSec: number } {
  const n = Math.max(0, Math.floor(bars));
  if (n === 0) return { clicks: [], durationSec: 0 };
  const startBeat = timeToBeat(tempo, startSec);
  const m = barAt(normalizeMeterMap(meter, false), Math.max(0, startBeat) * 4, Math.max(0, opts.pickupSteps ?? 0)).meter;
  const barLen = stepsPerBar(m) / 4;
  if (!(barLen > EPS)) return { clicks: [], durationSec: 0 };
  const inBar = barClicks(m, opts.mode ?? 'quarter');
  const clicks: ClickPlan[] = [];
  for (let b = 0; b < n; b += 1) {
    const barStart = startBeat - (n - b) * barLen;
    for (const c of inBar) {
      const beat = barStart + c.at / 4;
      clicks.push({ beat, sec: beatToTime(tempo, beat), accent: c.accent });
    }
  }
  const firstBeat = startBeat - n * barLen;
  return { clicks, durationSec: startSec - beatToTime(tempo, firstBeat) };
}

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  /** Context time the click starts at. */
  at: number;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * The rolling-lookahead click scheduler. It owns no timer: `tick()` is public
 * and the service (or a test) decides when it runs, which is what makes the
 * window behaviour testable against a fake context.
 */
export class MetronomeScheduler {
  private readonly deps: MetronomeDeps;
  private running = false;
  private bus: GainNode | null = null;
  private busCtx: BaseAudioContext | null = null;
  private anchorCtx = 0;
  private anchorTransport = 0;
  /** Last beat handed to the schedule (or vetoed); only ever moves forward. */
  private lastBeat: number | null = null;
  /** The transport's own report at the previous tick, to tell a stall from a seek. */
  private lastActual: number | null = null;
  private voices: Voice[] = [];
  private countInVoices: Voice[] = [];
  private countInTimer: number | null = null;
  /** Bumped by every new or cancelled count-in, so a resume that resolves late
   *  cannot arm a count the caller already walked away from. */
  private countInGen = 0;
  private muteTest: ((transportSec: number) => boolean) | null = null;

  constructor(deps: MetronomeDeps) {
    this.deps = deps;
  }

  /** True while the rolling window is live. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Install a per-click veto over the transport position — the extension point
   * for future click modes (see the header). `null` clears it.
   */
  setMuteTest(fn: ((transportSec: number) => boolean) | null): void {
    this.muteTest = fn;
  }

  /** Anchor on the transport as it is now and schedule the first window. */
  start(): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    this.running = true;
    this.anchorCtx = ctx.currentTime;
    this.anchorTransport = this.deps.transportSec();
    this.lastBeat = null;
    this.lastActual = null;
    this.tick();
  }

  /** Drop the window and silence anything queued but not yet sounding. */
  stop(): void {
    this.running = false;
    this.lastBeat = null;
    this.lastActual = null;
    const ctx = this.deps.ctx();
    if (ctx) this.cancelPending(ctx.currentTime);
    this.voices = [];
  }

  /** One pass of the lookahead. Safe to call at any rate, including too often. */
  tick(): void {
    if (!this.running) return;
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const now = ctx.currentTime;

    // The transport is somewhere the anchor does not predict. Two very
    // different causes, told apart by whether its REPORT moved since last tick.
    const predicted = this.anchorTransport + (now - this.anchorCtx);
    const actual = this.deps.transportSec();
    if (!Number.isFinite(actual)) return;
    const frozen = this.lastActual !== null && Math.abs(actual - this.lastActual) < METRONOME_STALL_SEC;
    this.lastActual = actual;
    if (Math.abs(actual - predicted) > METRONOME_RESYNC_SEC) {
      // Stalled (song ran off its clamped end, tab hidden, rAF parked): re-anchor
      // so the divergence stops growing, but keep the cursor and schedule
      // NOTHING. Re-scheduling here is what made the click repeat a beat once a
      // second forever after the song ended.
      this.anchorCtx = now;
      this.anchorTransport = actual;
      if (frozen) return;
      // A real seek: the old queue is for a position we are no longer at.
      this.cancelPending(now);
      this.lastBeat = null;
    }
    this.pruneVoices(now);

    const settings = this.deps.settings();
    if (!settings.enabled) return;

    const from = this.anchorTransport + (now - this.anchorCtx);
    const until = from + (this.deps.lookaheadSec ?? METRONOME_LOOKAHEAD_SEC);
    const clicks = this.deps.plan
      ? this.deps.plan(from, until)
      : clicksInWindow(this.deps.tempoMap(), this.deps.meterMap(), from, until, this.deps.clickOpts?.());
    for (const c of clicks) {
      if (this.lastBeat !== null && c.beat <= this.lastBeat + EPS) continue;
      this.lastBeat = c.beat;
      if (this.muteTest?.(c.sec)) continue;
      const at = this.anchorCtx + (c.sec - this.anchorTransport);
      // Never schedule in the past: a late tick drops the beat rather than
      // firing it against the wrong part of the bar.
      if (at < now - EPS) continue;
      const voice = this.scheduleClick(ctx, at, c.accent, settings);
      if (voice) this.voices.push(voice);
    }
  }

  /**
   * Play `bars` bars of clicks, then call `onDone`. Nothing else happens — the
   * caller releases the transport from `onDone`, so the playhead never advances
   * and nothing records during the count. Returns a cancel that silences the
   * count and never calls `onDone`. `startSec` is the TRANSPORT second the count
   * leads into; absent, the transport's position now.
   */
  countIn(bars: number, onDone: () => void, startSec?: number): () => void {
    this.cancelCountIn();
    const gen = ++this.countInGen;
    const mine = () => gen === this.countInGen;
    const cancel = (): void => { if (mine()) this.cancelCountIn(); };
    const ctx = this.deps.ctx();
    const n = Math.max(0, Math.floor(bars));
    // A count-in is the metronome speaking, so the metronome has to be on. With
    // it off, a persisted `countInBars` would otherwise sit a silent few seconds
    // in front of every play with nothing on screen to explain the wait.
    if (!ctx || n === 0 || !this.deps.settings().enabled) {
      onDone();
      return () => undefined;
    }
    // On the session's very first interaction the engine context can still be
    // suspended (playerStore arms its resume from a window listener, which runs
    // after React's handler). Scheduling against a stopped clock would put the
    // whole count in the past and fire it as one burst on resume, so resume
    // first — and let a cancel that lands during the await win.
    const resumable = ctx as { state?: AudioContextState; resume?: () => Promise<void> };
    if (resumable.state === 'suspended' && typeof resumable.resume === 'function') {
      void resumable.resume().then(
        () => { if (mine()) this.armCountIn(ctx, n, onDone, startSec); },
        // The clock could not be started; the count is inaudible either way and
        // waiting on a stopped clock would strand the transport. Go straight in.
        () => { if (mine()) onDone(); },
      );
      return cancel;
    }
    this.armCountIn(ctx, n, onDone, startSec);
    return cancel;
  }

  /** Silence a count-in in flight and drop its pending release. */
  cancelCountIn(): void {
    this.countInGen += 1;
    this.clearCountInTimer();
    const ctx = this.deps.ctx();
    const now = ctx ? ctx.currentTime : 0;
    for (const v of this.countInVoices) killVoice(v, now);
    this.countInVoices = [];
  }

  /** Schedule the count's clicks and the release that follows them. */
  private armCountIn(ctx: BaseAudioContext, bars: number, onDone: () => void, at?: number): void {
    const settings = this.deps.settings();
    const startSec = at ?? this.deps.transportSec();
    const { clicks, durationSec } = countInClicks(this.deps.tempoMap(), this.deps.meterMap(), startSec, bars, this.deps.clickOpts?.());
    if (!clicks.length || !(durationSec > 0)) {
      onDone();
      return;
    }
    const t0 = ctx.currentTime + CLICK_LEAD_SEC;
    const firstSec = clicks[0].sec;
    for (const c of clicks) {
      const voice = this.scheduleClick(ctx, t0 + (c.sec - firstSec), c.accent, settings);
      if (voice) this.countInVoices.push(voice);
    }
    // Release on the AUDIO clock, not on wall-clock. A `setTimeout` for the
    // count's length is late by however late the timer is — and a timer that
    // fires 80 ms late starts the transport 80 ms off the beat the user just
    // counted. Polling `ctx.currentTime` against an absolute target in the same
    // domain the clicks were scheduled in bounds that at one poll interval, and
    // survives a context that resumes in between.
    const releaseAt = t0 + durationSec;
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => window.setInterval(fn, ms));
    // Latched: releasing twice would start the transport twice, so one poll
    // that outlives its clear (a reused timer id, a host that keeps firing)
    // cannot do it.
    let released = false;
    this.countInTimer = setTimer(() => {
      if (released) return;
      const live = this.deps.ctx();
      // No context left to wait on: release rather than strand the transport.
      if (live && live.currentTime < releaseAt - EPS) return;
      released = true;
      this.clearCountInTimer();
      this.countInVoices = [];
      onDone();
    }, COUNT_IN_POLL_MS);
  }

  private clearCountInTimer(): void {
    if (this.countInTimer === null) return;
    const clearTimer = this.deps.clearTimer ?? ((id: number) => window.clearInterval(id));
    clearTimer(this.countInTimer);
    this.countInTimer = null;
  }

  /** Release the audio nodes. The scheduler is reusable afterwards. */
  dispose(): void {
    this.stop();
    this.cancelCountIn();
    if (this.bus) {
      try { this.bus.disconnect(); } catch { /* already gone */ }
    }
    this.bus = null;
    this.busCtx = null;
  }

  /** The metronome's own gain, re-created if the engine context was replaced. */
  private ensureBus(ctx: BaseAudioContext, volume: number): GainNode | null {
    const dest = this.deps.destination();
    if (!dest) return null;
    if (!this.bus || this.busCtx !== ctx) {
      if (this.bus) { try { this.bus.disconnect(); } catch { /* already gone */ } }
      this.bus = ctx.createGain();
      this.busCtx = ctx;
      this.bus.connect(dest);
    }
    this.bus.gain.value = clamp01(volume);
    return this.bus;
  }

  private scheduleClick(
    ctx: BaseAudioContext,
    at: number,
    accent: boolean,
    settings: MetronomeSettings,
  ): Voice | null {
    const bus = this.ensureBus(ctx, settings.volume);
    if (!bus) return null;
    const hot = accent && settings.accent;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hot ? CLICK_ACCENT_HZ : CLICK_HZ;
    const gain = ctx.createGain();
    const peak = hot ? 0.6 : 0.4;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.002);
    gain.gain.setValueAtTime(peak, at + CLICK_LENGTH_SEC * 0.6);
    gain.gain.linearRampToValueAtTime(0, at + CLICK_LENGTH_SEC);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(at);
    osc.stop(at + CLICK_LENGTH_SEC + 0.02);
    return { osc, gain, at };
  }

  /** Stop every click that has not started yet; a click already sounding is
   *  a few ms long and is left to finish rather than clipped. */
  private cancelPending(now: number): void {
    const kept: Voice[] = [];
    for (const v of this.voices) {
      if (v.at > now - EPS) killVoice(v, now);
      else kept.push(v);
    }
    this.voices = kept;
  }

  private pruneVoices(now: number): void {
    const cutoff = now - (CLICK_LENGTH_SEC + 0.1);
    if (this.voices.length && this.voices[0].at < cutoff) {
      this.voices = this.voices.filter((v) => v.at >= cutoff);
    }
  }
}

function killVoice(v: Voice, now: number): void {
  try { v.osc.stop(now); } catch { /* already stopped */ }
  try { v.osc.disconnect(); } catch { /* already gone */ }
  try { v.gain.disconnect(); } catch { /* already gone */ }
}
