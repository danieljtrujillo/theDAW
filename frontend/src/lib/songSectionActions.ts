/**
 * The two places a song's sections are written from a key (lib/songSections
 * has the placement rules):
 *
 *   - addSectionMarkersToClip: EDIT's clip menu, "Add section markers"
 *   - applySongFormToRoll: the MIDI tab's song menu, FORM
 *
 * Both find the sections first when the song has none yet, and say what they
 * did in the LOG.
 */
import { clipStretchRate, useEditorStore } from '../state/editorStore';
import { usePianoRollStore } from '../state/pianoRollStore';
import { logError, logInfo, logWarn } from '../state/logStore';
import { barLines } from './meterMap';
import { loadChordTrack } from './chordTrack';
import { listNotationArtifacts } from './notationClient';
import { markerStep, withFormMarkers } from './rollMarkers';
import { stepClock } from './rollTempo';
import {
  chordTrackHarmony,
  fetchSongSections,
  findSongSections,
  sectionEditMarkers,
  sectionRollMarkers,
  type SongSectionsDoc,
} from './songSections';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function sectionsOf(entryId: string, label: string): Promise<SongSectionsDoc> {
  const had = await fetchSongSections(entryId);
  if (had.status === 'ready') return had;
  logInfo('sections', `Finding the sections of "${label}"`);
  return findSongSections(entryId);
}

/**
 * EDIT: a marker at each section start of the clip's song, where the clip
 * plays it. Replaces the markers an earlier add wrote on this clip. Returns
 * how many it placed, or null when it could not run.
 */
export async function addSectionMarkersToClip(clipId: string): Promise<number | null> {
  const clip = useEditorStore.getState().clips.find((c) => c.id === clipId);
  const entryId = clip?.libraryEntryId;
  if (!clip || !entryId) return null;
  try {
    const doc = await sectionsOf(entryId, clip.label);
    const sections = doc.sections ?? [];
    // The clip may have moved or gone while the sections were found.
    const now = useEditorStore.getState().clips.find((c) => c.id === clipId);
    if (!now) return null;
    const markers = sectionEditMarkers(
      sections,
      {
        id: now.id,
        startSec: now.startSec,
        offsetIntoSource: now.offsetIntoSource,
        durationSec: now.durationSec,
        sourceDuration: now.sourceDuration,
        rate: clipStretchRate(now),
      },
      doc.duration_sec ?? now.sourceDuration,
    );
    useEditorStore.getState().setClipSectionMarkers(clipId, markers);
    const outside = sections.length - markers.length;
    if (sections.length === 0) logWarn('sections', `"${now.label}" has no sections to mark`);
    else {
      logInfo(
        'sections',
        `Added ${plural(markers.length, 'section marker')} to "${now.label}"${outside > 0 ? `; ${plural(outside, 'section')} start outside the clip` : ''}`,
      );
    }
    return markers.length;
  } catch (e) {
    logError('sections', `Could not add section markers: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** What FORM did, for the MIDI tab's status line and the LOG. */
export interface SongFormResult {
  sections: number;
  /** Sections that start past the roll's end, so the ruler does not show them. */
  pastEnd: number;
  chords: number;
  /** True when the song has a chord track. */
  hasChordTrack: boolean;
  status: string;
  level: 'info' | 'warn';
}

/** The song's newest chord track's chords, or null when it has none. */
async function songChords(entryId: string) {
  const rows = await listNotationArtifacts(entryId, 'chordtrack');
  const newest = [...rows].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!newest) return null;
  return (await loadChordTrack(newest.id)).chords;
}

/**
 * The MIDI tab's FORM: the song's sections as section markers on the roll's
 * marker row (at the bar line where each starts on the roll's clock; the
 * previous FORM markers are replaced, the user's own stay) and, when the song
 * has a chord track, its chords in the HARMONY row. One undo step for the
 * markers. Throws when the sections cannot be read or found.
 */
export async function applySongFormToRoll(entryId: string, label: string): Promise<SongFormResult> {
  const doc = await sectionsOf(entryId, label);
  const sections = doc.sections ?? [];
  let chords: Awaited<ReturnType<typeof songChords>> = null;
  try {
    chords = await songChords(entryId);
  } catch (e) {
    logWarn('piano-roll', `The chord track of "${label}" could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const roll = usePianoRollStore.getState();
  const clock = stepClock(roll.bpm, roll.tempoMap);
  const lines = barLines(roll.meterMap, roll.totalSteps, roll.pickupSteps);
  const markers = sectionRollMarkers(sections, clock, lines);
  roll.setMarkers(withFormMarkers(roll.markers, markers));
  const pastEnd = markers.filter((m) => markerStep(m) >= roll.totalSteps).length;
  const harmony = chords ? chordTrackHarmony(chords, clock) : [];
  if (chords) roll.showSongChords(harmony);

  const parts = [`FORM WROTE ${plural(markers.length, 'SECTION MARKER')}`];
  if (chords) parts.push(`${plural(harmony.length, 'CHORD')} IN THE HARMONY ROW`);
  let status = `${parts.join(' AND ')}.`;
  if (!chords) status += ' THE SONG HAS NO CHORD TRACK YET; SCORE > CHORDS BUILDS ONE.';
  if (pastEnd > 0) status += ` ${plural(pastEnd, 'SECTION')} START PAST THE ROLL'S END.`;
  const level: SongFormResult['level'] = sections.length === 0 || pastEnd > 0 ? 'warn' : 'info';
  (level === 'warn' ? logWarn : logInfo)(
    'piano-roll',
    `Form of "${label}": ${plural(markers.length, 'section marker')}${chords ? `, ${plural(harmony.length, 'chord')} in the harmony row` : ', no chord track'}${pastEnd ? `, ${pastEnd} past the roll's end` : ''}`,
  );
  return { sections: markers.length, pastEnd, chords: harmony.length, hasChordTrack: !!chords, status, level };
}
