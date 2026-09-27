/**
 * The orchestral instrument registry, read by the instrument pickers, the
 * SCORE maker and anything that needs to know what a part is.
 *
 * The records live in orchestraData.ts, which is generated from the backend's
 * registry (backend/modules/notation/instruments.py) and checked against it
 * by tests/test_orchestra_registry.py, so the two cannot drift. This module
 * only types the data and adds the lookups.
 *
 * Every record's range is at SOUNDING pitch (what a MIDI file and the roll
 * hold), `semitones` is written-to-sounding (`sounding = written + semitones`),
 * `program` is 0-based General MIDI and `bank` is the SoundFont bank (0 for
 * the melodic set, 128 for the kits). An unpitched percussion record plays
 * key `kitPitch` of the Orchestral kit on the drum channel.
 */
import { ORCHESTRA_DATA } from './orchestraData';
import { GM_NAMES } from './gmInstruments';

export type ClefId = 'treble' | 'treble8vb' | 'alto' | 'tenor' | 'bass' | 'percussion';

export type OrchestraFamilyId = (typeof ORCHESTRA_DATA.families)[number]['id'];

export interface OrchestraFamily {
  id: OrchestraFamilyId;
  label: string;
}

export interface OrchestraInstrument {
  id: string;
  family: OrchestraFamilyId;
  /** Position in score order, top staff first. */
  order: number;
  name: string;
  abbreviation: string;
  /** The music21 instrument class the backend builds the part on. */
  music21Class: string;
  /** Written-to-sounding interval in music21's notation ("M-2", "P8", "P1"). */
  transposition: string;
  /** The same interval in semitones: sounding = written + semitones. */
  semitones: number;
  /** The clefs the part reads in, the usual one first. */
  clefs: readonly ClefId[];
  /** 2 for an instrument written on a grand staff (piano, harp, celesta...). */
  staves: number;
  /** Practical range, sounding MIDI numbers. */
  rangeLow: number;
  rangeHigh: number;
  program: number;
  bank: number;
  percussion: boolean;
  kitPitch: number | null;
  aliases: readonly string[];
  matchKeys: readonly string[];
}

export const ORCHESTRA_FAMILIES: readonly OrchestraFamily[] = ORCHESTRA_DATA.families;

/** Every record, in score order. */
export const ORCHESTRA: readonly OrchestraInstrument[] = ORCHESTRA_DATA.instruments as readonly OrchestraInstrument[];

const BY_ID = new Map(ORCHESTRA.map((i) => [i.id, i]));

export const orchestraInstrument = (id: string | null | undefined): OrchestraInstrument | undefined =>
  id ? BY_ID.get(id) : undefined;

export const familyLabel = (family: OrchestraFamilyId): string =>
  ORCHESTRA_FAMILIES.find((f) => f.id === family)?.label ?? family;

/** The records grouped by family, both in score order; `keep` filters the records. */
export function orchestraByFamily(
  keep: (inst: OrchestraInstrument) => boolean = () => true,
): { family: OrchestraFamily; instruments: OrchestraInstrument[] }[] {
  return ORCHESTRA_FAMILIES.map((family) => ({
    family,
    instruments: ORCHESTRA.filter((i) => i.family === family.id && keep(i)),
  })).filter((g) => g.instruments.length > 0);
}

/** The first record in score order that plays `program` in `bank`; a drum-channel part is the drum kit. */
export function instrumentForProgram(program: number, bank = 0, percussion = false): OrchestraInstrument | undefined {
  if (percussion) return BY_ID.get('drum-kit');
  return ORCHESTRA.find((i) => i.program === program && i.bank === bank && !i.percussion);
}

const MATCH_RE = new RegExp(ORCHESTRA_DATA.matchPattern, 'gu');

/** A part name as the registry compares it (the backend's normalize_name). */
export const normalizeName = (text: string): string =>
  text.toLowerCase().replace(MATCH_RE, ' ').replace(/\s+/g, ' ').trim();

/**
 * The record a part name names: one of its match keys as a whole word, the
 * longest match winning ("Bass Clarinet 1" is the bass clarinet) and the
 * earlier record in score order on a tie. The backend's guess_from_name runs
 * the same match over the same keys.
 */
export function guessInstrument(text: string): OrchestraInstrument | undefined {
  const hay = ` ${normalizeName(text)} `;
  let best: OrchestraInstrument | undefined;
  let bestLen = -1;
  for (const inst of ORCHESTRA) {
    for (const key of inst.matchKeys) {
      if (key.length > bestLen && hay.includes(` ${key} `)) {
        best = inst;
        bestLen = key.length;
      }
    }
  }
  return best;
}

export const writtenPitch = (inst: OrchestraInstrument, sounding: number): number => sounding - inst.semitones;
export const soundingPitch = (inst: OrchestraInstrument, written: number): number => written + inst.semitones;
export const inRange = (inst: OrchestraInstrument, sounding: number): boolean =>
  sounding >= inst.rangeLow && sounding <= inst.rangeHigh;

export const CLEF_NAMES: Record<ClefId, string> = {
  treble: 'treble',
  treble8vb: 'treble 8vb',
  alto: 'alto',
  tenor: 'tenor',
  bass: 'bass',
  percussion: 'percussion',
};

const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** "C4" for MIDI 60. */
export const pitchLabel = (midi: number): string => `${FLAT_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/** What the record's sound bank plays: the GM program name, or the kit. */
export function soundLabel(inst: OrchestraInstrument): string {
  if (inst.percussion) {
    const kit = inst.program === 48 ? 'Orchestral kit' : 'Standard kit';
    return inst.kitPitch == null ? kit : `${kit}, key ${inst.kitPitch}`;
  }
  return `GM ${inst.program + 1} ${GM_NAMES[inst.program]}`;
}

const INTERVAL_WORDS: Record<string, string> = {
  m2: 'a minor second',
  M2: 'a major second',
  m3: 'a minor third',
  M3: 'a major third',
  P4: 'a fourth',
  P5: 'a fifth',
  M6: 'a major sixth',
  P8: 'an octave',
  M9: 'a major ninth',
  M13: 'an octave and a major sixth',
  P15: 'two octaves',
};

/** "sounds a major second lower", or "sounds as written". */
export function transpositionLabel(inst: OrchestraInstrument): string {
  if (inst.semitones === 0) return 'sounds as written';
  const m = /^([mMPAd])(-?)(\d+)$/.exec(inst.transposition);
  const words = m ? INTERVAL_WORDS[`${m[1]}${m[3]}`] : undefined;
  const dir = inst.semitones < 0 ? 'lower' : 'higher';
  return `sounds ${words ?? `${Math.abs(inst.semitones)} semitones`} ${dir}`;
}

/** One line for a tooltip: clefs, transposition, range, sound. */
export function describeInstrument(inst: OrchestraInstrument): string {
  const clefs = inst.clefs.map((c) => CLEF_NAMES[c]).join(' / ');
  const range = inst.kitPitch != null ? '' : ` · ${pitchLabel(inst.rangeLow)} to ${pitchLabel(inst.rangeHigh)}`;
  const staves = inst.staves > 1 ? ' · grand staff' : '';
  return `${inst.name} · ${clefs} clef${staves} · ${transpositionLabel(inst)}${range} · ${soundLabel(inst)}`;
}
