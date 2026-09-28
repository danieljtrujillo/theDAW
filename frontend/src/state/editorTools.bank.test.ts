/**
 * The assistant's audio tools on a live part in a bank past 0.
 *
 * The sequence: the piano roll's Horn part (program 60, Bank 1) is sent with
 * the EDIT key. It plays live, so its clip holds no render. The assistant
 * duplicates the clip (editor_duplicate_clip) and merges the two
 * (editor_merge_clips), which first renders each part's window. Before: that
 * render (editorTools extractWindow) asked the synth for program 60 with no
 * bank while EDIT plays the part in bank 1, so the merged audio clip took the
 * General MIDI horn in place of the parts EDIT played. On a fresh send the
 * bounce tool (editor_bounce_clip, which renders through the note path) asks
 * for the same bank.
 *
 *   cd frontend && npx tsx src/state/editorTools.bank.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from './editorStore.ts';
import { partLinkOf, rollTracksOf, usePianoRollStore } from './pianoRollStore.ts';
import * as tools from './editorTools.ts';
import type { ToolResult } from './editorTools.ts';
import { bounceRollToEditor } from '../lib/rollBounce.ts';
import { clipVoice } from '../lib/clipProgram.ts';
import { encodeWav } from '../lib/wavEncode.ts';
import type { OfflineCtxFactory, StepNoteRenderer } from '../lib/clipOps/index.ts';

const SR = 8000;
const ed = () => useEditorStore.getState();
const roll = () => usePianoRollStore.getState();
const GLOBAL = { useSoundfont: true, activeProgram: 0 };

const bufferOf = (channels: Float32Array[], sampleRate: number): AudioBuffer =>
  ({
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0]?.length ?? 0,
    duration: (channels[0]?.length ?? 0) / sampleRate,
    getChannelData: (c: number) => channels[c],
  }) as unknown as AudioBuffer;

/** What encodeWav writes in its 16-bit mode, read back (node has no decodeAudioData). */
const decodeWav = (data: ArrayBuffer): AudioBuffer => {
  const view = new DataView(data);
  const numCh = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const frames = view.getUint32(40, true) / (numCh * 2);
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
  let off = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const v = view.getInt16(off, true);
      channels[c][i] = v < 0 ? v / 0x8000 : v / 0x7fff;
      off += 2;
    }
  }
  return bufferOf(channels, sampleRate);
};

const ctxFactory: OfflineCtxFactory = () => ({
  decodeAudioData: async (data: ArrayBuffer) => decodeWav(data),
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) =>
    bufferOf(Array.from({ length: numberOfChannels }, () => new Float32Array(length)), sampleRate),
});

/** A stand-in synth that records the program and bank each render is asked for. */
const asked: Array<{ program?: number; bank?: number; percussion?: boolean }> = [];
const render: StepNoteRenderer = async (_notes, bpm, totalSteps, opts) => {
  asked.push({ program: opts?.program, bank: opts?.bank, percussion: opts?.percussion });
  const frames = Math.max(2, Math.round(((totalSteps * 60) / bpm / 4) * SR));
  return { blob: encodeWav(bufferOf([new Float32Array(frames).fill(0.25)], SR)), duration: frames / SR };
};
const seams = { render, ctxFactory, sample_rate: SR };

const okOf = (r: ToolResult, what: string): ToolResult => {
  assert.ok(r.ok, `${what}: expected ok, got: ${r.ok ? '' : r.error}`);
  return r;
};

/** The roll's Horn in Bank 1, sent with the EDIT key: its clip id. */
async function sendHorn(): Promise<string> {
  ed().loadProject({ tracks: [], clips: [] });
  roll().importParts([{ name: 'Horn', program: 60, bank: 1, notes: [{ id: 'h1', note: 53, step: 0, length: 4, velocity: 90 }, { id: 'h2', note: 57, step: 8, length: 4, velocity: 90 }] }], 120);
  await bounceRollToEditor({ global: () => GLOBAL });
  const clipId = partLinkOf(roll(), rollTracksOf(roll())[0].id) as string;
  const clip = ed().clips.find((c) => c.id === clipId)!;
  assert.equal(clip.audioBlob, undefined, 'the part plays live and holds no render');
  assert.deepEqual(clipVoice(clip, ed().tracks.find((t) => t.id === clip.trackId), GLOBAL), { program: 60, percussion: false, bank: 1 }, 'EDIT plays it in bank 1');
  return clipId;
}

// ── duplicate, then merge the two live parts ────────────────────────────────
{
  const first = await sendHorn();
  const copy = (okOf(tools.duplicateClip({ clip_id: first }), 'duplicate').data as { clipId: string }).clipId;
  assert.equal(ed().clips.find((c) => c.id === copy)?.instrumentBank, 1, 'the copy keeps the bank');
  asked.length = 0;
  const merged = okOf(await tools.mergeClips({ clip_ids: [first, copy], ...seams }), 'merge');
  assert.equal(asked.length, 2, 'each live part is rendered once');
  assert.deepEqual(asked, [{ program: 60, bank: 1, percussion: false }, { program: 60, bank: 1, percussion: false }], 'each render is asked for bank 1, the bank EDIT plays');
  const mergedId = (merged.data as { clipId: string }).clipId;
  assert.ok(ed().clips.some((c) => c.id === mergedId) && !ed().clips.some((c) => c.id === first || c.id === copy), 'one merged clip replaces both parts');
}

// ── the bounce tool renders the same part through its note path ─────────────
// Both of the assistant's render paths ask for one voice, so a merge and a
// bounce of the same part sound alike.
{
  const horn = await sendHorn();
  asked.length = 0;
  okOf(await tools.bounceClip({ clip_id: horn, ...seams }), 'bounce');
  assert.deepEqual(asked, [{ program: 60, bank: 1, percussion: false }], 'the bounce is asked for bank 1 too');
  assert.equal(ed().clips.find((c) => c.id === horn)?.renderedBank, 1, 'and the clip records the bank its audio has');
}

console.log('editorTools.bank: ok');
