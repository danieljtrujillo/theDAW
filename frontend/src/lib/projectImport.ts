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
  type AutomationLane,
  type AutomationPoint,
  type AutomationTarget,
  type AutomationTargetKind,
  type EditorBus,
  type EditorTrack,
  type TimelineMarker,
  type TimeSignature,
} from '../state/editorStore';
import {
  addBus as graphAddBus,
  addSend,
  emptyGraph,
  ensureTrackNode,
  outputOf,
  sendsFrom,
  setOutput,
  MASTER_ID,
  type RoutingGraph,
} from '../state/routingGraph';
import { normalizeComp, type ClipTake, type CompRegion } from './clipComp';
import { MIN_NOTE_STEPS, type PianoNote } from '../state/pianoRollStore';
import { useAppUiStore } from '../state/appUiStore';
import { renderNotesToBlob, type RenderNote, type RenderOptions } from './midiSynth';
import {
  projectApi,
  type TasmoProjectLoaded,
  type TasmoLoadedClip,
  type TasmoLoadedTrack,
  type TasmoTrackInput,
  type TasmoClipInput,
  type EffectChainNode,
  type TasmoBus,
  type TasmoControllerMappings,
  type TasmoLocator,
  type TasmoLoop,
  type TasmoCompRegion,
  type TasmoTake,
  type TasmoChainEntry,
  type TasmoAutomationLane,
  clipNotesToTasmo,
  clipTotalSteps,
  gmProgramOf,
  playedNotesFromRoll,
  tasmoClipBpm,
  tasmoMeterToClip,
  tasmoNoteExtras,
  tasmoOwnBpm,
  ticksMatching,
} from './projectClient';
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { assertTree } from './timeline/trackOrder';
import { toTreeTracks } from './timeline/folderOps';
import { getRackEffect, rackEffectDefaults } from './rackEffects';
import { EFFECT_LABELS, type ChainEntry } from '../state/effectChainStore';
import { logError, logInfo, logWarn } from '../state/logStore';
import { useSwayImportStore, startSwayImportDriver } from '../state/swayImportStore';
import { usePerformRoutingStore } from '../state/performRouting';
import { tasmoLoadedToDawProject } from './tasmoToSession';
import { GM_STANDARD_KIT } from './clipProgram';
import { DRUM_CHANNEL } from './editChannels';
import { meterFromTasmo } from './timeSignatureIO';
import { pairingHeader } from './pairing';

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

/**
 * The piano-roll view of the same notes, for "Edit in Piano Roll" and EDIT's
 * playback of the clip. An edge in seconds (a DAW importer's, or a set saved
 * from the Session grid) lands on its tick at `bpm` (PPQ to the quarter), never
 * snapped to a 16th, and keeps only its lane. An edge in steps (theDAW's own
 * save) keeps its fraction, with the `tick` / `ticks` the file writes beside it
 * (pianoNoteToTasmo), and its lane, channel and expression
 * (`tasmoNoteExtras`), so a note shorter than a 16th reopens at its own length.
 * A length in steps with no ticks beside it (a file an older build wrote) keeps
 * its length down to the roll's one tick; a missing or non-positive one reads
 * as one step.
 */
export const tasmoMidiNotesToPiano = (raw: Array<Record<string, number>>, bpm: number): PianoNote[] => {
  const ticksPerSec = (Math.max(40, bpm) / 60) * PPQ;
  const ticksPerStep = PPQ / ROLL_STEPS_PER_BEAT;
  return raw
    .map((n): PianoNote | null => {
      const note = pick(n, 'note', 'pitch', 'midi', 'key');
      if (note === undefined) return null;
      const startSec = pick(n, 'start', 'startSec', 'start_time', 'time');
      const durSec = pick(n, 'duration', 'durationSec', 'dur', 'length_sec');
      const stepIn = Math.max(0, pick(n, 'step') ?? 0);
      const lengthIn = pick(n, 'length');
      const tick = startSec !== undefined ? Math.max(0, Math.round(startSec * ticksPerSec)) : ticksMatching(n.tick, stepIn, 0);
      const ticks =
        durSec !== undefined
          ? Math.max(MIN_NOTE_TICKS, Math.round(durSec * ticksPerSec))
          : lengthIn !== undefined
            ? ticksMatching(n.ticks, lengthIn, MIN_NOTE_TICKS)
            : undefined;
      // A seconds-based note comes from an importer and carries no roll fields;
      // only its lane is read, as it always was.
      const lane = pick(n, 'lane');
      const extras = startSec !== undefined || durSec !== undefined
        ? lane !== undefined && Number.isInteger(lane) && lane >= 0 ? { lane } : {}
        : tasmoNoteExtras(n);
      return {
        id: uid('pn'),
        note: Math.round(note),
        step: tick !== undefined ? tick / ticksPerStep : stepIn,
        // A length of 0 or less (a hand-edited file) still loads as one step.
        length: ticks !== undefined ? ticks / ticksPerStep : lengthIn !== undefined && lengthIn > 0 ? Math.max(MIN_NOTE_STEPS, lengthIn) : 1,
        velocity: clamp(pick(n, 'velocity', 'vel'), 1, 127, 100),
        ...extras,
        ...(tick !== undefined ? { tick } : {}),
        ...(ticks !== undefined ? { ticks } : {}),
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
      id: node.id || uid('fx'),
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
      id: node.id || uid('fx'),
      effect: id,
      params: { ...rackEffectDefaults(id), ...params },
      enabled: !node.bypass,
      label: rackDef.label,
    };
  }
  // Catalog id (eq_mid/compression/reverb_delay/…) or unmapped foreign name:
  // theDAW has no live per-track engine for it, so keep it inert but visible.
  return {
    id: node.id || uid('fx'),
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
      id: e.id,
      node_type: 'vst3',
      effect_name: e.vst.plugin_name,
      parameters: e.params ?? {},
      bypass: !e.enabled,
      vst_state: { plugin_path: e.vst.plugin_path, plugin_name: e.vst.plugin_name, parameters: e.params ?? {} },
    };
  }
  return {
    id: e.id,
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

// ── Takes + the comp at the file boundary ────────────────────────────────────
//
// A clip's alternate takes are stored as one file entry each, alongside the
// clip's own; the comp is the boundary list `lib/clipComp.ts` defines. Mirrors
// `Take` / `CompRegion` in backend/modules/project/tasmo_project.py.
//
// THE INVARIANT both directions keep (clipComp.ts states it in full): the
// clip's `audioBlob` / `mimeType` / `sourceDuration` / `offsetIntoSource` /
// `peaks` ARE `takes[activeTakeIndex]`. On the way out that means the active
// take's file is the same bytes as the clip's own; on the way in it means the
// active take is built from the blob the clip already fetched rather than from
// a second fetch of identical bytes — which also keeps them the SAME Blob
// OBJECT, the key `lib/decodeCache` caches decoded audio under.

/** The active take index a file names, clamped to a take that exists. Anything
 *  that is not an in-range integer reads as 0, exactly as `clipComp` treats a
 *  nonsense index. */
const activeTakeIndexOf = (raw: unknown, takeCount: number): number => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= takeCount) return 0;
  return raw;
};

/** The file's comp regions → `clipComp`'s, dropping anything malformed. The
 *  result is still run through `normalizeComp` against the real take count and
 *  clip length, which is what makes it safe for the segment walk. */
const tasmoCompToClip = (raw: unknown): CompRegion[] => {
  const out: CompRegion[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.start_sec !== 'number' || !Number.isFinite(r.start_sec)) continue;
    if (typeof r.take_index !== 'number' || !Number.isInteger(r.take_index)) continue;
    const xfade = typeof r.crossfade_sec === 'number' && r.crossfade_sec > 0 ? r.crossfade_sec : undefined;
    out.push(xfade === undefined
      ? { startSec: r.start_sec, takeIndex: r.take_index }
      : { startSec: r.start_sec, takeIndex: r.take_index, crossfadeSec: xfade });
  }
  return out;
};

/**
 * Rebuild a loaded clip's takes and comp, or `{}` when the file carries none —
 * which is every .tasmo written before takes existed, and is why a legacy file
 * loads through here completely unchanged.
 *
 * Every non-active take's bytes are fetched the way the clip's own are. If ANY
 * of them fails to load the takes and the comp are dropped TOGETHER: a comp
 * indexes into the take list by position, so loading a subset would silently
 * repoint every region past the gap at the wrong recording. The clip itself is
 * unharmed — it keeps the active take's audio it already has, which is exactly
 * how it behaved before it had takes.
 */
const loadTakes = async (
  c: TasmoLoadedClip,
  clip: AudioClip,
): Promise<Pick<AudioClip, 'takes' | 'comp' | 'activeTakeIndex'>> => {
  const raw = Array.isArray(c.takes) ? c.takes.filter((t) => !!t && typeof t === 'object') : [];
  if (raw.length === 0) return {};
  const active = activeTakeIndexOf(c.active_take_index, raw.length);

  // Fetched in parallel — a comped clip has as many requests as takes, and
  // doing them one after another would stack the whole list's latency onto
  // opening the project. `Promise.all` keeps the ORDER, which is load-bearing:
  // the comp indexes takes by position.
  const loaded = await Promise.all(raw.map(async (t, i): Promise<ClipTake | null> => {
    const label = t.name || `Take ${i + 1}`;
    if (i === active) {
      // The clip's own media IS this take (the invariant), so it is reused
      // rather than re-fetched: one less request, and one Blob object.
      return {
        id: t.id || uid('take'),
        label,
        audioBlob: clip.audioBlob,
        mimeType: clip.mimeType,
        sourceDuration: clip.sourceDuration,
        offsetIntoSource: clip.offsetIntoSource,
        peaks: clip.peaks,
      };
    }
    if (!t.audio_file) {
      logWarn('project', `Clip "${c.name}": take "${label}" has no audio file — takes dropped`);
      return null;
    }
    const res = await fetch(projectApi.clipAudioUrl(t.audio_file), { headers: pairingHeader() });
    if (!res.ok) {
      logWarn(
        'project',
        `Clip "${c.name}": take "${label}" audio not loadable (${res.status}) — takes dropped`,
      );
      return null;
    }
    const blob = await res.blob();
    const stored = t.source_duration;
    return {
      id: t.id || uid('take'),
      label,
      audioBlob: blob,
      mimeType: t.mime_type || blob.type || 'audio/wav',
      // The stored length when the file has a usable one; otherwise decode for
      // it, the same way the clip's own duration is arrived at. Peaks stay
      // lazy for an inactive take — nothing draws it until it is selected.
      sourceDuration:
        typeof stored === 'number' && Number.isFinite(stored) && stored > 0
          ? stored
          : (await computePeaks(blob, 240)).duration,
      offsetIntoSource: Math.max(0, t.offset_into_source ?? 0),
    };
  }));

  // One unloadable take drops the whole list, comp included: the comp indexes
  // takes by POSITION, so keeping the rest would repoint every region past the
  // gap at the wrong recording.
  const takes = loaded.filter((t): t is ClipTake => t !== null);
  if (takes.length !== loaded.length) return {};

  // An empty comp is NOT COMPED, which is the absence of the field rather than
  // an empty list — a clip with takes and no comp plays its active take and
  // nothing downstream can tell it apart from a clip that never had any.
  const comp = normalizeComp(tasmoCompToClip(c.comp), takes.length, clip.durationSec);
  return { takes, comp: comp.length ? comp : undefined, activeTakeIndex: active };
};

/** How a saved MIDI clip with no audio file renders: at least to the end of
 *  its window (trim point plus length), so the rests after its last note keep
 *  the length the file gives it, and with no fixed tail, so a soundfont render
 *  rings out (lib/renderTail). */
export const tasmoMidiRenderOptions = (c: Pick<TasmoLoadedClip, 'offset_into_source' | 'start_time' | 'end_time'>): RenderOptions => ({
  minDurationSec: Math.max(0, c.offset_into_source ?? 0) + Math.max(0, (c.end_time ?? 0) - (c.start_time ?? 0)),
});

/** Build one editor clip from a loaded .tasmo clip, or null if it has nothing
 *  playable (missing audio file on disk, or a MIDI clip with no notes).
 *  `projectBpm` is the tempo a clip without its own `source_bpm` was written
 *  at; `trackProgram` is the track's GM program, which a clip with no audio
 *  file of its own renders through when it has no program of its own, and
 *  `trackPercussion` puts that render on the drum channel, where the program
 *  is the kit (the Standard kit when neither names one). */
const buildClip = async (
  c: TasmoLoadedClip,
  trackId: string,
  color: string,
  projectBpm: number,
  trackProgram?: number,
  trackPercussion = false,
): Promise<AudioClip | null> => {
  let blob: Blob | null = null;
  let sourceKind: AudioClip['sourceKind'];
  let sourcePianoRoll: PianoNote[] | undefined;
  // The tempo this clip's notes were written at. A file written before
  // source_bpm existed gives every clip the project tempo, as it always did.
  const bpm = tasmoClipBpm(c, projectBpm);
  const instrumentProgram = gmProgramOf(c.instrument_program);
  let renderedProgram = gmProgramOf(c.rendered_program);
  let renderedPercussion = c.rendered_percussion === true;
  const meter = tasmoMeterToClip(c);

  // The notes the clip plays. `midi_notes` when the file carries them (every
  // file written before roll_notes became the single copy, an imported DAW
  // clip, and a clip whose played notes were edited apart from its roll
  // notes); otherwise the roll notes unrolled across the clip's lanes, the way
  // the bounce that wrote them unrolled them.
  if (c.midi_notes && c.midi_notes.length) {
    const pianoNotes = tasmoMidiNotesToPiano(c.midi_notes, bpm);
    if (pianoNotes.length) sourcePianoRoll = pianoNotes;
  } else if (meter.sourceRollNotes?.length) {
    sourcePianoRoll = playedNotesFromRoll(meter);
  }

  if (c.audio_file) {
    const res = await fetch(projectApi.clipAudioUrl(c.audio_file), { headers: pairingHeader() });
    if (!res.ok) {
      logError('project', `Clip "${c.name}" audio not loadable (${res.status}): ${c.audio_file}`);
      return null;
    }
    blob = await res.blob();
  } else if (c.midi_notes?.length || sourcePianoRoll?.length) {
    // No audio of its own: render the notes, through the clip's program, else
    // its track's, else the global instrument (no program given). The program
    // used is recorded, so EDIT does not render the clip a second time.
    const notes = toRenderNotes(
      c.midi_notes?.length
        ? c.midi_notes
        : (sourcePianoRoll ?? []).map((n) => ({ note: n.note, step: n.step, length: n.length, velocity: n.velocity })),
      bpm,
    );
    if (notes.length === 0) return null;
    const program = trackPercussion ? (instrumentProgram ?? trackProgram ?? GM_STANDARD_KIT) : instrumentProgram ?? trackProgram;
    const rendered = await renderNotesToBlob(
      trackPercussion ? notes.map((n) => ({ ...n, channel: DRUM_CHANNEL })) : notes,
      { ...tasmoMidiRenderOptions(c), ...(program === undefined ? {} : { program }) },
    );
    blob = rendered.blob;
    renderedProgram = program;
    renderedPercussion = trackPercussion;
  } else {
    return null;
  }
  // A piano-roll clip saved from EDIT carries its bounce as audio_file AND its
  // notes; the notes make it a roll clip again whichever one supplied the audio.
  if (sourcePianoRoll) sourceKind = 'piano-roll';
  // Files written before total_steps existed: the notes' end, up to a bar line
  // of the clip's meter map (4/4 when it has none).
  // The roll's fields belong to a roll clip only, as they always have.
  const rollMeter = sourcePianoRoll ? meter : {};
  const sourceTotalSteps = sourcePianoRoll ? clipTotalSteps(rollMeter, sourcePianoRoll) : undefined;

  const { peaks, duration } = await computePeaks(blob, 240);
  // Respect the clip's real timeline length when the importer provides it
  // (end_time - start_time); fall back to the full source for placeholder
  // timing. Never exceed the decoded source length.
  const startSec = Math.max(0, c.start_time ?? 0);
  const span = (c.end_time ?? 0) - startSec;
  // The trim point into the (full, untrimmed) source. Clamped inside the decoded
  // length so a corrupt or hand-edited value can't produce a silent clip, and the
  // available duration is measured from the offset rather than from zero.
  const offsetIntoSource = Math.max(0, Math.min(c.offset_into_source ?? 0, Math.max(0, duration - 0.01)));
  const available = Math.max(0, duration - offsetIntoSource);
  const durationSec = span > 0.02 ? Math.min(span, available) : available;
  const clip: AudioClip = {
    id: c.id || uid('clip'),
    trackId,
    label: c.name || 'clip',
    audioBlob: blob,
    mimeType: blob.type || 'audio/wav',
    sourceDuration: duration,
    offsetIntoSource,
    durationSec,
    startSec,
    color,
    peaks,
    sourceKind,
    sourcePianoRoll,
    // A roll clip's notes are read at `bpm`. An audio clip keeps the tempo it
    // was tagged with (editor_set_clip_source_bpm, a stretch), which
    // stretch-to-tempo needs; one with none stays untagged.
    sourceBpm: sourceKind ? bpm : tasmoOwnBpm(c),
    // What the audio plays at after a beat match, and its library entry; left
    // out when the file has none, as for a clip that never had them.
    ...(typeof c.bpm === 'number' && Number.isFinite(c.bpm) && c.bpm > 0 ? { bpm: c.bpm } : {}),
    ...(typeof c.library_entry_id === 'string' && c.library_entry_id ? { libraryEntryId: c.library_entry_id } : {}),
    // The clip's own instrument and the one its audio holds. With the second
    // missing, EDIT's instrument sync saw every reopened roll clip as stale and
    // rendered them all again through whatever program was active.
    ...(sourceKind && instrumentProgram !== undefined ? { instrumentProgram } : {}),
    ...(sourceKind && renderedProgram !== undefined ? { renderedProgram } : {}),
    ...(sourceKind && renderedPercussion ? { renderedPercussion: true } : {}),
    sourceTotalSteps,
    sourceRollNotes: rollMeter.sourceRollNotes,
    sourceMeterMap: rollMeter.sourceMeterMap,
    sourcePickupSteps: rollMeter.sourcePickupSteps,
    sourceLanes: rollMeter.sourceLanes,
    sourceBends: rollMeter.sourceBends,
    sourceTempoMap: rollMeter.sourceTempoMap,
    // Restore the per-clip mute; omit the field entirely for unmuted clips so
    // pre-mute projects hydrate exactly as before. Gain and fades follow the same
    // rule: a unity/zero value stays `undefined` rather than being written back.
    muted: c.muted ? true : undefined,
    gain: typeof c.gain === 'number' && c.gain !== 1 ? c.gain : undefined,
    fadeInSec: c.fade_in || undefined,
    fadeOutSec: c.fade_out || undefined,
  };
  // The alternate takes and the comp across them, when the file has any. The
  // clip built above is the ACTIVE take by the invariant, so this only adds to
  // it — a file carrying none leaves the clip exactly as it was.
  return { ...clip, ...(await loadTakes(c, clip)) };
};

// ── Markers + the loop region at the file boundary ───────────────────────────
//
// Both are per-project document state that `loadProject` CLEARS (editorStore.ts:
// "Markers, automation lanes and the loop region are cleared with the tracks"),
// so until they were written they could not survive save -> open at all. The
// file already had `locators` for markers; the loop is a new defaulted object.
// Mirrors `Locator` / `Loop` in backend/modules/project/tasmo_project.py.
//
// Like every other reader here, these NEVER throw: a hand-edited entry with a
// missing name or a nonsense position is dropped, not fatal.

/**
 * State the EDIT session does NOT write into a `.tasmo`, listed in ONE place so
 * a gap is discoverable instead of being rediscovered by whoever next notices
 * something missing after a reload.
 *
 * EMPTY, and the test below pins it empty. The last three entries — the master
 * FX chain, the master VST chain and the automation lanes — are written and
 * restored by `captureProjectDocument` / `applyTasmoMasterAndAutomation`, and
 * the IMPORTED-DAW save branch in projectStore.ts (`pendingTracks.length > 0`)
 * now builds its project-level payload through that same helper, so it no
 * longer drops markers, the loop, the buses or any of the three either.
 *
 * Adding session state that a save does not carry means adding its name here in
 * the same change, so the omission is written down rather than discovered.
 */
export const TASMO_UNSAVED_STATE: readonly string[] = [];

/** Timeline markers → the file's `locators`, in the order the store holds them
 *  (sorted by position). The editor's marker has no colour, so none is written. */
export function markersToLocators(markers: readonly TimelineMarker[]): TasmoLocator[] {
  return markers
    .filter((m) => m && Number.isFinite(m.t) && m.t >= 0)
    .map((m) => ({ id: m.id, name: m.label, position: m.t }));
}

/** The inverse: the file's `locators` → timeline markers. An entry without a
 *  usable position is dropped; a missing name becomes the marker's index, which
 *  is what `addMarker` labels an unnamed marker with. */
export function locatorsToMarkers(raw: unknown): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const l = item as Record<string, unknown>;
    const pos = l.position;
    if (typeof pos !== 'number' || !Number.isFinite(pos) || pos < 0) continue;
    const name = typeof l.name === 'string' && l.name ? l.name : String(out.length + 1);
    out.push({ id: typeof l.id === 'string' && l.id ? l.id : uid('marker'), t: pos, label: name });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The shortest cycle worth keeping, in seconds. The same threshold `setLoopRegion`
 *  enforces, applied on BOTH sides of the file so a 20 ms cycle a hand-edited file
 *  asks for is no more reachable than one the UI would refuse to make. */
const MIN_LOOP_SEC = 0.05;

/** The editor's loop region → the file's `loop`, or null when there is no region
 *  to keep. `enabled` is written independently of the bounds so switching the
 *  loop off does not throw the region away. */
export function loopToTasmo(loop: { loopEnabled: boolean; loopStart: number; loopEnd: number }): TasmoLoop | null {
  const { loopEnabled, loopStart, loopEnd } = loop;
  if (!Number.isFinite(loopStart) || !Number.isFinite(loopEnd)) return null;
  const start = Math.max(0, loopStart);
  if (loopEnd - start <= MIN_LOOP_SEC) return null;
  return { enabled: !!loopEnabled, start_sec: start, end_sec: loopEnd };
}

/** The inverse. A missing, null or empty region reads as null, which the load
 *  path leaves alone — i.e. today's behaviour for a file without the key. */
export function tasmoToLoop(raw: unknown): { enabled: boolean; start: number; end: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  const start = typeof l.start_sec === 'number' && Number.isFinite(l.start_sec) ? Math.max(0, l.start_sec) : NaN;
  const end = typeof l.end_sec === 'number' && Number.isFinite(l.end_sec) ? l.end_sec : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= MIN_LOOP_SEC) return null;
  return { enabled: l.enabled === true, start, end };
}

/**
 * Put a loaded project's markers and loop region back on the timeline.
 *
 * Called AFTER `loadProject`, which has just cleared both — so a file carrying
 * neither leaves the freshly cleared state exactly as it is, which is what every
 * project written before this did. Uses only the editor store's existing public
 * setters (`addMarker`, `setLoopRegion`, `setLoopEnabled`); marker ids are NOT
 * preserved, because `addMarker` mints its own — nothing outside the store keys
 * off a marker id, and the file's id is only there to identify the entry.
 */
export function applyTasmoMarkersAndLoop(project: Pick<TasmoProjectLoaded, 'locators' | 'loop'>): void {
  const store = useEditorStore.getState();
  for (const m of locatorsToMarkers(project.locators)) store.addMarker(m.t, m.label);
  const loop = tasmoToLoop(project.loop);
  if (loop) {
    // setLoopRegion enables the loop for any region worth having; setLoopEnabled
    // then honours a region the user had saved switched OFF.
    store.setLoopRegion(loop.start, loop.end);
    store.setLoopEnabled(loop.enabled);
  }
}

// ── The master chains + automation lanes at the file boundary ────────────────
//
// The last three pieces of session state a `.tasmo` could not carry. They are
// per-project document state like the markers and the loop, but they fail in
// two OPPOSITE ways, which is why the reader treats an absent key and an empty
// one differently:
//
//  - `loadProject` CLEARS `automationLanes` (it says so: lanes key off
//    trackId/entryId, so carrying them across a load leaves them pointing at
//    tracks that no longer exist), so an unsaved lane was simply gone.
//  - `loadProject` does NOT clear `masterFxChain` / `masterVstChain`, so the
//    master rack of whatever was open before SURVIVED into the project the user
//    just opened, and then got written into its next save.
//
// So: a key that is absent/null leaves the live state alone (a file written
// before this existed opens exactly as it always did), and a key that is
// present — including an empty array — replaces it.
//
// Mirrors `ChainEntry` / `EditorAutomationLane` in
// backend/modules/project/tasmo_project.py.

/** The four target kinds the editor can automate. A lane naming anything else
 *  is a hand-edited file, and is dropped rather than restored as a lane that
 *  writes nowhere. */
const AUTOMATION_KINDS: readonly AutomationTargetKind[] = [
  'trackVolume',
  'trackPan',
  'trackFx',
  'masterFx',
];

/** A non-empty string, or undefined for anything else a file might hold. */
const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;

/** A params record with only the finite numbers kept — a NaN param would reach
 *  an AudioParam and silence the node it belongs to. */
const numericParams = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
};

/** A live master-chain entry → the file's shape. Optional fields are left out
 *  rather than written as null, so an ordinary rack effect writes the same four
 *  keys it always would. */
export function chainEntryToTasmo(e: ChainEntry): TasmoChainEntry {
  return {
    id: e.id,
    effect: e.effect,
    params: e.params ?? {},
    enabled: !!e.enabled,
    ...(e.vst
      ? {
          vst: {
            plugin_path: e.vst.plugin_path,
            plugin_name: e.vst.plugin_name,
            // The dialed-in native-editor state. Absent when the plugin has
            // never been opened, which is not the same as an empty blob.
            ...(e.vst.raw_state ? { raw_state: e.vst.raw_state } : {}),
          },
        }
      : {}),
    ...(e.label ? { label: e.label } : {}),
  };
}

/** The inverse, for a whole chain. An entry without a usable `id`/`effect` is
 *  dropped: the id is what automation targets, so an entry that has none cannot
 *  be the entry a lane means. `requireVst` is set for the master VST chain,
 *  where an entry with no plugin names nothing to host. */
export function tasmoToChainEntries(raw: unknown, requireVst = false): ChainEntry[] {
  const out: ChainEntry[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    if (typeof e.effect !== 'string' || !e.effect) continue;
    const v = e.vst as Record<string, unknown> | null | undefined;
    const vst =
      v && typeof v === 'object' && typeof v.plugin_path === 'string' && v.plugin_path
        ? {
            plugin_path: v.plugin_path,
            plugin_name: typeof v.plugin_name === 'string' ? v.plugin_name : v.plugin_path,
            ...(typeof v.raw_state === 'string' && v.raw_state ? { raw_state: v.raw_state } : {}),
          }
        : undefined;
    if (requireVst && !vst) {
      logWarn('project', `Master VST "${e.id}" names no plugin; dropped`);
      continue;
    }
    out.push({
      id: e.id,
      effect: e.effect,
      params: numericParams(e.params),
      // The backend defaults `enabled` to true, so only an explicit false is off.
      enabled: e.enabled !== false,
      ...(vst ? { vst } : {}),
      ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
    });
  }
  return out;
}

/** The lane's breakpoints in the file shape, keeping only what can be sampled:
 *  finite points that strictly ascend in `t`. Nothing is reordered — a point
 *  that does not advance the curve is dropped, the way a malformed locator is —
 *  because the backend REJECTS a lane whose points do not ascend, and a save
 *  the backend refuses is worse than a lane that lost a duplicate boundary. */
const sanitizePoints = (points: readonly AutomationPoint[]): AutomationPoint[] => {
  const out: AutomationPoint[] = [];
  let last = -Infinity;
  for (const p of points) {
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.v) || p.t <= last) continue;
    const curve = typeof p.curve === 'number' && Number.isFinite(p.curve)
      ? Math.max(-1, Math.min(1, p.curve))
      : 0;
    // A zero curve is linear, which is the ABSENCE of the key — the same rule
    // `automationModes.makePoint` writes points by.
    out.push(curve === 0 ? { t: p.t, v: p.v } : { t: p.t, v: p.v, curve });
    last = p.t;
  }
  return out;
};

/** The editor's automation lanes → the file's `automation_lanes`. `only` limits
 *  the result to lanes whose track is in the payload being written: the imported-
 *  DAW save branch writes ITS tracks, not the editor's, so a lane naming a track
 *  that will not be in the file is left out instead of saved as a dangler. */
export function automationLanesToTasmo(
  lanes: readonly AutomationLane[],
  only?: ReadonlySet<string>,
): TasmoAutomationLane[] {
  const out: TasmoAutomationLane[] = [];
  for (const l of lanes) {
    if (!l || !l.target || !AUTOMATION_KINDS.includes(l.target.kind)) continue;
    if (only && l.target.trackId !== undefined && !only.has(l.target.trackId)) continue;
    out.push({
      id: l.id,
      target: {
        kind: l.target.kind,
        ...(l.target.trackId !== undefined ? { track_id: l.target.trackId } : {}),
        ...(l.target.entryId !== undefined ? { entry_id: l.target.entryId } : {}),
        ...(l.target.paramKey !== undefined ? { param_key: l.target.paramKey } : {}),
      },
      points: sanitizePoints(l.points ?? []),
      enabled: l.enabled !== false,
    });
  }
  return out;
}

/**
 * Whether a restored lane still has something to write to, given the project
 * that has just been loaded. This is the whole reason `loadProject` clears the
 * lanes in the first place: a lane pointing at a track or an FX slot that is not
 * there rides a control that does not exist, and no UI can show or remove it.
 *
 * A track's FX entry ids round-trip (`effectNodeToChainEntry` keeps `node.id`),
 * so a lane saved against one resolves — unless the file predates chain-entry
 * ids, in which case the entries get fresh ones and the lane is dropped, which
 * is the honest outcome.
 */
export function automationTargetResolver(
  tracks: readonly EditorTrack[],
  masterFxChain: readonly ChainEntry[],
): (target: AutomationTarget) => boolean {
  const trackIds = new Set(tracks.map((t) => t.id));
  const trackEntries = new Map<string, Set<string>>();
  for (const t of tracks) trackEntries.set(t.id, new Set((t.fxChain ?? []).map((e) => e.id)));
  const masterEntries = new Set(masterFxChain.map((e) => e.id));
  return (target) => {
    if (target.kind === 'masterFx') {
      return !!target.entryId && !!target.paramKey && masterEntries.has(target.entryId);
    }
    if (!target.trackId || !trackIds.has(target.trackId)) return false;
    if (target.kind !== 'trackFx') return true;
    return !!target.entryId && !!target.paramKey && !!trackEntries.get(target.trackId)?.has(target.entryId);
  };
}

/** The file's `automation_lanes` → editor lanes, dropping any that cannot be
 *  sampled or cannot be resolved against the loaded project. Never throws: a
 *  hand-edited lane is worth less than the project it sits in. */
export function tasmoToAutomationLanes(
  raw: unknown,
  canTarget: (target: AutomationTarget) => boolean,
): AutomationLane[] {
  const out: AutomationLane[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const l = item as Record<string, unknown>;
    const t = (l.target ?? {}) as Record<string, unknown>;
    const kind = AUTOMATION_KINDS.find((k) => k === t.kind);
    if (!kind) continue;
    const trackId = nonEmpty(t.track_id);
    const entryId = nonEmpty(t.entry_id);
    const paramKey = nonEmpty(t.param_key);
    const target: AutomationTarget = {
      kind,
      ...(trackId !== undefined ? { trackId } : {}),
      ...(entryId !== undefined ? { entryId } : {}),
      ...(paramKey !== undefined ? { paramKey } : {}),
    };
    if (!canTarget(target)) {
      logWarn('project', `Automation lane for ${kind} targets nothing in this project; dropped`);
      continue;
    }
    const points = sanitizePoints(
      (Array.isArray(l.points) ? l.points : []).filter(
        (p): p is AutomationPoint => !!p && typeof p === 'object',
      ),
    );
    out.push({
      id: nonEmpty(l.id) ?? uid('lane'),
      target,
      points,
      enabled: l.enabled !== false,
    });
  }
  return out;
}

/**
 * Put a loaded project's master chains and automation lanes back on the editor.
 *
 * Called AFTER `loadProject`, like `applyTasmoMarkersAndLoop`, and for the same
 * reason: the tracks have to exist before a lane can be resolved against them.
 *
 * This writes the three document slices THROUGH THE STORE rather than through
 * per-entry setters, because every one of those setters would corrupt what it
 * restored: `addMasterEffect` mints a fresh entry id (and an automation lane
 * targets an entry BY id, so the chain would reload with its automation
 * orphaned) and seeds the rack defaults over the saved params;
 * `beginAutomationTouch` / `recordAutomationPoint` no-op outside a record mode
 * and merge any two points closer than the store's 20 ms floor, i.e. they would
 * silently redraw the user's curve. `useEditorStore.setState` is the same public
 * store API `loadProjectIntoEditor` already uses to reset the history below, and
 * the ONE call keeps the three slices in step for the history subscription.
 */
export function applyTasmoMasterAndAutomation(
  project: Pick<TasmoProjectLoaded, 'master_fx_chain' | 'master_vst_chain' | 'automation_lanes'>,
): void {
  const store = useEditorStore.getState();
  // Absent/null = the file says nothing: keep what is live (legacy behaviour).
  // Present, even empty = the file says this project has none: replace.
  const masterFxChain =
    project.master_fx_chain == null
      ? store.masterFxChain
      : tasmoToChainEntries(project.master_fx_chain);
  const hasVst = project.master_vst_chain != null;
  const masterVstChain = hasVst
    ? tasmoToChainEntries(project.master_vst_chain, true)
    : store.masterVstChain;
  const automationLanes =
    project.automation_lanes == null
      ? store.automationLanes
      : tasmoToAutomationLanes(
          project.automation_lanes,
          automationTargetResolver(store.tracks, masterFxChain),
        );
  useEditorStore.setState({
    masterFxChain,
    masterVstChain,
    automationLanes,
    // A rendered master belongs to the VST chain it was printed from, so a new
    // chain invalidates it — the rule `clearMasterVst` and every master-VST
    // mutator already keep. Without this a freshly opened project could play the
    // PREVIOUS project's frozen master.
    ...(hasVst ? { frozenMaster: null, previewMode: 'live' as const } : {}),
  });
}

// ── Routing + buses at the file boundary ─────────────────────────────────────
//
// `routing` is a graph (state/routingGraph.ts); the .tasmo format is flat, so
// the two mappers below are the whole translation. A track/bus names ONE output
// (`output_routing`, absent or null = the master) and any number of sends
// (`send_amounts`, bus id -> linear gain), which is exactly `outputOf` +
// `sendsFrom`. Mirrors `Track` / `Bus` in backend/modules/project/tasmo_project.py.
//
// The reader NEVER throws. A file is not a mutator-vetted graph: it can be
// hand-edited into a loop, or name a bus that isn't there. Both are LOGGED and
// SKIPPED, and the node keeps the output edge `ensureTrackNode`/`addBus` gave it
// — the master. A project that opens one edge short is worth infinitely more
// than a project that refuses to open.

/** The largest send gain a file may set: +6 dB, the ceiling the send UI offers. */
const SEND_GAIN_MAX = 2;

/** A track's routing as the file carries it. */
export interface TasmoRoutedTrack {
  id: string;
  name?: string;
  /** The id of the bus this feeds; `null`/absent = the master. */
  output_routing?: string | null;
  /** Bus id -> linear send gain. */
  send_amounts?: Record<string, number> | null;
}

/** One node's routing in the file shape. The master is written as `null`, never
 *  as a node id — `MASTER_ID` is this app's name for it, not part of the format. */
export function trackRoutingToTasmo(
  graph: RoutingGraph,
  nodeId: string,
): { output_routing: string | null; send_amounts: Record<string, number> } {
  const out = outputOf(graph, nodeId);
  const sendAmounts: Record<string, number> = {};
  for (const e of sendsFrom(graph, nodeId)) sendAmounts[e.to] = e.gain;
  return { output_routing: out === null || out === MASTER_ID ? null : out, send_amounts: sendAmounts };
}

/**
 * The bus strips in the file shape. Driven by the STRIP list, not the graph's
 * nodes: the master is a node but never a bus, and a node with no strip behind
 * it is document damage that must not be persisted as a phantom bus.
 *
 * LIMITATION, deliberate: a bus persists its `output_routing` and nothing else
 * about its place in the graph. Sends LEAVING a bus, and sidechain edges of any
 * kind, are NOT written — the format has no field for either, and no UI creates
 * either today. The autosave manifest carries the whole `RoutingGraph` verbatim,
 * so nothing a user can currently build is lost across a crash; it is only the
 * `.tasmo` that is lossy, and only for edges that cannot yet exist. Adding
 * `send_amounts` to the backend `Bus` is the change to make when bus sends get
 * a UI — not before, so the format does not grow a field nothing writes.
 */
export function busesToTasmo(graph: RoutingGraph, buses: readonly EditorBus[]): TasmoBus[] {
  return buses.map((b) => ({
    id: b.id,
    name: b.name,
    volume: b.volume,
    mute: b.mute,
    output_routing: trackRoutingToTasmo(graph, b.id).output_routing,
    effect_chain: (b.fxChain ?? []).map(chainEntryToEffectNode),
  }));
}

/**
 * Rebuild `routing` + the bus strips from a loaded file, in the one order that
 * makes the mutators' guards meaningful: every track node, then every bus node
 * (so an output can name either), then the outputs, then the sends (a send into
 * a bus that an output already reaches is the case `wouldCycle` must see).
 */
export function tasmoToRouting(
  tracks: readonly TasmoRoutedTrack[],
  buses: readonly TasmoBus[] | undefined,
): { routing: RoutingGraph; buses: EditorBus[] } {
  const trackList = (tracks ?? []).filter((t) => t && t.id);
  const busList = (buses ?? []).filter((b) => b && b.id);
  let g = emptyGraph();
  for (const t of trackList) g = ensureTrackNode(g, t.id, t.name || t.id);
  for (const b of busList) g = graphAddBus(g, b.id, b.name || b.id);

  for (const n of [...trackList, ...busList]) {
    const to = n.output_routing;
    if (!to || to === MASTER_ID) continue;
    const r = setOutput(g, n.id, to);
    if (r.ok) g = r.graph;
    else logWarn('project', `Routing: output "${n.id}" -> "${to}" refused (${r.reason}); left feeding the master`);
  }

  for (const t of trackList) {
    for (const [to, gain] of Object.entries(t.send_amounts ?? {})) {
      if (typeof gain !== 'number' || !Number.isFinite(gain)) {
        logWarn('project', `Routing: send "${t.id}" -> "${to}" has a non-numeric gain; dropped`);
        continue;
      }
      // Clamped, not merely finite: a hand-edited 1e9 is a valid float and would
      // reach the mixer as a gain that blows the graph's headroom apart. SEND_GAIN_MAX
      // is +6 dB, the same ceiling the send UI offers.
      const clamped = Math.max(0, Math.min(SEND_GAIN_MAX, gain));
      if (clamped !== gain) {
        logWarn('project', `Routing: send "${t.id}" -> "${to}" gain ${gain} clamped to ${clamped}`);
      }
      const r = addSend(g, t.id, to, clamped);
      if (r.ok) g = r.graph;
      else logWarn('project', `Routing: send "${t.id}" -> "${to}" refused (${r.reason}); dropped`);
    }
  }

  const strips: EditorBus[] = busList.map((b) => ({
    id: b.id,
    name: b.name || b.id,
    fxChain: (b.effect_chain ?? []).map(effectNodeToChainEntry),
    // A missing or corrupt value takes the BACKEND's default (`Bus.volume = 1.0`,
    // unity), not the store's default for a NEW bus (0.8) — a hand-written file
    // must load to the same fader on both sides of the wire.
    volume: typeof b.volume === 'number' && Number.isFinite(b.volume) ? b.volume : 1,
    mute: !!b.mute,
  }));
  return { routing: g, buses: strips };
}

/**
 * A loaded track list with its folder hierarchy made valid. The file is not a
 * store-vetted tree: a hand edit, or a save from a build that dropped a folder,
 * can leave a track whose parent names no track, names a track that is not a
 * folder, or closes a loop. Each such link is logged and cut, and the track sits
 * at the root, the same never-throw rule the routing reader follows; every
 * other link is kept. Returns the same array when nothing needed cutting.
 */
export function tasmoTrackTree(tracks: readonly EditorTrack[]): EditorTrack[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const parentOf = new Map<string, string | null>();
  for (const t of tracks) {
    const p = t.parentTrackId ?? null;
    if (p !== null && byId.get(p)?.isFolder !== true) {
      const parent = byId.get(p);
      logWarn(
        'project',
        parent
          ? `Track "${t.name}" sits under "${parent.name}", a track that is not a folder; placed at the root`
          : `Track "${t.name}" names a folder that is not in this project; placed at the root`,
      );
      parentOf.set(t.id, null);
    } else {
      parentOf.set(t.id, p);
    }
  }
  // A loop: walk up from each track and cut the link that closes it.
  for (const t of tracks) {
    const seen = new Set<string>([t.id]);
    let cur = t.id;
    for (;;) {
      const p = parentOf.get(cur) ?? null;
      if (p === null) break;
      if (seen.has(p)) {
        logWarn('project', `Folder "${byId.get(cur)?.name ?? cur}" sits inside itself; placed at the root`);
        parentOf.set(cur, null);
        break;
      }
      seen.add(p);
      cur = p;
    }
  }
  let changed = false;
  const out = tracks.map((t): EditorTrack => {
    const p = parentOf.get(t.id) ?? null;
    if (p === (t.parentTrackId ?? null)) return t;
    changed = true;
    const { parentTrackId: _cut, ...rest } = t;
    return rest;
  });
  const result = changed ? out : (tracks as EditorTrack[]);
  // The tree module's own check, so this and the folder edits agree on what a
  // valid tree is. It cannot fail after the cuts above; if it ever does, the
  // folders are dropped flat rather than the project failing to open.
  try {
    assertTree(toTreeTracks(result));
    return result;
  } catch (e) {
    logWarn('project', `Folder hierarchy unusable (${e instanceof Error ? e.message : String(e)}); tracks loaded flat`);
    return result.map(({ parentTrackId: _cut, ...rest }) => rest);
  }
}

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
  let gridClips = 0;
  // The routing half of each track, collected against the id the timeline
  // actually gets (a file may carry a track with no id, which is uid()'d below)
  // so the rebuilt graph names the same nodes the store does.
  const routedTracks: TasmoRoutedTrack[] = [];

  for (let i = 0; i < project.tracks.length; i += 1) {
    const t: TasmoLoadedTrack = project.tracks[i];
    const trackId = t.id || uid('t');
    const color = t.color || TRACK_COLORS[i % TRACK_COLORS.length];
    const fxChain = (t.effect_chain ?? []).map(effectNodeToChainEntry);
    const isFolder = t.is_folder === true;
    // A folder is an arrangement row with no audio node, the rule
    // `addFolderFromSelectedTracks` keeps, so it takes no part in routing.
    if (!isFolder) {
      routedTracks.push({
        id: trackId,
        name: t.name || `Track ${i + 1}`,
        output_routing: t.output_routing,
        send_amounts: t.send_amounts,
      });
    }
    effects += t.effect_chain?.length ?? 0;
    effectsLive += liveFxCount(t.effect_chain);
    const trackProgram = gmProgramOf(t.instrument_program);
    const parentTrackId = nonEmpty(t.parent_track_id) ?? null;
    outTracks.push({
      id: trackId,
      name: t.name || `Track ${i + 1}`,
      nameAutoGenerated: false,
      volume: dbToGain(t.volume_db),
      pan: clamp(t.pan, -1, 1, 0),
      mute: !!t.mute,
      solo: !!t.solo,
      color,
      // A whole program 0-127 only: the file is hand-editable, and a program
      // outside the GM range names no instrument.
      ...(trackProgram !== undefined ? { instrumentProgram: trackProgram } : {}),
      // A drum track plays its clips on the drum channel, the program its kit.
      ...(t.is_percussion === true ? { isPercussion: true } : {}),
      fxChain: fxChain.length ? fxChain : undefined,
      // The arrangement folders. Checked against the whole track list below,
      // once every track is known.
      ...(parentTrackId !== null ? { parentTrackId } : {}),
      ...(isFolder ? { isFolder: true, collapsed: t.collapsed === true } : {}),
    });
    for (const c of t.clips || []) {
      // Session (Perform grid) clips live in the same clips array now that the
      // format can represent them, but they are NOT arrangement content — they
      // belong to the clip-launch grid and would otherwise all pile onto the
      // EDIT timeline. Filtering on LOAD is the correct place for this; it used
      // to happen on SAVE, which deleted them from the file outright.
      if (c.scene_index != null || c.slot_index != null) {
        gridClips += 1;
        continue;
      }
      try {
        const clip = await buildClip(c, trackId, color, bpm, trackProgram, t.is_percussion === true);
        if (clip) outClips.push(clip);
        else skipped += 1;
      } catch (e) {
        skipped += 1;
        logError('project', `Clip "${c.name}" failed to load: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // routing/buses go through loadProject's payload rather than a setState, so a
  // file written before they existed takes the ONE migration path there (see
  // `migrateRouting`), exactly like a pre-routing autosave manifest. The meter
  // rides the same payload: `meterFromTasmo` answers 4/4 for a file saved before
  // `time_signature` existed, so a legacy project opens in the meter it was
  // written in rather than the one the outgoing session happened to hold.
  const { routing, buses } = tasmoToRouting(routedTracks, project.buses);
  useEditorStore.getState().loadProject({
    tracks: tasmoTrackTree(outTracks),
    clips: outClips,
    bpm,
    timeSignature: meterFromTasmo(project.time_signature),
    routing,
    buses,
  });

  // Markers and the loop region, which loadProject has just cleared. Restored
  // here rather than at either call site so BOTH ways into the editor (Open a
  // .tasmo, and a DAW import that round-trips through one) get them.
  applyTasmoMarkersAndLoop(project);
  // The master rack, the master VST chain and the automation lanes, for the
  // same reason and in the same place. This one runs SECOND because it resolves
  // each lane against the tracks `loadProject` has just put in the store.
  applyTasmoMasterAndAutomation(project);
  // `addMarker` is an ordinary document mutation, so the history subscription
  // (editorStore.ts, `state.markers !== prev.markers`) has just flagged the
  // freshly opened project dirty and pushed an undo step that would rewind the
  // markers out of it. A just-opened project is by definition unmodified and has
  // no history — loadProject says so itself — so put both back. Both calls are
  // public store API; the slices are unchanged by this point, so the same
  // subscription sees nothing to record.
  useEditorStore.getState().markSaved();
  useEditorStore.setState({ _undo: [], _redo: [] });

  // Restore persisted controller (Sway) auto-attach bindings so a re-opened
  // session re-wires the hardware to the same track/FX targets. Track ids are
  // preserved on load and FX entry ids now round-trip (see effectNodeToChainEntry),
  // so the persisted bindings still resolve. Clear when the project carries none,
  // so a non-Sway project doesn't inherit stale bindings.
  const cm = project.controller_mappings;
  if (cm && Array.isArray(cm.bindings) && cm.bindings.length) {
    useSwayImportStore.getState().setResult(
      { bindings: cm.bindings, unattached: cm.unattached ?? [] },
      cm.source_name ?? '',
    );
    startSwayImportDriver();
    logInfo('project', `Restored ${cm.bindings.length} controller mapping(s) from the saved session`);
  } else {
    useSwayImportStore.getState().clear();
  }

  // Open the project in EVERY surface it applies to, not just EDIT. The Perform
  // grid gets the same loaded payload converted to a session view (grid clips —
  // the ones EDIT filters out above — land here), and the project's Perform
  // routing hydrates or clears exactly as SessionView's own opener does. The
  // dawImportStore import is dynamic because that store statically imports this
  // module (loadIntoEditor); a static back-import would create an eval cycle.
  try {
    const { useDawImportStore } = await import('../state/dawImportStore');
    useDawImportStore.setState({ project: tasmoLoadedToDawProject(project) });
    if (project.perform_routing) {
      usePerformRoutingStore.getState().hydrate(project.perform_routing);
    } else {
      usePerformRoutingStore.getState().setCcMods([]);
    }
    logInfo('project', 'Project also opened in PERFORM (session grid seeded from the same load)');
  } catch (e) {
    logError('project', `Perform seed failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Land on the surface the project is actually for: a grid-only project (all
  // clips are scene/slot clips, e.g. the Sway Perform templates) opens onto an
  // empty EDIT timeline, so send it to PERFORM instead.
  const landing = outClips.length === 0 && gridClips > 0 ? 'session' : 'edit';
  useAppUiStore.getState().setCenterTab(landing);
  logInfo(
    'project',
    `Imported into editor: ${outTracks.length} track(s), ${outClips.length} clip(s)` +
      `${gridClips ? `, ${gridClips} grid clip(s) -> PERFORM` : ''}` +
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

/**
 * A clip's takes and comp in the file shape, with one `files` entry pushed per
 * take. Returns `{}` for a clip with no takes, so a session that has never
 * recorded an alternate writes byte-identical payloads to the ones it did
 * before takes existed.
 *
 * The ACTIVE take gets its own file even though its bytes are already in the
 * clip's own entry. That duplication buys the property that matters here: each
 * take's file is named for the take, so the take list survives an
 * active-take switch, a re-save and a reload without any entry having to be
 * understood as "the one that is also the clip's". `save-session` de-duplicates
 * nothing, and neither does this — correctness first; a content-addressed
 * archive is the fix if it ever costs enough to matter.
 */
const takesToTasmo = (
  clip: AudioClip,
  files: Array<{ name: string; blob: Blob }>,
): Pick<TasmoClipInput, 'takes' | 'comp' | 'active_take_index'> => {
  const takes = clip.takes ?? [];
  if (takes.length === 0) return {};
  const out: TasmoTake[] = takes.map((t) => {
    const fname = `${clip.id}-${t.id}.${extForMime(t.mimeType || t.audioBlob.type || 'audio/wav')}`;
    files.push({ name: fname, blob: t.audioBlob });
    return {
      id: t.id,
      name: t.label,
      audio_file: `audio/${fname}`,
      mime_type: t.mimeType,
      offset_into_source: t.offsetIntoSource,
      source_duration: t.sourceDuration,
    };
  });
  // Normalized on the way out too, so what lands in the file is a comp the
  // backend's ascending/in-range check accepts and the reader can play.
  const comp: TasmoCompRegion[] = normalizeComp(clip.comp, out.length, clip.durationSec).map((r) => ({
    start_sec: r.startSec,
    take_index: r.takeIndex,
    crossfade_sec: r.crossfadeSec ?? 0,
  }));
  return {
    takes: out,
    comp,
    // Which take the clip's OWN audio_file mirrors. Always written when there
    // are takes: a reader that defaulted it to 0 would hand back a clip whose
    // fields and active take disagree. An index that names no take reads as 0,
    // which is the store's own rule (`activeIndexOf` in editorStore.ts) — NOT
    // the last take, which would write a file claiming the clip is playing a
    // recording it never held.
    active_take_index: activeTakeIndexOf(clip.activeTakeIndex, out.length),
  };
};

/**
 * Everything a save must carry that is not a track: the project-level document
 * state. Split out from `CapturedSession` because the two save branches in
 * projectStore.ts disagree about the TRACKS (an imported DAW project saves the
 * structure it was imported from, with its files on disk; a live session saves
 * the EDIT timeline with its blobs embedded) and agree about everything else.
 * Building it in one place is what stops the imported branch from quietly
 * dropping half the document again.
 */
export interface CapturedDocument {
  controllerMappings?: TasmoControllerMappings;
  /** The project's mix buses. The master is never one of them. */
  buses: TasmoBus[];
  /** The timeline markers, as the file's `locators`. */
  locators: TasmoLocator[];
  /** The transport's cycle region, or null when there is none. */
  loop: TasmoLoop | null;
  /** The master bus's insert rack and its hosted-VST chain, in the file shape.
   *  Always written — an empty array says "this project has no master FX",
   *  which is what stops the next project from inheriting these. */
  masterFxChain: TasmoChainEntry[];
  masterVstChain: TasmoChainEntry[];
  /** The automation lanes, minus any naming a track the payload will not have. */
  automationLanes: TasmoAutomationLane[];
}

export interface CapturedSession extends CapturedDocument {
  tracks: TasmoTrackInput[];
  files: Array<{ name: string; blob: Blob }>;
  bpm: number;
  /** Project meter, saved alongside the tempo so a non-4/4 session reopens in
   *  the meter it was written in. */
  timeSignature: TimeSignature;
  clipCount: number;
}

/** Snapshot the live Sway auto-attach bindings for persistence into a .tasmo,
 *  or undefined when there are none to save. */
export function captureControllerMappings(): TasmoControllerMappings | undefined {
  const s = useSwayImportStore.getState();
  if (!s.bindings.length && !s.unattached.length) return undefined;
  return { source_name: s.sourceName, bindings: s.bindings, unattached: s.unattached };
}

/**
 * Snapshot the project-level document state for a save.
 *
 * `trackIds` names the tracks the payload being built will actually contain.
 * Only the automation lanes care: a lane keys off a track id, so writing the
 * editor's lanes into an imported-DAW save — whose tracks are the IMPORTER's,
 * with the importer's ids — would fill the file with lanes that resolve against
 * nothing. Omit it (the live-session save, whose tracks ARE the editor's) and
 * every lane is written.
 */
export function captureProjectDocument(trackIds?: readonly string[]): CapturedDocument {
  const editor = useEditorStore.getState();
  return {
    controllerMappings: captureControllerMappings(),
    buses: busesToTasmo(editor.routing, editor.buses),
    // Markers and the loop region are part of what the project IS, and were
    // dropped by every save until batch 10. See TASMO_UNSAVED_STATE for what
    // still is not written — which is now nothing.
    locators: markersToLocators(editor.markers),
    loop: loopToTasmo(editor),
    // The master bus's two chains. `loadProject` does NOT clear them, so before
    // they were written the master rack of whatever was open previously stayed
    // on the project the user opened next — and was saved into it.
    masterFxChain: editor.masterFxChain.map(chainEntryToTasmo),
    masterVstChain: editor.masterVstChain.map(chainEntryToTasmo),
    automationLanes: automationLanesToTasmo(
      editor.automationLanes,
      trackIds ? new Set(trackIds) : undefined,
    ),
  };
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
          // The notes (each stored once: the played notes, the roll's own notes
          // with their lanes, or both when neither rebuilds the other), the grid
          // length, meter map, pickup and lanes, so the clip plays what it
          // played and "Edit in Piano Roll" after a reload opens the same bars.
          ...(isMidi ? clipNotesToTasmo(c) : { midi_notes: null }),
          // The clip's own instrument and the one its embedded audio was
          // rendered with, each only as a GM program the backend accepts.
          // Without them a reopened project put every part on the global
          // instrument.
          ...(isMidi
            ? {
                instrument_program: gmProgramOf(c.instrumentProgram) ?? null,
                rendered_program: gmProgramOf(c.renderedProgram) ?? null,
                rendered_percussion: c.renderedPercussion === true,
              }
            : {}),
          // The tempo a roll clip's notes were written at, or the tempo an
          // audio clip was tagged with, which stretch-to-tempo reads.
          source_bpm: c.sourceBpm ?? null,
          // The tempo the audio plays at after a beat match or a stretch, and
          // the library entry it came from: SYNC and the BPM readout read the
          // first, and the second finds the clip's analysis, beats and stems.
          bpm: c.bpm ?? null,
          library_entry_id: c.libraryEntryId ?? null,
          // Per-clip mute, gain, fades and the trim point all survive the .tasmo
          // round-trip. offset_into_source is the load-bearing one: the embedded
          // audio is the FULL untrimmed source, so without it a split clip reloads
          // at the right place and length playing the wrong part of the take.
          muted: c.muted ?? false,
          gain: c.gain ?? 1,
          fade_in: c.fadeInSec ?? 0,
          fade_out: c.fadeOutSec ?? 0,
          offset_into_source: c.offsetIntoSource ?? 0,
          // The alternate takes (one embedded file each) and the comp across
          // them. Absent from the payload entirely for a clip with no takes.
          ...takesToTasmo(c, files),
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
      // Where this track's signal goes. Without these two keys the file said
      // nothing about routing at all, so a saved session reopened with every
      // track collapsed onto the master and every send gone.
      ...trackRoutingToTasmo(editor.routing, t.id),
      // The instrument this track's MIDI clips play through, and its place in
      // the arrangement folders. Before these were written a reopened project
      // had every part on the global instrument and every track at the root.
      // A program is written only as the whole number 0-127 the backend
      // accepts: one stray value would otherwise refuse the whole save.
      instrument_program: gmProgramOf(t.instrumentProgram) ?? null,
      // A drum track, whose program above is its kit. Without it a reopened
      // drum part played its kit's program as a melodic instrument.
      is_percussion: t.isPercussion === true,
      parent_track_id: t.parentTrackId ?? null,
      is_folder: t.isFolder === true,
      collapsed: t.collapsed === true,
    };
  });

  return {
    tracks,
    files,
    bpm: editor.bpm,
    timeSignature: editor.timeSignature,
    clipCount,
    // The tracks above ARE the editor's, so no lane can name one the payload
    // lacks — the filter is left off.
    ...captureProjectDocument(),
  };
}
