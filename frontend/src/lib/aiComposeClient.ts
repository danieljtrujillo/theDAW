// AI symbolic composition: ask a Gemini model (through theDAW's server-side
// proxy) to write a two-hand piano part from parameters, returned as notes
// on the piano roll's 16th-note step grid. The request carries the roll's
// meter map and pickup and names every bar's steps and groups
// (lib/aiComposeGrid.ts); the notes come back with fractional steps allowed and
// go into the roll with the meter the request used.
//
// Keys stay server-side: the client points the @google/genai SDK at the backend
// /api/genai-proxy passthrough (same pattern as vocal2midi/geminiService.ts).

import { GoogleGenAI, Type } from '@google/genai';
import type { PianoNote } from '../state/pianoRollStore';
import { buildComposePrompt, composeGrid, parseComposeResponse, type ComposePromptInput } from './aiComposeGrid';
import type { MeterSegment } from './meterMap';
import { pairingHeader } from './pairing';

const PROXY_BASE =
  (typeof window !== 'undefined' ? window.location.origin : '') + '/api/genai-proxy';
// SEC-001: a non-loopback caller (the phone, over a plain http://<lan-ip>
// share link) needs a real secret to reach the proxy — see
// backend/lib/pairing.py. pairingHeader() is {} on this machine's own UI,
// which never needed it.
//
// Read once here, not per request: @google/genai's HttpOptions.headers is a
// plain object captured at construction (js-genai's api-report.md — no
// per-call hook), so making this live would mean rebuilding `ai` on every
// call across three files. A phone tab already open keeps using its current
// token after POST /api/pairing/token/regenerate revokes it, same as any
// other credential a page is already holding — until that tab is reloaded
// (a fresh #pair= link/QR scan) it gets refused like any other stale one, no
// worse than closing and reopening the tab today.
const ai = new GoogleGenAI({
  apiKey: 'thedaw-proxy',
  httpOptions: { baseUrl: PROXY_BASE, headers: pairingHeader() },
});

// Default model matches the rest of the in-app Gemini suite. Overridable per call.
export const DEFAULT_COMPOSE_MODEL = 'gemini-3.5-flash';

/** A request: what the prompt says (lib/aiComposeGrid.ts), and which model answers it. */
export interface AiComposeParams extends ComposePromptInput {
  /** Gemini model id (defaults to DEFAULT_COMPOSE_MODEL). */
  model?: string;
  /** Reasoning budget in tokens. */
  thinkingBudget?: number;
}

export interface AiComposeResult {
  notes: PianoNote[];
  bpm: number;
  summary: string;
  /** The meter map and pickup the request was written for; the roll takes them with the notes. */
  meterMap: MeterSegment[];
  pickupSteps: number;
}

/** Generate a piano part from parameters and return roll-ready notes on the roll's meter. */
export async function generatePianoFromParams(p: AiComposeParams): Promise<AiComposeResult> {
  const grid = composeGrid(p);
  const response = await ai.models.generateContent({
    model: p.model || DEFAULT_COMPOSE_MODEL,
    contents: { parts: [{ text: buildComposePrompt(p, grid) }] },
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
                // Numbers, not integers: a tuplet sits between 16th steps.
                step: { type: Type.NUMBER },
                length: { type: Type.NUMBER },
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

  const stamp = Math.random().toString(36).slice(2);
  return parseComposeResponse(response.text || '', grid, p.bpm, (i) => `ai-${stamp}-${i}`);
}
