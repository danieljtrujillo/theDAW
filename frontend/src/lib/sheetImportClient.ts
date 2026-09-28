// Client for the sheet-music import backend (/api/sheetimport/*).
// Parses MusicXML / ABC / Humdrum / MIDI scores into piano-roll note batches:
// each note at its tick on the roll's 960 PPQ clock (and its 16th-step view),
// every time signature and tempo mark of the score, and each part's instrument
// (backend/modules/sheetimport/parser.py).

export interface SheetNote {
  pitch: number;
  /** 16th steps from the score's start (tick / 240); fractional off the 16th grid. */
  step: number;
  /** Length in 16th steps (ticks / 240). */
  length: number;
  velocity: number;
  /** Ticks from the score's start at `SheetScore.ppq`. Absent from older backends, which sent whole steps. */
  tick?: number;
  /** Length in ticks at `SheetScore.ppq`. Absent from older backends. */
  ticks?: number;
}

export interface SheetTrack {
  name: string;
  notes: SheetNote[];
  /** The orchestral registry id the part's instrument matches (backend match_music21), or null. Absent from older backends. */
  instrument?: string | null;
  /** The part's General MIDI program (0-127), or null. Absent from older backends. */
  program?: number | null;
  /** True for an unpitched percussion part, which the roll puts on channel 10. */
  percussion?: boolean;
  /** The part's controller changes at ticks of `SheetScore.ppq`: its sustain pedal (64) from the score's pedal marks and its printed dynamics as expression (11). Absent when it has none, and from older backends. */
  controls?: SheetControl[];
}

/** A controller change of a part at its tick. */
export interface SheetControl {
  tick: number;
  controller: number;
  value: number;
}

/** A time signature of the score at its tick (bar 1's at tick 0; `pickup_ticks` says where bar 1 starts). */
export interface SheetTimeSignature {
  tick: number;
  num: number;
  den: number;
  /** An additive signature's groups in units of `den` (2+2+3/8: [2, 2, 3]); [] otherwise. */
  groups?: number[];
  measure?: number | null;
}

/** A tempo mark of the score at its tick: a metronome number, or the tempo a tempo word stands for (`implicit`). */
export interface SheetTempoMark {
  tick: number;
  /** Quarter notes per minute. */
  bpm: number;
  text?: string;
  implicit?: boolean;
}

export interface SheetScore {
  ok: boolean;
  name: string;
  format: string;
  /** The tempo at the score's start (its first tempo mark at tick 0, else 120). */
  bpm: number;
  /** The first time signature, [num, den]. */
  time_signature: number[];
  detected_key: string;
  track_count: number;
  note_count: number;
  tracks: SheetTrack[];
  steps_per_quarter: number;
  /** Ticks to the quarter note of every `tick` (960). Absent from older backends. */
  ppq?: number;
  /** Every time signature at its tick. Absent from older backends, which sent `time_signature` alone. */
  time_signatures?: SheetTimeSignature[];
  /** Ticks before bar 1: the score's pickup (anacrusis); 0 when it starts on a downbeat. */
  pickup_ticks?: number;
  /** Every tempo mark at its tick. Absent from older backends, which sent `bpm` alone. */
  tempos?: SheetTempoMark[];
  /** What the importer did on the way in: grace notes timed, ornaments played out, chord symbols left out, unpitched notes put on kit keys (and how many only the snare fallback placed). */
  grace_notes?: number;
  ornaments?: number;
  chord_symbols_skipped?: number;
  unpitched?: number;
  unmapped_unpitched?: number;
  /** Sustain pedal presses the score writes (a pedal change is one), which its parts play as controller 64. */
  pedal_marks?: number;
}

/** Extensions accepted by the sheet importer (music21 symbolic formats). MIDI is
 *  parsed locally by the roll, so it is intentionally omitted here. */
export const SHEET_ACCEPT = '.musicxml,.mxl,.xml,.abc,.krn';

/** Upload a notation file and get back its notes mapped to the roll grid. */
export async function parseSheetFile(file: File): Promise<SheetScore> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/api/sheetimport/parse', { method: 'POST', body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j?.detail) detail = j.detail;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new Error(detail);
  }
  return (await res.json()) as SheetScore;
}
