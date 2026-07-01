/**
 * Materialize a loaded .tasmo project into the EDIT timeline.
 *
 * Opening a project must do more than preview a track list — it has to put the
 * tracks and clips into `useEditorStore` so the user can actually hear and work
 * with them. Audio clips reference on-disk files (linked, or extracted from an
 * embedded archive); those bytes are pulled through `/api/project/clip-audio`.
 * MIDI clips carrying notes are synthesized to audio so they land on the
 * timeline like any other clip. Clips with nothing loadable are skipped and
 * counted so the caller can report honestly.
 */
import {
  useEditorStore,
  computePeaks,
  type AudioClip,
  type EditorTrack,
} from '../state/editorStore';
import type { PianoNote } from '../state/pianoRollStore';
import { useAppUiStore } from '../state/appUiStore';
import { renderNotesToBlob, type RenderNote } from './midiSynth';
import {
  projectApi,
  type TasmoProjectLoaded,
  type TasmoLoadedClip,
  type TasmoLoadedTrack,
  type TasmoTrackInput,
  type TasmoClipInput,
  type EffectChainNode,
} from './projectClient';
import { getRackEffect, rackEffectDefaults } from './rackEffects';
import { EFFECT_LABELS, type ChainEntry } from '../state/effectChainStore';
import { logError, logInfo } from '../state/logStore';

const TRACK_COLORS = ['#8b5cf6', '#a855f7', '#ec4899', '#06b6d4', '#10b981', '#facc15', '#f97316', '#ef4444'];

let _seq = 0;
const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${_seq++}`;

/** dB → linear gain, clamped to the editor's 0..1 fader range. */
const dbToGain = (db: number | undefined): number => {
  if (db === undefined || !Number.isFinite(db)) return 0.8;
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)));
};

const clamp = (v: number | undefined, lo: number, hi: number, dflt: number): number =>
  v === undefined || !Number.isFinite(v) ? dflt : Math.max(lo, Math.min(hi, v));

/** Pull the first numeric value present among several candidate keys. */
const pick = (o: Record<string, number>, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
};

/**
 * Convert a clip's stored note list into absolute-seconds render notes. The
 * stored shape varies by importer, so this accepts both seconds-based
 * (start/duration) and step-based (step/length) spellings.
 */
const toRenderNotes = (raw: Array<Record<string, number>>, bpm: number): RenderNote[] => {
  const stepSec = 60 / Math.max(40, bpm) / 4; // 16th-note seconds
  const notes: RenderNote[] = [];
  for (const n of raw) {
    const midi = pick(n, 'note', 'pitch', 'midi', 'key');
    if (midi === undefined) continue;
    const startSec =
      pick(n, 'start', 'startSec', 'start_time', 'time') ??
      (pick(n, 'step') ?? 0) * stepSec;
    const durSec =
      pick(n, 'duration', 'durationSec', 'dur', 'length_sec') ??
      (pick(n, 'length') ?? 1) * stepSec;
    notes.push({
      midi: Math.round(midi),
      startSec: Math.max(0, startSec),
      durationSec: Math.max(0.02, durSec),
      velocity: clamp(pick(n, 'velocity', 'vel'), 1, 127, 100),
    });
  }
  return notes;
};

/** Best-effort step-grid view of the same notes for "Edit in Piano Roll". */
const toPianoNotes = (raw: Array<Record<string, number>>, bpm: number): PianoNote[] => {
  const stepSec = 60 / Math.max(40, bpm) / 4;
  return raw
    .map((n): PianoNote | null => {
      const note = pick(n, 'note', 'pitch', 'midi', 'key');
      if (note === undefined) return null;
      const startSec = pick(n, 'start', 'startSec', 'start_time', 'time');
      const step = startSec !== undefined ? Math.round(startSec / stepSec) : (pick(n, 'step') ?? 0);
      const durSec = pick(n, 'duration', 'durationSec', 'dur', 'length_sec');
      const length = durSec !== undefined ? Math.max(1, Math.round(durSec / stepSec)) : (pick(n, 'length') ?? 1);
      return {
        id: uid('pn'),
        note: Math.round(note),
        step: Math.max(0, step),
        length: Math.max(1, length),
        velocity: clamp(pick(n, 'velocity', 'vel'), 1, 127, 100),
      };
    })
    .filter((n): n is PianoNote => n !== null);
};

/**
 * Convert a persisted effect node into a live editor chain entry.
 *  - VST3/AU  -> a VST entry (carried so the user sees it; per-track VST is not
 *    rendered live in the editor yet, so it stays disabled = preserved).
 *  - builtin mapped to a LIVE rack effect -> enabled, real-time.
 *  - builtin mapped to a catalog id or a raw foreign name -> preserved/inactive,
 *    shown with a friendly label so nothing is hidden.
 */
const effectNodeToChainEntry = (node: EffectChainNode): ChainEntry => {
  const params = node.parameters ?? {};
  if (node.node_type === 'vst3' || node.node_type === 'audiounit') {
    const vs = node.vst_state;
    return {
      id: uid('fx'),
      effect: 'vst3',
      params,
      // VST3 can't run live in-browser, but an enabled entry is the freeze target
      // (Freeze prints it into the track stem). buildEffectChain skips it live, so
      // enabling it is harmless to playback. A source-bypassed plugin stays off.
      enabled: !node.bypass,
      vst: vs ? { plugin_path: vs.plugin_path, plugin_name: vs.plugin_name } : undefined,
      label: vs?.plugin_name || node.effect_name,
    };
  }
  const id = node.effect_name;
  const rackDef = getRackEffect(id);
  if (rackDef) {
    return {
      id: uid('fx'),
      effect: id,
      params: { ...rackEffectDefaults(id), ...params },
      enabled: !node.bypass,
      label: rackDef.label,
    };
  }
  // Catalog id (eq_mid/compression/reverb_delay/…) or unmapped foreign name:
  // theDAW has no live per-track engine for it, so keep it inert but visible.
  return {
    id: uid('fx'),
    effect: id,
    params,
    enabled: false,
    label: EFFECT_LABELS[id] || id,
  };
};

/** Count of effect nodes a loaded track carries that theDAW can render live. */
const liveFxCount = (chain: EffectChainNode[] | undefined): number =>
  (chain ?? []).filter(
    (n) => n.node_type === 'builtin' && !!getRackEffect(n.effect_name) && !n.bypass,
  ).length;

/** Serialize a live editor chain entry back into a persisted effect node. */
const chainEntryToEffectNode = (e: ChainEntry): EffectChainNode => {
  if (e.effect === 'vst3' && e.vst) {
    return {
      node_type: 'vst3',
      effect_name: e.vst.plugin_name,
      parameters: e.params ?? {},
      bypass: !e.enabled,
      vst_state: { plugin_path: e.vst.plugin_path, plugin_name: e.vst.plugin_name, parameters: e.params ?? {} },
    };
  }
  return {
    node_type: 'builtin',
    effect_name: e.effect,
    parameters: e.params ?? {},
    bypass: !e.enabled,
  };
};

export interface ProjectImportResult {
  tracks: number;
  clips: number;
  /** Clips that had no loadable content (missing audio file or empty MIDI). */
  skipped: number;
  /** Effect nodes carried in from the project (across all tracks). */
  effects: number;
  /** Of those, how many render live in theDAW (rack effects); the rest are
   *  preserved-but-inactive (VST3 + EQ/comp/reverb with no live per-track engine). */
  effectsLive: number;
}

/** Build one editor clip from a loaded .tasmo clip, or null if it has nothing
 *  playable (missing audio file on disk, or a MIDI clip with no notes). */
const buildClip = async (
  c: TasmoLoadedClip,
  trackId: string,
  color: string,
  bpm: number,
): Promise<AudioClip | null> => {
  let blob: Blob | null = null;
  let sourceKind: AudioClip['sourceKind'];
  let sourcePianoRoll: PianoNote[] | undefined;

  if (c.audio_file) {
    const res = await fetch(projectApi.clipAudioUrl(c.audio_file));
    if (!res.ok) {
      logError('project', `Clip "${c.name}" audio not loadable (${res.status}): ${c.audio_file}`);
      return null;
    }
    blob = await res.blob();
  } else if (c.midi_notes && c.midi_notes.length) {
    const notes = toRenderNotes(c.midi_notes, bpm);
    if (notes.length === 0) return null;
    const rendered = await renderNotesToBlob(notes);
    blob = rendered.blob;
    sourceKind = 'piano-roll';
    sourcePianoRoll = toPianoNotes(c.midi_notes, bpm);
  } else {
    return null;
  }

  const { peaks, duration } = await computePeaks(blob, 240);
  // Respect the clip's real timeline length when the importer provides it
  // (end_time - start_time); fall back to the full source for placeholder
  // timing. Never exceed the decoded source length.
  const startSec = Math.max(0, c.start_time ?? 0);
  const span = (c.end_time ?? 0) - startSec;
  const durationSec = span > 0.02 ? Math.min(span, duration) : duration;
  return {
    id: c.id || uid('clip'),
    trackId,
    label: c.name || 'clip',
    audioBlob: blob,
    mimeType: blob.type || 'audio/wav',
    sourceDuration: duration,
    offsetIntoSource: 0,
    durationSec,
    startSec,
    color,
    peaks,
    sourceKind,
    sourcePianoRoll,
    sourceBpm: sourceKind ? bpm : undefined,
  };
};

/**
 * Load a project into the EDIT timeline (replacing the current session), switch
 * to the EDIT tab, and return a summary. Throws only on a catastrophic failure;
 * individual unloadable clips are skipped and counted.
 */
export async function loadProjectIntoEditor(
  project: TasmoProjectLoaded,
): Promise<ProjectImportResult> {
  const bpm = project.tempo || 120;
  const outTracks: EditorTrack[] = [];
  const outClips: AudioClip[] = [];
  let skipped = 0;
  let effects = 0;
  let effectsLive = 0;

  for (let i = 0; i < project.tracks.length; i += 1) {
    const t: TasmoLoadedTrack = project.tracks[i];
    const trackId = t.id || uid('t');
    const color = t.color || TRACK_COLORS[i % TRACK_COLORS.length];
    const fxChain = (t.effect_chain ?? []).map(effectNodeToChainEntry);
    effects += t.effect_chain?.length ?? 0;
    effectsLive += liveFxCount(t.effect_chain);
    outTracks.push({
      id: trackId,
      name: t.name || `Track ${i + 1}`,
      nameAutoGenerated: false,
      volume: dbToGain(t.volume_db),
      pan: clamp(t.pan, -1, 1, 0),
      mute: !!t.mute,
      solo: !!t.solo,
      color,
      instrumentProgram: t.instrument_program,
      fxChain: fxChain.length ? fxChain : undefined,
    });
    for (const c of t.clips || []) {
      try {
        const clip = await buildClip(c, trackId, color, bpm);
        if (clip) outClips.push(clip);
        else skipped += 1;
      } catch (e) {
        skipped += 1;
        logError('project', `Clip "${c.name}" failed to load: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  useEditorStore.getState().loadProject({ tracks: outTracks, clips: outClips, bpm });
  useAppUiStore.getState().setCenterTab('edit');
  logInfo(
    'project',
    `Imported into editor: ${outTracks.length} track(s), ${outClips.length} clip(s)` +
      `${skipped ? `, ${skipped} clip(s) skipped` : ''}` +
      `${effects ? `, ${effects} effect(s) (${effectsLive} live, ${effects - effectsLive} preserved)` : ''}`,
  );
  return { tracks: outTracks.length, clips: outClips.length, skipped, effects, effectsLive };
}

// ── Saving the live session ──────────────────────────────────────────────────

/** Linear fader gain → dB (clamped; silence maps to -60 dB, not -Infinity). */
const gainToDb = (gain: number): number => (gain <= 0.0001 ? -60 : 20 * Math.log10(gain));

/** Pick a sane file extension for an editor clip's blob, so the embedded file
 *  round-trips through the audio-only /clip-audio endpoint. */
const extForMime = (mime: string): string => {
  const m = mime.toLowerCase();
  if (m.includes('flac')) return 'flac';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  return 'wav';
};

export interface CapturedSession {
  tracks: TasmoTrackInput[];
  files: Array<{ name: string; blob: Blob }>;
  bpm: number;
  clipCount: number;
}

/**
 * Snapshot the EDIT timeline into a save payload: tracks plus one embedded audio
 * file per clip (the editor's clips are in-memory blobs, so they're uploaded and
 * embedded rather than linked). MIDI clips also carry their note list so the
 * piano-roll source survives the round-trip.
 */
export function captureEditorSession(): CapturedSession {
  const editor = useEditorStore.getState();
  const files: Array<{ name: string; blob: Blob }> = [];
  let clipCount = 0;

  const tracks: TasmoTrackInput[] = editor.tracks.map((t) => {
    const clips: TasmoClipInput[] = editor.clips
      .filter((c) => c.trackId === t.id)
      .map((c) => {
        const fname = `${c.id}.${extForMime(c.mimeType || c.audioBlob.type || 'audio/wav')}`;
        files.push({ name: fname, blob: c.audioBlob });
        clipCount += 1;
        const isMidi = c.sourceKind === 'piano-roll';
        return {
          id: c.id,
          name: c.label,
          clip_type: isMidi ? 'midi' : 'audio',
          track_id: t.id,
          start_time: c.startSec,
          end_time: c.startSec + c.durationSec,
          audio_file: `audio/${fname}`,
          midi_notes:
            isMidi && c.sourcePianoRoll
              ? c.sourcePianoRoll.map((n) => ({
                  note: n.note,
                  step: n.step,
                  length: n.length,
                  velocity: n.velocity,
                }))
              : null,
        };
      });
    return {
      id: t.id,
      name: t.name,
      type: 'audio',
      volume_db: gainToDb(t.volume),
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      color: t.color,
      clips,
      effect_chain: (t.fxChain ?? []).map(chainEntryToEffectNode),
    };
  });

  return { tracks, files, bpm: editor.bpm, clipCount };
}
