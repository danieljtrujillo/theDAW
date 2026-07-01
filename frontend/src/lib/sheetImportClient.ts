// Client for the sheet-music import backend (/api/sheetimport/*).
// Parses MusicXML / ABC / Humdrum / MIDI scores into piano-roll note batches
// (step/length already on the 16th-note grid, tempo-independent).

export interface SheetNote {
  pitch: number;
  step: number;
  length: number;
  velocity: number;
}

export interface SheetTrack {
  name: string;
  notes: SheetNote[];
}

export interface SheetScore {
  ok: boolean;
  name: string;
  format: string;
  bpm: number;
  time_signature: number[];
  detected_key: string;
  track_count: number;
  note_count: number;
  tracks: SheetTrack[];
  steps_per_quarter: number;
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
