/**
 * beatMatchRun — EDIT's SYNC and Time/Pitch against the document: which tempo
 * and beats a clip is known to have, what a finished time/pitch render writes
 * onto the clip, and the beat match that stretches clips and lands their first
 * beat on the grid (lib/beatMatch holds the maths).
 *
 * The render itself (the backend's time_pitch effect) is passed in, so the
 * whole run can be replayed in a node test with a renderer that returns audio
 * of the right length.
 *
 * A clip's tempo and beats come from, in order:
 *   1. `bpm`, what a beat match or a stretch set;
 *   2. `songTime` (lib/clipSongTime), the song the audio belongs to: the
 *      song's analysed tempo and beats mapped through the stretch the audio was
 *      rendered at, so a stem or a clip beat matched twice still knows them;
 *   3. `libraryEntryId`, the library analysis of the entry the audio came from.
 */
import { useEditorStore, type AudioClip } from '../state/editorStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
import { logError, logInfo } from '../state/logStore';
import { alignedStart, alignedStartOn, beatMatchPlan, firstBeatInClip } from './beatMatch';
import { songBeatsAsAudio, songTimeAfterStretch, songTimeAudioBpm, type ClipSongTime } from './clipSongTime';
import { editMoveByBeats, editSnapSec, editTempoAtSec } from './editTimeMap';
import { hasTempoChanges } from './rollTempo';

/** What a finished time/pitch render hands back: the new audio, its length and its peaks. */
export interface TimePitchRender {
  blob: Blob;
  duration: number;
  peaks?: Float32Array;
}

/** Renders the clip's played region at `tempo` (> 1 faster) and `semitones`. */
export type TimePitchRenderer = (clip: AudioClip, tempo: number, semitones: number) => Promise<TimePitchRender>;

const djData = (entryId: string | undefined) => (entryId ? useDjAnalysisStore.getState().byId[entryId]?.data ?? null : null);

/** The song's analysed tempo: the one the clip carries, else the library analysis cache's. */
export function songBpmOf(st: ClipSongTime): number | null {
  if (st.bpm && st.bpm > 0) return st.bpm;
  const d = djData(st.entryId);
  return d?.bpm && d.bpm > 0 ? d.bpm : null;
}

/** The tempo a clip plays at: what a beat match or stretch set, else its song's
 *  tempo through the stretch its audio was rendered at, else the library
 *  analysis of its source. Null for MIDI clips and unanalysed audio. */
export function clipKnownBpm(clip: AudioClip): number | null {
  if (clip.sourceKind === 'piano-roll') return null;
  if (clip.bpm && clip.bpm > 0) return clip.bpm;
  if (clip.songTime) return songTimeAudioBpm(clip.songTime, songBpmOf(clip.songTime));
  const d = djData(clip.libraryEntryId);
  return d?.bpm && d.bpm > 0 ? d.bpm : null;
}

/** The clip's analysed beats as seconds of its own audio. A clip tied to its
 *  song reads the song's beats through the tie, stretched or not. Without a
 *  tie, the library entry's beats describe the audio only until a stretch
 *  re-renders it, so a stretched clip then has none. */
export function clipAudioBeats(clip: AudioClip): number[] | null {
  if (clip.songTime) return songBeatsAsAudio(clip.songTime, djData(clip.songTime.entryId)?.beats);
  if (!clip.bpm && clip.libraryEntryId) return djData(clip.libraryEntryId)?.beats ?? null;
  return null;
}

/**
 * Put a finished time/pitch render on the clip: the new audio from its head,
 * the tempo it now plays at, and the song tie moved by the stretch. One undo
 * step with the clip's other edits of the moment (updateClip coalesces by clip).
 */
export function applyTimePitchResult(clipId: string, render: TimePitchRender, tempo: number, knownBpm: number | null): void {
  const clip = useEditorStore.getState().clips.find((c) => c.id === clipId);
  if (!clip) return;
  useEditorStore.getState().updateClip(clipId, {
    audioBlob: render.blob,
    mimeType: 'audio/wav',
    offsetIntoSource: 0,
    durationSec: render.duration,
    ...(render.peaks ? { peaks: render.peaks } : {}),
    // The readout follows the stretch: a 120 clip at 1.05x plays at 126.
    bpm: knownBpm ? knownBpm * tempo : clip.bpm,
    // The rendered audio starts where the clip's region did, at the new pace.
    // Named even when absent, so the drop rule for new audio never fires here.
    songTime: clip.songTime ? songTimeAfterStretch(clip.songTime, clip.offsetIntoSource, tempo) : undefined,
  });
}

/** Render a time/pitch change and put it on the clip, logging the result. False when it failed. */
export async function runTimePitch(clipId: string, tempo: number, semitones: number, render: TimePitchRenderer): Promise<boolean> {
  const clip = useEditorStore.getState().clips.find((c) => c.id === clipId);
  if (!clip) return false;
  const known = clipKnownBpm(clip);
  try {
    const out = await render(clip, tempo, semitones);
    applyTimePitchResult(clipId, out, tempo, known);
    logInfo('editor', `Time/Pitch: ${tempo.toFixed(2)}x, ${semitones >= 0 ? '+' : ''}${semitones} st -> ${out.duration.toFixed(2)}s`);
    return true;
  } catch (e) {
    logError('editor', `Time/Pitch failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** What a beat match did. */
export interface BeatMatchOutcome {
  stretched: number;
  aligned: number;
  unknown: number;
}

/**
 * Beat match, the way a deck's SYNC works: every clip in `ids` is stretched to
 * `targetBpm` (pitch kept), its first analysed beat is put on the grid, and the
 * project tempo becomes the target so the grid agrees. One render per clip, in
 * turn. MIDI clips and clips with no known tempo are skipped and counted.
 *
 * `toProject`: the target is the arrangement's own tempo. When the
 * arrangement's tempo map changes tempo, each clip then stretches to the tempo
 * sounding where it starts, and the map is left as it is.
 */
export async function runBeatMatch(ids: readonly string[], targetBpm: number, toProject: boolean, render: TimePitchRenderer): Promise<BeatMatchOutcome> {
  const outcome: BeatMatchOutcome = { stretched: 0, aligned: 0, unknown: 0 };
  if (!(targetBpm > 0)) return outcome;
  const live = useEditorStore.getState();
  const subjects = ids
    .map((id) => live.clips.find((c) => c.id === id))
    .filter((c): c is AudioClip => !!c && c.sourceKind !== 'piano-roll');
  if (subjects.length === 0) return outcome;
  // With tempo changes, the grid a first beat lands on is the arrangement's
  // quarter grid through its tempo map (restarting at each bar line), not a
  // constant beat from 0, and the map is not rewritten to one tempo.
  const maps = { tempoMap: live.tempoMap, meterMap: live.meterMap };
  const mapped = hasTempoChanges(live.tempoMap);
  const targetOf = (c: AudioClip): number => (mapped && toProject ? editTempoAtSec(live.tempoMap, c.startSec) : targetBpm);
  const plan = subjects.flatMap((c) => beatMatchPlan([{ id: c.id, bpm: clipKnownBpm(c) }], targetOf(c)));
  const tempoById = new Map(plan.map((step) => [step.id, step.tempo]));
  if (!mapped && Math.abs(targetBpm - live.bpm) > 0.01) live.setBpm(targetBpm);
  const beatLen = 60 / targetBpm;
  const quarterGrid = { ...maps, meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }] };
  for (const clip of subjects) {
    const known = clipKnownBpm(clip);
    if (known === null) {
      outcome.unknown += 1;
      continue;
    }
    const tempo = tempoById.get(clip.id) ?? 1;
    const first = firstBeatInClip(clipAudioBeats(clip), clip.offsetIntoSource, clip.durationSec, tempo);
    if (tempo !== 1) {
      if (!(await runTimePitch(clip.id, tempo, 0, render))) continue;
      outcome.stretched += 1;
    }
    const now = useEditorStore.getState().clips.find((c) => c.id === clip.id);
    if (!now) continue;
    const patch: Partial<AudioClip> = {};
    const start = mapped
      ? alignedStartOn(now.startSec, first, (sec) => editSnapSec(maps, sec, 4), (line) => editMoveByBeats(quarterGrid, line, 1))
      : alignedStart(now.startSec, first, beatLen);
    if (Math.abs(start - now.startSec) > 1e-6) {
      patch.startSec = start;
      outcome.aligned += 1;
    }
    if (!now.bpm) patch.bpm = known * tempo;
    if (Object.keys(patch).length > 0) useEditorStore.getState().updateClip(clip.id, patch);
  }
  const skipped = outcome.unknown > 0 ? `, ${outcome.unknown} skipped (no tempo known; analyse them in the library first)` : '';
  const toWhat = mapped && toProject ? 'the arrangement\'s tempo map' : `${Math.round(targetBpm)} bpm`;
  logInfo('editor', `Beat match to ${toWhat}: ${outcome.stretched} stretched, ${outcome.aligned} moved onto the grid${skipped}`);
  return outcome;
}
