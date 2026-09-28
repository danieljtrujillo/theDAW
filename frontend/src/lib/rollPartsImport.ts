/**
 * rollPartsImport — a MIDI file or a score into the roll's parts.
 *
 * A file of several parts replaces the roll's parts with them (pianoRollStore
 * importParts), each on its own instrument, with the file's tempo map, meter
 * and lanes for the document. A file of one part writes into the ACTIVE part
 * (importNotes), as every generator does, and keeps the other parts; its
 * controller changes replace the part's, and when the active part follows the
 * roll's voice and the file names an instrument, the part takes it, all in the
 * one undo step.
 *
 * A score (the sheet importer's answer, lib/sheetImportClient) comes in on the
 * roll's own clock: each note at its tick (960 to the quarter, nothing snapped
 * to 16ths), every time signature of the score as the roll's meter map with
 * its pickup, and every tempo mark as the roll's tempo map. An answer from an
 * older backend, which sent whole steps and the first signature and tempo
 * alone, comes in as it always did.
 *
 * Store-writing but free of Vite-only imports, so node tests replay it.
 */
import { usePianoRollStore, type PianoNote, type RollMeter, type RollTrack } from '../state/pianoRollStore';
import type { MidiFileData } from './midi';
import { midiEventsToMeterMap, normalizeMeterMap, stepsAsMeter, type MeterEvent, type MeterSegment } from './meterMap';
import { PPQ } from './noteClock';
import { guessInstrument, orchestraInstrument } from './orchestra';
import type { LaneBend } from './pitchBend';
import { midiFileToRollParts, type RollMidiPart } from './rollMidi';
import { sanitizeRollTempoMap } from './rollTempo';
import { MAX_ROLL_PARTS, PERCUSSION_PART_CHANNEL, cleanPartControls, cleanPartProgram, partColorAt } from './rollTracks';
import type { SheetScore } from './sheetImportClient';
import type { TempoEvent } from './tempoMap';

/** What an import did: how many parts and notes arrived, and whether they replaced the parts or went into the active one. */
export interface PartsImportResult {
  parts: number;
  notes: number;
  into: 'parts' | 'active';
  /** Parts past MAX_ROLL_PARTS, whose notes went into the last part. */
  folded: number;
}

/** Put `parts` in the roll: several replace every part, one goes into the active part. */
export function applyRollParts(
  parts: readonly RollMidiPart[],
  bpm: number | undefined,
  meter: Partial<RollMeter> | undefined,
  bends: readonly LaneBend[] | undefined,
  tempoMap: readonly TempoEvent[] | undefined,
): PartsImportResult {
  const roll = usePianoRollStore.getState();
  const notes = parts.reduce((n, p) => n + p.notes.length, 0);
  // A file with nothing in it changes nothing.
  if (parts.length === 0) return { parts: 0, notes: 0, into: 'active', folded: 0 };
  if (parts.length > 1) {
    roll.importParts(parts.map((p) => ({ ...p.track, notes: p.notes })), bpm, meter, bends, tempoMap);
    return { parts: Math.min(parts.length, MAX_ROLL_PARTS), notes, into: 'parts', folded: Math.max(0, parts.length - MAX_ROLL_PARTS) };
  }
  const part = parts[0];
  // The file's part replaces the part's controller changes and, for a part
  // with no sound of its own, gives it the file's instrument: all in the one
  // write, so the import is one undo step.
  roll.importNotes(part.notes, bpm, meter, bends, tempoMap, {
    controls: part.track.controls ?? [],
    ...(part.track.instrumentId ? { instrumentId: part.track.instrumentId } : {}),
    program: part.track.program ?? null,
    percussion: part.track.channel === PERCUSSION_PART_CHANNEL,
  });
  return { parts: 1, notes, into: 'active', folded: 0 };
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

/** The resolution of a score's ticks: its `ppq`, else the roll's own. */
const scorePpq = (score: Pick<SheetScore, 'ppq'>): number => (typeof score.ppq === 'number' && score.ppq > 0 ? score.ppq : PPQ);

/**
 * A score's parts (the sheet importer's tracks) as the roll's parts: each
 * with its name, and the instrument the importer read from the score
 * (`instrument`, a registry id), else the one its name names, else its GM
 * `program`. A part the importer marks `percussion` goes on channel 10. Each
 * note keeps its tick, rescaled from the score's PPQ to the roll's (the same
 * 960, so unchanged); a note from an older backend, which sent steps alone,
 * is placed by its step. The part's controller changes (its sustain pedal
 * from the score's pedal marks) come on the same clock as its `controls`.
 */
export function sheetScoreParts(score: Pick<SheetScore, 'tracks' | 'ppq'>): RollMidiPart[] {
  const toModel = PPQ / scorePpq(score);
  const perStep = PPQ / 4;
  return score.tracks.map((track, index) => {
    const notes: PianoNote[] = track.notes.map((n, i) => {
      const id = `sheet-${index}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      if (typeof n.tick === 'number' && Number.isFinite(n.tick) && typeof n.ticks === 'number' && Number.isFinite(n.ticks)) {
        const tick = Math.max(0, Math.round(n.tick * toModel));
        const ticks = Math.max(1, Math.round(n.ticks * toModel));
        return { id, note: n.pitch, step: tick / perStep, length: ticks / perStep, velocity: n.velocity, tick, ticks };
      }
      return { id, note: n.pitch, step: n.step, length: Math.max(1, n.length), velocity: n.velocity };
    });
    notes.sort((a, b) => a.step - b.step);
    const inst = orchestraInstrument(track.instrument ?? undefined) ?? guessInstrument(track.name);
    const percussion = track.percussion === true || inst?.percussion === true;
    const program = inst ? inst.program : cleanPartProgram(track.program);
    // Rescaled to the roll's clock; cleanPartControls drops anything that is not a controller change a part keeps.
    const controls = cleanPartControls(
      (track.controls ?? []).map((c) => (c && typeof c.tick === 'number' ? { ...c, tick: Math.max(0, Math.round(c.tick * toModel)) } : c)),
    );
    const part: Partial<RollTrack> = {
      name: track.name,
      program,
      color: partColorAt(index),
      ...(percussion ? { channel: PERCUSSION_PART_CHANNEL } : {}),
      ...(inst ? { instrumentId: inst.id } : {}),
      ...(controls ? { controls } : {}),
    };
    return { track: part, notes };
  });
}

/**
 * A score's meter as the roll holds it: every time signature at its tick,
 * with the pickup before bar 1, read as a MIDI file's signatures are
 * (lib/meterMap midiEventsToMeterMap). An older backend's answer gives its
 * first signature alone (4/4 when it has none, or one the roll cannot draw).
 */
export function sheetScoreMeter(score: Pick<SheetScore, 'time_signature' | 'time_signatures' | 'pickup_ticks' | 'ppq'>): { meterMap: MeterSegment[]; pickupSteps: number } {
  const signatures = score.time_signatures ?? [];
  if (!signatures.length) {
    const [num, den] = score.time_signature ?? [];
    return { meterMap: normalizeMeterMap([{ bar: 0, meter: { num: Number(num), den: Number(den), groups: [] } }]), pickupSteps: 0 };
  }
  const ppq = scorePpq(score);
  const stepTicks = ppq / 4;
  const pickupTicks = Math.max(0, score.pickup_ticks ?? 0);
  // A pickup the roll can write as a partial bar (a whole number of 32nds).
  const partial = pickupTicks > 0 ? stepsAsMeter(pickupTicks / stepTicks) : null;
  const events: MeterEvent[] = [];
  if (partial) events.push({ tick: 0, num: partial.num, den: partial.den, groups: [], pickupSteps: pickupTicks / stepTicks });
  for (const ts of signatures) {
    // Bar 1's signature governs the pickup too; its own bar starts where the pickup ends.
    const tick = partial && ts.tick === 0 ? pickupTicks : ts.tick;
    events.push({ tick, num: ts.num, den: ts.den, groups: ts.groups ?? [], ...(!partial && tick === 0 ? { pickupSteps: 0 } : {}) });
  }
  const { map, pickupSteps } = midiEventsToMeterMap(events, ppq);
  return { meterMap: map, pickupSteps };
}

/**
 * A score's tempo map: its start tempo at beat 0, then each tempo mark at its
 * beat (a step each, as a score's tempo changes are). Undefined for an answer
 * with no marks past the start (an older backend's included), so the roll
 * holds one tempo at `bpm`.
 */
export function sheetScoreTempoMap(score: Pick<SheetScore, 'bpm' | 'tempos' | 'ppq'>): TempoEvent[] | undefined {
  const later = (score.tempos ?? []).filter((t) => t.tick > 0 && Number.isFinite(t.bpm) && t.bpm > 0);
  if (!later.length) return undefined;
  const ppq = scorePpq(score);
  const start = Number.isFinite(score.bpm) && score.bpm > 0 ? score.bpm : 120;
  return sanitizeRollTempoMap([{ beat: 0, bpm: start }, ...later.map((t) => ({ beat: t.tick / ppq, bpm: t.bpm }))], start);
}

/** A score into the roll: its parts, every time signature with its pickup, and every tempo mark. */
export function importSheetParts(score: SheetScore): PartsImportResult & { meterChanges: number; tempoChanges: number } {
  const meter = sheetScoreMeter(score);
  const tempoMap = sheetScoreTempoMap(score);
  const parts = sheetScoreParts(score).filter((p) => p.notes.length > 0);
  // Its notes carry no lanes or bends, so the roll's lanes reset to lane A alone, unbent.
  const done = applyRollParts(parts, score.bpm, { ...meter, lanes: [{ id: 0, name: 'A', cycleSteps: null }] }, [], tempoMap);
  return { ...done, meterChanges: Math.max(0, meter.meterMap.length - 1), tempoChanges: tempoMap ? tempoMap.length - 1 : 0 };
}
