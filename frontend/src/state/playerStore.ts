import { create } from 'zustand';
import { logError, logInfo } from './logStore';

/**
 * Global playback engine — a single HTMLAudioElement piped through a single
 * Web Audio graph (master gain + AnalyserNode + destination). Every audio
 * source in the app should route through this graph so the visualizer + HUD
 * always reflect whatever's audible.
 *
 *   HTMLAudioElement ──┐
 *                      ├──▶ master gain ──▶ analyser ──▶ destination
 *   editor preview  ───┤
 *   sequencer voices ──┘
 */

let _ctx: AudioContext | null = null;
let _master: GainNode | null = null;
let _analyser: AnalyserNode | null = null;
let _audioEl: HTMLAudioElement | null = null;
let _mediaSrc: MediaElementAudioSourceNode | null = null;
let _objectUrl: string | null = null;

type EngineHandles = {
  ctx: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  audioEl: HTMLAudioElement;
};

// Was the engine first touched from inside a real user-gesture call
// path (click/keydown/touchstart)? Until that happens the AudioContext
// is constructed but kept suspended — calling .resume() before a gesture
// prints "The AudioContext was not allowed to start" to the console on
// every render. Flipped to true by the first user-input listener (see
// the module-load auto-resume below) and by play().
let _userGesture = false;

export const ensureEngine = (): EngineHandles => {
  if (_ctx && _master && _analyser && _audioEl) {
    // Only resume once we know a user gesture has happened; otherwise
    // the browser refuses + warns. ensureEngine() is also called from
    // pure read paths (analyzer visualizer, getMasterGain, etc).
    if (_userGesture && _ctx.state === 'suspended') {
      void _ctx.resume().catch(() => { /* swallowed; will retry on next gesture */ });
    }
    return { ctx: _ctx, master: _master, analyser: _analyser, audioEl: _audioEl };
  }
  const Ctor =
    (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = 1;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.7;
  master.connect(analyser);
  analyser.connect(ctx.destination);

  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioEl.preload = 'auto';
  const mediaSrc = ctx.createMediaElementSource(audioEl);
  mediaSrc.connect(master);

  audioEl.addEventListener('timeupdate', () => {
    usePlayerStore.setState({ currentTime: audioEl.currentTime });
  });
  audioEl.addEventListener('loadedmetadata', () => {
    usePlayerStore.setState({ duration: Number.isFinite(audioEl.duration) ? audioEl.duration : 0 });
  });
  audioEl.addEventListener('play', () => {
    usePlayerStore.setState({ isPlaying: true });
  });
  audioEl.addEventListener('pause', () => {
    usePlayerStore.setState({ isPlaying: false });
  });
  audioEl.addEventListener('ended', () => {
    if (!audioEl.loop) usePlayerStore.setState({ isPlaying: false, currentTime: 0 });
  });
  audioEl.addEventListener('error', () => {
    logError('player', `Audio element error: ${audioEl.error?.message ?? 'unknown'}`);
    usePlayerStore.setState({ isPlaying: false });
  });

  _ctx = ctx;
  _master = master;
  _analyser = analyser;
  _audioEl = audioEl;
  _mediaSrc = mediaSrc;
  return { ctx, master, analyser, audioEl };
};

/** Other sources (editor preview, sequencer voices) connect here so they go through the same analyser. */
export const getMasterGain = (): GainNode => ensureEngine().master;
export const getAnalyser = (): AnalyserNode => ensureEngine().analyser;
export const getEngineCtx = (): AudioContext => ensureEngine().ctx;

// Auto-warm-up: the first time the user interacts with the page in
// ANY way (click / keydown / pointerdown / touchstart), flip the gesture
// flag and resume any suspended AudioContext. Eliminates the console
// warning on initial load and means the visualizer is alive the instant
// the user does anything.
if (typeof window !== 'undefined') {
  const onFirstGesture = () => {
    _userGesture = true;
    if (_ctx && _ctx.state === 'suspended') {
      void _ctx.resume().catch(() => { /* swallowed */ });
    }
    window.removeEventListener('click', onFirstGesture);
    window.removeEventListener('keydown', onFirstGesture);
    window.removeEventListener('pointerdown', onFirstGesture);
    window.removeEventListener('touchstart', onFirstGesture);
  };
  window.addEventListener('click', onFirstGesture, { once: false, passive: true });
  window.addEventListener('keydown', onFirstGesture, { once: false, passive: true });
  window.addEventListener('pointerdown', onFirstGesture, { once: false, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: false, passive: true });
}

interface PlayerStoreState {
  // Currently-loaded track meta
  currentLabel: string | null;
  currentEntryId: string | null;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  isLooping: boolean;
  // Whether a track is loaded at all (for footer UI states)
  hasTrack: boolean;

  load: (blob: Blob, meta: { label: string; entryId?: string }) => Promise<void>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
  seek: (sec: number) => void;
  seekByFraction: (frac: number) => void;
  toggleLoop: () => void;
  setMasterGain: (gain: number) => void;
}

export const usePlayerStore = create<PlayerStoreState>()((set, get) => ({
  currentLabel: null,
  currentEntryId: null,
  duration: 0,
  currentTime: 0,
  isPlaying: false,
  isLooping: true,
  hasTrack: false,

  load: async (blob, meta) => {
    const { audioEl } = ensureEngine();
    // Revoke previous object URL if we created one for the engine.
    if (_objectUrl) {
      try { URL.revokeObjectURL(_objectUrl); } catch { /* ignore */ }
      _objectUrl = null;
    }
    _objectUrl = URL.createObjectURL(blob);
    audioEl.src = _objectUrl;
    audioEl.loop = get().isLooping;
    set({
      currentLabel: meta.label,
      currentEntryId: meta.entryId ?? null,
      hasTrack: true,
      currentTime: 0,
    });
    try {
      // Wait for metadata so duration is known.
      await new Promise<void>((resolve, reject) => {
        const onLoaded = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(new Error(audioEl.error?.message ?? 'load failed')); };
        const cleanup = () => {
          audioEl.removeEventListener('loadedmetadata', onLoaded);
          audioEl.removeEventListener('error', onErr);
        };
        audioEl.addEventListener('loadedmetadata', onLoaded);
        audioEl.addEventListener('error', onErr);
      });
      logInfo('player', `Loaded: ${meta.label} (${audioEl.duration.toFixed(2)}s)`);
    } catch (e) {
      logError('player', `Failed to load: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  play: () => {
    // play() is always invoked from a user gesture (button click,
    // keyboard shortcut, drag-drop). Mark the gesture so subsequent
    // ensureEngine() calls are allowed to resume the suspended ctx.
    _userGesture = true;
    const { audioEl, ctx } = ensureEngine();
    if (!audioEl.src) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => { /* swallowed; will retry */ });
    }
    void audioEl.play().catch((err) => {
      logError('player', `Play rejected: ${err instanceof Error ? err.message : String(err)}`);
    });
  },

  pause: () => {
    const { audioEl } = ensureEngine();
    audioEl.pause();
  },

  toggle: () => {
    const { audioEl } = ensureEngine();
    if (!audioEl.src) return;
    if (audioEl.paused) get().play();
    else get().pause();
  },

  stop: () => {
    const { audioEl } = ensureEngine();
    audioEl.pause();
    audioEl.currentTime = 0;
    set({ currentTime: 0, isPlaying: false });
  },

  seek: (sec) => {
    const { audioEl } = ensureEngine();
    if (!Number.isFinite(sec)) return;
    audioEl.currentTime = Math.max(0, Math.min(audioEl.duration || 0, sec));
    set({ currentTime: audioEl.currentTime });
  },

  seekByFraction: (frac) => {
    const { audioEl } = ensureEngine();
    const dur = audioEl.duration || 0;
    if (!dur) return;
    const target = Math.max(0, Math.min(1, frac)) * dur;
    audioEl.currentTime = target;
    set({ currentTime: target });
  },

  toggleLoop: () => {
    const next = !get().isLooping;
    set({ isLooping: next });
    const { audioEl } = ensureEngine();
    audioEl.loop = next;
  },

  setMasterGain: (gain) => {
    const { master, ctx } = ensureEngine();
    master.gain.setTargetAtTime(Math.max(0, gain), ctx.currentTime, 0.01);
  },
}));

/** One-shot analyser sample helpers, used by the visualizer + HUD. */
export const samplePeakAndRMS = (): { peakDb: number; rmsDb: number; peak: number; rms: number } => {
  const analyser = getAnalyser();
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = buf[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / buf.length);
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  return { peakDb, rmsDb, peak, rms };
};
