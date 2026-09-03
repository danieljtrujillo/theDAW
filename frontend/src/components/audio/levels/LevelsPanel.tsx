/**
 * Levels tab — a conventional master meter bridge:
 *
 *   ┌ PEAK ──────┐ ┌ LOUDNESS ─────────────────────────┐ ┌ SHORT-TERM · 60 s ───────┐
 *   │ clip L  R  │ │ target ▾  ceiling  [Reset]        │ │ history strip + target   │
 *   │  0  ▮  ▮   │ │ MOMENTARY  SHORT-TERM  INTEGRATED │ │                          │
 *   │ -6  ▮  ▮   │ │  -13.8      -14.2       -14.0     │ ├ STEREO ──────────────────┤
 *   │ -18 ▮  ▮   │ │ RANGE      TRUE PEAK   VS TARGET  │ │ CORR  ─────┼──●─  +0.86  │
 *   │ max        │ │  6.2 LU     -1.2 dBTP   +0.0 LU   │ │ BAL   ─────●────  C      │
 *   └────────────┘ └───────────────────────────────────┘ └──────────────────────────┘
 *
 * Stereo L/R bar meters (RMS fill, falling peak marker, 1.5 s peak hold,
 * latching clip LEDs, green / amber / red at -18 / -6 / 0 dBFS) on the left;
 * LUFS numerics against the delivery target in the middle; the short-term
 * loudness history and the correlation / balance meters on the right.
 *
 * Data: the worklet frame in levelsStore supplies LUFS M/S/I, LRA and true
 * peak; two per-channel AnalyserNodes supply the bar meters' peak / RMS and
 * the correlation at display rate. One rAF loop (capped at 60 fps, paused
 * while the document or the panel is hidden) paints the three canvases from
 * module-scope readings — never through React — so metering never re-renders
 * the tree; the numeric readouts are written to the DOM directly at 10 Hz and
 * the visually-hidden live readouts at 2 Hz.
 *
 * Meters whatever is audible on any tab (MAKE / EDIT / DJ / Sequencer / …),
 * because they all route through the shared master chain.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  useLevelsStore,
  ensureMeter,
  disposeMeter,
  resetMeter,
  getLevelsFrame,
  getLoudnessHistory,
  getMeterHolds,
  isWorkletMeter,
  sampleChannelLevels,
  LUFS_PRESETS,
  LUFS_TARGET_MIN,
  LUFS_TARGET_MAX,
  TP_CEILING_MIN,
  TP_CEILING_MAX,
  type LufsPresetId,
} from '../../../state/levelsStore';
import { fitCanvas, scaleContextToBox, type CanvasBox } from '../../../lib/canvasScale';
import { BarMeter, StereoMeter, fmtLevel, fmtSigned, fmtBalance } from './meterModel';
import { drawBarMeters, drawLoudnessHistory, drawStereoMeters } from './levelsViews';

const MAX_FPS_INTERVAL_MS = 1000 / 60 - 1; // paint at most ~60 fps on 120 Hz+ displays
const TEXT_INTERVAL_MS = 100;
const LIVE_INTERVAL_MS = 500;

// Readout colours: the same tokens the canvases use (emerald / amber / rose / zinc).
const C_OK = '#34d399';
const C_HOT = '#fb7185';
const C_LOW = '#fbbf24';
const C_NEUTRAL = '#f4f4f5';
const C_DIM = '#71717a';

/** Colour a LUFS reading against the target: within ±1 LU ok, hot above, quiet below. */
const targetColor = (v: number, target: number): string => {
  if (!Number.isFinite(v)) return C_DIM;
  const d = v - target;
  return d > 1 ? C_HOT : d < -1 ? C_LOW : C_OK;
};

const writeText = (el: HTMLElement | null, text: string): void => {
  if (el && el.textContent !== text) el.textContent = text;
};
const writeColor = (el: HTMLElement | null, color: string): void => {
  if (el) el.style.color = color;
};
const writeFlag = (el: HTMLElement | null, name: string, on: boolean): void => {
  if (el && el.hasAttribute(name) !== on) el.toggleAttribute(name, on);
};

const LABEL_CLS = 'text-[11px] font-mono uppercase tracking-widest text-zinc-500';
const HEADER_CLS = 'h-8 shrink-0 flex items-center gap-2 px-3 border-b border-white/5';
const HEADER_TITLE_CLS = 'text-[11px] font-mono uppercase tracking-widest text-zinc-400';
const HEADER_NOTE_CLS = 'text-[11px] font-mono text-zinc-600';
const NUM_INPUT_CLS =
  'w-14 bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-zinc-200 focus:outline-none focus:border-purple-400/40';
const LED_CLS =
  'h-4 rounded-sm border border-white/10 bg-white/5 text-[11px] font-mono font-bold leading-none text-zinc-500 transition-colors data-lit:border-red-400 data-lit:bg-red-500 data-lit:text-white data-lit:shadow-[0_0_8px_rgba(239,68,68,0.65)]';
const HOLD_CLS =
  'h-4 rounded-sm text-[11px] font-mono tabular-nums leading-none text-zinc-300 hover:text-white hover:bg-white/5 data-hot:text-red-400';
/** Mirrors METER_SCALE_W / METER_GAP / METER_PAD_R in levelsViews.ts. */
const METER_ROW_CLS = 'grid grid-cols-[2.25rem_1fr_1fr] gap-x-1 pr-1.5 items-center shrink-0';

interface FittedCanvas {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  boxRef: React.MutableRefObject<CanvasBox | null>;
}

/** A canvas that tracks its wrapper's size (DPR- and zoom-aware). */
function useFittedCanvas(): FittedCanvas {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<CanvasBox | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    const cnv = canvasRef.current;
    if (!wrap || !cnv) return;
    // The canvas is `absolute inset-0`, so it needs an inline size, written in
    // local css px (a rect width would be zoomed twice under the shell zoom).
    const ro = new ResizeObserver(() => {
      boxRef.current = fitCanvas(cnv, wrap, { style: true });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);
  return { wrapRef, canvasRef, boxRef };
}

function paintCanvas(c: FittedCanvas, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
  const cnv = c.canvasRef.current;
  const box = c.boxRef.current;
  const ctx = cnv?.getContext('2d');
  if (!cnv || !box || !ctx) return;
  ctx.save();
  scaleContextToBox(ctx, box);
  draw(ctx, box.cssWidth, box.cssHeight);
  ctx.restore();
}

/** Labelled numeric field that commits only finite in-range values while typing. */
const NumberField: React.FC<{
  id: string;
  label: string;
  labelHidden?: boolean;
  value: number;
  step: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}> = ({ id, label, labelHidden, value, step, min, max, onCommit }) => {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <>
      <label htmlFor={id} className={labelHidden ? 'sr-only' : LABEL_CLS}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(value));
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const v = Number(raw);
          if (raw.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) onCommit(v);
        }}
        className={NUM_INPUT_CLS}
      />
    </>
  );
};

/** One loudness readout: label, large tabular numeric (written by the loop), unit, sub-line. */
const Tile: React.FC<{
  label: string;
  unit: string;
  valueRef: React.Ref<HTMLSpanElement>;
  subRef?: React.Ref<HTMLSpanElement>;
  sub?: string;
  emphasis?: boolean;
}> = ({ label, unit, valueRef, subRef, sub, emphasis }) => (
  <div
    className={`min-w-0 flex flex-col justify-center px-3 py-1 bg-[#0b0912] overflow-hidden ${
      emphasis ? 'shadow-[inset_3px_0_0_0_rgba(168,85,247,0.6)]' : ''
    }`}
  >
    <span className={`${LABEL_CLS} truncate`}>{label}</span>
    <span className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
      {/* Scales with the tile grid's height (size container): 24px in the normal dock, up to 48px maximised. */}
      <span
        ref={valueRef}
        className="font-mono tabular-nums text-[clamp(1.5rem,11cqh,3rem)] leading-tight text-zinc-100 truncate"
      >
        —
      </span>
      <span className="text-[11px] font-mono text-zinc-600 shrink-0">{unit}</span>
    </span>
    <span ref={subRef} className="text-[11px] font-mono tabular-nums text-zinc-600 mt-1 truncate h-4 leading-4">
      {sub ?? ''}
    </span>
  </div>
);

export const LevelsPanel: React.FC = () => {
  const lufsTarget = useLevelsStore((s) => s.lufsTarget);
  const lufsPreset = useLevelsStore((s) => s.lufsPreset);
  const truePeakCeiling = useLevelsStore((s) => s.truePeakCeiling);
  const setLufsTarget = useLevelsStore((s) => s.setLufsTarget);
  const setLufsPreset = useLevelsStore((s) => s.setLufsPreset);
  const setTruePeakCeiling = useLevelsStore((s) => s.setTruePeakCeiling);

  const [fallback, setFallback] = useState(false);

  // Ballistics live for the panel's lifetime, outside React state.
  const [model] = useState(() => ({ left: new BarMeter(), right: new BarMeter(), stereo: new StereoMeter() }));

  const rootRef = useRef<HTMLDivElement>(null);
  const meters = useFittedCanvas();
  const hist = useFittedCanvas();
  const stereoCanvas = useFittedCanvas();

  // DOM readouts written by the loop (never via React state).
  const ledL = useRef<HTMLButtonElement>(null);
  const ledR = useRef<HTMLButtonElement>(null);
  const holdL = useRef<HTMLButtonElement>(null);
  const holdR = useRef<HTMLButtonElement>(null);
  const mRef = useRef<HTMLSpanElement>(null);
  const sRef = useRef<HTMLSpanElement>(null);
  const iRef = useRef<HTMLSpanElement>(null);
  const lraRef = useRef<HTMLSpanElement>(null);
  const tpRef = useRef<HTMLSpanElement>(null);
  const tpMaxRef = useRef<HTMLSpanElement>(null);
  const deltaRef = useRef<HTMLSpanElement>(null);
  const liveMeters = useRef<HTMLParagraphElement>(null);
  const liveHist = useRef<HTMLParagraphElement>(null);
  const liveStereo = useRef<HTMLParagraphElement>(null);

  // Refs so the loop reads the latest target / ceiling without re-subscribing.
  const stateRef = useRef({ lufsTarget, truePeakCeiling });
  stateRef.current = { lufsTarget, truePeakCeiling };

  useEffect(() => {
    let alive = true;
    ensureMeter()
      .then(() => {
        if (alive) setFallback(!isWorkletMeter());
      })
      .catch(() => {
        if (alive) setFallback(true);
      });
    return () => {
      alive = false;
      disposeMeter();
    };
  }, []);

  const resetClips = useCallback(() => {
    model.left.resetHold();
    model.right.resetHold();
  }, [model]);

  const onReset = useCallback(() => {
    resetMeter();
    resetClips();
  }, [resetClips]);

  // Single paint loop: ≤60 fps, paused while the document or the panel is hidden.
  useEffect(() => {
    const { left, right, stereo } = model;
    let raf = 0;
    let lastPaint = 0;
    let lastText = 0;
    let lastLive = 0;
    let docVisible = typeof document === 'undefined' ? true : !document.hidden;
    let onScreen = true;

    const tick = (now: number): void => {
      raf = 0;
      if (!docVisible || !onScreen) return; // paused; a visibility handler restarts it
      raf = requestAnimationFrame(tick);
      if (now - lastPaint < MAX_FPS_INTERVAL_MS) return;
      const dt = lastPaint ? Math.min(0.1, (now - lastPaint) / 1000) : 1 / 60;
      lastPaint = now;

      const ch = sampleChannelLevels();
      if (ch) {
        left.update(ch.peakL, ch.rmsL, dt);
        right.update(ch.peakR, ch.rmsR, dt);
        stereo.update(ch.correlation, ch.rmsL, ch.rmsR, dt);
      } else {
        left.update(0, 0, dt);
        right.update(0, 0, dt);
      }
      const frame = getLevelsFrame();
      const { lufsTarget: target, truePeakCeiling: ceiling } = stateRef.current;

      paintCanvas(meters, (ctx, w, h) => drawBarMeters({ ctx, w, h, left, right }));
      paintCanvas(hist, (ctx, w, h) => drawLoudnessHistory({ ctx, w, h, history: getLoudnessHistory(), target }));
      paintCanvas(stereoCanvas, (ctx, w, h) => drawStereoMeters({ ctx, w, h, stereo }));

      if (now - lastText >= TEXT_INTERVAL_MS) {
        lastText = now;
        const worklet = isWorkletMeter();
        const m = frame?.momentary ?? NaN;
        const s = frame?.short ?? NaN;
        const i = frame?.integrated ?? NaN;
        writeText(mRef.current, fmtLevel(m));
        writeText(sRef.current, fmtLevel(s));
        writeColor(sRef.current, targetColor(s, target));
        writeText(iRef.current, fmtLevel(i));
        writeColor(iRef.current, targetColor(i, target));
        const delta = Number.isFinite(i) ? i - target : NaN;
        writeText(deltaRef.current, Number.isFinite(delta) ? fmtSigned(delta) : '—');
        writeColor(deltaRef.current, targetColor(i, target));
        writeText(lraRef.current, frame && Number.isFinite(i) ? frame.lra.toFixed(1) : '—');

        if (worklet) {
          const tp = frame?.truePeakDb ?? NaN;
          const tpMax = getMeterHolds().maxTruePeakDb;
          writeText(tpRef.current, fmtLevel(tp, true));
          writeColor(tpRef.current, tp > ceiling ? C_HOT : C_NEUTRAL);
          writeText(tpMaxRef.current, `max ${fmtLevel(tpMax, true)}`);
          writeColor(tpMaxRef.current, tpMax > ceiling ? C_HOT : C_DIM);
        } else {
          const sp = Math.max(left.peakDb, right.peakDb);
          const spMax = Math.max(left.maxDb, right.maxDb);
          writeText(tpRef.current, fmtLevel(sp, true));
          writeColor(tpRef.current, sp > ceiling ? C_HOT : C_NEUTRAL);
          writeText(tpMaxRef.current, `max ${fmtLevel(spMax, true)} (sample)`);
          writeColor(tpMaxRef.current, spMax > ceiling ? C_HOT : C_DIM);
        }

        writeFlag(ledL.current, 'data-lit', left.clipped);
        writeFlag(ledR.current, 'data-lit', right.clipped);
        writeText(holdL.current, fmtLevel(left.maxDb, true));
        writeText(holdR.current, fmtLevel(right.maxDb, true));
        writeFlag(holdL.current, 'data-hot', left.clipped);
        writeFlag(holdR.current, 'data-hot', right.clipped);
      }

      if (now - lastLive >= LIVE_INTERVAL_MS) {
        lastLive = now;
        const clip = left.clipped || right.clipped ? ', clipping' : '';
        writeText(
          liveMeters.current,
          `Left ${fmtLevel(left.peakDb)} dBFS, right ${fmtLevel(right.peakDb)} dBFS${clip}`,
        );
        writeText(
          liveHist.current,
          `Short-term ${fmtLevel(frame?.short ?? NaN)} LUFS, integrated ${fmtLevel(frame?.integrated ?? NaN)} LUFS, target ${target} LUFS`,
        );
        writeText(
          liveStereo.current,
          `Correlation ${fmtSigned(stereo.correlation, 2)}, balance ${fmtBalance(stereo.balanceDb)}`,
        );
      }
    };

    const start = (): void => {
      if (!raf && docVisible && onScreen) {
        lastPaint = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    const onVisibility = (): void => {
      docVisible = !document.hidden;
      start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const root = rootRef.current;
    const io =
      root && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            start();
          })
        : null;
    if (root && io) io.observe(root);
    start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [model, meters, hist, stereoCanvas]);

  return (
    <div ref={rootRef} className="absolute inset-0 flex bg-[#0b0912] text-zinc-300 select-none overflow-hidden">
      {/* ── Stereo bar meters ─────────────────────────────────────────── */}
      <section aria-label="Stereo peak meters" className="w-30 shrink-0 flex flex-col border-r border-white/5">
        <header className={`${HEADER_CLS} justify-between px-2`}>
          <span className={HEADER_TITLE_CLS}>Peak</span>
          <span className={HEADER_NOTE_CLS}>dBFS</span>
        </header>
        <div className={`${METER_ROW_CLS} pt-1.5`}>
          <span className="text-[10px] font-mono text-zinc-600 text-right pr-1.5">clip</span>
          <button
            ref={ledL}
            type="button"
            onClick={resetClips}
            className={LED_CLS}
            aria-label="Left channel clip indicator; click to reset"
            title="Left clip indicator — click to reset"
          >
            L
          </button>
          <button
            ref={ledR}
            type="button"
            onClick={resetClips}
            className={LED_CLS}
            aria-label="Right channel clip indicator; click to reset"
            title="Right clip indicator — click to reset"
          >
            R
          </button>
        </div>
        <div ref={meters.wrapRef} className="flex-1 min-h-0 relative">
          <canvas
            ref={meters.canvasRef}
            role="img"
            aria-label="Stereo peak and RMS bar meters, left and right, in dBFS"
            className="absolute inset-0"
          />
        </div>
        <div className={`${METER_ROW_CLS} pb-1.5`}>
          <span className="text-[10px] font-mono text-zinc-600 text-right pr-1.5">max</span>
          <button
            ref={holdL}
            type="button"
            onClick={resetClips}
            className={HOLD_CLS}
            aria-label="Left peak hold; click to reset"
            title="Left peak hold — click to reset"
          >
            -∞
          </button>
          <button
            ref={holdR}
            type="button"
            onClick={resetClips}
            className={HOLD_CLS}
            aria-label="Right peak hold; click to reset"
            title="Right peak hold — click to reset"
          >
            -∞
          </button>
        </div>
        <p ref={liveMeters} className="sr-only" aria-live="polite" aria-atomic="true" />
      </section>

      {/* ── Loudness ──────────────────────────────────────────────────── */}
      <section aria-label="Loudness" className="flex-1 min-w-0 flex flex-col border-r border-white/5">
        <header className={`${HEADER_CLS} overflow-hidden`}>
          <span className={HEADER_TITLE_CLS}>Loudness</span>
          <span className={HEADER_NOTE_CLS}>LUFS</span>
          {fallback && (
            <span
              className="text-[11px] font-mono text-amber-400/80"
              title="AudioWorklet unavailable — RMS/peak only, no LUFS or true peak"
            >
              RMS only
            </span>
          )}
          <div className="flex-1" />
          <label htmlFor="levels-target-preset" className={LABEL_CLS}>
            Target
          </label>
          <select
            id="levels-target-preset"
            name="levels-target-preset"
            value={lufsPreset}
            onChange={(e) => setLufsPreset(e.target.value as LufsPresetId)}
            className="form-select px-1.5 py-0.5 text-[11px] font-mono tabular-nums"
          >
            {LUFS_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.lufs === null ? p.label : `${p.label} ${p.lufs}`}
              </option>
            ))}
          </select>
          {lufsPreset === 'custom' && (
            <NumberField
              id="levels-target-custom"
              label="Custom target in LUFS"
              labelHidden
              value={lufsTarget}
              step={0.5}
              min={LUFS_TARGET_MIN}
              max={LUFS_TARGET_MAX}
              onCommit={setLufsTarget}
            />
          )}
          <NumberField
            id="levels-tp-ceiling"
            label="Ceiling"
            value={truePeakCeiling}
            step={0.1}
            min={TP_CEILING_MIN}
            max={TP_CEILING_MAX}
            onCommit={setTruePeakCeiling}
          />
          <span className={HEADER_NOTE_CLS}>dBTP</span>
          <button
            type="button"
            onClick={onReset}
            className="px-2 py-0.5 rounded border border-white/10 bg-white/5 hover:bg-white/10 text-[11px] font-mono uppercase tracking-widest text-zinc-300 hover:text-white transition-colors"
            title="Restart the integrated measurement and clear the max holds, history and clip indicators"
          >
            Reset
          </button>
        </header>
        <div className="flex-1 min-h-0 grid grid-cols-3 grid-rows-2 gap-px bg-white/5 @container-size">
          <Tile label="Momentary" unit="LUFS" valueRef={mRef} sub="400 ms" />
          <Tile label="Short-term" unit="LUFS" valueRef={sRef} sub="3 s" />
          <Tile label="Integrated" unit="LUFS" valueRef={iRef} sub="gated, since reset" emphasis />
          <Tile label="Range" unit="LU" valueRef={lraRef} sub="LRA" />
          <Tile
            label={fallback ? 'Sample peak' : 'True peak'}
            unit={fallback ? 'dBFS' : 'dBTP'}
            valueRef={tpRef}
            subRef={tpMaxRef}
          />
          <Tile label="vs target" unit="LU" valueRef={deltaRef} sub={`integrated − ${lufsTarget} LUFS`} />
        </div>
      </section>

      {/* ── History + stereo ──────────────────────────────────────────── */}
      <section aria-label="Loudness history and stereo image" className="flex-1 min-w-0 flex flex-col">
        <header className={HEADER_CLS}>
          <span className={HEADER_TITLE_CLS}>Short-term</span>
          <span className={HEADER_NOTE_CLS}>last 60 s</span>
          <div className="flex-1" />
          <span className="text-[11px] font-mono tabular-nums text-purple-300">target {lufsTarget} LUFS</span>
        </header>
        <div ref={hist.wrapRef} className="flex-1 min-h-0 relative">
          <canvas
            ref={hist.canvasRef}
            role="img"
            aria-label="Short-term loudness over the last 60 seconds against the target"
            className="absolute inset-0"
          />
        </div>
        <p ref={liveHist} className="sr-only" aria-live="polite" aria-atomic="true" />
        <header className="h-7 shrink-0 flex items-center gap-2 px-3 border-y border-white/5">
          <span className={HEADER_TITLE_CLS}>Stereo</span>
          <span className={HEADER_NOTE_CLS}>correlation · balance</span>
        </header>
        <div ref={stereoCanvas.wrapRef} className="h-20 shrink-0 relative">
          <canvas
            ref={stereoCanvas.canvasRef}
            role="img"
            aria-label="Stereo correlation from minus one to plus one, and left-right balance"
            className="absolute inset-0"
          />
        </div>
        <p ref={liveStereo} className="sr-only" aria-live="polite" aria-atomic="true" />
      </section>
    </div>
  );
};
