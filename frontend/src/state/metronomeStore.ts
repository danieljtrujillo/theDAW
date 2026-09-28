/**
 * metronomeStore — the transport click's settings, and the one service that
 * drives `lib/metronome.ts` from the live transport.
 *
 * The scheduler itself is pure and knows nothing about this app: it is handed
 * callbacks. The wiring lives HERE rather than in `lib/metronome.ts` so that
 * module stays importable by a plain `tsx` test with no DOM, no AudioContext
 * and no store graph behind it — `metronome.test.ts` drives it with a fake
 * context. This file is the seam where it meets playerStore, liveMixer,
 * editorStore and tempoStore, and every one of those is READ ONLY from here.
 *
 * Settings are persisted like the app's other small preference stores
 * (`drawModeStore`, `layoutPrefsStore`): `persist` + a `partialize` that saves
 * only the five values, never the actions. One set of settings serves every
 * transport: the footer's click on the EDIT timeline and the piano roll's
 * CLICK key read and write the same switch, level, count-in and click mode.
 *
 * The piano roll runs its own scheduler (`createRollMetronome`): its PLAY loops
 * over roll steps on its own clock, so it hands the scheduler a click planner
 * and a lookahead of its own, and only borrows the context, the output and
 * these settings from here.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MetronomeScheduler,
  METRONOME_TICK_MS,
  asClickMode,
  type ClickMode,
  type MetronomeDeps,
  type MetronomeSettings,
} from '../lib/metronome';
import type { TempoEvent } from '../lib/tempoMap';
import type { MeterSegment } from '../lib/meterMap';
import { getEngineCtx, getMasterGain, usePlayerStore } from './playerStore';
import { currentTransportSec, isPlaying as liveIsPlaying } from './liveMixer';
import { useEditorStore } from './editorStore';
import { useTempoStore } from './tempoStore';
// The arrangement's tempo map into tempoStore, which `editTempoMap` reads.
import './editTempoMirror';
import { EDITOR_TIMELINE_ID } from '../components/audio/trackMenuModel';

/** The count-in lengths the UI offers. */
export const COUNT_IN_CHOICES = [0, 1, 2] as const;
export type CountInBars = (typeof COUNT_IN_CHOICES)[number];

interface MetronomeState extends MetronomeSettings {
  countInBars: CountInBars;
  /** What each bar's clicks fall on: quarters, group starts, or dotted quarters. */
  clickMode: ClickMode;
  setEnabled: (on: boolean) => void;
  toggle: () => void;
  setVolume: (v: number) => void;
  setAccent: (on: boolean) => void;
  setCountInBars: (bars: CountInBars) => void;
  setClickMode: (mode: ClickMode) => void;
}

const asCountIn = (n: unknown): CountInBars =>
  (COUNT_IN_CHOICES as readonly unknown[]).includes(n) ? (n as CountInBars) : 0;

export const useMetronomeStore = create<MetronomeState>()(
  persist(
    (set) => ({
      enabled: false,
      volume: 0.7,
      accent: true,
      countInBars: 0,
      clickMode: 'quarter',
      setEnabled: (on) => set({ enabled: !!on }),
      toggle: () => set((s) => ({ enabled: !s.enabled })),
      setVolume: (v) => set({ volume: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0 }),
      setAccent: (on) => set({ accent: !!on }),
      setCountInBars: (bars) => set({ countInBars: asCountIn(bars) }),
      setClickMode: (mode) => set({ clickMode: asClickMode(mode) }),
    }),
    {
      name: 'thedaw-metronome',
      version: 1,
      // Settings saved before the click mode existed load with quarters; a
      // stored count-in or mode the UI does not offer loads as its default.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MetronomeState>;
        return { ...current, ...p, countInBars: asCountIn(p.countInBars ?? current.countInBars), clickMode: asClickMode(p.clickMode) };
      },
      partialize: (s) => ({
        enabled: s.enabled,
        volume: s.volume,
        accent: s.accent,
        countInBars: s.countInBars,
        clickMode: s.clickMode,
      }),
    },
  ),
);

/* ------------------------------- the service ------------------------------ */

/**
 * The EDIT arrangement's tempo map, read through `tempoStore`, the app's one
 * owned tempo map, which mirrors `editorStore.tempoMap` (ramps and fermatas
 * included). tempoStore replaces its frozen array on every change and never
 * otherwise, so the array handed to `tempoMap.ts` keeps its identity from tick
 * to tick and `normalizeTempoMap`'s identity cache keeps hitting.
 */
export function editTempoMap(): readonly TempoEvent[] {
  return useTempoStore.getState().events;
}

/**
 * The EDIT arrangement's meter map (`editorStore.meterMap`). The click follows
 * the EDIT transport, so it counts the arrangement's bars: a 7/8 bar at bar 9
 * clicks in 7/8 there. Before the arrangement held a meter map, this read the
 * shared `beatClock`'s, which LOOM or PERFORM may have set to their own meter.
 * The store replaces the array on every edit, so its identity is stable between.
 */
export function editMeterMap(): readonly MeterSegment[] {
  return useEditorStore.getState().meterMap;
}

/**
 * The RUNNING click follows the EDIT timeline, which is the only transport
 * whose position `currentTransportSec()` describes. While a library track plays
 * through the <audio> element that function reports the (stationary) editor
 * playhead, so a click there would sit on one beat forever — hence the gate.
 *
 * This is safe HERE and only here: by the time the click is running, liveMixer
 * has started and has set the entry id itself. It is NOT a valid test of "is
 * the user on EDIT" — see `shouldCountIn`.
 */
function onEditTransport(): boolean {
  return usePlayerStore.getState().currentEntryId === EDITOR_TIMELINE_ID;
}

let scheduler: MetronomeScheduler | null = null;
let timer = 0;
let started = false;

function ensureScheduler(): MetronomeScheduler {
  scheduler ??= new MetronomeScheduler({
    ctx: () => { try { return getEngineCtx(); } catch { return null; } },
    destination: () => { try { return getMasterGain(); } catch { return null; } },
    transportSec: () => currentTransportSec(),
    tempoMap: editTempoMap,
    // The arrangement's meter map: the bars the EDIT transport plays through.
    meterMap: editMeterMap,
    settings: () => useMetronomeStore.getState(),
    clickOpts: () => ({ mode: useMetronomeStore.getState().clickMode }),
  });
  return scheduler;
}

/** What the piano roll hands its scheduler: its own position, maps, grid and planner. */
export type RollMetronomeDeps = Pick<MetronomeDeps, 'transportSec' | 'tempoMap' | 'meterMap' | 'plan' | 'lookaheadSec'> & {
  /** Steps before the roll's bar 0. */
  pickupSteps: () => number;
};

/**
 * A scheduler for the piano roll's transport: the engine context and output
 * and these settings, with the roll's position, tempo and meter maps and click
 * planner. The roll owns it, ticks it from its own scheduler and disposes it.
 */
export function createRollMetronome(deps: RollMetronomeDeps): MetronomeScheduler {
  return new MetronomeScheduler({
    ctx: () => { try { return getEngineCtx(); } catch { return null; } },
    destination: () => { try { return getMasterGain(); } catch { return null; } },
    settings: () => useMetronomeStore.getState(),
    clickOpts: () => ({ mode: useMetronomeStore.getState().clickMode, pickupSteps: deps.pickupSteps() }),
    transportSec: deps.transportSec,
    tempoMap: deps.tempoMap,
    meterMap: deps.meterMap,
    plan: deps.plan,
    lookaheadSec: deps.lookaheadSec,
  });
}

function runWindow(): void {
  const s = ensureScheduler();
  if (timer) return;
  s.start();
  // `start` no-ops when the engine context is not up yet. Arming the interval
  // anyway would leave a timer ticking a scheduler that is not running and
  // never will be — the next store push retries instead.
  if (!s.isRunning) return;
  timer = window.setInterval(() => s.tick(), METRONOME_TICK_MS);
}

function stopWindow(): void {
  if (timer) { window.clearInterval(timer); timer = 0; }
  scheduler?.stop();
}

/**
 * Whether the click should be running right now. `livePlaying` is liveMixer's
 * own flag, passed in rather than read here so the rule is testable without a
 * running mixer — both flags are required because playerStore's `isPlaying`
 * also covers the <audio> element, whose position `currentTransportSec()` does
 * not describe.
 */
export function shouldRun(livePlaying: boolean): boolean {
  if (!useMetronomeStore.getState().enabled) return false;
  if (!onEditTransport()) return false;
  return usePlayerStore.getState().isPlaying && livePlaying;
}

function sync(): void {
  if (shouldRun(liveIsPlaying())) runWindow();
  else stopWindow();
}

/** What the caller knows about the play press. The count-in is a function of
 *  THIS and of `countInBars`, and of nothing it could read behind the caller's
 *  back — see `shouldCountIn`. */
export interface CountInPress {
  /** The EDIT surface is what this press drives (the footer's `inEditorMode`). */
  editor: boolean;
  /** The transport is already running, so the press is a pause, not a start. */
  playing: boolean;
}

/**
 * Does this press count in? Pure, and deliberately NOT a function of
 * `playerStore.currentEntryId`.
 *
 * That id only becomes `'editor-timeline'` once `liveMixer` has actually
 * STARTED (it writes it inside `start()`, and again in `reactivate()`). EDIT is
 * routinely the active surface while the id still names the last library track
 * or is null — the footer's own `inEditorMode && currentEntryId !==
 * 'editor-timeline' -> callEditorPlay()` branch exists precisely for that
 * state. So gating the count-in on the id skipped it on the FIRST play of every
 * session, and on any play after a library track: the user asked for two bars
 * and got none, silently.
 *
 * The caller states which surface it is driving instead, because the caller is
 * the only one that knows before the transport moves. A count-in needs nothing
 * else: no transport position, no loaded track — only the engine context, the
 * tempo and the meter. Contrast `shouldRun`, which gates the RUNNING click on
 * the entry id and is right to, because by then the transport has started.
 *
 * `enabled` is part of the rule: a count-in is the metronome speaking, so with
 * the metronome off a persisted `countInBars` must not sit a silent few seconds
 * in front of every play. (The scheduler enforces this too, for any caller that
 * reaches it directly.)
 */
export function shouldCountIn(press: CountInPress & { bars: number; enabled: boolean }): boolean {
  return press.enabled && press.editor && !press.playing && press.bars > 0;
}

/**
 * Play the configured count-in, then call `onDone` — which is where the caller
 * starts the transport. Nothing here touches the playhead, the recorder or the
 * player store, so a count-in that is cancelled leaves the session exactly
 * where it was. Returns a cancel; a press that does not count in calls `onDone`
 * at once and returns a no-op.
 */
export function metronomeCountIn(onDone: () => void, press: CountInPress): () => void {
  const { countInBars: bars, enabled } = useMetronomeStore.getState();
  if (!shouldCountIn({ ...press, bars, enabled })) { onDone(); return () => undefined; }
  return ensureScheduler().countIn(bars, onDone);
}

/** Silence a count-in in flight (the user hit stop, or switched tab). */
export function cancelMetronomeCountIn(): void {
  scheduler?.cancelCountIn();
}

/**
 * Start the click service. Idempotent — safe under StrictMode double-mount, and
 * safe to call from more than one mount point. It only subscribes; nothing is
 * scheduled until the transport plays with the metronome on.
 */
export function initMetronome(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  // Subscribe, never poll: both stores push, and the scheduler derives the
  // position from the audio clock rather than from a store tick.
  usePlayerStore.subscribe(sync);
  useMetronomeStore.subscribe(sync);
}
