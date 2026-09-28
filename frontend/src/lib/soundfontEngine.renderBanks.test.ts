/**
 * The user banks an offline render loads (soundfontEngine renderMidiToBlob):
 * the ones the file's bank selects fall in, and for its drum channel, which
 * sends no bank select, a bank holding a kit at the selected program that the
 * bundled bank has none at, as EDIT's live synths load it (lib/editBankBanks).
 * So a drum track on a user bank's kit bounces and exports on that kit.
 *
 *   cd frontend && npx tsx src/lib/soundfontEngine.renderBanks.test.ts
 */
import assert from 'node:assert/strict';
import { BasicMIDI } from 'spessasynth_core';
import { notesToSmf } from './midiWrite.ts';
import { banksForKits, banksForSelects, midiBankSelects, midiDrumPrograms } from './soundfontEngine.ts';
import { userBanksByEditBank } from './editBankBanks.ts';
import type { SoundBank } from './bankRegistry.ts';
import type { AudioClip, EditorTrack } from '../state/editorStore.ts';

const kit = (program: number, name = 'Kit') => ({ bank: 0, bankLsb: 0, program, name, drum: true });
const bundled = { id: 'gm', name: 'GM', kind: 'bundled', format: 'sf3', offset: 0, span: 128, url: '', presets: [0, 8, 16, 24, 25, 32, 40, 48, 56, 127].map((p) => kit(p)) } as unknown as SoundBank;
const kits = { id: 'mykits', name: 'My kits', kind: 'user', format: 'sf2', offset: 40, span: 1, url: '', presets: [kit(50, 'Brush Kit'), kit(48, 'Orchestra Kit')] } as unknown as SoundBank;
const strings = { id: 'strings', name: 'Strings', kind: 'user', format: 'sf2', offset: 41, span: 1, url: '', presets: [{ bank: 0, bankLsb: 0, program: 40, name: 'Violin', drum: false }] } as unknown as SoundBank;
const banks = [bundled, kits, strings];

// What midiSynth renders for a percussion clip: its notes on channel 10 with the kit's program, no bank select.
const smf = notesToSmf([{ midi: 38, note: 38, start: 0, startSec: 0, duration: 0.5, durationSec: 0.5, velocity: 100, channel: 9 }] as never, 50, 9, [], 120, [], { controls: [] });
const midi = BasicMIDI.fromArrayBuffer(smf.buffer.slice(smf.byteOffset, smf.byteOffset + smf.byteLength) as ArrayBuffer, 'drums');
assert.deepEqual([...midiBankSelects(midi)], [], 'the drum render sends no bank select');
assert.deepEqual(banksForSelects(midiBankSelects(midi), banks), [], 'so the bank selects alone load no user bank');
assert.deepEqual([...midiDrumPrograms(midi)], [50]);
assert.deepEqual(banksForKits(midiDrumPrograms(midi), banks).map((b) => b.id), ['mykits'], 'the kit at program 50 loads its bank');
assert.deepEqual(banksForKits([48], banks), [], 'program 48: the bundled bank has a kit there, and it is the one that plays');
assert.deepEqual(banksForKits([0], banks), []);

// The render and EDIT's live synth load the same bank for the drum track.
const track = { id: 't', name: 'Drums', isPercussion: true, instrumentProgram: 50, instrumentBankId: 'mykits', instrumentBank: 0 } as unknown as EditorTrack;
const clip = { id: 'c', trackId: 't', sourceKind: 'piano-roll', sourcePianoRoll: [{}] } as unknown as AudioClip;
const live = userBanksByEditBank(new Map([['t', [9]]]), [clip], [track], { useSoundfont: true, activeProgram: 0 }, banks).map((s) => [...s]);
assert.deepEqual(live, [['mykits']]);

console.log('soundfontEngine.renderBanks: ok');
