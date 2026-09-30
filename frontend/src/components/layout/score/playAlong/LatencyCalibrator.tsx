import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getEngineCtx, getMasterGain } from '../../../../state/playerStore';
import { subscribeToMidi } from '../../../../state/midiBus';
import { resolveGlobal } from '../../../../state/ioDevicesStore';
import { recordingDeviceKey, useRecordingPrefs } from '../../../../state/recordingStore';
import {
  CLIPPING_WARN_FRACTION,
  MIN_USABLE_CONFIDENCE,
  roundTripMs,
  type RoundTripSplit,
} from '../../../../lib/roundTripLatency';
import {
  PROBE_UI_MAX_LAG_SEC,
  RoundTripProbeError,
  measureRoundTrip,
  type RoundTripMeasurement,
} from '../../../../lib/roundTripProbe';
import {
  USER_OFFSET_MAX_MS,
  USER_OFFSET_MIN_MS,
  usePlayAlongStore,
} from '../../../../state/playAlongStore';
import {
  CALIBRATION_CLICKS,
  CALIBRATION_PERIOD_SEC,
  CLICK_HZ,
  CLICK_LEAD_SEC,
  CLICK_LENGTH_SEC,
  clickTimes,
  estimateOffsetMs,
  SPREAD_WARN_MS,
  tapDelta,
  type OffsetEstimate,
} from './latencyMath';

export interface LatencyCalibratorProps {
  open: boolean;
  onClose: () => void;
}

/** Element id the CALIBRATE button's aria-controls points at. */
export const CALIBRATOR_ID = 'score-latency-calibrator';

/**
 * The two things this dialog can measure, which are NOT the same number.
 *
 *   - `tap` — a human against a click. The answer is a VISUAL offset
 *     (`playAlongStore.userOffsetMs`): how far to slide the notation so it
 *     looks like it sounds. It contains the player's own reaction time and is
 *     good to a few tens of milliseconds, which is all a visual offset needs.
 *   - `loopback` — the machine against itself. A probe leaves the master
 *     output, the microphone hears it, and cross-correlation says how long the
 *     trip took. That is a property of the DEVICE, is good to the sample, and
 *     is the number a recorded take has to be slid back by — so it is saved per
 *     input device in `useRecordingPrefs.roundTrip` and NOT into the visual
 *     offset. Mixing the two up would place takes by a reaction time.
 */
export type CalibratorMode = 'tap' | 'loopback';

interface ClickNodes {
  osc: OscillatorNode;
  gain: GainNode;
}

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
};

const clampOffset = (ms: number): number =>
  Math.min(USER_OFFSET_MAX_MS, Math.max(USER_OFFSET_MIN_MS, Math.round(ms)));

/**
 * Tap calibrator for the visual offset. START schedules twelve 1 kHz clicks at
 * 100 BPM on the audio engine's own clock (through the master bus, so they go
 * out the same path the music does); the player taps Space or any MIDI key on
 * each one. Every tap is a delta against its nearest click; the offset is the
 * median of the last eight minus the context's reported output latency.
 * APPLY writes it to playAlongStore.userOffsetMs (what every play-along view
 * subtracts); CANCEL restores the value from before the dialog opened.
 */
export const LatencyCalibrator: React.FC<LatencyCalibratorProps> = ({ open, onClose }) => {
  const setUserOffsetMs = usePlayAlongStore((s) => s.setUserOffsetMs);
  const setRoundTrip = useRecordingPrefs((s) => s.setRoundTrip);
  const savedRoundTrip = useRecordingPrefs((s) => s.roundTrip);
  const [mode, setMode] = useState<CalibratorMode>('tap');
  const [running, setRunning] = useState(false);
  const [clicksDone, setClicksDone] = useState(0);
  const [tapCount, setTapCount] = useState(0);
  const [estimate, setEstimate] = useState<OffsetEstimate | null>(null);
  const [error, setError] = useState('');

  // The loopback half. Kept separate from the tap half's state so switching
  // modes never shows one run's numbers under the other's heading.
  const [probing, setProbing] = useState(false);
  const [probeProgress, setProbeProgress] = useState(0);
  const [probeResult, setProbeResult] = useState<RoundTripMeasurement | null>(null);
  const [probeSplit, setProbeSplit] = useState<RoundTripSplit | null>(null);
  const [probeError, setProbeError] = useState('');
  const [saved, setSaved] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const previousRef = useRef(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const clicksRef = useRef<number[]>([]);
  const deltasRef = useRef<number[]>([]);
  const nodesRef = useRef<ClickNodes[]>([]);
  const timerRef = useRef(0);
  const runningRef = useRef(false);

  const stopClicks = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = 0;
    }
    for (const { osc, gain } of nodesRef.current) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* already gone */
      }
    }
    nodesRef.current = [];
  }, []);

  /** Abort a loopback run in flight. Safe to call when none is. */
  const stopProbe = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stopClicks();
    clicksRef.current = [];
    deltasRef.current = [];
    setClicksDone(0);
    setTapCount(0);
    setEstimate(null);
    setError('');
  }, [stopClicks]);

  const resetProbe = useCallback(() => {
    stopProbe();
    setProbing(false);
    setProbeProgress(0);
    setProbeResult(null);
    setProbeSplit(null);
    setProbeError('');
    setSaved(false);
  }, [stopProbe]);

  // Snapshot the offset when opening (CANCEL restores it) and tidy on close.
  useEffect(() => {
    if (!open) return;
    previousRef.current = usePlayAlongStore.getState().userOffsetMs;
    reset();
    resetProbe();
    // `startRef` is on whichever mode's start button is mounted; the dialog
    // itself is the fallback, so reopening in loopback mode still lands focus
    // inside the dialog rather than nowhere.
    const raf = requestAnimationFrame(() => (startRef.current ?? dialogRef.current)?.focus());
    return () => {
      cancelAnimationFrame(raf);
      stopClicks();
      stopProbe();
    };
  }, [open, reset, resetProbe, stopClicks, stopProbe]);

  const outputLatencySec = (ctx: AudioContext): number => {
    const c = ctx as AudioContext & { outputLatency?: number };
    const v = typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency : c.baseLatency;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  const recordTap = useCallback((tapCtxSec: number) => {
    const ctx = ctxRef.current;
    if (!ctx || !runningRef.current) return;
    const delta = tapDelta(clicksRef.current, tapCtxSec);
    if (delta === null) return;
    deltasRef.current.push(delta);
    setTapCount(deltasRef.current.length);
    setEstimate(estimateOffsetMs(deltasRef.current, outputLatencySec(ctx)));
  }, []);

  const start = useCallback(async () => {
    reset();
    let ctx: AudioContext;
    try {
      ctx = getEngineCtx();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (e) {
      setError(`Audio engine unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    ctxRef.current = ctx;
    const master = getMasterGain();
    const t0 = ctx.currentTime + CLICK_LEAD_SEC;
    const clicks = clickTimes(t0);
    clicksRef.current = clicks;
    const nodes: ClickNodes[] = [];
    try {
      for (const tk of clicks) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = CLICK_HZ;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, tk);
        gain.gain.linearRampToValueAtTime(0.5, tk + 0.002);
        gain.gain.setValueAtTime(0.5, tk + CLICK_LENGTH_SEC * 0.6);
        gain.gain.linearRampToValueAtTime(0, tk + CLICK_LENGTH_SEC);
        osc.connect(gain);
        gain.connect(master);
        osc.start(tk);
        osc.stop(tk + CLICK_LENGTH_SEC + 0.02);
        nodes.push({ osc, gain });
      }
    } catch (e) {
      setError(`Could not schedule the clicks: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    nodesRef.current = nodes;
    runningRef.current = true;
    setRunning(true);
    // Space must be a tap, not a click on the focused START button.
    dialogRef.current?.focus();
    const last = clicks[clicks.length - 1];
    timerRef.current = window.setInterval(() => {
      const now = ctx.currentTime;
      let done = 0;
      for (const tk of clicks) if (tk <= now) done += 1;
      setClicksDone(done);
      if (now > last + CALIBRATION_PERIOD_SEC) {
        // Leave the taps and the estimate; only the metronome ends.
        runningRef.current = false;
        setRunning(false);
        window.clearInterval(timerRef.current);
        timerRef.current = 0;
      }
    }, 50);
  }, [reset]);

  /**
   * One loopback run: open the input, play the probe through the MASTER bus —
   * the same path the music takes, and the same path this dialog's own clicks
   * take — and correlate what the microphone heard against what was played.
   *
   * The device is the one a record pass would use (`recordingDeviceKey()`), so
   * the measurement is filed under the device it measured.
   */
  const startProbe = useCallback(async () => {
    resetProbe();
    let ctx: AudioContext;
    try {
      ctx = getEngineCtx();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (e) {
      setProbeError(`Audio engine unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setProbing(true);
    try {
      const result = await measureRoundTrip(ctx, {
        deviceId: recordingDeviceKey(),
        output: getMasterGain(),
        // The correlation runs on the MAIN THREAD and costs O(n·lag), so an
        // interactive run searches the tighter window — see PROBE_UI_MAX_LAG_SEC.
        maxLagSec: PROBE_UI_MAX_LAG_SEC,
        onProgress: setProbeProgress,
        signal: controller.signal,
      });
      // The context's own reported output latency is a REAL component of what
      // was just measured (the probe went out through it), so the split says
      // which end of the loop the time went. `compMs` — the whole loop — is
      // what placement removes; see `roundTripLatency.roundTripMs`.
      setProbeSplit(roundTripMs(result.lagSec, result.contextOutputLatencySec, 0));
      setProbeResult(result);
    } catch (e) {
      if (e instanceof RoundTripProbeError) {
        if (e.kind !== 'cancelled') setProbeError(e.message);
      } else {
        setProbeError(`The loopback test failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      abortRef.current = null;
      setProbing(false);
    }
  }, [resetProbe]);

  /** Persist the measurement against the device it was taken on. */
  const saveProbe = useCallback(() => {
    if (!probeResult || !probeSplit) return;
    setRoundTrip(recordingDeviceKey(), {
      ms: Math.round(probeSplit.compMs * 10) / 10,
      measuredAt: new Date().toISOString(),
      confidence: probeResult.confidence,
    });
    setSaved(true);
  }, [probeResult, probeSplit, setRoundTrip]);

  // Taps: Space on the keyboard (while the dialog is open), any MIDI note-on.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopClicks();
        stopProbe();
        onClose();
        return;
      }
      if (!runningRef.current) return;
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const ctx = ctxRef.current;
      if (ctx) recordTap(ctx.currentTime);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Buttons activate on Space keyup: swallow it while the run is on so a
      // tap never re-triggers START or APPLY.
      if (!runningRef.current) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    const offMidi = subscribeToMidi((msg) => {
      if (!runningRef.current) return;
      const status = (msg.data[0] ?? 0) & 0xf0;
      const velocity = msg.data[2] ?? 0;
      if (status !== 0x90 || velocity === 0) return;
      const ctx = ctxRef.current;
      if (!ctx) return;
      recordTap(ctx.currentTime - (performance.now() - msg.t) / 1000);
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      offMidi();
    };
  }, [open, onClose, recordTap, stopClicks, stopProbe]);

  const apply = () => {
    if (!estimate) return;
    setUserOffsetMs(clampOffset(estimate.ms));
    stopClicks();
    onClose();
  };

  const cancel = () => {
    setUserOffsetMs(previousRef.current);
    stopClicks();
    stopProbe();
    onClose();
  };

  /** Switching modes never leaves the other half's run going. */
  const pickMode = (next: CalibratorMode) => {
    if (next === mode) return;
    stopClicks();
    stopProbe();
    setProbing(false);
    setMode(next);
  };

  if (!open) return null;

  const resultMs = estimate ? clampOffset(estimate.ms) : null;
  const noisy = !!estimate && estimate.spreadMs > SPREAD_WARN_MS;
  const canApply = !!estimate && estimate.count >= 3 && !running;

  const device = resolveGlobal('audio_input');
  const deviceName = device.label || 'system default input';
  const existing = savedRoundTrip[recordingDeviceKey()] ?? null;
  const confident = !!probeResult && probeResult.confidence >= MIN_USABLE_CONFIDENCE;
  const clipping = !!probeResult && probeResult.clippedFraction > CLIPPING_WARN_FRACTION;
  const canSave = confident && !probing;

  const modeButton = (value: CalibratorMode, text: string, hint: string) => (
    <button
      type="button"
      onClick={() => pickMode(value)}
      aria-pressed={mode === value}
      className={
        mode === value
          ? 'px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-100'
          : 'px-2 py-0.5 rounded border border-white/10 text-zinc-400 hover:bg-white/10'
      }
      title={hint}
    >
      {text}
    </button>
  );

  return (
    <div
      ref={dialogRef}
      id={CALIBRATOR_ID}
      role="dialog"
      aria-labelledby="score-latency-title"
      aria-modal="false"
      tabIndex={-1}
      className="absolute bottom-full right-0 mb-1 z-50 w-72 rounded-lg border border-white/10 bg-[#0a080f] p-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.75)] text-xs font-bold text-zinc-300 outline-none focus:border-emerald-500/40"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="score-latency-title" className="text-xs font-black uppercase tracking-widest text-emerald-200">
          Latency calibration
        </h3>
        {mode === 'tap' && (
          <span className="text-zinc-500 tabular-nums" aria-live="polite">
            {clicksDone}/{CALIBRATION_CLICKS} clicks · {tapCount} taps
          </span>
        )}
      </div>

      <div role="group" aria-label="Calibration mode" className="mt-1.5 flex items-center gap-1.5">
        {modeButton('tap', 'TAP (VISUAL)', 'Tap along to clicks — sets the visual offset for play-along views')}
        {modeButton(
          'loopback',
          'LOOPBACK (MIC)',
          'Play a probe and listen for it — measures the recording round trip for take placement',
        )}
      </div>

      {mode === 'tap' ? (
        <>
          <p className="mt-1.5 leading-relaxed text-zinc-400">
            Press START, then tap <kbd className="rounded border border-white/15 px-1 text-zinc-200">Space</kbd> (or any MIDI key)
            exactly on each click. Twelve clicks at 100 BPM; the last eight taps count.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              ref={startRef}
              type="button"
              onClick={() => void start()}
              disabled={running}
              className="btn-ghost text-xs py-1 px-2 disabled:opacity-40"
              title="Play twelve clicks through the master output"
            >
              {running ? 'RUNNING…' : tapCount > 0 ? 'AGAIN' : 'START'}
            </button>
            {running && (
              <button
                type="button"
                onClick={stopClicks}
                className="btn-ghost text-xs py-1 px-2"
                title="Stop the clicks"
              >
                STOP
              </button>
            )}
            <span className="ml-auto tabular-nums text-zinc-200" aria-live="polite">
              {resultMs === null
                ? 'Offset: —'
                : `Offset: ${resultMs > 0 ? '+' : ''}${resultMs} ms (spread ${Math.round(estimate!.spreadMs)} ms)`}
            </span>
          </div>
          {noisy && (
            <div className="mt-1.5 text-amber-300/90">
              Spread above {SPREAD_WARN_MS} ms — tap more evenly and run it AGAIN before applying.
            </div>
          )}
          {error && <div className="mt-1.5 text-rose-300">{error}</div>}
        </>
      ) : (
        <>
          <p className="mt-1.5 leading-relaxed text-zinc-400">
            Put the microphone next to the speakers (or patch the output back into the input), then press MEASURE.
            A short sweep is played and listened for; the delay between them is the round trip your recorded takes
            are slid back by.
          </p>
          <p className="mt-1 text-zinc-500">
            Input: <span className="text-zinc-300">{deviceName}</span>
            {existing && (
              <>
                {' · saved '}
                <span className="text-zinc-300 tabular-nums">{existing.ms} ms</span>
              </>
            )}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              ref={startRef}
              type="button"
              onClick={() => void startProbe()}
              disabled={probing}
              className="btn-ghost text-xs py-1 px-2 disabled:opacity-40"
              title={`Play a probe through the master output and listen for it on the microphone. Searches the first ${Math.round(
                PROBE_UI_MAX_LAG_SEC * 1000,
              )} ms; the match runs on the main thread, so the interface pauses briefly at the end.`}
            >
              {probing ? 'MEASURING…' : probeResult ? 'AGAIN' : 'MEASURE'}
            </button>
            {probing && (
              <button
                type="button"
                onClick={stopProbe}
                className="btn-ghost text-xs py-1 px-2"
                title="Stop the measurement"
              >
                STOP
              </button>
            )}
            {/* No `aria-label` here: on a live region it REPLACES the announced
                text, so a screen reader would say "Measured round trip" and
                never the number that changed. The words are in the content. */}
            <span className="ml-auto tabular-nums text-zinc-200" role="status" aria-live="polite">
              {probing
                ? `Measuring… ${Math.round(probeProgress * 100)}%`
                : probeSplit
                  ? `Round trip: ${probeSplit.compMs.toFixed(1)} ms`
                  : 'Round trip: —'}
            </span>
          </div>
          {probing && (
            <div
              role="progressbar"
              aria-label="Loopback measurement progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(probeProgress * 100)}
              className="mt-1.5 h-1 w-full overflow-hidden rounded bg-white/10"
            >
              <div
                className="h-full bg-emerald-400/70"
                style={{ width: `${Math.round(probeProgress * 100)}%` }}
              />
            </div>
          )}
          {probeResult && probeSplit && !probing && (
            <p className="mt-1.5 text-zinc-400 tabular-nums" aria-live="polite">
              confidence {probeResult.confidence.toFixed(2)} · output {probeSplit.outputMs.toFixed(1)} ms · input{' '}
              {probeSplit.inputMs.toFixed(1)} ms
            </p>
          )}
          {probeResult && !confident && !probing && (
            <div className="mt-1.5 text-amber-300/90">
              Confidence below {MIN_USABLE_CONFIDENCE.toFixed(2)} — the probe was not clearly heard. Turn the
              speakers up, move the microphone closer, and measure AGAIN.
            </div>
          )}
          {clipping && !probing && (
            <div className="mt-1.5 text-amber-300/90">
              The input is clipping — turn the input gain down and measure again for a tighter reading.
            </div>
          )}
          {saved && !probing && (
            <div className="mt-1.5 text-emerald-300/90" role="status">
              Saved for {deviceName}. New takes are placed with it.
            </div>
          )}
          {probeError && (
            <div className="mt-1.5 text-rose-300" role="alert">
              {probeError}
            </div>
          )}
        </>
      )}

      <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-white/10 pt-2">
        <button
          type="button"
          onClick={cancel}
          className="px-2 py-0.5 rounded hover:bg-white/10"
          title="Close without changing the offset"
        >
          CANCEL
        </button>
        {mode === 'tap' ? (
          <button
            type="button"
            onClick={apply}
            disabled={!canApply}
            className="px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40"
            title={canApply ? 'Use this offset for every play-along view' : 'Tap along to at least three clicks first'}
          >
            APPLY
          </button>
        ) : (
          <button
            type="button"
            onClick={saveProbe}
            disabled={!canSave}
            className="px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40"
            title={
              canSave
                ? 'Save this round trip for the current input device'
                : 'Measure a clear loopback first — a low-confidence reading is not saved'
            }
          >
            SAVE
          </button>
        )}
      </div>
    </div>
  );
};

export default LatencyCalibrator;
