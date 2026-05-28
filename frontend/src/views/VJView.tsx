import React, { useEffect, useRef, useState } from 'react';
import {
  Tv2,
  ExternalLink,
  Loader2,
  AlertCircle,
  RefreshCw,
  Mic,
  Music as MusicIcon,
  Piano,
  Maximize2,
} from 'lucide-react';
import { getAnalyser } from '../state/playerStore';
import { usePlayerStore } from '../state/playerStore';
import { useLibraryStore } from '../state/libraryStore';

/**
 * VJ tab — embeds the GANTASMO-LIVE-VJ Vite dev server in an iframe.
 *
 * The backend `vj` module spawns the dev server (default port 5187)
 * lazily. We fetch its live URL from `/api/vj/url` so the port isn't
 * hardcoded in the frontend; if the user / env overrode it via
 * STABLEDAW_VJ_PORT, this stays in sync automatically.
 *
 * The "Pop out" action opens the iframe URL in a new browser window
 * — the user can drag, resize, or move that window onto a second
 * monitor for live performance while SA3 keeps running on the main
 * display. When popped out, we collapse the in-tab iframe and show a
 * placeholder with a "Pop back in" button.
 *
 * Audio / mic / MIDI plumbing (postMessage bridge to the iframe) is
 * intentionally a TODO for the follow-up commit — wiring those
 * requires reading the SA3 playerStore + MIDI subsystem and adding a
 * matching listener on the VJ side. Mic input already works without
 * any plumbing because the iframe can request mic permission itself.
 */
export const VJView: React.FC = () => {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState<string>('');
  const [popped, setPopped] = useState(false);
  const [bridgeFps, setBridgeFps] = useState(0);
  const poppedWindowRef = useRef<Window | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const libraryEntries = useLibraryStore((s) => s.entries);

  // Fetch the VJ URL on mount. The backend will spawn the dev server
  // if it isn't already running — this can take ~30s on first launch
  // (npm install) and ~2-3s on subsequent launches.
  const loadUrl = async () => {
    setStatus('loading');
    setDetail('Asking SA3 backend for the VJ URL…');
    try {
      const r = await fetch('/api/vj/url');
      if (!r.ok) {
        const body = await r.json().catch(() => ({ detail: '' }));
        throw new Error(body.detail || `backend returned ${r.status}`);
      }
      const j = (await r.json()) as { url: string };
      setUrl(j.url);
      setStatus('ready');
      setDetail('');
    } catch (e) {
      setStatus('error');
      setDetail(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadUrl();
  }, []);

  // ── Audio bridge: read SA3's master AnalyserNode every animation
  // frame, derive bass/mid/high/volume buckets (matching VJ's existing
  // useAudioAnalyzer signature), and postMessage them to the iframe.
  // VJ's sa3Bridge.ts hook picks these up and feeds them into
  // useAudioAnalyzer when audioReactive is on, so the visualizer
  // reacts to whatever's playing in SA3's global player instead of
  // requiring its own mic capture.
  useEffect(() => {
    if (status !== 'ready' || popped) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let raf = 0;
    let frameCount = 0;
    let fpsTick = performance.now();
    const analyser = getAnalyser();
    const buf = new Uint8Array(analyser.frequencyBinCount);
    // 2048 fft → 1024 bins; carve into low/mid/high using approx
    // log-spaced ranges that match VJ's 256-bin layout proportionally.
    const lowEnd = Math.floor(buf.length * 0.05);
    const midEnd = Math.floor(buf.length * 0.30);
    const highEnd = buf.length;

    const tick = () => {
      analyser.getByteFrequencyData(buf);
      let bassSum = 0, midSum = 0, highSum = 0;
      for (let i = 0; i < lowEnd; i++) bassSum += buf[i];
      for (let i = lowEnd; i < midEnd; i++) midSum += buf[i];
      for (let i = midEnd; i < highEnd; i++) highSum += buf[i];
      const bass = lowEnd > 0 ? (bassSum / lowEnd) / 255 : 0;
      const mid = midEnd - lowEnd > 0 ? (midSum / (midEnd - lowEnd)) / 255 : 0;
      const high = highEnd - midEnd > 0 ? (highSum / (highEnd - midEnd)) / 255 : 0;
      const volume = (bassSum + midSum + highSum) / (buf.length * 255);
      try {
        iframe.contentWindow?.postMessage(
          {
            type: 'sa3-vj/audio-levels',
            bass,
            mid,
            high,
            volume,
            t: performance.now(),
          },
          '*',
        );
      } catch {
        // contentWindow unavailable (iframe still loading or popped) —
        // skip this frame and try again next tick.
      }
      frameCount += 1;
      const now = performance.now();
      if (now - fpsTick > 1000) {
        setBridgeFps(Math.round((frameCount * 1000) / (now - fpsTick)));
        frameCount = 0;
        fpsTick = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setBridgeFps(0);
    };
  }, [status, popped]);

  // Track-meta + BPM bridge: when the SA3 player loads a new entry
  // (or playback toggles), post the current track's metadata to the
  // iframe so VJ can sync its bpm slider, show the title in HUDs, etc.
  useEffect(() => {
    if (status !== 'ready' || popped) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const entry = libraryEntries.find((e) => e.id === currentEntryId) ?? null;
    try {
      iframe.contentWindow?.postMessage(
        {
          type: 'sa3-vj/track-meta',
          entryId: entry?.id ?? null,
          title: entry?.title ?? null,
          // BPM / key live in the analysis sidecar store, not on the
          // library entry — VJ can request them via the SA3 analysis
          // endpoint if it ever needs them. We send the basics here.
          model: entry?.model ?? null,
          source: entry?.source ?? null,
          duration: entry?.duration ?? null,
          isPlaying,
        },
        '*',
      );
    } catch {
      // ignored — iframe may not be ready yet
    }
  }, [status, popped, currentEntryId, isPlaying, libraryEntries]);

  // Watch the popped window — if the user closes it manually, snap
  // back to the in-tab iframe view.
  useEffect(() => {
    if (!popped || !poppedWindowRef.current) return;
    const t = window.setInterval(() => {
      if (poppedWindowRef.current?.closed) {
        setPopped(false);
        poppedWindowRef.current = null;
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [popped]);

  const popOut = () => {
    if (!url) return;
    // 1280x800 is a reasonable default for a VJ canvas — big enough
    // to look good on a second monitor, small enough to not auto-
    // maximize on a single-screen setup.
    const w = window.open(
      url,
      'sa3-vj-window',
      'noopener=no,width=1280,height=800,location=no,menubar=no,toolbar=no,status=no',
    );
    if (!w) {
      setDetail(
        'Pop-out blocked by the browser — allow pop-ups for this origin and try again.',
      );
      return;
    }
    poppedWindowRef.current = w;
    setPopped(true);
  };

  const popBackIn = () => {
    poppedWindowRef.current?.close();
    poppedWindowRef.current = null;
    setPopped(false);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      {/* Toolbar */}
      <div className="shrink-0 h-9 flex items-center justify-between px-3 border-b border-fuchsia-500/20 bg-[#0a080f]">
        <div className="flex items-center gap-2">
          <Tv2 className="w-3.5 h-3.5 text-fuchsia-300" />
          <span className="text-[10px] font-black uppercase tracking-widest text-fuchsia-200">
            VJ · Live Visuals
          </span>
          {status === 'ready' && url && (
            <span className="text-[8px] font-mono text-zinc-600">{url}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Inputs hint chips — VJ accepts these via the in-iframe
              controls. Mic permission is granted by the iframe itself
              on first use; audio / MIDI plumbing from SA3 is a
              follow-up. */}
          <span
            className="px-1.5 py-0.5 rounded border border-white/10 text-[8px] font-mono uppercase tracking-widest text-zinc-500 flex items-center gap-1"
            title="VJ canvas can request mic access via its native UI"
          >
            <Mic className="w-2.5 h-2.5" /> Mic
          </span>
          <span
            className={`px-1.5 py-0.5 rounded border text-[8px] font-mono uppercase tracking-widest flex items-center gap-1 ${
              bridgeFps > 0
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-white/10 text-zinc-500'
            }`}
            title={
              bridgeFps > 0
                ? `Audio bridge live — forwarding SA3 player levels @ ${bridgeFps}fps`
                : 'Audio bridge idle — load + play a track in SA3'
            }
          >
            <MusicIcon className="w-2.5 h-2.5" /> Audio{bridgeFps > 0 ? ` ${bridgeFps}` : ''}
          </span>
          <span
            className="px-1.5 py-0.5 rounded border border-white/10 text-[8px] font-mono uppercase tracking-widest text-zinc-500 flex items-center gap-1"
            title="MIDI events bridge from SA3 (TODO)"
          >
            <Piano className="w-2.5 h-2.5" /> MIDI
          </span>
          <button
            type="button"
            onClick={() => void loadUrl()}
            className="p-1.5 rounded border border-white/5 hover:bg-white/5 text-zinc-400 hover:text-zinc-100"
            title="Reload the VJ iframe"
            aria-label="Reload VJ"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {popped ? (
            <button
              type="button"
              onClick={popBackIn}
              className="p-1.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-200 hover:bg-fuchsia-500/25 flex items-center gap-1"
              title="Close the floating VJ window and return it to this tab"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span className="text-[9px] font-black uppercase tracking-widest pr-1">
                Pop in
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={popOut}
              disabled={status !== 'ready'}
              className="p-1.5 rounded border border-fuchsia-500/30 hover:bg-fuchsia-500/15 text-fuchsia-300 hover:text-fuchsia-100 disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1"
              title="Pop the VJ into a separate window — drag onto a second monitor for live performance"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="text-[9px] font-black uppercase tracking-widest pr-1">
                Pop out
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 relative min-h-0">
        {status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin text-fuchsia-300" />
            <span className="text-[10px] font-mono uppercase tracking-widest">
              {detail || 'Booting VJ sidecar…'}
            </span>
            <span className="text-[9px] font-mono text-zinc-600 max-w-md text-center leading-relaxed">
              First launch runs `npm install` in the VJ project — this
              can take a minute. Subsequent launches are fast.
            </span>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-rose-300 px-6">
            <AlertCircle className="w-5 h-5" />
            <span className="text-[10px] font-mono uppercase tracking-widest">
              VJ sidecar failed
            </span>
            <span className="text-[9px] font-mono text-rose-200/80 max-w-xl text-center leading-relaxed">
              {detail}
            </span>
            <button
              type="button"
              onClick={() => void loadUrl()}
              className="mt-2 px-3 py-1.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
            <span className="text-[8px] font-mono text-zinc-600 max-w-xl text-center leading-relaxed">
              Check the SA3 Backend window for the spawn error. Most
              common causes: Node not on PATH, the VJ project path is
              wrong (override with STABLEDAW_VJ_PROJECT), or port 5187
              is already in use (override with STABLEDAW_VJ_PORT).
            </span>
          </div>
        )}
        {status === 'ready' && popped && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-fuchsia-200">
            <ExternalLink className="w-5 h-5" />
            <span className="text-[10px] font-mono uppercase tracking-widest">
              VJ is in a separate window
            </span>
            <button
              type="button"
              onClick={popBackIn}
              className="px-3 py-1.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-200 hover:bg-fuchsia-500/25 text-[9px] font-black uppercase tracking-widest"
            >
              Pop back in
            </button>
          </div>
        )}
        {status === 'ready' && !popped && url && (
          <iframe
            ref={iframeRef}
            src={url}
            // The VJ project hosts its own controls + canvas. We grant
            // microphone permission so the user can VJ to mic input
            // without re-prompting; the iframe will still trigger the
            // browser's standard permission prompt on first use.
            allow="microphone; camera; autoplay; fullscreen"
            // sandbox is deliberately NOT set here because the VJ app
            // is a same-origin (localhost) sibling app we control —
            // we want full window APIs (audio context, MIDI, etc.).
            className="w-full h-full border-0 bg-black"
            title="VJ — Live visuals"
          />
        )}
      </div>
    </div>
  );
};
