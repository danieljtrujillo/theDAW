/**
 * MIDI input filtering. The failure mode this guards is a dead keyboard: a
 * controller that works today must not stop working because the user once
 * picked a device, and the Quest bridge (which is not a Web MIDI port at all)
 * must never be filtered out by a port list it cannot appear in.
 *
 * Run: npx tsx src/lib/midiPortFilter.test.ts
 */
import assert from 'node:assert/strict';

import {
  DEFAULT_MIDI_INPUT_CONFIG,
  QUEST_PORT,
  describeMidiInputs,
  midiPortAllowed,
  normalizeMidiInputConfig,
  toggleMidiPort,
  type MidiInputConfig,
} from './midiPortFilter.ts';

const launchkey = { id: 'port-1', name: 'Launchkey MK3 MIDI' };
const push = { id: 'port-2', name: 'Ableton Push 2' };
// Two of the same controller: the names collide, the ids never do.
const pushTwin = { id: 'port-3', name: 'Ableton Push 2' };

/* ── 'all' is the default and stays open ─────────────────────────────────── */

assert.equal(DEFAULT_MIDI_INPUT_CONFIG.mode, 'all');
assert.equal(midiPortAllowed(launchkey, DEFAULT_MIDI_INPUT_CONFIG), true);
// A controller plugged in AFTER the choice was made: still allowed, no trip to
// Settings needed.
assert.equal(midiPortAllowed({ id: 'brand-new', name: 'Keystep' }, { mode: 'all', ports: [{ id: 'port-1', label: 'Launchkey MK3 MIDI' }] }), true);

/* ── a malformed or missing config fails OPEN ────────────────────────────── */

assert.equal(midiPortAllowed(launchkey, null), true);
assert.equal(midiPortAllowed(launchkey, undefined), true);
assert.equal(midiPortAllowed(launchkey, normalizeMidiInputConfig('nonsense')), true);
assert.equal(midiPortAllowed(launchkey, normalizeMidiInputConfig({ mode: 'weird' })), true);

/* ── 'some' passes only the saved ports ──────────────────────────────────── */

const only: MidiInputConfig = { mode: 'some', ports: [{ id: 'port-2', label: 'Ableton Push 2' }] };
assert.equal(midiPortAllowed(push, only), true);
assert.equal(midiPortAllowed(launchkey, only), false, 'an unlisted port is silent');
assert.equal(
  midiPortAllowed(pushTwin, only),
  true,
  'the twin matches by NAME — the id rotated or a second identical unit is plugged in',
);

/* ── ids distinguish two ports sharing a name ────────────────────────────── */

const byIdOnly: MidiInputConfig = { mode: 'some', ports: [{ id: 'port-2', label: '' }] };
assert.equal(midiPortAllowed(push, byIdOnly), true);
assert.equal(midiPortAllowed(pushTwin, byIdOnly), false, 'no label to fall back on, so the id decides');

/* ── 'some' with nothing chosen means nothing, deliberately ──────────────── */

const none: MidiInputConfig = { mode: 'some', ports: [] };
assert.equal(midiPortAllowed(push, none), false);
assert.equal(describeMidiInputs(none, 3), 'No inputs');

/* ── the Quest bridge is never filtered ──────────────────────────────────── */

assert.equal(midiPortAllowed(QUEST_PORT, none), true, 'the Quest bridge rides the bus, not Web MIDI');
assert.equal(midiPortAllowed(QUEST_PORT, only), true);

/* ── normalize: drops junk, keeps the shape the backend stores ───────────── */

const normalized = normalizeMidiInputConfig({
  mode: 'some',
  ports: [{ id: 'port-1', label: 'Launchkey MK3 MIDI' }, null, 'x', { label: 'No id but a name' }, {}],
});
assert.equal(normalized.mode, 'some');
assert.deepEqual(normalized.ports, [
  { id: 'port-1', label: 'Launchkey MK3 MIDI' },
  { id: '', label: 'No id but a name' },
]);

/* ── describe + toggle round trip ────────────────────────────────────────── */

assert.equal(describeMidiInputs({ mode: 'all', ports: [] }, 2), 'All inputs (2)');
assert.equal(describeMidiInputs(only, 3), '1 of 3 inputs');

{
  const on = toggleMidiPort({ mode: 'all', ports: [] }, { id: 'port-1', label: 'Launchkey MK3 MIDI' }, true);
  assert.equal(on.mode, 'some', 'picking one port switches the mode');
  assert.deepEqual(on.ports, [{ id: 'port-1', label: 'Launchkey MK3 MIDI' }]);
  const off = toggleMidiPort(on, { id: 'port-1', label: 'Launchkey MK3 MIDI' }, false);
  assert.deepEqual(off.ports, []);
  const twice = toggleMidiPort(on, { id: 'port-1', label: 'Launchkey MK3 MIDI' }, true);
  assert.deepEqual(twice.ports, [{ id: 'port-1', label: 'Launchkey MK3 MIDI' }], 'no duplicates');
}

console.log('midiPortFilter passed');
