/**
 * clipSongTime — where an audio clip's audio sits in a library song's own time.
 *
 * Library audio and the stems separated from it are the song's own seconds, so
 * the song's analysis (its tempo, its beats, its downbeats and meter) describes
 * the clip. A clip carries that tie as `songTime`: the song's library entry,
 * the song's analysed tempo, and a linear map from the clip's audio seconds to
 * the song's:
 *
 *   song second = offsetSec + audio second * rate
 *
 * Inserted audio starts at { offsetSec: 0, rate: 1 }. A beat match or a
 * Time/Pitch render bakes a stretch of part of the audio into new audio, and
 * the map follows it (songTimeAfterStretch), so a clip stretched to 120 still
 * reads the song's beats where they now sound. Anything else that replaces the
 * audio drops the tie (editorStore clipWithUpdates): reversed or re-generated
 * audio is no longer the song's time.
 *
 * Everything here is pure, so node tests load it.
 */

/** A clip's tie to its song's analysis. */
export interface ClipSongTime {
  /** The library entry whose analysis times this audio: the entry itself for
   *  library audio, the song a stem was separated from for a stem. */
  entryId: string;
  /** The song's analysed tempo in BPM, when it was known. */
  bpm?: number;
  /** Song seconds at second 0 of the clip's audio. */
  offsetSec: number;
  /** Song seconds per second of the clip's audio (a 1.05x stretch makes it 1.05). */
  rate: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A usable tempo, or undefined. */
const bpmOrUndefined = (bpm: unknown): number | undefined => (isNum(bpm) && bpm > 0 ? bpm : undefined);

/** The tie of audio that IS the song (or a stem of it), from its first second. */
export function songTimeForEntry(entryId: string | null | undefined, bpm?: number | null): ClipSongTime | undefined {
  if (!entryId) return undefined;
  const known = bpmOrUndefined(bpm);
  return { entryId, ...(known ? { bpm: known } : {}), offsetSec: 0, rate: 1 };
}

/** A tie read from a file or a hand-edited value, or undefined when it cannot map the audio. */
export function sanitizeSongTime(raw: unknown): ClipSongTime | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const entryId = typeof r.entryId === 'string' ? r.entryId : typeof r.entry_id === 'string' ? r.entry_id : '';
  if (!entryId) return undefined;
  const offset = isNum(r.offsetSec) ? r.offsetSec : isNum(r.offset_sec) ? r.offset_sec : 0;
  const rate = isNum(r.rate) && r.rate > 0 ? r.rate : 1;
  const bpm = bpmOrUndefined(r.bpm);
  return { entryId, ...(bpm ? { bpm } : {}), offsetSec: offset, rate };
}

/** The tie as a .tasmo file holds it (backend SongTime). */
export const songTimeToTasmo = (st: ClipSongTime): { entry_id: string; bpm: number | null; offset_sec: number; rate: number } => ({
  entry_id: st.entryId,
  bpm: st.bpm ?? null,
  offset_sec: st.offsetSec,
  rate: st.rate,
});

/** The tie with the song's tempo filled in; the same object when there is nothing new. */
export function songTimeWithBpm(st: ClipSongTime, bpm: number | null | undefined): ClipSongTime {
  const known = bpmOrUndefined(bpm);
  if (!known || st.bpm === known) return st;
  return { ...st, bpm: known };
}

/**
 * The tie after a stretch rendered the audio from `offsetIntoSource` on at
 * `tempo` (> 1 faster and shorter), as lib/beatMatchRun's time/pitch render
 * does: second `a` of the new audio is second `offsetIntoSource + a * tempo`
 * of the old.
 */
export function songTimeAfterStretch(st: ClipSongTime, offsetIntoSource: number, tempo: number): ClipSongTime {
  const t = isNum(tempo) && tempo > 0 ? tempo : 1;
  const off = isNum(offsetIntoSource) ? offsetIntoSource : 0;
  return { ...st, offsetSec: st.offsetSec + off * st.rate, rate: st.rate * t };
}

/** Song seconds to seconds of the clip's audio, and back. */
export const songSecToAudioSec = (st: ClipSongTime, songSec: number): number => (songSec - st.offsetSec) / st.rate;
export const audioSecToSongSec = (st: ClipSongTime, audioSec: number): number => st.offsetSec + audioSec * st.rate;

/** The clip fields that place song time on the timeline. */
export interface ClipTimelineWindow {
  startSec: number;
  offsetIntoSource: number;
  durationSec: number;
  /** Seconds of the clip's audio per timeline second (editorStore clipStretchRate). */
  playRate?: number;
}

/** The timeline second where song second `songSec` sounds in the clip (it may lie outside the clip's window). */
export function songSecToTimeline(st: ClipSongTime, clip: ClipTimelineWindow, songSec: number): number {
  const play = isNum(clip.playRate) && clip.playRate > 0 ? clip.playRate : 1;
  return clip.startSec + (songSecToAudioSec(st, songSec) - clip.offsetIntoSource) / play;
}

/** The song second that sounds at timeline second `sec` in the clip. */
export function timelineToSongSec(st: ClipSongTime, clip: ClipTimelineWindow, sec: number): number {
  const play = isNum(clip.playRate) && clip.playRate > 0 ? clip.playRate : 1;
  return audioSecToSongSec(st, clip.offsetIntoSource + (sec - clip.startSec) * play);
}

/** The song's beats (song seconds) as seconds of the clip's audio, in order. */
export const songBeatsAsAudio = (st: ClipSongTime, beats: readonly number[] | null | undefined): number[] | null =>
  beats && beats.length ? beats.filter(isNum).map((b) => songSecToAudioSec(st, b)) : null;

/** The tempo the clip's audio plays at: the song's, times the stretch it was rendered at. Null when the song's is unknown. */
export function songTimeAudioBpm(st: ClipSongTime, songBpm?: number | null): number | null {
  const bpm = bpmOrUndefined(songBpm) ?? st.bpm;
  return bpm ? bpm * st.rate : null;
}
