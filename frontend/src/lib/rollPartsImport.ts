/**
 * rollPartsImport — a MIDI file or a score into the roll's parts.
 *
 * A file of several parts replaces the roll's parts with them (pianoRollStore
 * importParts), each on its own instrument, with the file's tempo map, meter
 * and lanes for the document. A file of one part writes into the ACTIVE part
 * (importNotes), as every generator does, and keeps the other parts; when the
 * active part follows the roll's voice and the file names an instrument, the
 * part takes it. While other parts hold notes, the roll keeps its tempo map,
 * meter, lanes and bends, which they play by, and its markers, and the result
 * says so (`keptDocument`), so the import's log line can tell the user. A
 * file is a new document otherwise: its markers replace the roll's (none when
 * it carries none).
 *
 * Store-writing but free of Vite-only imports, so node tests replay it.
 */
import { activeTrackOf, usePianoRollStore, type PianoNote, type RollMeter, type RollTrack } from '../state/pianoRollStore';
import type { MidiFileData } from './midi';
import type { RollMarkerInput } from './rollMarkers';
import { normalizeMeterMap, type MeterSegment } from './meterMap';
import { guessInstrument, orchestraInstrument } from './orchestra';
import type { LaneBend } from './pitchBend';
import { midiFileToRollParts, type RollMidiPart } from './rollMidi';
import { MAX_ROLL_PARTS, PERCUSSION_PART_CHANNEL, cleanPartProgram, partColorAt } from './rollTracks';
import type { SheetScore } from './sheetImportClient';
import type { TempoEvent } from './tempoMap';

/** The log line of a one-part import into a roll whose other parts hold notes (PartsImportResult keptDocument). */
export const KEPT_DOCUMENT_LOG =
  "The roll kept its own tempo map, time signatures, lanes and pitch bends, which its other parts play by, and its markers; the file's were not applied";

/** What an import did: how many parts and notes arrived, and whether they replaced the parts or went into the active one. */
export interface PartsImportResult {
  parts: number;
  notes: number;
  into: 'parts' | 'active';
  /** Parts past MAX_ROLL_PARTS, whose notes went into the last part. */
  folded: number;
  /** True when the file went into the active part of a roll whose other parts hold notes, so the roll kept its own tempo map, meter, lanes and bends (pianoRollStore importNotes). */
  keptDocument: boolean;
}

/**
 * Put `parts` in the roll: several replace every part, one goes into the
 * active part. `markers` are the file's own (none when left out): a new
 * document's markers, kept out only where the roll keeps its document.
 */
export function applyRollParts(
  parts: readonly RollMidiPart[],
  bpm: number | undefined,
  meter: Partial<RollMeter> | undefined,
  bends: readonly LaneBend[] | undefined,
  tempoMap: readonly TempoEvent[] | undefined,
  markers: readonly RollMarkerInput[] = [],
): PartsImportResult {
  const roll = usePianoRollStore.getState();
  const notes = parts.reduce((n, p) => n + p.notes.length, 0);
  // A file with nothing in it changes nothing.
  if (parts.length === 0) return { parts: 0, notes: 0, into: 'active', folded: 0, keptDocument: false };
  if (parts.length > 1) {
    roll.importParts(parts.map((p) => ({ ...p.track, notes: p.notes })), bpm, meter, bends, tempoMap, 0, markers);
    return { parts: Math.min(parts.length, MAX_ROLL_PARTS), notes, into: 'parts', folded: Math.max(0, parts.length - MAX_ROLL_PARTS), keptDocument: false };
  }
  const part = parts[0];
  const { keptDocument } = roll.importNotes(part?.notes ?? [], bpm, meter, bends, tempoMap, { markers });
  const after = usePianoRollStore.getState();
  const active = activeTrackOf(after);
  // The file's instrument, for a part that has none of its own.
  if (part && active.program === null) {
    const inst = orchestraInstrument(part.track.instrumentId);
    if (inst && (part.track.program == null || inst.program === part.track.program)) after.setTrackInstrument(active.id, inst.id);
    else if (part.track.program != null) after.setTrackProgram(active.id, part.track.program, part.track.channel === PERCUSSION_PART_CHANNEL);
  }
  return { parts: 1, notes, into: 'active', folded: 0, keptDocument };
}

/** A parsed MIDI file into the roll's parts (lib/rollMidi midiFileToRollParts). */
export function importMidiParts(data: MidiFileData, idPrefix = 'imp'): PartsImportResult & { bpm: number; tempoChanges: number; meterMap: MeterSegment[]; bentLanes: number } {
  const file = midiFileToRollParts(data, idPrefix);
  const result = applyRollParts(file.parts, file.bpm, file.meter, file.bends, file.tempoMap);
  return {
    ...result,
    bpm: file.bpm,
    tempoChanges: file.tempoMap.length - 1,
    meterMap: file.meter.meterMap,
    bentLanes: file.bends.filter((b) => b.points.length).length,
  };
}

/**
 * A score's parts (the sheet importer's tracks) as the roll's parts: each
 * with its name, and the instrument the importer read from the score
 * (`instrument`, a registry id), else the one its name names, else its GM
 * `program`. A part the importer marks `percussion` goes on channel 10.
 */
export function sheetScoreParts(score: Pick<SheetScore, 'tracks'>): RollMidiPart[] {
  return score.tracks.map((track, index) => {
    const notes: PianoNote[] = track.notes.map((n, i) => ({
      id: `sheet-${index}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      note: n.pitch,
      step: n.step,
      length: Math.max(1, n.length),
      velocity: n.velocity,
    }));
    notes.sort((a, b) => a.step - b.step);
    const inst = orchestraInstrument(track.instrument ?? undefined) ?? guessInstrument(track.name);
    const percussion = track.percussion === true || inst?.percussion === true;
    const program = inst ? inst.program : cleanPartProgram(track.program);
    const part: Partial<RollTrack> = {
      name: track.name,
      program,
      color: partColorAt(index),
      ...(percussion ? { channel: PERCUSSION_PART_CHANNEL } : {}),
      ...(inst ? { instrumentId: inst.id } : {}),
    };
    return { track: part, notes };
  });
}

/** A score into the roll: its parts, its first time signature (4/4 when it has none) and its tempo. */
export function importSheetParts(score: SheetScore): PartsImportResult {
  const [num, den] = score.time_signature ?? [];
  const meterMap = normalizeMeterMap([{ bar: 0, meter: { num: Number(num), den: Number(den), groups: [] } }]);
  const parts = sheetScoreParts(score).filter((p) => p.notes.length > 0);
  // Its notes start at step 0 and carry no lanes or bends, so the roll's lanes reset to lane A alone, unbent.
  return applyRollParts(parts, score.bpm, { meterMap, pickupSteps: 0, lanes: [{ id: 0, name: 'A', cycleSteps: null }] }, [], undefined);
}
