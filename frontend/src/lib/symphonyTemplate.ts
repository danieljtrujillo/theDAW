/**
 * symphonyTemplate — the "Symphony orchestra" EDIT template as data.
 *
 * One track per section, each on its instrument from the orchestral registry
 * (lib/orchestra), panned to its seat on the stage, routed to its section's
 * bus. Each section bus sends to one shared Hall bus, whose Reverb plays the
 * Detmold Konzerthaus heard from the front stalls (lib/hallIrs). Every track
 * sets its synth reverb send (CC 91) to 0, so the soundfont's own reverb does
 * not double the hall.
 *
 * Depth is the classic orchestral mix: a section further back on the stage
 * sits lower on its bus fader and sends more of itself to the hall, so the
 * strings in front are close and dry and the brass behind them are distant
 * and wet. Width is the pan of each seat.
 *
 * Two seatings, seen from the audience (negative pan is left):
 *   - American: first and second violins left, violas centre right, cellos
 *     right, basses behind the cellos, harp behind the first violins.
 *   - European (German, antiphonal): first violins left, second violins right,
 *     cellos centre left, violas centre right, basses behind the cellos on
 *     the left, harp on the right.
 * Woodwinds sit in the middle rows and brass and percussion at the back in
 * both.
 *
 * Pure data and no store: editorTools createSymphonyTemplate writes it.
 */
import { orchestraInstrument } from './orchestra';

export type Seating = 'american' | 'european';

export const SEATINGS: readonly { id: Seating; label: string }[] = Object.freeze([
  { id: 'american', label: 'American seating' },
  { id: 'european', label: 'European seating' },
]);

export const isSeating = (v: unknown): v is Seating => v === 'american' || v === 'european';

export type SectionId = 'strings' | 'woodwinds' | 'harp' | 'brass' | 'percussion';

/** How far back on the stage a section sits. */
export type SectionRow = 'front' | 'middle' | 'back';

export interface SectionBusPlan {
  id: SectionId;
  name: string;
  /** How far back the section sits. */
  row: SectionRow;
  /** The bus fader, 0..1 (a new bus opens at 0.8). */
  volume: number;
  /** The send to the Hall bus, linear. */
  hallSend: number;
  color: string;
}

export interface SectionTrackPlan {
  name: string;
  /** The orchestral registry record the track plays (lib/orchestra). */
  instrumentId: string;
  /** GM program (the kit on a percussion track). */
  program: number;
  percussion: boolean;
  section: SectionId;
  /** -1..1, seen from the audience. */
  pan: number;
}

/** The front-to-back rows: a fader and a hall send for each. */
const ROW_MIX: Record<SectionRow, { volume: number; hallSend: number }> = {
  front: { volume: 0.8, hallSend: 0.3 },
  middle: { volume: 0.72, hallSend: 0.45 },
  back: { volume: 0.64, hallSend: 0.6 },
};

const bus = (id: SectionId, name: string, row: SectionRow, color: string): SectionBusPlan => ({
  id,
  name,
  row,
  ...ROW_MIX[row],
  color,
});

export const SECTION_BUSES: readonly SectionBusPlan[] = Object.freeze([
  bus('strings', 'Strings', 'front', '#f59e0b'),
  bus('woodwinds', 'Woodwinds', 'middle', '#34d399'),
  bus('harp', 'Harp', 'middle', '#22d3ee'),
  bus('brass', 'Brass', 'back', '#facc15'),
  bus('percussion', 'Percussion', 'back', '#fb7185'),
]);

/** The shared hall: its bus name and the Reverb it carries (rackEffects `reverb` params). */
export const HALL_BUS_NAME = 'Hall';
export const HALL_REVERB_PARAMS: Readonly<Record<string, number>> = Object.freeze({
  hall: 1, // Detmold Konzerthaus, front stalls
  position: 0, // the whole stage at once
  predelay: 20,
  tone: 16000,
  wet: 1, // a send return: the hall only
});
export const HALL_BUS_VOLUME = 0.8;

/** Every track's synth reverb send (CC 91): off, the hall bus plays the room. */
export const SECTION_SYNTH_REVERB_SEND = 0;

interface Seat {
  name: string;
  instrumentId: string;
  section: SectionId;
  american: number;
  european: number;
}

/** Score order, top to bottom, with each seat's pan in both seatings. */
const SEATS: readonly Seat[] = [
  { name: 'Flute', instrumentId: 'flute', section: 'woodwinds', american: -0.2, european: -0.2 },
  { name: 'Oboe', instrumentId: 'oboe', section: 'woodwinds', american: 0.2, european: 0.2 },
  { name: 'Clarinet', instrumentId: 'clarinet-bb', section: 'woodwinds', american: -0.15, european: -0.15 },
  { name: 'Bassoon', instrumentId: 'bassoon', section: 'woodwinds', american: 0.15, european: 0.15 },
  { name: 'Horn', instrumentId: 'horn', section: 'brass', american: -0.45, european: -0.45 },
  { name: 'Trumpet', instrumentId: 'trumpet-bb', section: 'brass', american: 0.15, european: 0.15 },
  { name: 'Trombone', instrumentId: 'trombone', section: 'brass', american: 0.4, european: 0.4 },
  { name: 'Tuba', instrumentId: 'tuba', section: 'brass', american: 0.55, european: 0.55 },
  { name: 'Timpani', instrumentId: 'timpani', section: 'percussion', american: -0.1, european: -0.1 },
  { name: 'Percussion', instrumentId: 'snare-drum', section: 'percussion', american: 0.3, european: 0.3 },
  { name: 'Harp', instrumentId: 'harp', section: 'harp', american: -0.75, european: 0.75 },
  { name: 'Violin I', instrumentId: 'violin', section: 'strings', american: -0.65, european: -0.65 },
  { name: 'Violin II', instrumentId: 'violin', section: 'strings', american: -0.3, european: 0.65 },
  { name: 'Viola', instrumentId: 'viola', section: 'strings', american: 0.2, european: 0.3 },
  { name: 'Violoncello', instrumentId: 'cello', section: 'strings', american: 0.45, european: -0.3 },
  { name: 'Contrabass', instrumentId: 'contrabass', section: 'strings', american: 0.7, european: -0.7 },
];

/** The template's tracks for `seating`, in score order. Throws on a registry record that is missing. */
export function symphonyTracks(seating: Seating): SectionTrackPlan[] {
  return SEATS.map((s) => {
    const inst = orchestraInstrument(s.instrumentId);
    if (!inst) throw new Error(`The orchestral registry has no "${s.instrumentId}"`);
    return {
      name: s.name,
      instrumentId: s.instrumentId,
      program: inst.program,
      percussion: inst.percussion,
      section: s.section,
      pan: seating === 'american' ? s.american : s.european,
    };
  });
}

export const sectionBus = (id: SectionId): SectionBusPlan =>
  SECTION_BUSES.find((b) => b.id === id) as SectionBusPlan;
