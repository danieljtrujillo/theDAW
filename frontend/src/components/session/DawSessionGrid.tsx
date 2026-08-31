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
import { registerPerformChainPush } from '../../state/performRailStore';
import { logError } from '../../state/logStore';
import { dawDeviceToEffectNode } from '../../lib/dawEffectMap';
import {
  buildEffectChain,
  ensureChopModule,
  ensureGranularModule,
  ensureSubharmonicModule,
  type ChainHandle,
} from '../../lib/rackEffects';
import type { ChainEntry } from '../../state/effectChainStore';

type ClipLookup = Map<string, DawClip>;

interface SessionPlayer {
  source: AudioBufferSourceNode;
  analyser?: AnalyserNode;
  gain?: GainNode;
  panner?: StereoPannerNode;
  trackIndex: number;
  /** The track's index in the mixer/track list (performTracks order), used to
   *  apply live Sway modulation to the right column's gain. */
  mixIndex: number;
  /** Which scene row this player came from, so the grid can show per-track
   *  playing state instead of one global "active scene". */
  sceneIndex: number;
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

/** Clip colour comes from Live's palette when the parser decoded one; the
 *  position-derived CLIP_COLORS entry is only a fallback now. Colour is how a
 *  performer navigates a grid at speed, so a set should look like itself. */
const clipStyle = (clip: DawClip, fallback: string): string =>
  clip.color ? 'border text-black' : fallback;

/** Tooltip that names WHY a clip can't play, instead of a bare clip name and an
 *  anonymous "N clips could not be played" banner. */
const clipTitle = (clip: DawClip): string => {
  if (isPlayableClip(clip)) return clip.name;
  return `${clip.name} — sample not found. Relink it in Live, or open the set from its Project folder.`;
};

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
      // < 1, not <= 1: a raw value of exactly 1 is a legitimate (very quiet)
      // MIDI velocity, and treating it as normalised 1.0 turned it into 127.
      velocity: velocityRaw < 1 ? Math.round(velocityRaw * 127) : Math.round(velocityRaw),
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
    // NOT the analyser: it belongs to the track's persistent FX chain and is
    // shared by every clip on that column. Disconnecting it here would sever the
    // column's output to the master bus for the rest of the session.
    player.gain?.disconnect();
    player.panner?.disconnect();
  });
};

/**
 * Build and start one clip's audio graph:
 *   source -> gain (track vol x Sway mod x mute/solo) -> panner -> analyser -> master
 *
 * Everything here was previously missing. The old body was a bare
 * `source.start(startAt)`, which meant: the whole source file played once from
 * sample zero (ignoring the clip's trim), nothing looped, mute/solo/pan never
 * reached the graph at all, and a loop recorded at another tempo played at its
 * own rate so a scene drifted apart within a bar.
 */
const startClipPlayer = (
  context: AudioContext,
  opts: {
    buffer: AudioBuffer;
    clip: DawClip;
    track: DawTrack;
    trackIndex: number;
    mixIndex: number;
    sceneIndex: number;
    startAt: number;
    projectTempo: number;
    mix?: { vol: number; mute: boolean };
    anySolo: boolean;
    /** Where this clip feeds: the track's FX-chain input, so an imported set's
     *  EQ/compression/reverb is actually in the signal path. */
    destination: AudioNode;
    /** The TRACK's analyser (post-FX), shared by every clip on that column. */
    analyser: AnalyserNode;
  },
): SessionPlayer => {
  const { buffer, clip, track, startAt, projectTempo, mix, anySolo, destination, analyser } = opts;
  const source = context.createBufferSource();
  const gain = context.createGain();
  const panner = context.createStereoPanner();
  source.buffer = buffer;

  // Warp: play the sample at the ratio between the project tempo and the tempo
  // it was recorded at. Constant-rate, which is exactly right for the
  // single-tempo loops a session grid is made of.
  if (clip.is_warped && clip.source_tempo && clip.source_tempo > 0) {
    source.playbackRate.value = projectTempo / clip.source_tempo;
  }

  // The clip is a WINDOW onto its sample: start at the trim point and run for
  // the clip's own length, not the file's.
  const maxOffset = Math.max(0, buffer.duration - 0.01);
  const offset = Math.min(Math.max(0, clip.offset_into_source ?? 0), maxOffset);
  const span = Math.max(0, (clip.end_time ?? 0) - (clip.start_time ?? 0));
  const available = Math.max(0, buffer.duration - offset);
  const duration = span > 0.02 ? Math.min(span, available) : available;

  // Loop when Live says so. `loop_on == null` means the set didn't say, so treat
  // it as a one-shot rather than looping material never meant to repeat.
  if (clip.loop_on) {
    source.loop = true;
    source.loopStart = offset;
    source.loopEnd = Math.min(buffer.duration, offset + (duration || available));
  }

  // Mute/solo are honoured here for the first time: a track muted in Live came
  // back audible, and a set with any track soloed played everything.
  const volMul = mix?.vol ?? 1;
  const modMuted = mix?.mute ?? false;
  const silencedBySolo = anySolo && !track.solo;
  const audible = !track.mute && !modMuted && !silencedBySolo;
  gain.gain.value = dbToVolume(track.volume_db) * volMul * (audible ? 1 : 0);
  panner.pan.value = Math.max(-1, Math.min(1, track.pan ?? 0));

  source.connect(gain);
  gain.connect(panner);
  // -> the track's FX chain (built once per column), which terminates in the
  // shared track analyser and then the master bus.
  panner.connect(destination);
  // A looping source ignores `duration`; a one-shot needs it to stop at the
  // clip's edge instead of running to the end of the file.
  if (source.loop) source.start(startAt, offset);
  else source.start(startAt, offset, duration || undefined);

  return {
    source,
    gain,
    panner,
    analyser,
    trackIndex: opts.trackIndex,
    mixIndex: opts.mixIndex,
    sceneIndex: opts.sceneIndex,
  };
};

interface DawSessionGridProps {
  project: DawProject;
  fill?: boolean;
}

export const DawSessionGrid: React.FC<DawSessionGridProps> = ({ project, fill = false }) => {
  const [activeScene, setActiveScene] = React.useState<number | null>(null);
  /** Which scene each column is currently playing, keyed by mixIndex. A single
   *  scalar activeScene could not represent Live's core move — holding a
   *  bassline while changing drums — so per-clip launch needs this. */
  const [trackScenes, setTrackScenes] = React.useState<Record<number, number>>({});
  /** Launch quantization in bars; 0 = launch immediately. */
  const [quantizeBars, setQuantizeBars] = React.useState(1);
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
  // Note-driven ccMods with `latch: true` that are currently toggled ON,
  // keyed by mod id. Session-only state, cleared when the mod disappears.
  const latchedRef = React.useRef<Set<string>>(new Set());

  // The worklet-backed rack stages (chop, Ares grains, the Kargyraa Sub
  // octave divider) degrade to passthrough/silence when their module is not
  // registered on the context. EDIT preloads them; PERFORM must too, or a
  // .tasmo chain using them plays defanged until the user visits EDIT.
  React.useEffect(() => {
    const ctx = getEngineCtx();
    void ensureChopModule(ctx).catch(() => {});
    void ensureGranularModule(ctx).catch(() => {});
    void ensureSubharmonicModule(ctx).catch(() => {});
  }, []);

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

  /* --- Per-track FX chains -------------------------------------------------
     Perform playback used to be completely dry: `grep device` over this file
     returned nothing, so an imported set's EQ, compression and reverb were
     parsed, mapped by dawEffectMap, and then never instantiated. Only the
     .tasmo conversion path ever called dawDeviceToEffectNode.

     One persistent chain per column, built lazily and reused across launches
     (rebuilding per clip would re-generate reverb IRs on every cell press). The
     chain terminates in the track's analyser, so metering is post-FX and every
     clip on a column shares one meter.

     Instruments are skipped at connect time rather than filtered out of
     track.devices — swayImportResolve.ts indexes fxChain by the FLATTENED device
     order, so removing elements would silently misalign controller mappings. */
  const trackChainsRef = React.useRef<
    Map<number, { input: GainNode; output: GainNode; analyser: AnalyserNode; handle: ChainHandle | null }>
  >(new Map());

  const ensureTrackChain = React.useCallback(
    (mixIndex: number, track: DawTrack) => {
      const existing = trackChainsRef.current.get(mixIndex);
      if (existing) return existing;
      const context = getEngineCtx();
      const input = context.createGain();
      const output = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.62;
      output.connect(analyser);
      analyser.connect(getMasterGain());

      let handle: ChainHandle | null = null;
      const entries: ChainEntry[] = (track.devices ?? [])
        .filter((d) => !d.is_instrument && !d.is_rack)
        .map((d, i) => {
          const node = dawDeviceToEffectNode(d);
          return {
            id: `perform-${mixIndex}-${i}`,
            effect: node.effect_name,
            params: node.parameters ?? {},
            enabled: !node.bypass,
          } as ChainEntry;
        })
        // VST3/AU cannot run in the live Web Audio graph (buildEffectChain only
        // knows the rack effects), so they are inert here exactly as they are on
        // the EDIT timeline.
        .filter((e) => e.effect !== 'vst3');
      try {
        handle = buildEffectChain(context, input, output, entries);
      } catch (e) {
        // A chain that fails to build must not take the whole grid down —
        // fall back to a clean passthrough.
        logError('perform', `Track FX chain failed for "${track.name}": ${e instanceof Error ? e.message : String(e)}`);
        try { input.connect(output); } catch { /* already wired */ }
      }
      const made = { input, output, analyser, handle };
      trackChainsRef.current.set(mixIndex, made);
      return made;
    },
    [],
  );

  const disposeTrackChains = React.useCallback(() => {
    for (const c of trackChainsRef.current.values()) {
      try { c.handle?.dispose(); } catch { /* already gone */ }
      try { c.input.disconnect(); c.output.disconnect(); c.analyser.disconnect(); } catch { /* gone */ }
    }
    trackChainsRef.current = new Map();
  }, []);

  React.useEffect(() => disposeTrackChains, [disposeTrackChains]);

  // The right rail's PARAMS tab edits device params through this bridge —
  // same entry ids the CC routes drive, same lazily-built live chains.
  React.useEffect(() => {
    registerPerformChainPush((trackIndex, deviceIndex, params) => {
      const track = tracksRef.current[trackIndex];
      if (!track) return;
      const chain = ensureTrackChain(trackIndex, track);
      chain.handle?.updateParams(`perform-${trackIndex}-${deviceIndex}`, params);
    });
    return () => registerPerformChainPush(null);
  }, [ensureTrackChain]);

  const stopScene = React.useCallback(() => {
    stopSessionPlayers(playersRef.current);
    playersRef.current = [];
    setActiveScene(null);
    setTrackScenes({});
    stopMeters();
  }, [stopMeters]);

  /* --- Launch quantization -------------------------------------------------
     Everything used to start at `context.currentTime + 0.01`, so launching
     against something already playing landed permanently off the grid. A
     session clock is set on the first launch; later launches snap to the next
     bar line relative to it, which is what makes layering usable. The toolbar's
     quantization control feeds `quantizeBars` ('off' = launch immediately). */
  const sessionStartRef = React.useRef<number | null>(null);
  const nextLaunchTime = React.useCallback(
    (context: AudioContext): number => {
      const now = context.currentTime + 0.01;
      if (quantizeBars <= 0) return now;
      const beatSec = 60 / Math.max(20, project.tempo || 120);
      const barSec = beatSec * (project.time_signature?.[0] || 4) * quantizeBars;
      if (sessionStartRef.current == null || playersRef.current.length === 0) {
        sessionStartRef.current = now;
        return now;
      }
      const elapsed = now - sessionStartRef.current;
      const bars = Math.ceil(elapsed / barSec);
      return sessionStartRef.current + bars * barSec;
    },
    [project.tempo, project.time_signature, quantizeBars],
  );

  /** Stop just one column, leaving everything else playing. Live puts this on
   *  the track's stop button and on every empty clip slot. */
  const stopTrack = React.useCallback((mixIndex: number) => {
    const [stay, go] = playersRef.current.reduce<[SessionPlayer[], SessionPlayer[]]>(
      (acc, p) => { acc[p.mixIndex === mixIndex ? 1 : 0].push(p); return acc; },
      [[], []],
    );
    if (go.length === 0) return;
    stopSessionPlayers(go);
    playersRef.current = stay;
    setTrackScenes((prev) => {
      const next = { ...prev };
      delete next[mixIndex];
      return next;
    });
    if (stay.length === 0) setActiveScene(null);
  }, []);

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
    // Warm only clips the grid can actually LAUNCH. This iterated every clip on
    // every track — arrangement lane included, which clipLookup can never reach —
    // so importing a real set decoded hundreds of MB of PCM (~10.6 MB per stereo
    // minute per clip) and locked the tab for tens of seconds, with no progress
    // and no cancel, even for an arrangement-only set whose grid is empty.
    // getClipBuffer memoises, so a cell outside this set costs one decode on use.
    const clips = Array.from(clipLookup.values()).filter((clip) => {
      if (!isPlayableClip(clip)) return false;
      const key = clipCacheKey(clip);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const warm = async () => {
      for (let index = 0; index < clips.length && !cancelled; index += 2) {
        await Promise.allSettled(clips.slice(index, index + 2).map(getClipBuffer));
      }
    };
    if (clips.length > 0) void warm();
    return () => { cancelled = true; };
  }, [getClipBuffer, clipLookup]);

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
      // mixIndex, not trackIndex. `next` is allocated at performTracks length,
      // while trackIndex counts ALL tracks including return/master — so any
      // trackIndex past the mixer columns wrote off the end of the array and the
      // meter silently died. It only worked because Live emits returns last and
      // the parser drops groups; admitting a group type mid-list desyncs it.
      next[player.mixIndex] = Math.max(next[player.mixIndex] ?? 0, Math.min(1, rms * 5.5));
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
            return { ok: true as const, buffer: await getClipBuffer(clip), clip, track, trackIndex, mixIndex };
          } catch (e) {
            return { ok: false as const, clip, reason: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      if (launchTokenRef.current !== launchToken) return;
      const decoded = results.filter(
        (r): r is { ok: true; buffer: AudioBuffer; clip: DawClip; track: DawTrack; trackIndex: number; mixIndex: number } => r.ok,
      );
      const failedClips = results.filter((r): r is { ok: false; clip: DawClip; reason: string } => !r.ok);
      for (const f of failedClips) {
        logError('perform', `Clip "${f.clip.name}" could not play: ${f.reason}`);
      }
      const failed = failedClips.length;
      const startAt = nextLaunchTime(context);
      const anySolo = tracks.some((t, i) => (trackStateRef.current[i] ?? { solo: !!t.solo }).solo);
      const nextPlayers = decoded.map(({ buffer, clip, track, trackIndex, mixIndex }) =>
        startClipPlayer(context, {
          buffer,
          clip,
          track: displayTrack(track, mixIndex),
          trackIndex,
          mixIndex,
          sceneIndex,
          startAt,
          projectTempo: project.tempo || 120,
          mix: mixRef.current.get(mixIndex),
          destination: ensureTrackChain(mixIndex, track).input,
          analyser: ensureTrackChain(mixIndex, track).analyser,
          anySolo,
        }),
      );
      playersRef.current = nextPlayers;
      setActiveScene(sceneIndex);
      setTrackScenes(Object.fromEntries(nextPlayers.map((p) => [p.mixIndex, sceneIndex])));
      startedAtRef.current = performance.now();
      if (animationRef.current == null) animationRef.current = window.requestAnimationFrame(tickMeters);
      setLaunchError(
        failed > 0 ? `${failed} of ${results.length} clip(s) could not be played.` : null,
      );
    },
    [getClipBuffer, sceneClips, stopScene, tickMeters, tracks, project.tempo, nextLaunchTime],
  );

  /** Launch ONE cell, leaving every other column playing — Live's core move.
   *  Replaces the old behaviour where clicking any cell relaunched the whole
   *  row, so there was no way to hold a bassline while changing drums. */
  const launchClip = React.useCallback(
    async (mixIndex: number, sceneIndex: number) => {
      const entry = sceneClips(sceneIndex).find((c) => c.mixIndex === mixIndex);
      if (!entry) {
        // An empty slot IS a command in Live: it stops that track.
        stopTrack(mixIndex);
        return;
      }
      const context = getEngineCtx();
      if (context.state === 'suspended') await context.resume();
      let buffer: AudioBuffer;
      try {
        buffer = await getClipBuffer(entry.clip);
      } catch (e) {
        logError('perform', `Clip "${entry.clip.name}" could not play: ${e instanceof Error ? e.message : String(e)}`);
        setLaunchError(`"${entry.clip.name}" could not be played.`);
        return;
      }
      // Replace only this column's players.
      const stay = playersRef.current.filter((p) => p.mixIndex !== mixIndex);
      const go = playersRef.current.filter((p) => p.mixIndex === mixIndex);
      stopSessionPlayers(go);
      const player = startClipPlayer(context, {
        buffer,
        clip: entry.clip,
        track: displayTrack(entry.track, mixIndex),
        trackIndex: entry.trackIndex,
        mixIndex,
        sceneIndex,
        startAt: nextLaunchTime(context),
        projectTempo: project.tempo || 120,
        mix: mixRef.current.get(mixIndex),
        destination: ensureTrackChain(mixIndex, entry.track).input,
        analyser: ensureTrackChain(mixIndex, entry.track).analyser,
        anySolo: tracks.some((t, i) => (trackStateRef.current[i] ?? { solo: !!t.solo }).solo),
      });
      playersRef.current = [...stay, player];
      setTrackScenes((prev) => ({ ...prev, [mixIndex]: sceneIndex }));
      setLaunchError(null);
      startedAtRef.current ??= performance.now();
      if (animationRef.current == null) animationRef.current = window.requestAnimationFrame(tickMeters);
    },
    [getClipBuffer, nextLaunchTime, project.tempo, sceneClips, stopTrack, tickMeters, tracks],
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
    const modMuted = mix?.mute ?? false;
    // Fold in the track's OWN mute/solo (plus any live override from the S/M
    // buttons). This used to consider only the Sway modulation mute, so a track
    // muted in Live played anyway and solo did nothing at all.
    const st = trackStateRef.current[mixIndex] ?? { mute: !!track.mute, solo: !!track.solo };
    const anySolo = tracksRef.current.some(
      (t, i) => (trackStateRef.current[i] ?? { solo: !!t.solo }).solo,
    );
    const audible = !st.mute && !modMuted && !(anySolo && !st.solo);
    const target = dbToVolume(track.volume_db) * vol * (audible ? 1 : 0);
    const context = getEngineCtx();
    for (const player of playersRef.current) {
      if (player.mixIndex === mixIndex && player.gain) {
        player.gain.gain.setTargetAtTime(target, context.currentTime, 0.02);
      }
    }
  }, []);

  /** Live mute/solo state per mixer column, seeded from the imported project and
   *  then owned by the S/M buttons. A ref so the audio callbacks read it without
   *  re-subscribing; mirrored into state purely for rendering. */
  const trackStateRef = React.useRef<Record<number, { mute: boolean; solo: boolean }>>({});
  const [trackStateVersion, setTrackStateVersion] = React.useState(0);
  React.useEffect(() => {
    trackStateRef.current = Object.fromEntries(
      tracks.map((t, i) => [i, { mute: !!t.mute, solo: !!t.solo }]),
    );
    setTrackStateVersion((v) => v + 1);
  }, [tracks]);

  /** Re-apply every column: solo is a project-wide decision, so toggling one
   *  track changes what every other track should be doing. */
  const applyAllMix = React.useCallback(() => {
    tracksRef.current.forEach((_, i) => applyMixToTrack(i));
  }, [applyMixToTrack]);

  const toggleTrackMute = React.useCallback((mixIndex: number) => {
    const cur = trackStateRef.current[mixIndex] ?? { mute: false, solo: false };
    trackStateRef.current[mixIndex] = { ...cur, mute: !cur.mute };
    setTrackStateVersion((v) => v + 1);
    applyAllMix();
  }, [applyAllMix]);

  const toggleTrackSolo = React.useCallback((mixIndex: number) => {
    const cur = trackStateRef.current[mixIndex] ?? { mute: false, solo: false };
    trackStateRef.current[mixIndex] = { ...cur, solo: !cur.solo };
    setTrackStateVersion((v) => v + 1);
    applyAllMix();
  }, [applyAllMix]);

  /** The track as the mixer should DISPLAY it (base project state + live S/M). */
  const displayTrack = React.useCallback(
    (track: DawTrack, mixIndex: number): DawTrack => {
      void trackStateVersion; // re-read after a toggle
      const st = trackStateRef.current[mixIndex];
      return st ? { ...track, mute: st.mute, solo: st.solo } : track;
    },
    [trackStateVersion],
  );

  // Direct CC routes (auto-created from the set's own MIDI-learn mappings, or
  // assigned on the Sway deck). Ref'd so the single MIDI subscription below can
  // apply them without re-subscribing when the mix callbacks re-create.
  const applyCcModRef = React.useRef<(cm: import('../../state/performRouting').CcMod, value01: number) => void>(() => {});
  React.useEffect(() => {
    applyCcModRef.current = (cm, value01) => {
      if (cm.target === 'fx') {
        // Reach the running chain entry. The chain is built lazily on first
        // launch; ensure it here so a knob works before the first clip fires.
        const track = tracksRef.current[cm.trackIndex];
        if (!track || cm.deviceIndex == null || !cm.paramKey) return;
        const chain = ensureTrackChain(cm.trackIndex, track);
        const lo = cm.min ?? 0;
        const hi = cm.max ?? 1;
        chain.handle?.updateParams(`perform-${cm.trackIndex}-${cm.deviceIndex}`, {
          [cm.paramKey]: lo + value01 * (hi - lo),
        });
        return;
      }
      const cur = mixRef.current.get(cm.trackIndex) ?? { vol: 1, mute: false };
      if (cm.target === 'mute') cur.mute = value01 > 0.5;
      else cur.vol = value01;
      mixRef.current.set(cm.trackIndex, cur);
      applyMixToTrack(cm.trackIndex);
    };
  }, [applyMixToTrack, ensureTrackChain]);

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
  const ccMods = usePerformRoutingStore((s) => s.ccMods);
  React.useEffect(() => {
    const modVol = new Set(trackMods.filter((m) => m.target === 'volume').map((m) => m.trackIndex));
    const modMute = new Set(trackMods.filter((m) => m.target === 'mute').map((m) => m.trackIndex));
    for (const m of ccMods) {
      if (m.target === 'volume') modVol.add(m.trackIndex);
      else if (m.target === 'mute') modMute.add(m.trackIndex);
      // fx routes live in the chain, not the mix layer — nothing to neutralize here
    }
    for (const [index, mix] of mixRef.current) {
      let changed = false;
      if (!modVol.has(index) && mix.vol !== 1) { mix.vol = 1; changed = true; }
      if (!modMute.has(index) && mix.mute) { mix.mute = false; changed = true; }
      if (changed) applyMixToTrack(index);
    }
    // Latch state follows its mod: a removed/replaced punch must not leave a
    // phantom "on" that inverts the next project's toggle.
    const ids = new Set(ccMods.map((m) => m.id));
    for (const id of latchedRef.current) {
      if (!ids.has(id)) latchedRef.current.delete(id);
    }
  }, [trackMods, ccMods, applyMixToTrack]);

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
      // Note-off matters now: momentary note-driven fx punches release on it.
      const isNoteOff = cmd === 0x80 || (cmd === 0x90 && (data[2] ?? 0) === 0);
      if (!isCc && !isNoteOn && !isNoteOff) return; // aftertouch / etc. ignored
      const num = data[1] ?? 0;
      const val = data[2] ?? 0;
      const st = usePerformRoutingStore.getState();

      // Learn: bind the armed function/scene to this control, then disarm.
      // Only activations bind — a release must not capture as a phantom CC.
      if (st.learn) {
        if (isNoteOff) return;
        const ctrl = { isNote: isNoteOn, channel: ch, number: num };
        if (st.learn.kind === 'fn') st.bindFn(st.learn.fn, ctrl);
        else st.bindScene(st.learn.scene, ctrl);
        return;
      }

      // Project-derived direct routes: the imported set's own MIDI-learn
      // mappings, applied to the live Perform mix with zero setup. Checked
      // before transport so a fader CC that happens to share a number with a
      // learned button still moves the fader it was mapped to in the DAW.
      if (isCc) {
        for (const cm of st.ccMods) {
          if (cm.isNote || cm.number !== num) continue;
          if (cm.channel >= 0 && cm.channel !== ch) continue;
          applyCcModRef.current(cm, val / 127);
        }
      }

      // Note-driven routes: pad punches. Momentary (default) pushes max on
      // press and min on release; `latch` toggles max/min on each press.
      // Like the CC loop above this does not return — a note shared with a
      // sceneCtrl fires both, mirroring the CC double-fire semantics.
      if (isNoteOn || isNoteOff) {
        for (const cm of st.ccMods) {
          if (!cm.isNote || cm.number !== num) continue;
          if (cm.channel >= 0 && cm.channel !== ch) continue;
          if (cm.latch) {
            if (!isNoteOn) continue;
            const on = !latchedRef.current.has(cm.id);
            if (on) latchedRef.current.add(cm.id);
            else latchedRef.current.delete(cm.id);
            applyCcModRef.current(cm, on ? 1 : 0);
          } else {
            applyCcModRef.current(cm, isNoteOn ? 1 : 0);
          }
        }
        // A release has no further meaning — scenes/transport fire on
        // activation only, and falling through would misread vel-0 as one.
        if (isNoteOff) return;
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

  // An arrangement-only Live Set still ships 8 <Scene> elements, so the header
  // said "8 scenes / 12 tracks" and the grid below was an entirely empty wall of
  // greyed-out cells with no explanation. Say what happened and point at the
  // surface that DOES have the content.
  if (clipLookup.size === 0) {
    return (
      <div className={`border border-white/10 bg-[#2f3238] ${fill ? 'h-full' : ''} grid place-items-center p-6`}>
        <div className="flex flex-col items-center gap-2 text-center max-w-md">
          <Square className="w-6 h-6 text-zinc-600" />
          <div className="text-[11px] font-bold text-zinc-300">No session clips in this project</div>
          <p className="text-[9px] font-mono text-zinc-500 leading-relaxed">
            {`This set's ${tracks.length} track${tracks.length === 1 ? '' : 's'} put their clips on the arrangement timeline rather than in Session view, so there is nothing to launch here. Use “Edit Timeline” to open the arrangement.`}
          </p>
        </div>
      </div>
    );
  }

  const activeSceneName = activeScene == null ? 'Stopped' : scenes[activeScene];
  const masterDb = linearToDb(masterLevel);
  const masterMeterLabel = masterDb <= -71 ? '-inf' : masterDb.toFixed(1);

  return (
    <div className={`border border-white/10 bg-[#2f3238] overflow-hidden ${fill ? 'h-full flex flex-col' : ''}`}>
      <div className="shrink-0 flex items-center gap-1 border-b border-black/70 bg-[#202329] px-2 py-1 text-[10px] font-bold text-zinc-200">
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          {/* Real time signature from the set, not a hardcoded "4 / 4". */}
          {`${project.time_signature?.[0] ?? 4} / ${project.time_signature?.[1] ?? 4}`}
        </div>
        {/* Launch quantization is a real control now — it used to be the literal
            text "1 Bar" while every launch fired immediately, so layering against
            something already playing landed permanently off the grid. */}
        <label htmlFor="perform-quantize" className="sr-only">Launch quantization</label>
        <select
          id="perform-quantize"
          name="perform-quantize"
          value={quantizeBars}
          onChange={(e) => setQuantizeBars(Number(e.target.value))}
          title="Launch quantization — clips start on the next bar line so layered launches stay in time"
          className="h-6 px-2 border border-black/50 bg-[#15171b] text-zinc-300 text-[10px] font-bold outline-none cursor-pointer"
          style={{ colorScheme: 'dark' }}
        >
          <option value={0}>Off</option>
          <option value={1}>1 Bar</option>
          <option value={2}>2 Bars</option>
          <option value={4}>4 Bars</option>
        </select>
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
                        trackScenes[trackIndex] === sceneIndex ? 'ring-1 ring-inset ring-emerald-200' : '',
                      ].join(' ')}
                    >
                      {clip ? (
                        <button
                          type="button"
                          onClick={() => void launchClip(trackIndex, sceneIndex)}
                          disabled={!isPlayableClip(clip)}
                          aria-label={`Launch ${clip.name} on ${track.name}`}
                          className={[
                            'h-7 w-full px-1.5 flex items-center gap-1 border text-left',
                            clipStyle(clip, color.clip),
                            !isPlayableClip(clip) ? 'opacity-45 cursor-not-allowed' : 'hover:brightness-110',
                          ].join(' ')}
                          style={clip.color ? { backgroundColor: clip.color, borderColor: clip.color } : undefined}
                          title={clipTitle(clip)}
                        >
                          <Play className="h-3 w-3 fill-current shrink-0" />
                          <span className="min-w-0 truncate text-[10px] font-bold">{clip.name}</span>
                        </button>
                      ) : (
                        /* An empty slot is a STOP button in Live, not dead space. */
                        <button
                          type="button"
                          onClick={() => stopTrack(trackIndex)}
                          aria-label={`Stop ${track.name}`}
                          title={`Stop ${track.name}`}
                          className="h-7 w-full bg-[#262a31] border border-black/20 flex items-center justify-center text-zinc-700 hover:text-zinc-200 hover:bg-[#2f343c]"
                        >
                          <Square className="h-2.5 w-2.5 fill-current" />
                        </button>
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
              track={displayTrack(track, trackIndex)}
              trackNumber={trackIndex + 1}
              level={trackLevels[trackIndex] ?? 0}
              mixIndex={trackIndex}
              onToggleMute={toggleTrackMute}
              onToggleSolo={toggleTrackSolo}
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

const TrackMixer: React.FC<{
  track: DawTrack;
  trackNumber: number;
  level: number;
  mixIndex: number;
  onToggleMute?: (mixIndex: number) => void;
  onToggleSolo?: (mixIndex: number) => void;
}> = ({
  track,
  trackNumber,
  level,
  mixIndex,
  onToggleMute,
  onToggleSolo,
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
          {/* These had no onClick, no aria-label and no aria-pressed — the unmuted
              state was a bare Headphones SVG with no accessible name at all. They
              now reflect and drive the imported track's real state. */}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onToggleSolo?.(mixIndex)}
              aria-label={`Solo ${track.name}`}
              aria-pressed={!!track.solo}
              title={`Solo ${track.name}`}
              className={`h-5 w-6 text-[9px] font-bold ${track.solo ? 'bg-sky-400 text-black' : 'bg-[#202329] text-zinc-300 hover:text-white'}`}
            >
              S
            </button>
            <button
              type="button"
              onClick={() => onToggleMute?.(mixIndex)}
              aria-label={`${track.mute ? 'Unmute' : 'Mute'} ${track.name}`}
              aria-pressed={!!track.mute}
              title={`${track.mute ? 'Unmute' : 'Mute'} ${track.name}`}
              className={`h-5 w-6 text-[9px] font-bold ${track.mute ? 'bg-amber-400 text-black' : 'bg-[#202329] text-zinc-300 hover:text-white'}`}
            >
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
