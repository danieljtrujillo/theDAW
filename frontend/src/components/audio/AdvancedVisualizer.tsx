import React, { useEffect, useRef, useState } from 'react';
import { Zap, Target, Maximize2, Settings2 } from 'lucide-react';
import { getAnalyser, getEngineCtx, samplePeakAndRMS } from '../../state/playerStore';

type Mode = 'oscilloscope' | 'spectrum' | 'radial';

const formatDb = (db: number): string => {
  if (!Number.isFinite(db)) return '−∞';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
};

export const AdvancedVisualizer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const [mode, setMode] = useState<Mode>('spectrum');
  const [peakDb, setPeakDb] = useState(-Infinity);
  const [rmsDb, setRmsDb] = useState(-Infinity);
  const [ctxInfo, setCtxInfo] = useState<{ sr: number; fft: number }>({ sr: 44100, fft: 2048 });

  // Resize the canvas to its container, accounting for device pixel ratio.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapperRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Render loop — reads from the shared engine analyser.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const analyser = getAnalyser();
    const engineCtx = getEngineCtx();
    setCtxInfo({ sr: engineCtx.sampleRate, fft: analyser.fftSize });

    const timeBuf = new Uint8Array(analyser.fftSize);
    const freqBuf = new Uint8Array(analyser.frequencyBinCount);
    let hudCounter = 0;

    const render = () => {
      rafRef.current = requestAnimationFrame(render);
      const w = canvas.width;
      const h = canvas.height;

      // Fully clear each frame so the grid background div behind the canvas
      // remains visible (no opaque trail buildup).
      ctx2d.clearRect(0, 0, w, h);

      if (mode === 'oscilloscope') {
        analyser.getByteTimeDomainData(timeBuf);
        ctx2d.lineWidth = 1.5;
        ctx2d.strokeStyle = '#8b5cf6';
        ctx2d.shadowBlur = 8;
        ctx2d.shadowColor = '#8b5cf6';
        ctx2d.beginPath();
        const step = w / timeBuf.length;
        for (let i = 0; i < timeBuf.length; i += 1) {
          const v = (timeBuf[i] - 128) / 128;
          const x = i * step;
          const y = h / 2 + v * (h / 2 - 4);
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
      } else if (mode === 'spectrum') {
        analyser.getByteFrequencyData(freqBuf);
        // Use a log-ish frequency axis: most musical info is below ~8kHz.
        const usableBins = Math.min(freqBuf.length, Math.floor(freqBuf.length * 0.6));
        const barCount = Math.min(96, usableBins);
        const barWidth = w / barCount;
        for (let i = 0; i < barCount; i += 1) {
          // Log-ish mapping from bar index to bin index.
          const t = i / barCount;
          const binIdx = Math.floor(Math.pow(t, 1.6) * (usableBins - 1));
          const mag = freqBuf[binIdx] / 255;
          const barH = Math.max(1, mag * (h - 4));
          const x = i * barWidth;
          const grad = ctx2d.createLinearGradient(0, h, 0, h - barH);
          grad.addColorStop(0, '#7c3aed');
          grad.addColorStop(1, '#c4b5fd');
          ctx2d.fillStyle = grad;
          ctx2d.fillRect(x + 0.5, h - barH, Math.max(1, barWidth - 1), barH);
        }
      } else {
        analyser.getByteFrequencyData(freqBuf);
        const cx = w / 2;
        const cy = h / 2;
        const baseR = Math.min(w, h) * 0.18;
        const segs = Math.min(180, freqBuf.length);
        ctx2d.strokeStyle = '#a78bfa';
        ctx2d.lineWidth = 1;
        ctx2d.shadowBlur = 6;
        ctx2d.shadowColor = '#8b5cf6';
        ctx2d.beginPath();
        for (let i = 0; i <= segs; i += 1) {
          const t = i / segs;
          const binIdx = Math.floor(Math.pow(t, 1.4) * (freqBuf.length - 1));
          const mag = freqBuf[binIdx] / 255;
          const r = baseR + mag * (Math.min(w, h) * 0.32);
          const ang = (i / segs) * Math.PI * 2;
          const x = cx + Math.cos(ang) * r;
          const y = cy + Math.sin(ang) * r;
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.closePath();
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
      }

      // HUD numbers — sample every ~5 frames to avoid React thrash.
      hudCounter += 1;
      if (hudCounter % 5 === 0) {
        const { peakDb: pd, rmsDb: rd } = samplePeakAndRMS();
        setPeakDb(pd);
        setRmsDb(rd);
      }
    };

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mode]);

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 relative overflow-hidden group">
      {/* Background Grid */}
      <div className="absolute inset-0 opacity-[0.07] pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)`,
          backgroundSize: '20px 20px'
        }}
      />

      <div className="flex items-center justify-end p-2 border-b border-white/5 bg-black/20 z-10">
        <div className="flex gap-1">
          {(['oscilloscope', 'spectrum', 'radial'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`p-1 px-1.5 rounded text-[8px] uppercase font-black transition-colors ${mode === m ? 'bg-purple-600 text-white' : 'text-zinc-600 hover:text-zinc-400'}`}
              title={m}
            >
              {m.charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div ref={wrapperRef} className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

        {/* Overlay HUD */}
        <div className="absolute top-2 left-2 flex flex-col gap-1 opacity-70 group-hover:opacity-100 transition-opacity pointer-events-none">
          <div className="flex items-center gap-2 bg-black/60 px-1.5 py-0.5 rounded border border-white/5">
            <Zap className="w-2.5 h-2.5 text-yellow-500" />
            <span className="text-[7px] font-mono text-zinc-400 tabular-nums">
              RMS: {formatDb(rmsDb)} dB
            </span>
          </div>
          <div className="flex items-center gap-2 bg-black/60 px-1.5 py-0.5 rounded border border-white/5">
            <Target className="w-2.5 h-2.5 text-emerald-500" />
            <span className="text-[7px] font-mono text-zinc-400 tabular-nums">
              PEAK: {formatDb(peakDb)} dB
            </span>
          </div>
        </div>

        <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button className="p-1 hover:bg-white/10 rounded text-zinc-600 transition-colors"><Settings2 className="w-3 h-3" /></button>
          <button className="p-1 hover:bg-white/10 rounded text-zinc-600 transition-colors"><Maximize2 className="w-3 h-3" /></button>
        </div>
      </div>

      <div className="h-4 border-t border-white/5 bg-black/60 flex items-center justify-between px-2">
        <span className="text-[7px] font-mono text-zinc-700 uppercase italic">
          {(ctxInfo.sr / 1000).toFixed(1)} kHz · FFT {ctxInfo.fft}
        </span>
        <div className="flex items-center gap-1">
          <div className={`w-1 h-1 rounded-full ${peakDb > -60 ? 'bg-purple-500 animate-pulse' : 'bg-zinc-700'}`} />
          <span className="text-[7px] font-mono text-purple-300 font-black uppercase">
            {peakDb > -60 ? 'LIVE' : 'SILENT'}
          </span>
        </div>
      </div>
    </div>
  );
};
