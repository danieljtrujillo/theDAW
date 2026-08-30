/**
 * SWAY tab -- the embedded SwayCommand cockpit plus theDAW's own Sway plumbing.
 *
 * SwayCommand (github.com/danieljtrujillo/SwayCommand) is a standalone Electron
 * app. Its renderer also builds as a plain static bundle, which theDAW's backend
 * serves at /sway-app and this view shows in an iframe -- the same shape as the
 * VJ tab, and for the same reasons: one origin, no Node on the target machine,
 * identical behaviour packaged and in Docker.
 *
 * Three things here are load-bearing rather than stylistic:
 *
 *   1. The iframe src is RELATIVE ('/sway-app/'), not an absolute backend URL.
 *      Chromium throttles a cross-origin hidden iframe to zero rAF callbacks,
 *      and SwayCommand's transport clock runs on rAF -- so a cross-origin embed
 *      freezes its timeline the moment the user switches tabs. Relative also
 *      keeps Web MIDI attribution and storage on theDAW's own origin.
 *
 *   2. The trailing slash is required. Without it the document base is '/' and
 *      the cockpit's relative asset loads (its AudioWorklet in particular)
 *      resolve against theDAW's root and 404.
 *
 *   3. Visibility must be pushed to the child. DAWCenterPanel warms a tab and
 *      then never unmounts it, so effect cleanups here never run on tab switch.
 *      Without an explicit visible:false the cockpit renders WebGL at full rate
 *      for the rest of the session behind whatever tab you are actually using.
 *
 * theDAW owns the only navigator.requestMIDIAccess() in the app (see App.tsx);
 * hardware reaches the cockpit by relay over postMessage, never by the iframe
 * opening its own MIDI access.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Waves } from 'lucide-react';
import { subscribeToMidi } from '../state/midiBus';
import { getAnalyser } from '../state/playerStore';
import { logInfo, logWarn } from '../state/logStore';
import { useMidiDevicesStore } from '../state/midiDevicesStore';
import { useMidiTriggerStore } from '../state/midiTriggerStore';

/** Where the cockpit is mounted. Must match backend/modules/sway/sidecar.py. */
const SWAY_SRC = '/sway-app/';

/** The template the cockpit boots into when the user has no saved project. */
const DEFAULT_TEMPLATE = 'will-i-dream';

/**
 * The iframe URL, with `?autoplay=` so the cockpit boots STRAIGHT into a
 * loaded project. This is load-bearing, not cosmetic: without a loaded
 * project the cockpit's + TRACK button and transport are silent no-ops
 * (its addTrack/play guard on a null timeline), and without the autoplay
 * param its boot shows the SYSTEM splash modal over the deck. The cockpit
 * shares theDAW's localStorage (same origin), so the most recent
 * cockpit-saved project (`swayproject:/` paths resolve from
 * localStorage['sway:projects']) wins over the default template; transient
 * `swaydrop:/` handles die on reload and are skipped.
 */
function swayBootSrc(): string {
  let target: string = DEFAULT_TEMPLATE;
  try {
    const recents = JSON.parse(window.localStorage.getItem('sway:recents') ?? '[]') as Array<{ path?: string }>;
    const saved = Array.isArray(recents)
      ? recents.find((r) => typeof r?.path === 'string' && r.path.startsWith('swayproject:/'))
      : null;
    if (saved?.path) target = saved.path;
  } catch {
    /* unreadable recents — boot the default template */
  }
  return `${SWAY_SRC}?autoplay=${encodeURIComponent(target)}`;
}

/** Wire-protocol version for every frame exchanged with the cockpit. */
const PROTOCOL = 1;

/** Analysis frames per second pushed to the cockpit. It smooths internally. */
const ANALYSIS_HZ = 30;

type EmbedState = 'checking' | 'ready' | 'unavailable' | 'error';

/**
 * What drives the cockpit's visuals. theDAW's master is the reason to embed at
 * all -- the visuals react to what you are actually making. An input device is
 * what standalone does, kept here for performing to an external source.
 */
type AudioSource = 'thedaw' | 'input';

interface SwayUrlResponse {
  url: string | null;
  mode: string;
  detail?: string | null;
  build?: { sha?: string; builtAt?: string; version?: string } | null;
}

export const SwayView: React.FC = () => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [embedState, setEmbedState] = useState<EmbedState>('checking');
  const [detail, setDetail] = useState<string | null>(null);
  const [build, setBuild] = useState<SwayUrlResponse['build']>(null);
  const [audioSource, setAudioSource] = useState<AudioSource>('thedaw');
  const [childReady, setChildReady] = useState(false);

  // Readiness is a ref, not just state: the analysis and MIDI loops read it on
  // every frame and a state value captured in a closure would be stale.
  const readyRef = useRef(false);
  // Frames posted before the cockpit says hello are queued, not dropped -- the
  // handshake and the first MIDI event can race.
  const pendingRef = useRef<Record<string, unknown>[]>([]);

  const post = useCallback((payload: Record<string, unknown>) => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    if (!readyRef.current) {
      // Bounded: a cockpit that never reports ready must not grow this forever.
      if (pendingRef.current.length < 128) pendingRef.current.push(payload);
      return;
    }
    try {
      w.postMessage(payload, window.location.origin);
    } catch {
      /* mid-navigation; the next frame retries */
    }
  }, []);

  // --- is there a build to show? -------------------------------------------
  const probe = useCallback(async () => {
    setEmbedState('checking');
    try {
      const res = await fetch('/api/sway/url');
      if (!res.ok) {
        setEmbedState('error');
        setDetail(`GET /api/sway/url returned HTTP ${res.status}.`);
        return;
      }
      const data = (await res.json()) as SwayUrlResponse;
      if (!data.url) {
        setEmbedState('unavailable');
        setDetail(data.detail ?? 'No SwayCommand build is staged.');
        return;
      }
      setBuild(data.build ?? null);
      setDetail(null);
      setEmbedState('ready');
    } catch (err) {
      setEmbedState('error');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  // --- handshake ------------------------------------------------------------
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Two guards, both required: the right window AND the right origin. The
      // cockpit is same-origin, so asserting it costs nothing and shuts out any
      // other frame on the page.
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; v?: number } | null;
      if (!d || typeof d.type !== 'string') return;

      switch (d.type) {
        case 'sway/ready': {
          readyRef.current = true;
          setChildReady(true);
          logInfo('sway', 'SwayCommand cockpit reported ready');
          const queued = pendingRef.current;
          pendingRef.current = [];
          post({ type: 'sway/host-ready', v: PROTOCOL, host: 'theDAW' });
          for (const frame of queued) post(frame);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post]);

  // A reloaded iframe has not said hello yet; re-gate until it does.
  const handleIframeLoad = useCallback(() => {
    readyRef.current = false;
    setChildReady(false);
  }, []);

  // --- visibility: this tab is warmed and never unmounted -------------------
  const [docVisible, setDocVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // This view only renders inside DAWCenterPanel's warm block, which hides it
  // with display:none rather than unmounting. An IntersectionObserver would
  // report nothing useful for a display:none subtree, so ask the element.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const check = () => setTabVisible(el.offsetParent !== null);
    check();
    const id = window.setInterval(check, 500);
    return () => window.clearInterval(id);
  }, []);

  const active = docVisible && tabVisible;

  useEffect(() => {
    post({ type: 'sway/visibility', v: PROTOCOL, visible: active });
  }, [active, childReady, post]);

  // --- MIDI relay -----------------------------------------------------------
  // theDAW holds the only MIDIAccess. Relaying raw bytes means the cockpit's
  // own decoding, its factory map and its learned overrides all apply
  // unchanged, with no duplicated semantics on this side.
  useEffect(() => {
    if (embedState !== 'ready') return;
    return subscribeToMidi((msg) => {
      if (!readyRef.current || !active) return;
      post({ type: 'sway/midi', v: PROTOCOL, data: msg.data, t: msg.t });
    });
  }, [embedState, active, post]);

  // --- audio analysis -------------------------------------------------------
  useEffect(() => {
    if (embedState !== 'ready') return;
    if (audioSource !== 'thedaw') {
      // The cockpit opens its own input device in this mode; tell it to.
      post({ type: 'sway/audio-source', v: PROTOCOL, source: 'input' });
      return;
    }
    post({ type: 'sway/audio-source', v: PROTOCOL, source: 'host' });
    if (!active) return;

    let raf = 0;
    let lastPost = 0;
    const postDt = 1000 / ANALYSIS_HZ;
    let analyser: AnalyserNode;
    try {
      analyser = getAnalyser();
    } catch (err) {
      logWarn('sway', `analysis bridge unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const lowEnd = Math.floor(buf.length * 0.05);
    const midEnd = Math.floor(buf.length * 0.3);
    const SPEC_BINS = 256;
    const specBlock = Math.max(1, Math.floor(buf.length / SPEC_BINS));
    const spec = new Array<number>(SPEC_BINS);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!readyRef.current) return;
      const now = performance.now();
      if (now - lastPost < postDt) return;
      lastPost = now;
      analyser.getByteFrequencyData(buf);
      let bassSum = 0;
      let midSum = 0;
      let highSum = 0;
      for (let i = 0; i < lowEnd; i++) bassSum += buf[i];
      for (let i = lowEnd; i < midEnd; i++) midSum += buf[i];
      for (let i = midEnd; i < buf.length; i++) highSum += buf[i];
      for (let i = 0; i < SPEC_BINS; i++) {
        let sum = 0;
        const start = i * specBlock;
        for (let j = 0; j < specBlock; j++) sum += buf[start + j] ?? 0;
        spec[i] = sum / specBlock / 255;
      }
      post({
        type: 'sway/analysis',
        v: PROTOCOL,
        bass: lowEnd > 0 ? bassSum / lowEnd / 255 : 0,
        mid: midEnd - lowEnd > 0 ? midSum / (midEnd - lowEnd) / 255 : 0,
        high: buf.length - midEnd > 0 ? highSum / (buf.length - midEnd) / 255 : 0,
        volume: (bassSum + midSum + highSum) / (buf.length * 255),
        spectrum: spec,
        t: now,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [embedState, audioSource, active, post]);

  const buildLabel = useMemo(() => {
    if (!build) return null;
    const sha = build.sha ? build.sha.slice(0, 7) : null;
    return [build.version, sha].filter(Boolean).join(' @ ') || null;
  }, [build]);

  // What is ACTUALLY hooked up, from the host's own MIDIAccess — the cockpit
  // can only ever say "theDAW (relayed)" because raw bytes are relayed to it,
  // so the real device names have to be surfaced on this side. midiEnabled
  // matters too: with the master gate off there IS no relay, and saying
  // "linked" while hardware is silently ignored is exactly the kind of lie
  // this header used to tell.
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  const midiInputs = useMidiDevicesStore((s) => s.inputs);
  const hardwareLabel = useMemo(() => {
    if (!midiEnabled) return 'MIDI off';
    if (midiInputs.length === 0) return 'no MIDI device';
    const sway = midiInputs.find((n) => /sway|audima/i.test(n));
    if (sway) return `Sway: ${sway}`;
    return midiInputs.join(', ');
  }, [midiEnabled, midiInputs]);
  const hardwareTone = !midiEnabled
    ? 'text-amber-400'
    : midiInputs.length === 0
      ? 'text-zinc-500'
      : 'text-emerald-400';

  return (
    <div ref={hostRef} className="absolute inset-0 flex bg-black">
      {/* The SWAY tab is the SwayCommand cockpit, nothing else. theDAW's own
          Sway rail (routing selects, per-dim learn rows, the MIDI enable
          button) used to sit alongside it and duplicated what the cockpit
          already does properly. Its plumbing is unchanged and still feeds
          PERFORM — only the redundant UI is gone. */}
      <div className="relative min-w-0 grow">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-black/70 px-2 py-1 backdrop-blur">
          <Waves className="h-3 w-3 shrink-0 text-fuchsia-300" />
          <span className="text-[9px] font-black uppercase tracking-[0.2em] text-fuchsia-200">SwayCommand</span>

          <label htmlFor="sway-audio-source" className="ml-3 text-[8px] font-bold uppercase tracking-wider text-zinc-400">
            Audio
          </label>
          <select
            id="sway-audio-source"
            name="sway-audio-source"
            value={audioSource}
            onChange={(e) => setAudioSource(e.target.value as AudioSource)}
            className="rounded border border-zinc-800 bg-black/40 px-1.5 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-fuchsia-500/50"
          >
            <option value="thedaw">theDAW master</option>
            <option value="input">Input device</option>
          </select>

          <span className={`ml-auto text-[8px] font-mono ${hardwareTone}`}>{hardwareLabel}</span>
          <span className="text-[8px] font-mono text-zinc-600">
            · {embedState === 'ready' ? (childReady ? 'linked' : 'loading…') : embedState}
            {buildLabel ? ` · ${buildLabel}` : ''}
          </span>
        </div>

        {embedState === 'ready' ? (
          <iframe
            ref={iframeRef}
            src={swayBootSrc()}
            title="SwayCommand"
            onLoad={handleIframeLoad}
            // midi: the cockpit's own learn UI reads relayed frames, but the
            // permissions policy must still allow it for any direct use.
            // microphone: the 'Input device' audio source.
            allow="midi; microphone; autoplay; fullscreen"
            className="absolute inset-0 h-full w-full border-0 bg-black pt-6"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 pt-6 text-center">
            {embedState === 'checking' ? (
              <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                Looking for a SwayCommand build…
              </span>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                <p className="max-w-lg text-[11px] font-mono leading-relaxed text-zinc-300">
                  {detail ?? 'The SwayCommand cockpit is not available.'}
                </p>
                <p className="max-w-lg text-[10px] font-mono leading-relaxed text-zinc-500">
                  SwayCommand also runs as its own desktop application; this tab embeds the same
                  cockpit inside theDAW.
                </p>
                <button
                  type="button"
                  onClick={() => void probe()}
                  className="mt-1 inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-fuchsia-400/50 hover:text-fuchsia-200"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
