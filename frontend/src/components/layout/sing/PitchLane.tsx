import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff } from 'lucide-react';
import { fetchVocalArtifact, type VocalArtifactDoc } from '../../../lib/vocalExport';
import { listAudioInputs } from '../../../lib/vocalToMidi';
import { pollVocalJob } from '../../../lib/lyricsClient';
import { useLyricsStore } from '../../../state/lyricsStore';
import { logError } from '../../../state/logStore';
import { LineScore, MIN_CLARITY, scoreFrame } from './singSync';
import { FrameRing, startSingMic, type SingMic } from './singPitch';

export interface PitchLaneProps {
  entryId: string;
  /** Song position now, ms (offset applied). */
  getPosMs: () => number;
  /** The scroller's active doc line, for per-line scoring. */
  activeLineRef: React.MutableRefObject<number>;
}

const MIC_DEVICE_KEY = 'vocal.inputDeviceId';
const WINDOW_BEFORE_MS = 1200;
const WINDOW_AFTER_MS = 2800;
const PLAYHEAD_POS = 0.3;
const SEMITONE_RANGE = 12;
const RMS_GATE = 0.08;

interface Targets {
  starts: Float64Array;
  ends: Float64Array;
  pitches: Float64Array;
}

const buildTargets = (doc: VocalArtifactDoc): Targets => {
  const notes = [...doc.notes].sort((a, b) => a.start_ms - b.start_ms);
  return {
    starts: Float64Array.from(notes, (n) => n.start_ms),
    ends: Float64Array.from(notes, (n) => n.end_ms),
    pitches: Float64Array.from(notes, (n) => n.pitch),
  };
};

/** Index of the note covering posMs, or -1. */
const noteAt = (t: Targets, posMs: number): number => {
  let lo = 0;
  let hi = t.starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.starts[mid] <= posMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && posMs <= t.ends[found] ? found : -1;
};

const median = (values: number[]): number => {
  if (!values.length) return 60;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * The pitch lane: the analyzed vocal's notes scroll past a playhead as the
 * target melody, the microphone's YIN pitch is drawn over them, and every
 * voiced frame inside a target note is judged within ±50 cents (octave
 * folded). Canvas 2D, own rAF loop, no React state per frame.
 */
export const PitchLane: React.FC<PitchLaneProps> = ({ entryId, getPosMs, activeLineRef }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [artifact, setArtifact] = useState<VocalArtifactDoc | null | 'loading'>('loading');
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => {
    try {
      return localStorage.getItem(MIC_DEVICE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [micError, setMicError] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const micOn = useLyricsStore((s) => s.micOn);
  const setMicOn = useLyricsStore((s) => s.setMicOn);
  const micOffsetMs = useLyricsStore((s) => s.micOffsetMs);
  const setMicOffsetMs = useLyricsStore((s) => s.setMicOffsetMs);

  const targetsRef = useRef<Targets | null>(null);
  const f0Ref = useRef<{ hopMs: number; hz: number[]; voiced: boolean[] } | null>(null);
  const ringRef = useRef(new FrameRing(WINDOW_BEFORE_MS + WINDOW_AFTER_MS));
  const scoreRef = useRef(new LineScore());
  const micRef = useRef<SingMic | null>(null);
  const micOffsetRef = useRef(micOffsetMs);
  micOffsetRef.current = micOffsetMs;
  const getPosRef = useRef(getPosMs);
  getPosRef.current = getPosMs;

  const loadArtifact = useCallback(async () => {
    setArtifact('loading');
    try {
      const doc = await fetchVocalArtifact(entryId);
      setArtifact(doc);
      targetsRef.current = doc ? buildTargets(doc) : null;
      f0Ref.current = doc?.f0 ? { hopMs: doc.f0.hop_ms, hz: doc.f0.hz, voiced: doc.f0.voiced } : null;
      scoreRef.current.reset();
      ringRef.current.clear();
    } catch (e) {
      setArtifact(null);
      logError('sing', `Vocal artifact load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [entryId]);

  useEffect(() => {
    void loadArtifact();
  }, [loadArtifact]);

  useEffect(() => {
    listAudioInputs().then(setDevices).catch(() => setDevices([]));
  }, []);

  const analyzeMelody = async () => {
    if (analyzing) return;
    setAnalyzing('starting');
    try {
      const res = await fetch('/api/vocal/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: entryId, isolate: true, transcribe: false }),
      });
      if (!res.ok) throw new Error(`prepare HTTP ${res.status}`);
      const payload = (await res.json()) as { job?: { id?: string }; job_id?: string; id?: string };
      const jobId = payload.job?.id ?? payload.job_id ?? payload.id;
      if (!jobId) throw new Error('prepare: no job id');
      const job = await pollVocalJob(jobId, (j) => setAnalyzing(j.message || j.status));
      if (job.status !== 'done') throw new Error(job.error || job.message || 'analysis failed');
      await loadArtifact();
    } catch (e) {
      logError('sing', `Melody analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAnalyzing(null);
    }
  };

  // Microphone lifecycle follows the MIC ON toggle and the chosen device.
  useEffect(() => {
    if (!micOn) {
      micRef.current?.stop();
      micRef.current = null;
      return;
    }
    let cancelled = false;
    setMicError(null);
    startSingMic(
      deviceId || undefined,
      () => getPosRef.current(),
      () => micOffsetRef.current,
      (frame) => {
        ringRef.current.push(frame);
        const targets = targetsRef.current;
        if (!targets || frame.clarity < MIN_CLARITY) return;
        const peak = Math.max(ringRef.current.peakRms, 1e-6);
        if (frame.rms < RMS_GATE * peak) return;
        const n = noteAt(targets, frame.songMs);
        if (n < 0) return;
        scoreRef.current.add(activeLineRef.current, scoreFrame(frame.midi, targets.pitches[n]).hit);
      },
    )
      .then((mic) => {
        if (cancelled) {
          mic.stop();
          return;
        }
        micRef.current = mic;
      })
      .catch((e) => {
        if (cancelled) return;
        setMicError(e instanceof Error ? e.message : String(e));
        setMicOn(false);
      });
    return () => {
      cancelled = true;
      micRef.current?.stop();
      micRef.current = null;
    };
  }, [micOn, deviceId, activeLineRef, setMicOn]);

  // Drawing loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let lastLive = 0;
    const size = { w: 0, h: 0, dpr: 1 };
    const fit = () => {
      const rect = wrap.getBoundingClientRect();
      size.dpr = window.devicePixelRatio || 1;
      size.w = Math.max(1, Math.floor(rect.width));
      size.h = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(size.w * size.dpr);
      canvas.height = Math.floor(size.h * size.dpr);
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { w, h, dpr } = size;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0a080f';
      ctx.fillRect(0, 0, w, h);
      const pos = getPosRef.current();
      const t0 = pos - WINDOW_BEFORE_MS;
      const t1 = pos + WINDOW_AFTER_MS;
      const xOf = (ms: number) => ((ms - t0) / (t1 - t0)) * w;
      const targets = targetsRef.current;

      // Pitch range: the median of the visible targets ± an octave.
      const visible: number[] = [];
      if (targets) {
        for (let i = 0; i < targets.starts.length; i += 1) {
          if (targets.ends[i] < t0) continue;
          if (targets.starts[i] > t1) break;
          visible.push(targets.pitches[i]);
        }
      }
      const centre = median(visible);
      const lo = centre - SEMITONE_RANGE;
      const hi = centre + SEMITONE_RANGE;
      const yOf = (midi: number) => h - ((midi - lo) / (hi - lo)) * h;

      // Octave lines.
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (let m = Math.ceil(lo); m <= hi; m += 1) {
        if (m % 12 !== 0) continue;
        const y = Math.round(yOf(m)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Target notes.
      if (targets) {
        const rowH = Math.max(4, h / (hi - lo));
        for (let i = 0; i < targets.starts.length; i += 1) {
          if (targets.ends[i] < t0) continue;
          if (targets.starts[i] > t1) break;
          const x0 = xOf(targets.starts[i]);
          const x1 = xOf(targets.ends[i]);
          const y = yOf(targets.pitches[i]) - rowH / 2;
          const sounding = targets.starts[i] <= pos && pos <= targets.ends[i];
          ctx.fillStyle = sounding ? 'rgba(251,113,133,0.85)' : 'rgba(168,85,247,0.45)';
          const r = Math.min(3, rowH / 2);
          ctx.beginPath();
          ctx.roundRect(x0, y, Math.max(2, x1 - x0), rowH, r);
          ctx.fill();
        }
      }

      // The analysed f0 curve, faint.
      const f0 = f0Ref.current;
      if (f0 && f0.hopMs > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let pen = false;
        const i0 = Math.max(0, Math.floor(t0 / f0.hopMs));
        const i1 = Math.min(f0.hz.length - 1, Math.ceil(t1 / f0.hopMs));
        for (let i = i0; i <= i1; i += 1) {
          const hz = f0.hz[i];
          if (!(hz > 0) || f0.voiced[i] === false) {
            pen = false;
            continue;
          }
          const x = xOf(i * f0.hopMs);
          const y = yOf(69 + 12 * Math.log2(hz / 440));
          if (pen) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          pen = true;
        }
        ctx.stroke();
      }

      // The sung trace, coloured by hit / miss.
      const frames = ringRef.current.slice(t0, pos);
      if (frames.length > 1) {
        ctx.lineWidth = 2;
        for (let i = 1; i < frames.length; i += 1) {
          const a = frames[i - 1];
          const b = frames[i];
          if (b.clarity < MIN_CLARITY || b.songMs - a.songMs > 200) continue;
          let hit = false;
          if (targets) {
            const n = noteAt(targets, b.songMs);
            hit = n >= 0 && scoreFrame(b.midi, targets.pitches[n]).hit;
          }
          ctx.strokeStyle = hit ? 'rgba(52,211,153,0.95)' : 'rgba(251,191,36,0.9)';
          ctx.beginPath();
          ctx.moveTo(xOf(a.songMs), yOf(a.midi));
          ctx.lineTo(xOf(b.songMs), yOf(b.midi));
          ctx.stroke();
        }
      }

      // Playhead.
      const px = Math.round(w * PLAYHEAD_POS) + 0.5;
      ctx.strokeStyle = 'rgba(251,113,133,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();

      // Score text.
      const total = scoreRef.current.total();
      const lineIdx = activeLineRef.current;
      const line = scoreRef.current.line(lineIdx);
      const text = total.frames
        ? `line ${Math.round(line.pct)}%  ·  total ${Math.round(total.pct)}%  ·  streak ${scoreRef.current.streak}`
        : targets
          ? micOn ? 'sing along…' : 'turn the mic on to score'
          : 'no melody analysed';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(text, 8, 14);
      const now = performance.now();
      if (now - lastLive > 1000) {
        lastLive = now;
        setLiveText(text);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [activeLineRef, micOn]);

  const chooseDevice = (id: string) => {
    setDeviceId(id);
    try {
      if (id) localStorage.setItem(MIC_DEVICE_KEY, id);
      else localStorage.removeItem(MIC_DEVICE_KEY);
    } catch {
      /* private mode */
    }
  };

  return (
    <div className="shrink-0 border-b border-white/10 bg-[#0a080f]">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-[9px] font-mono text-zinc-400">
        <span className="font-black uppercase tracking-widest text-rose-200">Pitch</span>
        {artifact === null && (
          <button
            type="button"
            className="btn-ghost text-[9px] py-0.5 px-1.5 border border-purple-500/40 text-purple-200 disabled:opacity-50"
            onClick={() => void analyzeMelody()}
            disabled={!!analyzing}
            title="Analyze the vocal (isolate + pitch + notes) so the lane has a target melody"
          >
            {analyzing ? <Loader2 className="inline w-3 h-3 animate-spin" /> : null} ANALYZE MELODY
          </button>
        )}
        {analyzing && <span className="text-zinc-500">{analyzing}</span>}
        <button
          type="button"
          className={`btn-ghost text-[9px] py-0.5 px-1.5 flex items-center gap-1 ${micOn ? 'border border-emerald-500/40 text-emerald-200' : ''}`}
          onClick={() => setMicOn(!micOn)}
          aria-pressed={micOn}
          title="Listen to the microphone and score the sung pitch"
        >
          {micOn ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />} MIC {micOn ? 'ON' : 'OFF'}
        </button>
        <label htmlFor="sing-mic" className="text-zinc-500">MIC</label>
        <select
          id="sing-mic"
          name="sing-mic"
          className="form-select text-[9px] px-1 py-0.5 max-w-40"
          value={deviceId}
          onChange={(e) => chooseDevice(e.target.value)}
        >
          <option value="">Default input</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Input ${d.deviceId.slice(0, 6)}`}</option>
          ))}
        </select>
        <label htmlFor="sing-mic-offset" className="text-zinc-500" title="Microphone latency compensation">MIC OFFSET ms</label>
        <input
          id="sing-mic-offset"
          name="sing-mic-offset"
          type="number"
          step={5}
          min={-200}
          max={400}
          value={micOffsetMs}
          onChange={(e) => setMicOffsetMs(Number(e.target.value) || 0)}
          className="w-14 form-select text-[9px] px-1 py-0.5 tabular-nums"
        />
        <span className="ml-auto text-amber-300/80" title="Without headphones the microphone hears the track and scores the song, not you">
          Use headphones
        </span>
        {micError && <span className="text-rose-300">{micError}</span>}
      </div>
      <div ref={wrapRef} className="h-28 w-full">
        <canvas ref={canvasRef} role="img" aria-label="Target melody and your sung pitch" className="block" />
      </div>
      <div className="sr-only" aria-live="polite">{liveText}</div>
    </div>
  );
};

export default PitchLane;
