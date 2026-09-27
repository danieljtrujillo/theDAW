/**
 * aiComposeGrid — the piano roll's grid as AI COMPOSE describes it to the
 * model, and the model's answer read back onto that grid. Pure: the request
 * itself lives in aiComposeClient.ts.
 *
 * The prompt names every bar: its first and last 16th-note step, its meter,
 * and the steps its groups start on, so a 7/8 3+2+2 bar reads as "steps 2-15,
 * groups start at 2, 8, 12" and a pickup sits before bar 1. Steps and lengths
 * come back as numbers, fractions allowed, so triplet and quintuplet figures
 * land where the model put them; the roll ticks them on import.
 */
import { barStartStep, bars as meterBars, beatLines, groupLines, normalizeMeterMap, type MeterSegment } from './meterMap';
import type { Meter } from './colony';
import type { PianoNote } from '../state/pianoRollStore';

/** The longest piece the AI key asks for, in bars after the pickup. */
export const COMPOSE_MAX_BARS = 32;
/** Decimals a step or length keeps: a thousandth of a 16th is finer than the roll's 960-to-the-quarter ticks. */
const PLACES = 1000;

export interface ComposeGridInput {
  /** Bars after the pickup. */
  bars: number;
  /** The roll's meter map; left out, 4/4 throughout. */
  meterMap?: readonly MeterSegment[];
  /** Steps before bar 1; left out, none. */
  pickupSteps?: number;
}

/** One bar as the prompt lists it: 1-based `bar`, steps `start` to `end` (exclusive), and absolute group starts. */
export interface ComposeBar { bar: number; start: number; end: number; meter: Meter; groupStarts: number[] }

export interface ComposeGrid {
  meterMap: MeterSegment[];
  pickupSteps: number;
  bars: number;
  /** Steps in the whole piece: the pickup and every bar. */
  totalSteps: number;
  rows: ComposeBar[];
}

const clampBars = (n: number): number => Math.max(1, Math.min(COMPOSE_MAX_BARS, Math.round(Number.isFinite(n) ? n : 8)));
const roundPlaces = (v: number): number => Math.round(v * PLACES) / PLACES;
const stepText = (v: number): string => String(roundPlaces(v));

/** The grid a request writes onto: the roll's meter map and pickup, `bars` bars long. */
export function composeGrid(p: ComposeGridInput): ComposeGrid {
  const meterMap = normalizeMeterMap(p.meterMap ?? null);
  const pickupSteps = Math.max(0, Math.min(64, Number.isFinite(p.pickupSteps) ? (p.pickupSteps as number) : 0));
  const bars = clampBars(p.bars);
  const totalSteps = barStartStep(meterMap, bars, pickupSteps);
  const rows = meterBars(meterMap, totalSteps, pickupSteps)
    .filter((b) => b.bar >= 0)
    .map((b) => {
      const groups = b.meter.groups.length > 1 ? groupLines(b.meter) : beatLines(b.meter);
      return { bar: b.bar + 1, start: b.start, end: b.start + b.len, meter: b.meter, groupStarts: groups.map((g) => b.start + g) };
    });
  return { meterMap, pickupSteps, bars, totalSteps, rows };
}

/** A meter as the prompt and the card print it: "7/8 grouped 3+2+2", "4/4". */
export const composeMeterText = (m: Meter): string => `${m.num}/${m.den}${m.groups.length > 1 ? ` grouped ${m.groups.join('+')}` : ''}`;

/** The card's one-line reading of what a request sends: "7/8 grouped 3+2+2, 5/4 from bar 5, pickup 2 steps". */
export function composeMeterSummary(meterMap: readonly MeterSegment[] | undefined, pickupSteps = 0): string {
  const segs = normalizeMeterMap(meterMap ?? null);
  const parts = segs.map((s, i) => (i === 0 ? composeMeterText(s.meter) : `${composeMeterText(s.meter)} from bar ${s.bar + 1}`));
  if (pickupSteps > 0) parts.push(`pickup ${stepText(pickupSteps)} step${pickupSteps === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** The prompt's GRID section: the step unit, the pickup, one line per bar, the length and the tuplet rule. */
export function composeGridLines(g: ComposeGrid): string[] {
  const lines = [
    'GRID & FORMAT:',
    '- A step is a 16th note. "step" counts 16th notes from the start of the piece, which is step 0.',
  ];
  if (g.pickupSteps > 0) {
    lines.push(`- The piece opens with a pickup (anacrusis) of ${stepText(g.pickupSteps)} steps, steps 0 to ${stepText(g.pickupSteps)}, before bar 1.`);
  }
  const changes = g.meterMap.length > 1;
  lines.push(
    changes
      ? '- The meter changes from bar to bar. Each bar below lists its steps, its meter and the steps its beat groups start on; accent the group starts.'
      : `- Every bar is ${composeMeterText(g.meterMap[0].meter)}. Each bar below lists its steps and the steps its beat groups start on; accent the group starts.`,
  );
  for (const r of g.rows) {
    lines.push(
      `- Bar ${r.bar}: steps ${stepText(r.start)} to ${stepText(r.end)} (${stepText(r.end - r.start)} steps), ${composeMeterText(r.meter)}; groups start at steps ${r.groupStarts.map(stepText).join(', ')}.`,
    );
  }
  lines.push(
    `- Total length: ${g.bars} bar${g.bars === 1 ? '' : 's'}${g.pickupSteps > 0 ? ' after the pickup' : ''} = ${stepText(g.totalSteps)} steps. Write no note at or after step ${stepText(g.totalSteps)}.`,
    '- "length" is the note duration in steps. Notes sharing a step form a chord.',
    '- Steps and lengths may be fractional for tuplets: 8th-note triplets sit 2/3 of a quarter apart (steps 0, 1.333, 2.667 in a 4-step beat), quintuplet 16ths 0.8 steps apart, septuplet 16ths 0.571 steps apart. Write at most 3 decimals.',
  );
  return lines;
}

/** Everything the prompt says: the grid, and the musical parameters from the AI card. */
export interface ComposePromptInput extends ComposeGridInput {
  /** Free-text intent, e.g. "dramatic cinematic piano intro that builds". */
  prompt: string;
  /** Tonic pitch class name, e.g. "C", "F#". */
  key: string;
  /** Mode / scale, e.g. "minor", "major", "dorian", "phrygian". */
  mode: string;
  /** Quarter notes per minute; the fraction is kept. */
  bpm: number;
  /** Optional style/genre hint. */
  style?: string;
  /** 0 = sparse & simple, 1 = dense virtuosic runs & ornaments. */
  complexity: number;
  /** Include a distinct left-hand bass/accompaniment line. */
  withBass?: boolean;
}

/** The whole prompt for a request on grid `g`. */
export const buildComposePrompt = (p: ComposePromptInput, g: ComposeGrid = composeGrid(p)): string => {
  const lines = [
    'You are a virtuoso composer and concert pianist. Compose an original, musical solo piano piece as MIDI note data.',
    '',
    ...composeGridLines(g),
    '- Middle C = MIDI 60. Use the full piano range (about MIDI 33-96).',
    '',
    'MUSICALITY (important):',
    `- Key: ${p.key} ${p.mode}. Stay mostly diatonic; use tasteful chromatic passing tones and leading tones into cadences.`,
    `- Tempo: ${Math.round(p.bpm * 100) / 100} BPM (quarter notes per minute).`,
    '- Write REAL two-hand piano: a singing right-hand melody with clear phrasing and an arch shape,',
    '  supported by a left-hand accompaniment (broken chords / arpeggios / stride / Alberti).',
    '- Use smooth voice-leading and inversions, build to a climax, and close phrases with cadences.',
    p.withBass
      ? '- Give the left hand a clear bass line in the low register (roughly MIDI 33-55).'
      : '- Keep the left hand as light accompaniment beneath the melody.',
    `- Density / virtuosity: ${p.complexity.toFixed(2)} (0 = sparse and simple, 1 = dense runs, ornaments and fast figuration).`,
    p.style ? `- Style: ${p.style}.` : '',
    `- Intent: "${p.prompt || 'a beautiful, natural piano piece'}".`,
    '',
    'Return JSON only: { "bpm": number, "notes": [{ "note", "step", "length", "velocity" }], "summary": string }.',
    '- note: integer MIDI 0-127. step: number >= 0, in 16th-note steps, fractions allowed for tuplets. length: number > 0, in steps. velocity: integer 1-127.',
    '- Sort notes ascending by step. summary: one sentence describing the piece.',
  ];
  return lines.filter((l) => l !== '').join('\n');
};

interface RawNote {
  note?: number;
  step?: number;
  length?: number;
  velocity?: number;
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
};

/** A composed part on its grid: the notes, the tempo the model chose (fraction kept, 40-240), its summary, and the meter it was asked for. */
export interface ComposeParsed {
  notes: PianoNote[];
  bpm: number;
  summary: string;
  meterMap: MeterSegment[];
  pickupSteps: number;
}

/**
 * The model's JSON on the request's grid. Steps and lengths keep their
 * fraction to a thousandth of a step; a note at or past the end is dropped, a
 * length runs to the end at most, and pitches and velocities stay whole.
 * Throws on JSON that does not parse or holds no notes.
 */
export function parseComposeResponse(text: string, g: ComposeGrid, requestBpm: number, idOf: (i: number) => string): ComposeParsed {
  let parsed: { bpm?: number; summary?: string; notes?: RawNote[] };
  try {
    parsed = JSON.parse(text || '{}');
  } catch (e) {
    throw new Error(`Model returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const raw = Array.isArray(parsed.notes) ? parsed.notes : [];
  const minLen = 1 / PLACES;
  const notes: PianoNote[] = [];
  raw.forEach((n, i) => {
    const stepIn = typeof n.step === 'number' && Number.isFinite(n.step) ? n.step : 0;
    const step = Math.max(0, roundPlaces(stepIn));
    if (step >= g.totalSteps) return;
    const lenIn = typeof n.length === 'number' && Number.isFinite(n.length) ? n.length : 1;
    const length = Math.max(minLen, Math.min(g.totalSteps - step, roundPlaces(lenIn)));
    notes.push({ id: idOf(i), note: clampInt(n.note, 0, 127, 60), step, length, velocity: clampInt(n.velocity, 1, 127, 90) });
  });
  notes.sort((a, b) => a.step - b.step);
  if (notes.length === 0) throw new Error('Model returned no notes');
  const bpm = typeof parsed.bpm === 'number' && Number.isFinite(parsed.bpm) && parsed.bpm > 0
    ? Math.max(40, Math.min(240, parsed.bpm))
    : requestBpm;
  return { notes, bpm, summary: parsed.summary || '', meterMap: g.meterMap, pickupSteps: g.pickupSteps };
}
