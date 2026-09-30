/**
 * `midiRowPart` — the instrument/part a MIDI row stands for.
 *
 * Pins the fix for "every MIDI row just says 'stem'": a per-stem MIDI row
 * carries `source: "stem"` for all of them, but its `midi_path` basename is the
 * real part (guitar/bass/drums), because the backend writes each stem's MIDI to
 * `<stem_name>.mid` (backend/modules/midi/runner.py). The part must come from
 * the filename, falling back to `source` only when there is no path, and
 * `midiRowLabel` must be `<title> · <part>` unchanged.
 *
 * Run: `npx tsx src/lib/libraryIndex.test.ts`
 */
import assert from 'node:assert/strict';
import { midiRowLabel, midiRowPart } from './libraryIndex';

// A per-stem MIDI: source is the useless literal "stem", the filename is real.
assert.equal(
  midiRowPart({ id: 'e__guitar_midi', source: 'stem', midi_path: '/data/midi/e/guitar.mid' }),
  'guitar',
  'a stem MIDI reads its part from the filename, not the "stem" source',
);
assert.equal(
  midiRowPart({ id: 'e__bass_midi', source: 'stem', midi_path: 'C:\\data\\midi\\e\\bass.mid' }),
  'bass',
  'a Windows backslash path resolves too',
);
assert.equal(
  midiRowPart({ id: 'e__full', source: 'full', midi_path: '/data/midi/e/full.mid' }),
  'full',
  'a "full" MIDI reads "full"',
);
assert.equal(
  midiRowPart({ id: 'x', source: 'full' }),
  'full',
  'no path -> falls back to source',
);
assert.equal(
  midiRowPart({ id: 'x' }),
  'midi',
  'nothing at all -> "midi"',
);
assert.equal(
  midiRowPart({ id: 'e', source: 'stem', midi_path: '/m/drums.midi' }),
  'drums',
  'the .midi extension is stripped too',
);

// The row reaching this helper is a `Record<string, unknown>` at the LIBRARY
// sub-tab call site, so a non-string midi_path must not throw mid-render.
assert.equal(
  midiRowPart({ id: 'x', source: 'stem', midi_path: 12 as unknown as string }),
  'stem',
  'a non-string midi_path is coerced, not split -> falls back to source',
);
assert.equal(
  midiRowPart({ id: 'x', source: 'full', midi_path: null as unknown as string }),
  'full',
  'a null midi_path falls back to source',
);

// `midiRowLabel` still composes `<title> · <part>` off the same part.
assert.equal(
  midiRowLabel({ id: 'e__guitar_midi', source: 'stem', midi_path: '/m/guitar.mid', parent_title: 'My Song' }),
  'My Song · guitar',
  'the label uses the derived part',
);
assert.equal(
  midiRowLabel({ id: 'e__full', source: 'full', midi_path: '/m/full.mid', parent_title: 'My Song.wav' }),
  'My Song · full',
  'the parent title extension is stripped, "full" unchanged',
);

console.log('libraryIndex tests passed');
