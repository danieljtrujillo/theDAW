// AI symbolic composition: ask a Gemini model (through theDAW's server-side
// proxy) to write a two-hand piano part from parameters, returned as notes
// already aligned to the piano roll's 16th-note step grid.
//
// Keys stay server-side: the client points the @google/genai SDK at the backend
// /api/genai-proxy passthrough (same pattern as vocal2midi/geminiService.ts).

import { GoogleGenAI, Type } from '@google/genai';
import type { PianoNote } from '../state/pianoRollStore';

const PROXY_BASE =
  (typeof window !== 'undefined' ? window.location.origin : '') + '/api/genai-proxy';
const ai = new GoogleGenAI({ apiKey: 'thedaw-proxy', httpOptions: { baseUrl: PROXY_BASE } });

// Default model matches the rest of the in-app Gemini suite. Overridable per call.
export const DEFAULT_COMPOSE_MODEL = 'gemini-3.5-flash';

export interface AiComposeParams {
  /** Free-text intent, e.g. "dramatic cinematic piano intro that builds". */
  prompt: string;
  /** Tonic pitch class name, e.g. "C", "F#". */
  key: string;
  /** Mode / scale, e.g. "minor", "major", "dorian", "phrygian". */
  mode: string;
  /** Length in bars (assumes 4/4 -> 16 steps per bar). */
  bars: number;
  bpm: number;
  /** Optional style/genre hint. */
  style?: string;
  /** 0 = sparse & simple, 1 = dense virtuosic runs & ornaments. */
  complexity: number;
  /** Include a distinct left-hand bass/accompaniment line. */
  withBass?: boolean;
  /** Gemini model id (defaults to DEFAULT_COMPOSE_MODEL). */
  model?: string;
  /** Reasoning budget in tokens. */
  thinkingBudget?: number;
}

export interface AiComposeResult {
  notes: PianoNote[];
  bpm: number;
  summary: string;
}

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

const buildPrompt = (p: AiComposeParams): string => {
  const totalSteps = Math.max(1, Math.round(p.bars)) * 16;
  const lines = [
    'You are a virtuoso composer and concert pianist. Compose an original, musical solo piano piece as MIDI note data.',
    '',
    'GRID & FORMAT:',
    '- 16 steps per bar (each step is a 16th note). "step" is the 0-based 16th-note index from the start of the piece.',
    `- Total length: ${p.bars} bars = ${totalSteps} steps. Do NOT exceed ${totalSteps} steps.`,
    '- "length" is the note duration in 16th steps (>= 1). Notes sharing a step form a chord.',
    '- Middle C = MIDI 60. Use the full piano range (about MIDI 33-96).',
    '',
    'MUSICALITY (important):',
    `- Key: ${p.key} ${p.mode}. Stay mostly diatonic; use tasteful chromatic passing tones and leading tones into cadences.`,
    `- Tempo: ${Math.round(p.bpm)} BPM.`,
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
    '- note: integer MIDI 0-127. step: integer >= 0. length: integer >= 1. velocity: integer 1-127.',
    '- Sort notes ascending by step. summary: one sentence describing the piece.',
  ];
  return lines.filter((l) => l !== '').join('\n');
};

/** Generate a piano part from parameters and return roll-ready notes. */
export async function generatePianoFromParams(p: AiComposeParams): Promise<AiComposeResult> {
  const totalSteps = Math.max(1, Math.round(p.bars)) * 16;
  const response = await ai.models.generateContent({
    model: p.model || DEFAULT_COMPOSE_MODEL,
    contents: { parts: [{ text: buildPrompt(p) }] },
    config: {
      thinkingConfig: { thinkingBudget: p.thinkingBudget ?? 4096 },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          bpm: { type: Type.NUMBER },
          summary: { type: Type.STRING },
          notes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                note: { type: Type.INTEGER },
                step: { type: Type.INTEGER },
                length: { type: Type.INTEGER },
                velocity: { type: Type.INTEGER },
              },
              required: ['note', 'step', 'length', 'velocity'],
            },
          },
        },
        required: ['notes'],
      },
    },
  });

  let parsed: { bpm?: number; summary?: string; notes?: RawNote[] };
  try {
    parsed = JSON.parse(response.text || '{}');
  } catch (e) {
    throw new Error(`Model returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const raw = Array.isArray(parsed.notes) ? parsed.notes : [];
  const notes: PianoNote[] = raw
    .map((n, i) => ({
      id: `ai-${Math.random().toString(36).slice(2)}-${i}`,
      note: clampInt(n.note, 0, 127, 60),
      step: clampInt(n.step, 0, totalSteps - 1, 0),
      length: clampInt(n.length, 1, totalSteps, 1),
      velocity: clampInt(n.velocity, 1, 127, 90),
    }))
    .sort((a, b) => a.step - b.step);

  if (notes.length === 0) {
    throw new Error('Model returned no notes');
  }

  const bpm =
    typeof parsed.bpm === 'number' && Number.isFinite(parsed.bpm)
      ? Math.max(40, Math.min(240, Math.round(parsed.bpm)))
      : Math.round(p.bpm);

  return { notes, bpm, summary: parsed.summary || '' };
}
