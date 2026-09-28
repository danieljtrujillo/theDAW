/**
 * AI COMPOSE writes for the roll part it goes into (lib/aiComposeGrid): a
 * part with an instrument asks for that instrument inside its range, a single
 * line unless it reads a grand staff, and rhythm alone for drums; a part with
 * no instrument, and the piano, get the piano prompt COMPOSE always wrote.
 * The notes that come back are folded into the instrument's range.
 *
 *   cd frontend && npx tsx src/lib/aiComposeParts.test.ts
 */
import assert from 'node:assert/strict';
import { buildComposePrompt, foldNotesIntoRange, type ComposePromptInput } from './aiComposeGrid.ts';
import { partComposeInstrument } from './rollTracks.ts';

const base: ComposePromptInput = { prompt: '', key: 'D', mode: 'minor', bpm: 72, complexity: 0.4, bars: 4, meterMap: [], pickupSteps: 0, withBass: true };

// No instrument: the piano prompt, word for word as before parts.
{
  const text = buildComposePrompt(base);
  assert.ok(text.startsWith('You are a virtuoso composer and concert pianist.'));
  assert.ok(text.includes('Use the full piano range (about MIDI 33-96).'));
  assert.ok(text.includes('Give the left hand a clear bass line'));
  assert.equal(buildComposePrompt({ ...base, instrument: partComposeInstrument({ program: 0, bank: 0, channel: null }) }), text, 'the piano part is the piano prompt');
}

// A viola part: a single line inside MIDI 48-88.
{
  const text = buildComposePrompt({ ...base, instrument: partComposeInstrument({ program: null, bank: 0, channel: null, instrumentId: 'viola' }) });
  assert.ok(text.startsWith('You are a virtuoso composer and orchestrator. Compose an original, musical Viola part'));
  assert.ok(text.includes('every note between MIDI 48 and 88'));
  assert.ok(text.includes('Write one singing line, as the Viola plays it'));
  assert.equal(text.includes('left hand'), false, 'no left hand for a viola');
  assert.ok(text.includes('"a beautiful, natural Viola part"'));
}

// A harp reads a grand staff: two hands. Drums: rhythm alone.
{
  const harp = buildComposePrompt({ ...base, instrument: partComposeInstrument({ program: 46, bank: 0, channel: null }) });
  assert.ok(harp.includes('Write for two hands on a grand staff, as the Harp plays'));
  const drums = buildComposePrompt({ ...base, instrument: partComposeInstrument({ program: 48, bank: 0, channel: 10 }) });
  assert.ok(drums.includes('General MIDI drum notes'));
  assert.ok(drums.includes('Each note is a drum on MIDI channel 10'));
}

// The notes fold into the range by octaves, keeping their pitch classes.
{
  const out = foldNotesIntoRange([{ note: 30 }, { note: 60 }, { note: 100 }, { note: 88 }], 48, 88);
  assert.deepEqual(out.map((n) => n.note), [54, 60, 88, 88]);
  assert.ok(out.every((n, i) => n.note % 12 === [30, 60, 100, 88][i] % 12));
}

console.log('aiComposeParts: ok');
