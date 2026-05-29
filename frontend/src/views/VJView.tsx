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
import { subscribeToMidi } from '../state/midiBus';
import { getVjPlaybackState, registerVjPlaybackHandler, reportVjPlaybackState } from '../state/vjPlaybackBus';

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
  // Active VJ inputs — user toggles which signals feed the iframe.
  // Invariant: at least one must stay active; clicking the last
  // enabled chip is a no-op (prevents the user from accidentally
  // muting all input). Each toggle posts a sa3-vj/toggle-{kind}
  // message so the VJ side can mute/unmute its own bus.
  const [vjInputs, setVjInputs] = useState<{ mic: boolean; audio: boolean; midi: boolean }>({
    mic: true,
    audio: true,
    midi: true,
  });
  const toggleVjInput = (kind: 'mic' | 'audio' | 'midi') => {
    setVjInputs((prev) => {
      const next = { ...prev, [kind]: !prev[kind] };
      // Min-1 invariant: refuse to disable the last active input.
      if (!next.mic && !next.audio && !next.midi) return prev;
      return next;
    });
  };
  const poppedWindowRef = useRef<Window | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeReadyTimerRef = useRef<number | null>(null);
  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const libraryEntries = useLibraryStore((s) => s.entries);

  const postToIframe = (payload: Record<string, unknown>) => {
    try {
      iframeRef.current?.contentWindow?.postMessage(payload, '*');
    } catch {
      // iframe can be mid-navigation; the next lifecycle tick retries.
    }
  };

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

  // Forward input-toggle state to the iframe whenever it changes.
  // VJ side listens for sa3-vj/inputs and mutes / unmutes its own
  // mic-capture / audio-bridge / MIDI listener accordingly.
  useEffect(() => {
    if (status !== 'ready' || popped) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    postToIframe({ type: 'sa3-vj/inputs', ...vjInputs });
  }, [status, popped, vjInputs]);

  // Global MIDI bus → forward raw messages to the iframe when MIDI
  // input is enabled. The single Web MIDI listener lives in App.tsx
  // and republishes through midiBus; here we just subscribe. This
  // avoids the last-listener-wins problem the previous version had
  // (where VJView called requestMIDIAccess() too and clobbered the
  // App-level synth trigger). Now App's synth trigger + VJ iframe
  // forwarding + MidiMapper popups all share one input.
  useEffect(() => {
    if (status !== 'ready' || popped) return;
    if (!vjInputs.midi) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const unsub = subscribeToMidi((msg) => {
      if (!iframe.contentWindow) return;
      try {
        iframe.contentWindow.postMessage(
          { type: 'sa3-vj/midi', data: msg.data, t: msg.t },
          '*',
        );
      } catch { /* ignored */ }
    });
    return unsub;
  }, [status, popped, vjInputs.midi]);

  // Register a VJ playback handler so the SA3 PlayerFooter's
  // Play/Pause button can drive the VJ iframe's video element. The
  // bus is module-level; this effect just installs and tears down
  // the handler around the iframe's lifecycle. The VJ side listens
  // for sa3-vj/playback messages and calls video.play() / video.pause().
  useEffect(() => {
    if (status !== 'ready' || popped) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let lastState: 'playing' | 'paused' = getVjPlaybackState() === 'playing' ? 'playing' : 'paused';
    const post = (action: 'play' | 'pause') => {
      postToIframe({ type: 'sa3-vj/playback', action });
    };
    const unregister = registerVjPlaybackHandler({
      play: () => { lastState = 'playing'; post('play'); },
      pause: () => { lastState = 'paused'; post('pause'); },
      getState: () => lastState,
    });
    // If the user clicked Play before the iframe registered, honor that
    // intent as soon as the bridge is ready instead of leaving the VJ
    // canvas parked on its black initial frame.
    if (lastState === 'playing') post('play');
    // Listen for state echoes from the VJ side ("I'm now playing/paused")
    // so the SA3 UI's icon stays in sync with the actual video element.
    const onMsg = (event: MessageEvent) => {
      const d = event.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'sa3-vj/playback-state') {
        lastState = d.state === 'playing' ? 'playing' : 'paused';
        reportVjPlaybackState(lastState);
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      unregister();
      window.removeEventListener('message', onMsg);
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
    postToIframe({
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
    });
  }, [status, popped, currentEntryId, isPlaying, libraryEntries]);

  const handleIframeLoad = () => {
    if (iframeReadyTimerRef.current !== null) {
      window.clearTimeout(iframeReadyTimerRef.current);
      iframeReadyTimerRef.current = null;
    }
    // The child app may attach its postMessage listeners after the
    // iframe load event. Send one immediate sync plus a short delayed
    // sync so startup state does not get lost, which previously left
    // the VJ view on an all-black initial frame.
    const sync = () => {
      postToIframe({ type: 'sa3-vj/inputs', ...vjInputs });
      const state = getVjPlaybackState();
      if (state === 'playing' || state === 'paused') {
        postToIframe({ type: 'sa3-vj/playback', action: state === 'playing' ? 'play' : 'pause' });
      }
    };
    sync();
    iframeReadyTimerRef.current = window.setTimeout(sync, 250);
  };

  useEffect(() => () => {
    if (iframeReadyTimerRef.current !== null) window.clearTimeout(iframeReadyTimerRef.current);
  }, []);

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
          {/* Input toggles — click to enable/disable each signal
              feeding the VJ iframe. Minimum 1 must stay active. The
              VJ side mutes/unmutes its own bus when it receives the
              sa3-vj/inputs message. */}
          <InputChip
            active={vjInputs.mic}
            onToggle={() => toggleVjInput('mic')}
            label="Mic"
            icon={<Mic className="w-2.5 h-2.5" />}
            activeLabel="Microphone capture is enabled — VJ iframe will request browser permission on first use."
            inactiveLabel="Microphone input is muted. Click to enable."
            disabled={vjInputs.mic && !vjInputs.audio && !vjInputs.midi}
          />
          <InputChip
            active={vjInputs.audio}
            onToggle={() => toggleVjInput('audio')}
            label={bridgeFps > 0 ? `Audio ${bridgeFps}` : 'Audio'}
            icon={<MusicIcon className="w-2.5 h-2.5" />}
            activeLabel={
              bridgeFps > 0
                ? `Audio bridge live — forwarding SA3 player levels @ ${bridgeFps}fps`
                : 'Audio bridge enabled — load + play a track in SA3 to drive visuals.'
            }
            inactiveLabel="Audio bridge muted. Click to enable."
            disabled={vjInputs.audio && !vjInputs.mic && !vjInputs.midi}
            indicator={bridgeFps > 0 && vjInputs.audio ? 'live' : null}
          />
          <InputChip
            active={vjInputs.midi}
            onToggle={() => toggleVjInput('midi')}
            label="MIDI"
            icon={<Piano className="w-2.5 h-2.5" />}
            activeLabel="MIDI events from your controller are forwarded into the VJ iframe."
            inactiveLabel="MIDI forwarding is off. Click to enable."
            disabled={vjInputs.midi && !vjInputs.mic && !vjInputs.audio}
          />
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
            onLoad={handleIframeLoad}
            // The VJ project hosts its own controls + canvas. We grant
            // microphone permission so the user can VJ to mic input
            // without re-prompting; the iframe will still trigger the
            // browser's standard permission prompt on first use.
            // `midi` is required so the iframe (VJ project) can call
            // navigator.requestMIDIAccess() — without it the browser's
            // Permissions Policy blocks the call inside the iframe even
            // though SA3 has access at the top frame.
            allow="microphone; camera; autoplay; fullscreen; midi"
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

/**
 * Tiny toggle chip for the VJ input row (Mic / Audio / MIDI). Lit
 * emerald when active; faded zinc when disabled. `disabled` true
 * means the chip can't be turned off because it's the last
 * remaining active input (min-1 invariant).
 */
const InputChip: React.FC<{
  active: boolean;
  onToggle: () => void;
  label: string;
  icon: React.ReactNode;
  activeLabel: string;
  inactiveLabel: string;
  disabled?: boolean;
  indicator?: 'live' | null;
}> = ({ active, onToggle, label, icon, activeLabel, inactiveLabel, disabled, indicator }) => (
  <button
    type="button"
    onClick={onToggle}
    disabled={!!disabled && active}
    className={`px-1.5 py-0.5 rounded border text-[8px] font-mono uppercase tracking-widest flex items-center gap-1 transition-colors ${
      active
        ? indicator === 'live'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
          : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20'
        : 'border-white/10 text-zinc-500 hover:text-zinc-200 hover:border-white/20 hover:bg-white/3'
    } disabled:cursor-not-allowed disabled:opacity-100`}
    title={
      disabled && active
        ? `${activeLabel} — at least one input must stay enabled.`
        : active
        ? `${activeLabel} (click to mute)`
        : inactiveLabel
    }
  >
    {icon} {label}
  </button>
);
