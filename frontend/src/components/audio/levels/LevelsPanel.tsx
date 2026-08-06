/**
 * Levels tab — master loudness / peak / stereo metering. A single AudioWorklet
 * (levels-meter.js), fanned non-destructively off the master gain, feeds all
 * six views. The active view is painted on one <canvas> by a single rAF loop
 * reading the module-scope readings frame (never through React), so metering
 * never re-renders the tree.
 *
 * Meters whatever is audible on any tab (MAKE / EDIT / DJ / Sequencer / …),
 * because they all route through the shared master gain.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, Volume2, Activity, Waves, Radar, BarChart3 } from 'lucide-react';
import {
  useLevelsStore,
  ensureMeter,
  disposeMeter,
  getLevelsFrame,
  isWorkletMeter,
  type LevelsView,
} from '../../../state/levelsStore';
import { fitCanvas, scaleContextToBox, type CanvasBox } from '../../../lib/canvasScale';
import {
  drawRadial,
  drawLufs,
  drawPeak,
  drawDynamicRange,
  drawStereo,
  drawBass,
  type ViewCtx,
} from './levelsViews';

const VIEWS: Array<{ id: LevelsView; icon: React.ComponentType<{ className?: string }>; title: string }> = [
  { id: 'radial', icon: Gauge, title: 'Radial — combined readout' },
  { id: 'lufs', icon: Volume2, title: 'LUFS — loudness' },
  { id: 'peak', icon: Activity, title: 'Peak — sample + true peak' },
  { id: 'dr', icon: Waves, title: 'Dynamic Range' },
  { id: 'stereo', icon: Radar, title: 'Stereo field + correlation' },
  { id: 'bass', icon: BarChart3, title: 'Bass Space — low-end bands' },
];

const LUFS_TARGETS = [-14, -16, -23];

const PAINTERS: Record<LevelsView, (v: ViewCtx) => void> = {
  radial: drawRadial,
  lufs: drawLufs,
  peak: drawPeak,
  dr: drawDynamicRange,
  stereo: drawStereo,
  bass: drawBass,
};

export const LevelsPanel: React.FC = () => {
  const view = useLevelsStore((s) => s.view);
  const setView = useLevelsStore((s) => s.setView);
  const lufsTarget = useLevelsStore((s) => s.lufsTarget);
  const setLufsTarget = useLevelsStore((s) => s.setLufsTarget);
  const truePeakCeiling = useLevelsStore((s) => s.truePeakCeiling);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Last measured geometry, shared from the resize observer to the rAF loop so
  // the painters keep working in local css px without re-measuring per frame.
  const boxRef = useRef<CanvasBox | null>(null);
  const [fallback, setFallback] = useState(false);

  // Refs so the rAF loop reads the latest view/target without re-subscribing.
  const stateRef = useRef({ view, lufsTarget, truePeakCeiling });
  stateRef.current = { view, lufsTarget, truePeakCeiling };

  useEffect(() => {
    void ensureMeter().then(() => setFallback(!isWorkletMeter()));
    return () => disposeMeter();
  }, []);

  // Size the canvas to its container (DPR- and zoom-aware). The canvas is only
  // `absolute inset-0`, so it does need an inline size, but that size has to be
  // written in local css px: a rect width would be zoomed twice and leave the
  // meters covering a fraction of the panel.
  useEffect(() => {
    const wrap = wrapRef.current;
    const cnv = canvasRef.current;
    if (!wrap || !cnv) return;
    const ro = new ResizeObserver(() => {
      boxRef.current = fitCanvas(cnv, wrap, { style: true });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Single rAF paint loop.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const cnv = canvasRef.current;
      const ctx = cnv?.getContext('2d');
      const box = boxRef.current;
      if (cnv && ctx && box) {
        const w = box.cssWidth;
        const h = box.cssHeight;
        ctx.save();
        scaleContextToBox(ctx, box);
        const frame = getLevelsFrame();
        if (frame) {
          const st = stateRef.current;
          PAINTERS[st.view]({ ctx, w, h, frame, lufsTarget: st.lufsTarget, truePeakCeiling: st.truePeakCeiling });
        } else {
          ctx.fillStyle = '#0b0912';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = '#7a7390';
          ctx.font = '10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText('waiting for audio…', w / 2, h / 2);
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const showTarget = useMemo(() => view === 'lufs' || view === 'radial', [view]);

  return (
    <div className="absolute inset-0 flex flex-col bg-[#0b0912]">
      {/* Switcher + target */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/5 shrink-0">
        {VIEWS.map((vw) => {
          const Icon = vw.icon;
          const active = view === vw.id;
          return (
            <button
              key={vw.id}
              onClick={() => setView(vw.id)}
              title={vw.title}
              aria-label={vw.title}
              aria-pressed={active}
              className={`w-7 h-7 grid place-items-center rounded-full border transition-colors ${
                active ? 'border-purple-500/60 bg-purple-500/15 text-purple-200' : 'border-white/10 text-zinc-500 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          );
        })}

        {showTarget && (
          <div className="flex items-center gap-1 ml-2">
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">target</span>
            {LUFS_TARGETS.map((t) => (
              <button
                key={t}
                onClick={() => setLufsTarget(t)}
                aria-pressed={lufsTarget === t}
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition-colors ${
                  lufsTarget === t ? 'border-purple-500/50 bg-purple-500/15 text-purple-200' : 'border-white/10 text-zinc-500 hover:text-white hover:bg-white/5'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1" />
        {fallback && (
          <span className="text-[8px] font-mono text-amber-400/80" title="AudioWorklet unavailable — RMS/peak only, no gated LUFS">
            RMS only
          </span>
        )}
      </div>

      {/* Meter canvas */}
      <div ref={wrapRef} className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="absolute inset-0" />
      </div>
    </div>
  );
};
