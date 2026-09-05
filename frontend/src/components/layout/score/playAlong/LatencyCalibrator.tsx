import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getEngineCtx, getMasterGain } from '../../../../state/playerStore';
import { subscribeToMidi } from '../../../../state/midiBus';
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
  const [running, setRunning] = useState(false);
  const [clicksDone, setClicksDone] = useState(0);
  const [tapCount, setTapCount] = useState(0);
  const [estimate, setEstimate] = useState<OffsetEstimate | null>(null);
  const [error, setError] = useState('');

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

  const reset = useCallback(() => {
    stopClicks();
    clicksRef.current = [];
    deltasRef.current = [];
    setClicksDone(0);
    setTapCount(0);
    setEstimate(null);
    setError('');
  }, [stopClicks]);

  // Snapshot the offset when opening (CANCEL restores it) and tidy on close.
  useEffect(() => {
    if (!open) return;
    previousRef.current = usePlayAlongStore.getState().userOffsetMs;
    reset();
    const raf = requestAnimationFrame(() => startRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      stopClicks();
    };
  }, [open, reset, stopClicks]);

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

  // Taps: Space on the keyboard (while the dialog is open), any MIDI note-on.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopClicks();
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
  }, [open, onClose, recordTap, stopClicks]);

  const apply = () => {
    if (!estimate) return;
    setUserOffsetMs(clampOffset(estimate.ms));
    stopClicks();
    onClose();
  };

  const cancel = () => {
    setUserOffsetMs(previousRef.current);
    stopClicks();
    onClose();
  };

  if (!open) return null;

  const resultMs = estimate ? clampOffset(estimate.ms) : null;
  const noisy = !!estimate && estimate.spreadMs > SPREAD_WARN_MS;
  const canApply = !!estimate && estimate.count >= 3 && !running;

  return (
    <div
      ref={dialogRef}
      id={CALIBRATOR_ID}
      role="dialog"
      aria-labelledby="score-latency-title"
      aria-modal="false"
      tabIndex={-1}
      className="absolute bottom-full right-0 mb-1 z-50 w-72 rounded-lg border border-white/10 bg-[#0a080f] p-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.75)] text-[10px] font-mono text-zinc-300 outline-none focus:border-emerald-500/40"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="score-latency-title" className="text-[9px] font-black uppercase tracking-widest text-emerald-200">
          Latency calibration
        </h3>
        <span className="text-zinc-500 tabular-nums" aria-live="polite">
          {clicksDone}/{CALIBRATION_CLICKS} clicks · {tapCount} taps
        </span>
      </div>
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
          className="btn-ghost text-[9px] py-1 px-2 disabled:opacity-40"
          title="Play twelve clicks through the master output"
        >
          {running ? 'RUNNING…' : tapCount > 0 ? 'AGAIN' : 'START'}
        </button>
        {running && (
          <button
            type="button"
            onClick={stopClicks}
            className="btn-ghost text-[9px] py-1 px-2"
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
      <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-white/10 pt-2">
        <button
          type="button"
          onClick={cancel}
          className="px-2 py-0.5 rounded hover:bg-white/10"
          title="Close without changing the offset"
        >
          CANCEL
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={!canApply}
          className="px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40"
          title={canApply ? 'Use this offset for every play-along view' : 'Tap along to at least three clicks first'}
        >
          APPLY
        </button>
      </div>
    </div>
  );
};

export default LatencyCalibrator;
