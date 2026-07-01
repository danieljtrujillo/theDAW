import React from 'react';
import {
  Circle,
  Headphones,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
} from 'lucide-react';
import { dawImportAudioUrl } from '../../lib/dawImportClient';
import type { DawClip, DawProject, DawTrack } from '../../lib/dawImportClient';
import { performScenes, performSceneCount, performTracks } from '../../lib/performModel';
import { getEngineCtx, getMasterGain } from '../../state/playerStore';
import { renderNotesToBlob, type RenderNote } from '../../lib/midiSynth';
import { subscribeToMidi } from '../../state/midiBus';
import { subscribeSwayValue } from '../../state/swayBus';
import { enableMidi } from '../../state/midiTriggerStore';
import { usePerformRoutingStore, ctrlMatches } from '../../state/performRouting';
import { logError } from '../../state/logStore';

type ClipLookup = Map<string, DawClip>;

interface SessionPlayer {
  source: AudioBufferSourceNode;
  analyser?: AnalyserNode;
  gain?: GainNode;
  trackIndex: number;
  /** The track's index in the mixer/track list (performTracks order), used to
   *  apply live Sway modulation to the right column's gain. */
  mixIndex: number;
}

type ClipBufferCache = Map<string, Promise<AudioBuffer>>;

const CLIP_COLORS = [
  {
    clip: 'bg-[#7864ff] border-[#9f91ff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#7864ff]',
  },
  {
    clip: 'bg-[#ff3232] border-[#ff7474] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#ff3232]',
  },
  {
    clip: 'bg-[#11c6aa] border-[#5af5dc] text-black',
    header: 'bg-[#c1aa31] text-black',
    scene: 'bg-[#11c6aa]',
  },
  {
    clip: 'bg-[#d9d9d9] border-white/80 text-black',
    header: 'bg-[#ff3232] text-black',
    scene: 'bg-[#d9d9d9]',
  },
  {
    clip: 'bg-[#91a7ff] border-[#c1cdff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#91a7ff]',
  },
  {
    clip: 'bg-[#66ff50] border-[#a2ff92] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#66ff50]',
  },
  {
    clip: 'bg-[#28f0b8] border-[#84ffe1] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#28f0b8]',
  },
  {
    clip: 'bg-[#91a7ff] border-[#c1cdff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#91a7ff]',
  },
];

const clipKey = (trackIndex: number, sceneIndex: number) => `${trackIndex}:${sceneIndex}`;

const dbToVolume = (db: number): number => {
  if (!Number.isFinite(db)) return 1;
  return Math.min(1, Math.max(0, 10 ** (db / 20)));
};

/** A clip is playable if it has audio on disk or MIDI notes to render. */
const isPlayableClip = (clip: DawClip): boolean =>
  !!clip.file_path || !!(clip.midi_notes && clip.midi_notes.length);

/** Cache key: the audio URL for audio clips, or a stable MIDI key otherwise. */
const clipCacheKey = (clip: DawClip): string =>
  clip.file_path
    ? dawImportAudioUrl(clip.file_path)
    : `midi:${clip.track_index ?? '?'}:${clip.scene_index ?? clip.slot_index ?? '?'}:${clip.name}`;

/** DAW MIDI-note dicts -> synth RenderNote[] (start/duration in seconds). */
const notesFromDawClip = (clip: DawClip): RenderNote[] => {
  if (!Array.isArray(clip.midi_notes)) return [];
  return clip.midi_notes.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const note = raw as Record<string, unknown>;
    const midi = Number(note.midi ?? note.note ?? note.pitch);
    const startSec = Number(note.startSec ?? note.start_sec ?? note.start ?? 0);
    const durationSec = Number(note.durationSec ?? note.duration_sec ?? note.duration ?? 0.25);
    const velocityRaw = Number(note.velocity ?? 0.8);
    if (!Number.isFinite(midi) || !Number.isFinite(startSec) || !Number.isFinite(durationSec)) return [];
    return [{
      midi,
      startSec: Math.max(0, startSec),
      durationSec: Math.max(0.02, durationSec),
      velocity: velocityRaw <= 1 ? Math.round(velocityRaw * 127) : Math.round(velocityRaw),
    }];
  });
};

const linearToDb = (value: number): number => {
  if (value <= 0.0001) return -72;
  return Math.max(-72, Math.min(6, 20 * Math.log10(value)));
};

const meterHeight = (level: number): string => `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;

const stopSessionPlayers = (players: SessionPlayer[]) => {
  players.forEach((player) => {
    try { player.source.onended = null; player.source.stop(); } catch { /* already stopped */ }
    try { player.source.disconnect(); } catch { /* already disconnected */ }
    player.analyser?.disconnect();
    player.gain?.disconnect();
  });
};

interface DawSessionGridProps {
  project: DawProject;
  fill?: boolean;
}

export const DawSessionGrid: React.FC<DawSessionGridProps> = ({ project, fill = false }) => {
  const [activeScene, setActiveScene] = React.useState<number | null>(null);
  const [selectedScene, setSelectedScene] = React.useState(0);
  const [launchError, setLaunchError] = React.useState<string | null>(null);
  const [lastAction, setLastAction] = React.useState<string | null>(null);
  const [trackLevels, setTrackLevels] = React.useState<number[]>([]);
  const [masterLevel, setMasterLevel] = React.useState(0);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const playersRef = React.useRef<SessionPlayer[]>([]);
  const bufferCacheRef = React.useRef<ClipBufferCache>(new Map());
  const launchTokenRef = React.useRef(0);
  const animationRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef<number | null>(null);
  const meterDataRef = React.useRef(new Uint8Array(0));
  // Per-mixer-column live modulation from the Sway dims (0..1 volume multiplier
  // + mute), applied on top of the clip's base track gain. Persists across scene
  // launches so a held hand position keeps modulating the next scene.
  const mixRef = React.useRef<Map<number, { vol: number; mute: boolean }>>(new Map());

  const tracks = React.useMemo(() => performTracks(project), [project]);

  React.useEffect(() => {
    setTrackLevels(Array.from({ length: tracks.length }, () => 0));
  }, [tracks.length]);

  const clipLookup = React.useMemo<ClipLookup>(() => {
    const lookup: ClipLookup = new Map();
    tracks.forEach((track, fallbackTrackIndex) => {
      track.clips.forEach((clip) => {
        const trackIndex = clip.track_index ?? fallbackTrackIndex;
        const sceneIndex = clip.scene_index ?? clip.slot_index;
        if (sceneIndex == null) return;
        lookup.set(clipKey(trackIndex, sceneIndex), clip);
      });
    });
    return lookup;
  }, [tracks]);

  const sceneCount = React.useMemo(() => performSceneCount(project), [project]);

  const scenes = React.useMemo(() => performScenes(project), [project]);

  const stopMeters = React.useCallback(() => {
    if (animationRef.current != null) window.cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    startedAtRef.current = null;
    setElapsedSeconds(0);
    setMasterLevel(0);
    setTrackLevels(Array.from({ length: tracks.length }, () => 0));
  }, [tracks.length]);

  const stopScene = React.useCallback(() => {
    stopSessionPlayers(playersRef.current);
    playersRef.current = [];
    setActiveScene(null);
    stopMeters();
  }, [stopMeters]);

  React.useEffect(() => stopScene, [stopScene]);

  const sceneClips = React.useCallback(
    (sceneIndex: number) =>
      tracks.flatMap((track, fallbackTrackIndex) => {
        const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? fallbackTrackIndex;
        const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
        return clip && isPlayableClip(clip)
          ? [{ clip, track, trackIndex, mixIndex: fallbackTrackIndex }]
          : [];
      }),
    [clipLookup, tracks],
  );

  const getClipBuffer = React.useCallback((clip: DawClip): Promise<AudioBuffer> => {
    const key = clipCacheKey(clip);
    const cached = bufferCacheRef.current.get(key);
    if (cached) return cached;
    const task = (async () => {
      const context = getEngineCtx();
      if (clip.file_path) {
        const response = await fetch(dawImportAudioUrl(clip.file_path));
        if (!response.ok) throw new Error(`clip fetch ${response.status}`);
        return context.decodeAudioData(await response.arrayBuffer());
      }
      // MIDI clip: render its notes to audio so session cells still play.
      const notes = notesFromDawClip(clip);
      if (notes.length === 0) throw new Error('clip has no audio or notes');
      const rendered = await renderNotesToBlob(notes, { tailSec: 0.2 });
      return context.decodeAudioData(await rendered.blob.arrayBuffer());
    })();
    bufferCacheRef.current.set(key, task);
    task.catch(() => bufferCacheRef.current.delete(key));
    return task;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const seen = new Set<string>();
    const clips = tracks.flatMap((track) =>
      track.clips.filter((clip) => {
        if (!isPlayableClip(clip)) return false;
        const key = clipCacheKey(clip);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
    const warm = async () => {
      for (let index = 0; index < clips.length && !cancelled; index += 2) {
        await Promise.allSettled(clips.slice(index, index + 2).map(getClipBuffer));
      }
    };
    if (clips.length > 0) void warm();
    return () => { cancelled = true; };
  }, [getClipBuffer, tracks]);

  const tickMeters = React.useCallback(() => {
    const players = playersRef.current;
    const next = Array.from({ length: tracks.length }, () => 0);
    players.forEach((player) => {
      const analyser = player.analyser;
      if (!analyser) return;
      if (meterDataRef.current.length !== analyser.fftSize) {
        meterDataRef.current = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteTimeDomainData(meterDataRef.current);
      let sum = 0;
      for (let i = 0; i < meterDataRef.current.length; i += 1) {
        const centered = (meterDataRef.current[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / meterDataRef.current.length);
      next[player.trackIndex] = Math.max(next[player.trackIndex] ?? 0, Math.min(1, rms * 5.5));
    });
    setTrackLevels((previous) => next.map((level, index) => Math.max(level, (previous[index] ?? 0) * 0.72)));
    setMasterLevel((previous) => {
      const peak = Math.max(0, ...next);
      return Math.max(peak, previous * 0.76);
    });
    if (startedAtRef.current != null) setElapsedSeconds((performance.now() - startedAtRef.current) / 1000);
    animationRef.current = window.requestAnimationFrame(tickMeters);
  }, [tracks.length]);

  const launchScene = React.useCallback(
    async (sceneIndex: number) => {
      const launchToken = launchTokenRef.current + 1;
      launchTokenRef.current = launchToken;
      stopScene();
      setLaunchError(null);
      const clips = sceneClips(sceneIndex);
      if (clips.length === 0) {
        setActiveScene(sceneIndex);
        return;
      }
      const context = getEngineCtx();
      if (context.state === 'suspended') await context.resume();
      // Decode each clip independently: one bad/missing clip must not stop the
      // rest of the scene from playing. Play what decoded, and log the specific
      // reason for each that failed so the cause is visible in the log.
      const results = await Promise.all(
        clips.map(async ({ clip, track, trackIndex, mixIndex }) => {
          try {
            return { ok: true as const, buffer: await getClipBuffer(clip), track, trackIndex, mixIndex };
          } catch (e) {
            return { ok: false as const, clip, reason: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      if (launchTokenRef.current !== launchToken) return;
      const decoded = results.filter(
        (r): r is { ok: true; buffer: AudioBuffer; track: DawTrack; trackIndex: number; mixIndex: number } => r.ok,
      );
      const failedClips = results.filter((r): r is { ok: false; clip: DawClip; reason: string } => !r.ok);
      for (const f of failedClips) {
        logError('perform', `Clip "${f.clip.name}" could not play: ${f.reason}`);
      }
      const failed = failedClips.length;
      const startAt = context.currentTime + 0.01;
      const nextPlayers = decoded.map(({ buffer, track, trackIndex, mixIndex }) => {
        const source = context.createBufferSource();
        const gain = context.createGain();
        const analyser = context.createAnalyser();
        source.buffer = buffer;
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.62;
        const mix = mixRef.current.get(mixIndex);
        const volMul = mix?.vol ?? 1;
        const muted = mix?.mute ?? false;
        gain.gain.value = dbToVolume(track.volume_db) * volMul * (muted ? 0 : 1);
        source.connect(gain);
        gain.connect(analyser);
        analyser.connect(getMasterGain());
        source.start(startAt);
        return { source, gain, analyser, trackIndex, mixIndex };
      });
      playersRef.current = nextPlayers;
      setActiveScene(sceneIndex);
      startedAtRef.current = performance.now();
      if (animationRef.current == null) animationRef.current = window.requestAnimationFrame(tickMeters);
      setLaunchError(
        failed > 0 ? `${failed} of ${results.length} clip(s) could not be played.` : null,
      );
    },
    [getClipBuffer, sceneClips, stopScene, tickMeters],
  );

  // --- Live modulation from the Sway dims ------------------------------------
  // The hand-tracking dimensions (strike / sway / pulse / glide / press / sculpt)
  // route to a Perform-mix function (a track's volume or mute) via the routing
  // panel. Reading swayBus's normalized 0..1 values here applies them to the live
  // track gains and to the mix layer future scene launches inherit.
  const tracksRef = React.useRef(tracks);
  React.useEffect(() => { tracksRef.current = tracks; }, [tracks]);

  const applyMixToTrack = React.useCallback((mixIndex: number) => {
    const track = tracksRef.current[mixIndex];
    if (!track) return;
    const mix = mixRef.current.get(mixIndex);
    const vol = mix?.vol ?? 1;
    const muted = mix?.mute ?? false;
    const target = dbToVolume(track.volume_db) * vol * (muted ? 0 : 1);
    const context = getEngineCtx();
    for (const player of playersRef.current) {
      if (player.mixIndex === mixIndex && player.gain) {
        player.gain.gain.setTargetAtTime(target, context.currentTime, 0.02);
      }
    }
  }, []);

  React.useEffect(() => {
    const unsub = subscribeSwayValue((dim, value) => {
      const mods = usePerformRoutingStore.getState().trackMods.filter((m) => m.dim === dim);
      if (mods.length === 0) return;
      for (const m of mods) {
        const cur = mixRef.current.get(m.trackIndex) ?? { vol: 1, mute: false };
        if (m.target === 'volume') cur.vol = value;
        else cur.mute = value > 0.5;
        mixRef.current.set(m.trackIndex, cur);
        applyMixToTrack(m.trackIndex);
      }
    });
    return unsub;
  }, [applyMixToTrack]);

  // Removing a modulation route returns its track to neutral, so a track never
  // stays stuck at the last modulated gain/mute after its mod is deleted.
  const trackMods = usePerformRoutingStore((s) => s.trackMods);
  React.useEffect(() => {
    const modVol = new Set(trackMods.filter((m) => m.target === 'volume').map((m) => m.trackIndex));
    const modMute = new Set(trackMods.filter((m) => m.target === 'mute').map((m) => m.trackIndex));
    for (const [index, mix] of mixRef.current) {
      let changed = false;
      if (!modVol.has(index) && mix.vol !== 1) { mix.vol = 1; changed = true; }
      if (!modMute.has(index) && mix.mute) { mix.mute = false; changed = true; }
      if (changed) applyMixToTrack(index);
    }
  }, [trackMods, applyMixToTrack]);

  // --- Live scene control from assigned Sway controls ------------------------
  // Assignments live in performRouting: Scene Select moves the highlighted scene,
  // Launch fires it, plus Stop / Scene +/- and direct per-scene controls. Pads
  // deliberately do NOT launch scenes. Refs keep the one MIDI subscription stable
  // across renders; learn is armed from the routing panel and captured here.
  const launchSceneRef = React.useRef(launchScene);
  const stopSceneRef = React.useRef(stopScene);
  const sceneCountRef = React.useRef(sceneCount);
  const selectedSceneRef = React.useRef(selectedScene);
  React.useEffect(() => { launchSceneRef.current = launchScene; }, [launchScene]);
  React.useEffect(() => { stopSceneRef.current = stopScene; }, [stopScene]);
  React.useEffect(() => { sceneCountRef.current = sceneCount; }, [sceneCount]);
  React.useEffect(() => { selectedSceneRef.current = selectedScene; }, [selectedScene]);

  // Keep the highlighted scene inside range when a smaller project loads.
  React.useEffect(() => {
    setSelectedScene((prev) => Math.min(Math.max(0, prev), Math.max(0, sceneCount - 1)));
  }, [sceneCount]);

  const selectAndLaunch = React.useCallback((index: number) => {
    const clamped = Math.min(Math.max(0, index), Math.max(0, sceneCountRef.current - 1));
    setSelectedScene(clamped);
    setLastAction(`Launch ${clamped + 1}`);
    void launchSceneRef.current(clamped);
  }, []);

  React.useEffect(() => {
    void enableMidi();
    const unsub = subscribeToMidi((msg) => {
      const data = msg.data;
      const status = data[0] ?? 0;
      const cmd = status & 0xf0;
      const ch = status & 0x0f;
      const isCc = cmd === 0xb0;
      const isNoteOn = cmd === 0x90 && (data[2] ?? 0) > 0;
      if (!isCc && !isNoteOn) return; // note-off / aftertouch / etc. ignored
      const num = data[1] ?? 0;
      const val = data[2] ?? 0;
      const st = usePerformRoutingStore.getState();

      // Learn: bind the armed function/scene to this control, then disarm.
      if (st.learn) {
        const ctrl = { isNote: isNoteOn, channel: ch, number: num };
        if (st.learn.kind === 'fn') st.bindFn(st.learn.fn, ctrl);
        else st.bindScene(st.learn.scene, ctrl);
        return;
      }

      const count = sceneCountRef.current;
      if (count <= 0) return;

      // Scene Select encoder (CC): map its value across the scene range.
      const sel = st.transport.select;
      if (sel && isCc && ctrlMatches(sel, false, ch, num)) {
        const idx = Math.min(count - 1, Math.max(0, Math.round((val / 127) * (count - 1))));
        setSelectedScene(idx);
        setLastAction(`Select ${idx + 1}`);
        return;
      }

      // Everything else triggers on activation (note-on, or a CC button > 0).
      const activated = isNoteOn || (isCc && val > 0);
      if (!activated) return;
      const msgIsNote = isNoteOn;

      // Direct per-scene launch.
      for (const [key, ctrl] of Object.entries(st.sceneCtrls)) {
        if (ctrlMatches(ctrl, msgIsNote, ch, num)) {
          selectAndLaunch(Number(key));
          return;
        }
      }

      const { transport } = st;
      if (transport.launch && ctrlMatches(transport.launch, msgIsNote, ch, num)) {
        selectAndLaunch(selectedSceneRef.current);
      } else if (transport.stop && ctrlMatches(transport.stop, msgIsNote, ch, num)) {
        setLastAction('Stop');
        stopSceneRef.current();
      } else if (transport.next && ctrlMatches(transport.next, msgIsNote, ch, num)) {
        selectAndLaunch(selectedSceneRef.current + 1);
      } else if (transport.prev && ctrlMatches(transport.prev, msgIsNote, ch, num)) {
        selectAndLaunch(selectedSceneRef.current - 1);
      }
    });
    return unsub;
  }, [selectAndLaunch]);

  const launchPreviousScene = () => {
    if (scenes.length === 0) return;
    selectAndLaunch((activeScene ?? selectedScene) - 1);
  };

  const launchNextScene = () => {
    if (scenes.length === 0) return;
    selectAndLaunch((activeScene ?? selectedScene) + 1);
  };

  if (tracks.length === 0 || scenes.length === 0) return null;

  const activeSceneName = activeScene == null ? 'Stopped' : scenes[activeScene];
  const masterDb = linearToDb(masterLevel);
  const masterMeterLabel = masterDb <= -71 ? '-inf' : masterDb.toFixed(1);

  return (
    <div className={`border border-white/10 bg-[#2f3238] overflow-hidden ${fill ? 'h-full flex flex-col' : ''}`}>
      <div className="shrink-0 flex items-center gap-1 border-b border-black/70 bg-[#202329] px-2 py-1 text-[10px] font-bold text-zinc-200">
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          4 / 4
        </div>
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          1 Bar
        </div>
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          {project.tempo.toFixed(2)}
        </div>
        <div
          className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] font-mono text-[9px]"
          title="Scene launch is driven by the controls you assign in Perform Routing: turn the assigned encoder to select, push to launch. Pads stay free for MIDI / modulation."
        >
          <span className={lastAction ? 'text-emerald-300' : 'text-zinc-400'}>
            {`Sel ${selectedScene + 1}${lastAction ? ` · ${lastAction}` : ''}`}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void launchPreviousScene()}
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300 hover:bg-[#3a3d45] hover:text-white"
            aria-label="Launch previous scene"
            title="Previous scene"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => selectAndLaunch(activeScene ?? selectedScene)}
            className="h-7 w-8 grid place-items-center border border-emerald-900/70 bg-[#113525] text-emerald-300 hover:bg-[#185239]"
            aria-label="Play session"
            title="Play selected scene"
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
          <button
            type="button"
            onClick={stopScene}
            className="h-7 w-8 grid place-items-center border border-red-900/70 bg-[#3a1719] text-red-200 hover:bg-[#5a2024]"
            aria-label="Stop session"
            title="Stop all clips"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
          <button
            type="button"
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-400"
            aria-label="Record arm"
            title="Record arm placeholder"
          >
            <Circle className="h-3.5 w-3.5 fill-current text-zinc-500" />
          </button>
          <button
            type="button"
            onClick={() => void launchNextScene()}
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300 hover:bg-[#3a3d45] hover:text-white"
            aria-label="Launch next scene"
            title="Next scene"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="ml-2 h-7 min-w-32 px-2 flex items-center justify-between border border-black/50 bg-[#15171b] font-mono text-[10px] text-zinc-300">
          <span>{elapsedSeconds.toFixed(1)}</span>
          <span className="text-zinc-500">sec</span>
        </div>
        <div className="h-7 min-w-48 px-2 flex items-center border border-black/50 bg-[#15171b] font-mono text-[10px] text-zinc-300">
          <span className={activeScene == null ? 'text-zinc-500' : 'text-emerald-200'}>{activeSceneName}</span>
        </div>
      </div>

      <div className={`overflow-auto ${fill ? 'flex-1 min-h-0' : 'max-h-140'}`}>
        <div
          className="grid min-w-245"
          style={{
            gridTemplateColumns: `118px repeat(${tracks.length}, minmax(116px, 1fr)) 86px`,
          }}
        >
          <div className="sticky left-0 z-20 bg-[#202329] border-r-2 border-b-2 border-black/70 px-2 py-1.5 text-[9px] font-bold text-zinc-300">
            Scenes
          </div>
          {tracks.map((track, trackIndex) => {
            const color = CLIP_COLORS[trackIndex % CLIP_COLORS.length];
            return (
              <div
                key={`${track.name}-${trackIndex}`}
                className={`${color.header} border-r-2 border-b-2 border-black/70 px-1.5 py-1 min-w-0`}
              >
                <div className="text-[10px] font-black truncate">{String(trackIndex + 1).padStart(2, '0')} {track.name}</div>
                <div className="text-[8px] font-mono opacity-70 uppercase">{track.type}</div>
              </div>
            );
          })}
          <div className="bg-[#afd4dc] text-black border-b-2 border-black/70 px-1.5 py-1 text-[10px] font-black">
            Main
          </div>

          {scenes.map((sceneName, sceneIndex) => {
            const sceneColor = CLIP_COLORS[sceneIndex % CLIP_COLORS.length].scene;
            const hasClips = sceneClips(sceneIndex).length > 0;
            return (
              <React.Fragment key={`${sceneName}-${sceneIndex}`}>
                <button
                  type="button"
                  onClick={() => selectAndLaunch(sceneIndex)}
                  disabled={!hasClips}
                  className={[
                    'sticky left-0 z-10 min-h-7 border-r-2 border-b border-black/70 px-1.5 text-left',
                    activeScene === sceneIndex
                      ? 'bg-[#2affb0] text-black'
                      : selectedScene === sceneIndex
                        ? 'bg-[#3b3f47] text-emerald-200 ring-1 ring-inset ring-emerald-400/70'
                        : 'bg-[#3b3f47] text-zinc-200 hover:bg-[#4a4f59]',
                    !hasClips ? 'opacity-45 cursor-not-allowed' : '',
                  ].join(' ')}
                  aria-label={`Launch ${sceneName}`}
                  title="Launch scene (also sets it as the highlighted scene)"
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <Play className="h-3 w-3 fill-current shrink-0" />
                    <span className="truncate text-[10px] font-bold">{String(sceneIndex + 1).padStart(2, '0')} {sceneName}</span>
                  </div>
                </button>
                {tracks.map((track, fallbackTrackIndex) => {
                  const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? fallbackTrackIndex;
                  const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
                  const color = CLIP_COLORS[sceneIndex % CLIP_COLORS.length];
                  return (
                    <div
                      key={`${trackIndex}-${sceneIndex}`}
                      className={[
                        'border-r-2 border-b border-black/70 min-h-7 bg-[#30343b]',
                        activeScene === sceneIndex ? 'ring-1 ring-inset ring-emerald-200' : '',
                      ].join(' ')}
                    >
                      {clip ? (
                        <button
                          type="button"
                          onClick={() => selectAndLaunch(sceneIndex)}
                          disabled={!clip.file_path}
                          className={[
                            'h-7 w-full px-1.5 flex items-center gap-1 border text-left',
                            color.clip,
                            !clip.file_path ? 'opacity-45 cursor-not-allowed' : 'hover:brightness-110',
                          ].join(' ')}
                          title={clip.name}
                        >
                          <Play className="h-3 w-3 fill-current shrink-0" />
                          <span className="min-w-0 truncate text-[10px] font-bold">{clip.name}</span>
                        </button>
                      ) : (
                        <div className="h-7 bg-[#262a31] border border-black/20" />
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => selectAndLaunch(sceneIndex)}
                  disabled={!hasClips}
                  className={[
                    'min-h-7 border-b border-black/70 px-1.5 flex items-center gap-1 text-black',
                    sceneColor,
                    activeScene === sceneIndex ? 'brightness-125' : 'hover:brightness-110',
                    !hasClips ? 'opacity-45 cursor-not-allowed' : '',
                  ].join(' ')}
                  aria-label={`Launch main scene ${sceneName}`}
                >
                  <Play className="h-3 w-3 fill-current shrink-0" />
                  <span className="min-w-0 truncate text-[10px] font-bold">{String(sceneIndex + 1).padStart(2, '0')} {sceneName}</span>
                </button>
              </React.Fragment>
            );
          })}

          <div className="sticky left-0 z-10 bg-[#3b3f47] border-r-2 border-t-2 border-black/70 px-2 py-2 text-[9px] font-bold text-zinc-200">
            Mixer
          </div>
          {tracks.map((track, trackIndex) => (
            <TrackMixer
              key={`mixer-${track.name}-${trackIndex}`}
              track={track}
              trackNumber={trackIndex + 1}
              level={trackLevels[trackIndex] ?? 0}
            />
          ))}
          <div className="bg-[#454a54] border-t-2 border-black/70 px-2 py-2">
            <div className="flex items-end justify-center gap-2">
              <div className="h-28 w-5 border border-black/80 bg-[#101215] p-px flex items-end">
                <div className="w-full bg-linear-to-t from-emerald-500 via-lime-400 to-red-500" style={{ height: meterHeight(masterLevel) }} />
              </div>
              <div className="min-w-0">
                <div className="mb-1 rounded bg-[#202329] px-1 py-0.5 text-center text-[9px] font-mono text-zinc-100">
                  {masterMeterLabel}
                </div>
                <div className="text-[10px] font-black text-zinc-100">Main</div>
                <div className="text-[8px] font-mono text-zinc-400">1 / 2</div>
              </div>
            </div>
            <button
              type="button"
              onClick={stopScene}
              className="mt-2 h-7 w-full border border-red-900/70 bg-[#3a1719] text-[9px] font-black uppercase tracking-wider text-red-100 hover:bg-[#5a2024]"
            >
              Stop All
            </button>
          </div>
        </div>
      </div>

      {launchError && (
        <div className="shrink-0 border-t border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[8px] font-mono text-amber-100">
          {launchError}
        </div>
      )}
    </div>
  );
};

const TrackMixer: React.FC<{ track: DawTrack; trackNumber: number; level: number }> = ({
  track,
  trackNumber,
  level,
}) => {
  const db = linearToDb(level);
  const label = db <= -71 ? '-inf' : db.toFixed(1);
  return (
    <div className="bg-[#343841] border-r-2 border-t-2 border-black/70 px-2 py-2 min-w-0">
      <div className="h-16 border border-black/80 bg-[#1b1e23] px-1 py-1 text-[8px] font-bold text-zinc-200">
        <div className="flex items-center justify-between gap-1">
          <span>Audio From</span>
          <span className="text-zinc-500">Ext. In</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1">
          <span>Monitor</span>
          <span className="text-zinc-500">Auto</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1">
          <span>Audio To</span>
          <span className="text-zinc-500">Main</span>
        </div>
      </div>
      <div className="mt-2 flex items-end justify-center gap-2">
        <div className="flex flex-col items-center gap-1">
          <div className="rounded bg-[#15171b] px-1 py-0.5 text-[9px] font-mono text-zinc-100">
            {label}
          </div>
          <div className="h-7 w-7 rounded-full border-2 border-black/80 bg-[#242832] grid place-items-center">
            <div className="h-3 w-px bg-zinc-300" style={{ transform: `rotate(${track.pan * 55}deg)`, transformOrigin: '50% 100%' }} />
          </div>
          <div className="h-6 w-6 grid place-items-center bg-pink-300 text-[11px] font-black text-black">
            {trackNumber}
          </div>
          <div className="flex gap-1">
            <button type="button" className="h-5 w-6 bg-[#202329] text-[9px] font-bold text-zinc-300">
              S
            </button>
            <button type="button" className="h-5 w-6 bg-[#202329] text-[9px] font-bold text-zinc-300">
              {track.mute ? 'M' : <Headphones className="mx-auto h-3 w-3" />}
            </button>
          </div>
        </div>
        <div className="h-28 w-5 border border-black/80 bg-[#101215] p-px flex items-end">
          <div className="w-full bg-linear-to-t from-emerald-500 via-lime-400 to-red-500" style={{ height: meterHeight(level) }} />
        </div>
        <div className="h-28 w-5 border border-black/80 bg-[#15171b] relative">
          <div className="absolute inset-x-1 bg-zinc-300" style={{ top: `${Math.round((1 - dbToVolume(track.volume_db)) * 76 + 16)}%`, height: 6 }} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[8px] font-mono text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <Volume2 className="h-3 w-3" />
          {track.volume_db.toFixed(1)} dB
        </span>
        <span>{track.type}</span>
      </div>
    </div>
  );
};
