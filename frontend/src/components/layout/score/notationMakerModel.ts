/**
 * What the SCORE tab's maker can write, per instrument, and the one request
 * each choice becomes.
 *
 * The backend has four makers: a MIDI written out as a sheet exactly as it was
 * transcribed (from-midi), tablature (tabs), a rule-based arrangement (arrange:
 * lead-sheet, piano-reduction, simplified, band-score) and a chord track
 * (chords). A reader thinks in instruments, not in routes, so the maker asks
 * for an instrument and a way to write it, and this module turns the pair
 * into the route and its body. Pure: no React, no fetch.
 */
import type { MakeArrangementRequest, MakeTabsRequest, NotationArtifact } from '../../../lib/notationClient';
import { guessInstrument, orchestraInstrument } from '../../../lib/orchestra';

export type MakerInstrument = 'piano' | 'voice' | 'guitar' | 'bass' | 'ukulele' | 'drums' | 'band';

export type MakerWay = 'tab' | 'exact' | 'grand' | 'lead' | 'melody' | 'chords' | 'score';

export const MAKER_INSTRUMENTS: readonly MakerInstrument[] = [
  'piano',
  'voice',
  'guitar',
  'bass',
  'ukulele',
  'drums',
  'band',
];

export const INSTRUMENT_NAMES: Record<MakerInstrument, string> = {
  piano: 'Piano',
  voice: 'Voice',
  guitar: 'Guitar',
  bass: 'Bass',
  ukulele: 'Ukulele',
  drums: 'Drums',
  band: 'Band',
};

/** The ways each instrument can be written, the usual one first. */
export const WAYS_FOR: Record<MakerInstrument, readonly MakerWay[]> = {
  piano: ['grand', 'lead', 'exact', 'chords'],
  voice: ['melody', 'lead', 'exact'],
  guitar: ['tab', 'chords', 'melody', 'exact'],
  bass: ['tab', 'exact'],
  ukulele: ['tab', 'chords'],
  drums: ['exact'],
  band: ['score'],
};

export const WAY_NAMES: Record<MakerWay, string> = {
  tab: 'Tab',
  exact: 'Exact',
  grand: 'Grand',
  lead: 'Lead',
  melody: 'Melody',
  chords: 'Chords',
  score: 'Score',
};

/** What each way writes, for its tooltip. */
export const WAY_HINTS: Record<MakerWay, string> = {
  tab: 'Tablature with playable fingerings, in the tuning and reach you pick',
  exact: 'The MIDI written out as a staff exactly as it was transcribed; a drum-kit MIDI becomes a percussion staff',
  grand: 'A two-staff grand staff, split at middle C',
  lead: 'A lead sheet: the melody with chord symbols over it',
  melody: 'One staff with the melody alone, quantized to read cleanly',
  chords: 'A chord track for the CHORDS view, from the lead sheet when there is one, else from the audio',
  score: 'A band score: one staff per stem on one beat grid, each written for the instrument picked beside it, in score order (the full-mix stem and pitched drum transcriptions are left out unless they are given an instrument)',
};

/** The stems an instrument reads from, best first. */
const STEMS_FOR: Record<MakerInstrument, readonly string[]> = {
  piano: ['piano', 'other', 'full'],
  voice: ['vocals', 'full'],
  guitar: ['guitar', 'other', 'full'],
  bass: ['bass', 'full'],
  ukulele: ['guitar', 'other', 'full'],
  drums: ['drums'],
  band: [],
};

/** The tuning names each fretted instrument offers, by prefix. */
const TUNING_PREFIX: Partial<Record<MakerInstrument, string>> = {
  guitar: 'guitar-',
  bass: 'bass-',
  ukulele: 'ukulele-',
};

/** The instrument the tabs route is asked for. */
const TAB_INSTRUMENT: Partial<Record<MakerInstrument, string>> = {
  guitar: 'guitar',
  bass: 'bass',
  ukulele: 'ukulele',
};

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** The stem a MIDI artifact was transcribed from: the id's `__stem` tail, else its source ref. */
export function stemOf(artifact: NotationArtifact): string {
  const ref = artifact.source_ref || artifact.id;
  const cut = ref.lastIndexOf('__');
  const tail = cut >= 0 ? ref.slice(cut + 2) : ref;
  return tail.replace(/_midi$/, '').replace(/__artifact_midi$/, '') || 'full';
}

/** The registry instrument each stem's staff is written for unless the reader picks another. */
const STEM_INSTRUMENT: Readonly<Record<string, string>> = {
  vocals: 'voice',
  bass: 'electric-bass',
  guitar: 'electric-guitar',
  piano: 'piano',
  drums: 'drum-kit',
};

/**
 * The registry instrument a MIDI's staff is written for by default: the stem's
 * own instrument, else whatever the stem name names ("Flute 1", "Violin II"),
 * else '' (the staff keeps the stem's name and a clef from its notes).
 */
export function defaultStaffInstrument(artifact: NotationArtifact): string {
  const stem = stemOf(artifact);
  return STEM_INSTRUMENT[stem] ?? guessInstrument(stem)?.id ?? '';
}

/** The instrument a MIDI's staff is written for: the reader's pick ('' = none) or the default. */
export function staffInstrumentValue(artifact: NotationArtifact, picks: Readonly<Record<string, string>>): string {
  return Object.prototype.hasOwnProperty.call(picks, artifact.id) ? picks[artifact.id] : defaultStaffInstrument(artifact);
}

/** Artifact id -> registry id for every MIDI whose staff is given a known instrument. */
export function staffInstrumentsFor(
  midis: readonly NotationArtifact[],
  picks: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of midis) {
    const id = staffInstrumentValue(m, picks);
    if (id && orchestraInstrument(id)) out[m.id] = id;
  }
  return out;
}

/** The legacy MIDI id the from-midi route takes. */
export function legacyMidiId(artifact: NotationArtifact): string {
  try {
    const meta = JSON.parse(artifact.metadata_json || '{}') as { legacy_midi_id?: string } | null;
    if (meta && typeof meta.legacy_midi_id === 'string' && meta.legacy_midi_id) return meta.legacy_midi_id;
  } catch {
    /* fall through to the id itself */
  }
  return artifact.source_ref || artifact.id.replace(/__artifact_midi$/, '');
}

/** The MIDI an instrument should read: its own stem when the song has one, else the first MIDI. */
export function pickSource(instrument: MakerInstrument, midis: readonly NotationArtifact[]): NotationArtifact | null {
  for (const stem of STEMS_FOR[instrument]) {
    const hit = midis.find((m) => stemOf(m) === stem);
    if (hit) return hit;
  }
  return midis[0] ?? null;
}

/** The tunings a fretted instrument offers from the backend's list; empty for the rest. */
export function tuningsFor(instrument: MakerInstrument, all: readonly string[]): string[] {
  const prefix = TUNING_PREFIX[instrument];
  return prefix ? all.filter((t) => t.startsWith(prefix)) : [];
}

/** A way reads a MIDI; chords read the lead sheet or the audio instead. */
export function needsMidi(way: MakerWay): boolean {
  return way !== 'chords';
}

/** The way to use when the instrument changes: keep the current one if the new instrument has it. */
export function wayAfterInstrumentChange(instrument: MakerInstrument, current: MakerWay): MakerWay {
  const ways = WAYS_FOR[instrument];
  return ways.includes(current) ? current : ways[0];
}

export type MakerPlan =
  | { route: 'from-midi'; midiId: string }
  | { route: 'tabs'; req: MakeTabsRequest }
  | { route: 'arrange'; req: MakeArrangementRequest }
  | { route: 'chords' };

export interface MakerChoice {
  instrument: MakerInstrument;
  way: MakerWay;
  /** The MIDI to read, for every way but chords and the band score. */
  source: NotationArtifact | null;
  /** Every MIDI of the song, for the band score. */
  midis: readonly NotationArtifact[];
  tuning: string;
  capo: number;
  difficulty: Difficulty;
  /** The band score's instrument picks, by artifact id ('' = keep the stem's name); unpicked MIDIs take their default. */
  staffInstruments?: Readonly<Record<string, string>>;
}

/** The request a choice becomes, or the reason it cannot be made yet. */
export function planFor(choice: MakerChoice): MakerPlan | { error: string } {
  const { instrument, way, source, midis } = choice;
  if (!WAYS_FOR[instrument].includes(way)) {
    return { error: `${INSTRUMENT_NAMES[instrument]} cannot be written as ${WAY_NAMES[way]}` };
  }
  if (way === 'chords') return { route: 'chords' };
  if (midis.length === 0) return { error: 'No MIDI yet. Right-click the track and Convert to MIDI.' };
  if (way === 'score') {
    const instruments = staffInstrumentsFor(midis, choice.staffInstruments ?? {});
    const req: MakeArrangementRequest = { style: 'band-score', source_artifact_ids: midis.map((m) => m.id) };
    if (Object.keys(instruments).length > 0) req.instruments = instruments;
    return { route: 'arrange', req };
  }
  if (!source) return { error: 'Pick a MIDI to read from' };
  switch (way) {
    case 'exact':
      return { route: 'from-midi', midiId: legacyMidiId(source) };
    case 'tab':
      return {
        route: 'tabs',
        req: {
          source_artifact_id: source.id,
          instrument: TAB_INSTRUMENT[instrument] ?? 'guitar',
          tuning_name: choice.tuning,
          capo: choice.capo,
          difficulty: choice.difficulty,
        },
      };
    case 'grand':
      return { route: 'arrange', req: { style: 'piano-reduction', source_artifact_id: source.id } };
    case 'lead':
      return { route: 'arrange', req: { style: 'lead-sheet', source_artifact_id: source.id } };
    case 'melody':
      return { route: 'arrange', req: { style: 'simplified', source_artifact_id: source.id } };
    default:
      return { error: `Unknown way ${String(way)}` };
  }
}
