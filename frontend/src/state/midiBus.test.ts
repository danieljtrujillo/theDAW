/**
 * MIDI ignore enforcement. FE-010: `isMidiSigIgnored` / `isMidiMessageIgnored`
 * existed in midiIgnoreStore but publishMidi never consulted them, so
 * "Ignore" in the DJ MIDI map did nothing — every bus subscriber (VJ
 * forwarder, DJ control map, MidiMapper learn popups) still saw the ignored
 * CC/note. The fix is in publishMidi itself: it is the one chokepoint every
 * MIDI source (Web MIDI, Quest bridge, synthetic Sway messages) funnels
 * through, so filtering there silences an ignored control for every bus
 * subscriber at once. The built-in piano synth is NOT a bus subscriber
 * (App.tsx triggers it straight off raw `e.data`, ahead of publishMidi), so
 * it repeats the ignore check itself — that path is covered by
 * App.tsx-level testing, not here.
 *
 * NOTE-OFF is exempt from the filter (see midiBus.ts) so an ignored note
 * that was already sounding can still be released instead of hanging stuck
 * open in MIDI capture.
 *
 * Run: npx tsx src/state/midiBus.test.ts
 */
import assert from 'node:assert/strict';

import { publishMidi, subscribeToMidi } from './midiBus.ts';
import { useMidiIgnoreStore } from './midiIgnoreStore.ts';

const STATUS_CC = 0xb0;
const STATUS_NOTE_ON = 0x90;
const STATUS_NOTE_OFF = 0x80;

function reset() {
  useMidiIgnoreStore.setState({ controls: [] });
}

/* ── an un-ignored message still reaches subscribers ─────────────────────── */
{
  reset();
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_CC | 0, 20, 64]);
  unsub();
  assert.deepEqual(seen, [[STATUS_CC | 0, 20, 64]], 'non-ignored CC still reaches subscribers');
}

/* ── an ignored CC on its exact channel is dropped before any subscriber sees it ── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'cc', number: 20, channel: 0 });
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_CC | 0, 20, 64]);
  unsub();
  assert.deepEqual(seen, [], 'ignored CC never reaches any subscriber');
}

/* ── ignoring one channel does not silence the same CC on another channel ── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'cc', number: 20, channel: 0 });
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_CC | 1, 20, 64]); // channel 1, not ignored
  unsub();
  assert.deepEqual(seen, [[STATUS_CC | 1, 20, 64]]);
}

/* ── "ignore on any channel" blocks the CC regardless of channel ─────────── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'cc', number: 20, channel: 0 }, { anyChannel: true });
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_CC | 5, 20, 1]);
  unsub();
  assert.deepEqual(seen, [], 'any-channel ignore blocks the CC on every channel');
}

/* ── ignoring a whole channel blocks every CC/note of that kind on it ────── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreChannel('note', 3);
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_NOTE_ON | 3, 60, 100]);
  publishMidi([STATUS_CC | 3, 20, 64]); // different kind, same channel: not ignored
  unsub();
  assert.deepEqual(seen, [[STATUS_CC | 3, 20, 64]]);
}

/* ── messages that don't parse into a control signature are never filtered ── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'cc', number: 20, channel: 0 }, { anyChannel: true });
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([0xf8]); // clock tick, no data bytes — midiSigFromData returns null
  unsub();
  assert.deepEqual(seen, [[0xf8]], 'system messages without a sig pass through untouched');
}

/* ── note-off (0x80) for an ignored note still reaches subscribers ───────── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'note', number: 60, channel: 2 }, { anyChannel: true });
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_NOTE_ON | 2, 60, 100]); // the note-on: still blocked
  publishMidi([STATUS_NOTE_OFF | 2, 60, 0]); // the release: must get through
  unsub();
  assert.deepEqual(seen, [[STATUS_NOTE_OFF | 2, 60, 0]], 'note-off is exempt so a held note can be released');
}

/* ── note-on with velocity 0 (running-status note-off) is exempt too ─────── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'note', number: 60, channel: 2 }, { anyChannel: true });
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_NOTE_ON | 2, 60, 0]); // note-on, velocity 0 == a note-off
  unsub();
  assert.deepEqual(seen, [[STATUS_NOTE_ON | 2, 60, 0]], 'velocity-0 note-on is treated as note-off and passes');
}

/* ── an ignored CC is still blocked (note-off exemption doesn't leak to CCs) ── */
{
  reset();
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'cc', number: 20, channel: 0 });
  const seen: number[][] = [];
  const unsub = subscribeToMidi((msg) => seen.push(msg.data));
  publishMidi([STATUS_CC | 0, 20, 0]); // CC with value 0 must not be mistaken for a note-off
  unsub();
  assert.deepEqual(seen, [], 'a zero-value CC is still an ignored CC, not an exempt note-off');
}

reset();
console.log('midiBus passed');
