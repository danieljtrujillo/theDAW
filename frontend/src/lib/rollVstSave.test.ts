/**
 * A roll part's VST3 instrument through save, reload, the EDIT key and a MIDI
 * export: the plugin and the state its editor captured go out in the part's
 * .tasmo record and come back onto the part; the EDIT key puts the plugin on
 * the part's EDIT track's instrument slot, where every bounce prints it; and
 * the MIDI export writes the part's General MIDI program, the fallback.
 *
 *   cd frontend && npx tsx src/lib/rollVstSave.test.ts
 */
import assert from 'node:assert/strict';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { cleanRollPartRef, rollPartRef } from './rollClip.ts';
import { rollPartToTasmo, tasmoRollPart } from './projectClient.ts';
import { makeRollTrack, sanitizeRollTracks } from './rollTracks.ts';
import { partTrackInstrument } from './rollBounce.ts';
import { rollToMidiFile } from './rollMidi.ts';

const PLUGIN = { plugin_path: 'C:\\Program Files\\Common Files\\VST3\\Surge XT.vst3', plugin_name: 'Surge XT' };
const st = () => usePianoRollStore.getState();

// A part on a VST3 instrument whose editor captured a state, its program the fallback.
const first = rollTracksOf(st())[0].id;
st().setTrackProgram(first, 40, false);
st().setPartNotes(first, [{ id: 'a', note: 60, step: 0, length: 4, velocity: 90 }]);
st().setTrackVstInstrument(first, PLUGIN);
st().setTrackArticulationSwitch(first, 'uacc');
const entryId = rollTracksOf(st())[0].vstInstrument!.id;
st().setPartVstState(entryId, 'U3VyZ2U=', 'thedaw');
const part = rollTracksOf(st())[0];
assert.equal(part.vstInstrument?.vst?.raw_state, 'U3VyZ2U=', "the captured state is on the part");

// ── SAVE: the record on the part's clip, in the file's shape, and back ──────
const ref = rollPartRef(part, 0, 'roll-doc');
const file = JSON.parse(JSON.stringify(rollPartToTasmo(ref)));
assert.deepEqual(file.vst_instrument, {
  id: entryId,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: PLUGIN.plugin_path, plugin_name: 'Surge XT', raw_state: 'U3VyZ2U=', state_host: 'thedaw' },
});
assert.equal(file.articulation_switch, 'uacc');
assert.equal(file.program, 40, 'the General MIDI program is written beside the plugin');
const back = tasmoRollPart(file, { name: 'x', color: '#000000' });
assert.deepEqual(back?.vstInstrument, ref.vstInstrument, 'the file gives the plugin and its state back');
assert.equal(back?.articulationSwitch, 'uacc');
const reopened = makeRollTrack(cleanRollPartRef(back, { name: 'x', color: '#000000' })!, 0);
assert.equal(reopened.vstInstrument?.id, entryId, "a reopened part holds its instrument under the same entry id");
assert.equal(reopened.vstInstrument?.vst?.raw_state, 'U3VyZ2U=');
assert.equal(reopened.program, 40);
// Two parts naming one entry (a duplicated part) get sessions of their own.
const twins = sanitizeRollTracks([reopened, { ...reopened, id: 'other' }]);
assert.notEqual(twins[1].vstInstrument?.id, twins[0].vstInstrument?.id);
assert.equal(twins[1].vstInstrument?.vst?.raw_state, 'U3VyZ2U=', 'with the same plugin and state');
// A part switched off keeps the plugin, and its record says so.
st().setTrackVstEnabled(first, false);
const off = rollPartToTasmo(rollPartRef(rollTracksOf(st())[0], 0, 'roll-doc'));
assert.equal(off.vst_instrument?.enabled, false);
assert.equal(tasmoRollPart(JSON.parse(JSON.stringify(off)), { name: 'x', color: '#000000' })?.vstInstrument?.enabled, false);
st().setTrackVstEnabled(first, true);

// ── EDIT key: the plugin goes onto the part's EDIT track's instrument slot ───
const fresh = partTrackInstrument(part, undefined, undefined);
assert.equal(fresh?.instrument?.vst?.plugin_path, PLUGIN.plugin_path, 'a new track gets the plugin');
assert.equal(fresh?.instrument?.vst?.raw_state, 'U3VyZ2U=', 'with the captured state');
assert.equal(fresh?.articulationSwitch, 'uacc');
assert.notEqual(fresh?.instrument?.id, entryId, 'under a slot entry of its own');
const again = partTrackInstrument(part, { instrument: fresh!.instrument }, ref);
assert.equal(again?.instrument?.id, fresh?.instrument?.id, 'a track already on that plugin keeps its slot entry, so its running session is reused');
const { vstInstrument: _gone, ...plain } = part;
assert.deepEqual(partTrackInstrument(plain, { instrument: fresh!.instrument }, ref), { instrument: undefined, articulationSwitch: undefined }, 'a part whose plugin was taken away takes it off the track');
assert.equal(partTrackInstrument(plain, { instrument: fresh!.instrument }, undefined), null, "a plugin the user put on the track stays");

// ── MIDI export: the part's General MIDI program is what the file carries ────
const second = st().addTrack({ notes: [{ id: 'b', note: 43, step: 0, length: 4, velocity: 90 }], program: 32 }) as string;
const roll = st();
const midi = rollToMidiFile({ ...roll, tracks: rollTracksOf(roll), activeTrackId: second });
const vstTrack = midi.tracks.find((t) => t.name === part.name);
assert.ok(vstTrack, "the VST part's track is in the file");
assert.deepEqual(vstTrack.programs?.map((p) => p.program), [40], 'with its General MIDI program, the fallback');
console.log('rollVstSave: the plugin and its state survive save and reload, reach the EDIT track, and the export keeps the program');
