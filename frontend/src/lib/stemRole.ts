/**
 * stemRole — the part a song's stem plays, read from a name, and the voice a
 * transcription of that stem takes.
 *
 * The library converts every stem of a song to MIDI (backend/modules/midi
 * runner): `<stem>.mid`, row id `<entry>__<stem>_midi`, shown as
 * "<title> · <stem>". basic-pitch writes every file it makes on General MIDI
 * program 4, Electric Piano 1, whatever the stem held, so a bass line, a
 * guitar part and a sung melody would all arrive as an electric piano. The
 * stem's name is the one place its instrument survives, so an import reads it
 * (stemRoleOf) and gives the part the registry instrument of its role
 * (stemRoleVoice): the voice for vocals, the electric bass, the electric
 * guitar, the piano, the organ, and a drum kit on channel 10 for the drums and
 * each piece of a split kit.
 *
 * A stem that names no instrument ("other", the full mix, "no_vocals") gives
 * no role, and its part keeps the file's program.
 *
 * Pure, so node tests and every import path share it.
 */
import { orchestraInstrument } from './orchestra';

/** The General MIDI program basic-pitch writes every transcription on: Electric Piano 1. */
export const BASIC_PITCH_PROGRAM = 4;

/** The instrument parts a stem can name. */
export type StemRole = 'vocals' | 'bass' | 'guitar' | 'piano' | 'organ' | 'drums' | 'kick' | 'snare' | 'toms' | 'hihat' | 'cymbals';

/** Each role's registry instrument (lib/orchestra) and the name its part takes. */
const ROLES: Readonly<Record<StemRole, { instrumentId: string; name: string }>> = Object.freeze({
  vocals: { instrumentId: 'voice', name: 'Vocals' },
  bass: { instrumentId: 'electric-bass', name: 'Bass' },
  guitar: { instrumentId: 'electric-guitar', name: 'Guitar' },
  piano: { instrumentId: 'piano', name: 'Piano' },
  organ: { instrumentId: 'organ', name: 'Organ' },
  drums: { instrumentId: 'drum-kit', name: 'Drums' },
  kick: { instrumentId: 'drum-kit', name: 'Kick' },
  snare: { instrumentId: 'drum-kit', name: 'Snare' },
  toms: { instrumentId: 'drum-kit', name: 'Toms' },
  hihat: { instrumentId: 'drum-kit', name: 'Hi-hat' },
  cymbals: { instrumentId: 'drum-kit', name: 'Cymbals' },
});

/** The words of a stem name that say its role. */
const ROLE_WORDS: ReadonlyMap<string, StemRole> = new Map<string, StemRole>([
  ['vocals', 'vocals'], ['vocal', 'vocals'], ['voice', 'vocals'], ['vox', 'vocals'], ['singer', 'vocals'], ['vocalist', 'vocals'],
  ['bass', 'bass'],
  ['guitar', 'guitar'], ['guitars', 'guitar'], ['gtr', 'guitar'],
  ['piano', 'piano'], ['keys', 'piano'], ['keyboard', 'piano'], ['keyboards', 'piano'],
  ['organ', 'organ'],
  ['drums', 'drums'], ['drum', 'drums'], ['kit', 'drums'], ['percussion', 'drums'],
  ['kick', 'kick'],
  ['snare', 'snare'],
  ['toms', 'toms'], ['tom', 'toms'],
  ['hihat', 'hihat'], ['hat', 'hihat'], ['hats', 'hihat'],
  ['cymbals', 'cymbals'], ['cymbal', 'cymbals'], ['overheads', 'cymbals'],
]);

/** Stem names that hold no one instrument: the search stops at them with no role. */
const NO_ROLE_WORDS: ReadonlySet<string> = new Set(['other', 'others', 'full', 'mix', 'master', 'instrumental', 'accompaniment', 'residual']);

/**
 * The role a name says (a file name "bass.mid", a row id "entry__bass_midi", a
 * label "Song · lead_vocals"), or null when it says none. The LAST word that
 * names a role or a mix wins, since the stem comes after the song's title
 * ("Blue Guitar · other" is the other stem, not a guitar). "no_vocals" is the
 * instrumental, never vocals.
 */
export function stemRoleOf(text: string | null | undefined): StemRole | null {
  if (typeof text !== 'string' || !text) return null;
  const words = text
    .toLowerCase()
    .replace(/\.midi?$/, '')
    .replace(/\bno[\s_-]*vocals?\b/g, ' instrumental ')
    .replace(/\bhi[\s_-]*hats?\b/g, ' hihat ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const w = words[i];
    if (NO_ROLE_WORDS.has(w)) return null;
    const role = ROLE_WORDS.get(w);
    if (role) return role;
  }
  return null;
}

/** What a role's part plays: its registry instrument, GM program, bank, whether it is percussion, and its name. */
export interface StemRoleVoice {
  role: StemRole;
  instrumentId: string;
  program: number;
  bank: number;
  percussion: boolean;
  name: string;
}

/** The voice a stem of `role` takes, from the orchestra registry. */
export function stemRoleVoice(role: StemRole | null): StemRoleVoice | null {
  if (!role) return null;
  const spec = ROLES[role];
  const inst = orchestraInstrument(spec.instrumentId);
  if (!inst) return null;
  return {
    role,
    instrumentId: inst.id,
    program: inst.program,
    // A kit is chosen by its program on channel 10; its registry bank (128) is the soundfont's drum bank, not a bank select.
    bank: inst.percussion ? 0 : inst.bank,
    percussion: inst.percussion === true,
    name: spec.name,
  };
}

/** The part name a stem's name gives: its role's ("Bass"), else the name with its separators as spaces ("Other", "Full"). */
export function stemPartName(stem: string): string {
  const voice = stemRoleVoice(stemRoleOf(stem));
  if (voice) return voice.name;
  const words = stem.replace(/\.midi?$/i, '').replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : stem;
}
