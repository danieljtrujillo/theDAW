/**
 * songTimeLink — ties new EDIT audio to the library song it is the time of
 * (lib/clipSongTime), from every place audio enters EDIT: a library drop or
 * send, a stem row's drop or send, a separation's stems, and "All stems".
 *
 * The tie names the song's library entry and carries the song's analysed
 * tempo when the library analysis already knows it. When it does not, the
 * analysis is asked for (GET first, a run only when there is none, behind the
 * user's own requests) and its tempo is written onto every clip tied to the
 * song as it lands, without an undo step: it is what the audio is, not an edit.
 */
import { clipStretchRate, useEditorStore, type AudioClip, type SongTempoRequest } from '../state/editorStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
import { useLibraryStore } from '../state/libraryStore';
import { warpSegments } from './audioWarp';
import { songSecToAudioSec, songTimeForEntry, songTimeWithBpm, type ClipSongTime } from './clipSongTime';
import type { EditTimeMaps } from './editTimeMap';
import type { RhythmAnalysis } from './rhythmSeed';
import { planSongTempo, type SongPlacement, type SongTempoResult } from './songTempo';

/** The song's tempo as the library already knows it: the analysis cache, else the entry's own analysis row. */
export function knownSongBpm(entryId: string): number | undefined {
  const cached = useDjAnalysisStore.getState().byId[entryId]?.data?.bpm;
  if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) return cached;
  const entry = useLibraryStore.getState().entries.find((e) => e.id === entryId);
  const row = entry?.analysis?.bpm;
  return typeof row === 'number' && Number.isFinite(row) && row > 0 ? row : undefined;
}

const filling = new Map<string, Promise<void>>();

/**
 * Ask the library analysis for the song's tempo and write it onto every clip
 * tied to `entryId` that has none. One request per song at a time.
 */
export function fillSongTempo(entryId: string): Promise<void> {
  const running = filling.get(entryId);
  if (running) return running;
  const job = (async () => {
    try {
      const data = await useDjAnalysisStore.getState().ensureAnalyzed(entryId, { priority: false });
      const bpm = data?.bpm;
      if (!(typeof bpm === 'number' && bpm > 0)) return;
      const store = useEditorStore.getState();
      for (const clip of store.clips) {
        if (clip.songTime?.entryId !== entryId || clip.songTime.bpm) continue;
        store.applyClipRender(clip.id, { songTime: songTimeWithBpm(clip.songTime, bpm) });
      }
    } catch {
      // The analysis is a nicety for SYNC; a clip without it says so in its menu.
    } finally {
      filling.delete(entryId);
    }
  })();
  filling.set(entryId, job);
  return job;
}

/**
 * The tie for new audio that is library entry `entryId`'s time from its first
 * second (the entry's own audio, or a stem separated from it). Starts the
 * tempo fill when the song's tempo is not known yet. Undefined without an entry.
 */
export function linkSongTime(entryId: string | null | undefined, bpm?: number | null): ClipSongTime | undefined {
  if (!entryId) return undefined;
  const st = songTimeForEntry(entryId, bpm ?? knownSongBpm(entryId));
  if (st && !st.bpm) void fillSongTempo(entryId);
  return st;
}

/**
 * The tie for stems separated from library entry `separatedEntryId` and
 * placed beside `parent`. Stems of an entry are that entry's time, so they
 * are tied to it from its first second. When the entry was imported from the
 * parent clip's own audio (a clip with no library entry), the stems are the
 * parent's audio time and keep the parent's tie.
 */
export function stemsSongTime(
  parent: Pick<AudioClip, 'songTime'>,
  separatedEntryId: string | null | undefined,
  importedFromClipAudio = false,
): ClipSongTime | undefined {
  if (importedFromClipAudio) return parent.songTime ? { ...parent.songTime } : undefined;
  if (!separatedEntryId) return undefined;
  const bpm = parent.songTime?.entryId === separatedEntryId ? parent.songTime.bpm : undefined;
  return linkSongTime(separatedEntryId, bpm);
}

/* ── where the song sounds ──────────────────────────────────────────────── */

/** A clip's song and where the song's seconds sound on the timeline, or the reason there are none. */
export type ClipSongPlacement =
  | { ok: true; songTime: ClipSongTime; placement: SongPlacement; error?: undefined }
  | { ok: false; error: string; songTime?: undefined; placement?: undefined };

/**
 * Where `clip`'s song sounds: song seconds through the clip's tie to its audio
 * seconds, then through the clip's trim, its stretch rate or its warp markers
 * (as liveMixer schedules them) to timeline seconds. A clip dropped from the
 * library before clips carried a tie reads as its entry's own time until a
 * stretch re-rendered it.
 */
export function clipSongPlacement(clip: AudioClip): ClipSongPlacement {
  if (clip.sourceKind === 'piano-roll') return { ok: false, error: `"${clip.label}" is a MIDI clip; its tempo and meter come from its own notes.` };
  const st = clip.songTime ?? (clip.libraryEntryId && !clip.bpm ? songTimeForEntry(clip.libraryEntryId) : undefined);
  if (!st) {
    return {
      ok: false,
      error: clip.libraryEntryId
        ? `"${clip.label}" was stretched before clips kept their place in the song's time. Put it on the timeline again from the library.`
        : `"${clip.label}" is not from a library song, so there is no rhythm analysis behind it.`,
    };
  }
  const play = clipStretchRate(clip);
  const span = Math.min(clip.durationSec, Math.max(0, clip.sourceDuration - clip.offsetIntoSource));
  const segs = clip.warpMarkers?.length ? warpSegments(clip.warpMarkers, span) : [];
  const warped = segs.length > 1 || (segs.length === 1 && Math.abs(segs[0].playbackRate - 1) > 1e-9);
  const audioToClip = (audioSec: number): number => {
    const x = audioSec - clip.offsetIntoSource;
    if (!warped) return x / play;
    // Before the first segment and after the last, the nearest segment's rate carries on.
    const seg = segs.find((s) => x < s.sourceEnd) ?? segs[segs.length - 1];
    return seg.targetStart + (x - seg.sourceStart) / seg.playbackRate;
  };
  return {
    ok: true,
    songTime: st,
    placement: {
      toTimeline: (songSec) => clip.startSec + audioToClip(songSecToAudioSec(st, songSec)),
      startSec: clip.startSec,
      endSec: clip.startSec + clip.durationSec,
    },
  };
}

/** The clip a "Use song tempo" for `entryId` lines up with: the one named, else the earliest clip of the song. */
export function songTempoClip(clips: readonly AudioClip[], entryId: string, clipId?: string): AudioClip | undefined {
  const named = clipId ? clips.find((c) => c.id === clipId) : undefined;
  if (named) return named;
  const ofSong = clips.filter((c) => c.sourceKind !== 'piano-roll' && (c.songTime ? c.songTime.entryId === entryId : c.libraryEntryId === entryId));
  return ofSong.sort((a, b) => a.startSec - b.startSec)[0];
}

/** The song as it would sound dropped at the start of the timeline: when no clip of it is there. */
export const songAtTimelineStart: SongPlacement = { toTimeline: (songSec) => songSec, startSec: 0, endSec: Number.POSITIVE_INFINITY };

/**
 * "Use song tempo" for `req` against the arrangement's maps: the clip it lines
 * up with (the one named, else the song's earliest clip, else none: the song
 * as if it starts at 0) and the plan, or the reason there is none.
 */
export function songTempoPlanFor(
  req: SongTempoRequest,
  clips: readonly AudioClip[],
  maps: EditTimeMaps,
  analysis: RhythmAnalysis,
): { clip: AudioClip | undefined; plan: SongTempoResult } {
  const clip = songTempoClip(clips, req.entryId, req.clipId);
  const where = clip ? clipSongPlacement(clip) : null;
  if (where && !where.ok) return { clip, plan: { ok: false, error: where.error } };
  return { clip, plan: planSongTempo(maps, analysis, where?.ok ? where.placement : songAtTimelineStart) };
}
