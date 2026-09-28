/**
 * The sound bank registry: a voice is {bankId, bank, program}, a user bank's
 * presets answer to its offset plus their own bank select, projects from
 * before sound banks migrate to the bundled bank, and the pickers list
 * presets by bank. The last part loads a second bank at an offset into
 * SpessaSynth (spessasynth_core, in node) and checks that CC 0 at that offset
 * picks the second bank's preset, as every live synth and render loads them
 * (lib/soundfontEngine).
 *
 *   cd frontend && npx tsx src/lib/bankRegistry.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIDIControllers, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import {
  BUNDLED_BANK_ID,
  bankForSelect,
  bankFromBackend,
  bankOffsetOf,
  bankSelectFor,
  instrumentRefValue,
  isKnownBank,
  migrateInstrumentRef,
  parseInstrumentRefValue,
  presetGroups,
  presetName,
  setBankOffsets,
  type SoundBank,
} from './bankRegistry.ts';
import { clipBank, clipRenderIsStale, clipVoice, rollVoice, type GlobalVoice } from './clipProgram.ts';
import { banksForSelects, bankPresets, programSwitch } from './soundfontEngine.ts';

const user = (id: string, offset: number, span: number, presets: SoundBank['presets']): SoundBank => ({
  id,
  name: id,
  kind: 'user',
  format: 'sf2',
  offset,
  span,
  presets,
  url: `/api/soundfonts/${id}/file`,
});
const bundled: SoundBank = {
  id: BUNDLED_BANK_ID,
  name: 'GeneralUser GS',
  kind: 'bundled',
  format: 'sf3',
  offset: 0,
  span: 128,
  url: '/soundfonts/gm.sf3',
  presets: [
    { bank: 0, bankLsb: 0, program: 0, name: 'Grand Piano', drum: false },
    { bank: 8, bankLsb: 0, program: 4, name: 'Detuned EP 1', drum: false },
    { bank: 0, bankLsb: 0, program: 0, name: 'Standard 1', drum: true },
    { bank: 120, bankLsb: 0, program: 0, name: 'Standard 1 Kit', drum: true },
    { bank: 0, bankLsb: 0, program: 48, name: 'Orchestral', drum: true },
  ],
};
const strings = user('sb-strings0001', 32, 2, [
  { bank: 0, bankLsb: 0, program: 40, name: 'Solo Violin', drum: false },
  { bank: 1, bankLsb: 0, program: 40, name: 'Violin Pizz', drum: false },
  { bank: 0, bankLsb: 0, program: 48, name: 'Timpani Kit', drum: true },
  { bank: 0, bankLsb: 0, program: 9, name: 'Hall Kit', drum: true },
]);

// ── offsets and bank selects ───────────────────────────────────────────────
{
  setBankOffsets([bundled, strings]);
  assert.equal(bankOffsetOf(undefined), 0, 'no bank id is the bundled bank');
  assert.equal(bankOffsetOf('sb-strings0001'), 32);
  assert.equal(bankSelectFor('sb-strings0001', 1), 33, "the bank's offset plus its own bank select");
  assert.equal(bankSelectFor(BUNDLED_BANK_ID, 8), 8, 'the bundled bank selects its own banks');
  assert.equal(bankSelectFor('sb-gone', 1), 1, 'a bank the registry does not know resolves at offset 0');
  assert.equal(isKnownBank('sb-gone'), false);
  assert.equal(bankSelectFor('sb-strings0001', 120), 127, 'never past 127');
  assert.deepEqual(bankForSelect(33, [bundled, strings]), { bankId: 'sb-strings0001', bank: 1 });
  assert.deepEqual(bankForSelect(34, [bundled, strings]), { bankId: BUNDLED_BANK_ID, bank: 34 }, 'past its span');
  assert.deepEqual(bankForSelect(8, [bundled, strings]), { bankId: BUNDLED_BANK_ID, bank: 8 });
}

// ── the migration of saved voices ──────────────────────────────────────────
{
  assert.deepEqual(migrateInstrumentRef(40), { bankId: BUNDLED_BANK_ID, bank: 0, program: 40 }, 'a bare program (every project before banks)');
  assert.deepEqual(migrateInstrumentRef({ instrumentProgram: 40, instrumentBank: 3 }), { bankId: BUNDLED_BANK_ID, bank: 3, program: 40 }, "a clip's program and bank");
  assert.deepEqual(
    migrateInstrumentRef({ instrument_program: 40, instrument_bank: 1, instrument_bank_id: 'sb-strings0001' }),
    { bankId: 'sb-strings0001', bank: 1, program: 40 },
    "a saved file's keys",
  );
  assert.deepEqual(migrateInstrumentRef({ instrument_program: 40, instrument_bank: null, instrument_bank_id: null }), { bankId: BUNDLED_BANK_ID, bank: 0, program: 40 });
  assert.equal(migrateInstrumentRef({ instrument_program: null }), undefined, 'no program: no voice');
  assert.equal(migrateInstrumentRef(Number.NaN), undefined);
  assert.deepEqual(migrateInstrumentRef({ bankId: ' ', bank: 300, program: -4 }), { bankId: BUNDLED_BANK_ID, bank: 127, program: 0 }, 'every field clamped');
  const ref = { bankId: 'sb-strings0001', bank: 1, program: 40 };
  assert.deepEqual(parseInstrumentRefValue(instrumentRefValue(ref)), ref, 'an option value names the ref');
  assert.equal(parseInstrumentRefValue('gm:40'), null);
}

// ── picker groups ──────────────────────────────────────────────────────────
{
  const melodic = presetGroups([bundled, strings], false);
  assert.deepEqual(melodic.map((g) => g.label), ['GeneralUser GS · bank 8', 'sb-strings0001 · bank 0', 'sb-strings0001 · bank 1'], "the bundled bank's bank 0 is the General MIDI list the pickers have");
  assert.equal(melodic[2].options[0].value, 'b:sb-strings0001:1:40');
  assert.equal(melodic[2].options[0].label, '41. Violin Pizz');
  const kits = presetGroups([bundled, strings], true, (id, program) => id === BUNDLED_BANK_ID && program === 0);
  assert.deepEqual(kits.map((g) => g.label), ['GeneralUser GS · kits', 'sb-strings0001 · kits']);
  assert.deepEqual(kits[0].options.map((o) => o.label), ['49. Orchestral'], 'a kit the picker lists already is skipped, one per program');
  const hall = kits[1].options.find((o) => o.ref.program === 9);
  const timp = kits[1].options.find((o) => o.ref.program === 48);
  assert.equal(hall?.shadowed, undefined, 'a user kit at a program of its own plays');
  assert.equal(timp?.shadowed, true, 'a user kit at a bundled kit\'s program is marked: a kit is chosen by program alone');
  assert.equal(presetName([bundled, strings], { bankId: 'sb-strings0001', bank: 1, program: 40 }), 'Violin Pizz');
  assert.equal(presetName([bundled, strings], { bankId: 'sb-strings0001', bank: 0, program: 9 }, true), 'Hall Kit');
  assert.equal(presetName([bundled], { bankId: 'sb-strings0001', bank: 0, program: 40 }), null);
}

// ── the backend's entries ──────────────────────────────────────────────────
{
  const b = bankFromBackend({
    id: 'sb-abc123def456',
    name: 'Hall',
    format: 'dls',
    offset: 40,
    span: 1,
    presets: [{ bank: 0, bank_lsb: 2, program: 60, name: 'Horn', drum: false }],
    path: 'C:/data/soundfonts/sb-abc123def456.dls',
  });
  assert.ok(b);
  assert.equal(b.url, '/api/soundfonts/sb-abc123def456/file');
  assert.equal(b.presets[0].bankLsb, 2);
  assert.equal(b.path, 'C:/data/soundfonts/sb-abc123def456.dls');
}

// ── a voice's bank select, as EDIT plays and renders it ────────────────────
{
  setBankOffsets([bundled, strings]);
  const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
  const melodic = { instrumentProgram: undefined, isPercussion: undefined };
  // A clip's own user-bank preset: offset 32 plus its bank 1.
  const clip = { instrumentProgram: 40, instrumentBank: 1, instrumentBankId: 'sb-strings0001' };
  assert.equal(clipBank(clip, melodic), 33);
  assert.deepEqual(clipVoice(clip, melodic, SF), { program: 40, percussion: false, bank: 33 });
  // The track's bank preset, for a clip with no program of its own.
  const track = { instrumentProgram: 40, isPercussion: undefined, instrumentBank: 0, instrumentBankId: 'sb-strings0001' };
  assert.deepEqual(clipVoice({ instrumentProgram: undefined, instrumentBank: undefined }, track, SF), { program: 40, percussion: false, bank: 32 });
  // The clip's own program keeps the clip's bank, not the track's.
  assert.deepEqual(clipVoice({ instrumentProgram: 5, instrumentBank: undefined }, track, SF), { program: 5, percussion: false });
  // The picker's bank preset, for a clip and track with none.
  const picker: GlobalVoice = { useSoundfont: true, activeProgram: 40, activeBankId: 'sb-strings0001', activeBank: 1 };
  assert.deepEqual(clipVoice({ instrumentProgram: undefined, instrumentBank: undefined }, melodic, picker), { program: 40, percussion: false, bank: 33 });
  assert.deepEqual(rollVoice(null, [], [], picker), { program: 40, percussion: false, bank: 33 }, "an unlinked roll plays the picker's bank preset");
  // A drum track selects no bank: a kit is its program.
  assert.equal(clipBank(clip, { instrumentProgram: 9, isPercussion: true }), 0);
  // A render made at the bank's old offset is stale once the offset moves.
  const rendered = { ...clip, renderedProgram: 40, renderedBank: 33 };
  assert.equal(clipRenderIsStale(rendered, melodic, SF), false);
  setBankOffsets([bundled, { ...strings, offset: 50 }]);
  assert.equal(clipRenderIsStale(rendered, melodic, SF), true);
  setBankOffsets([bundled, strings]);
  // The renders load only the user banks a file selects.
  assert.deepEqual(banksForSelects([0, 33], [strings]).map((b) => b.id), ['sb-strings0001']);
  assert.deepEqual(banksForSelects([0, 8], [strings]), []);
}

// ── the live synth's messages: CC 0 and CC 32 before every program change ──
{
  const toStrings = programSwitch(undefined, 40, bankSelectFor('sb-strings0001', 1));
  assert.deepEqual(toStrings.controllers, [[0, 33], [32, 0]]);
  assert.equal(toStrings.program, 40);
}

// ── SpessaSynth picks the second bank's preset at its offset ───────────────
{
  const gm = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
  const load = () => SoundBankLoader.fromArrayBuffer(gm.buffer.slice(gm.byteOffset, gm.byteOffset + gm.byteLength) as ArrayBuffer);
  const main = load();
  const second = load();
  // The bundled bank's own preset list, as the pickers get it: banks 1-26, the 120 kits and the percussion kits.
  const listed = bankPresets(main);
  assert.ok(listed.some((p) => !p.drum && p.bank === 8), 'a variation bank');
  assert.ok(listed.some((p) => p.drum && p.bank === 0 && p.program === 48), 'the Orchestral kit, selected by program');
  const synth = new SpessaSynthProcessor(44100, { effectsEnabled: false, eventsEnabled: false });
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(main, 'main');
  synth.soundBankManager.addSoundBank(second, 'sb-strings0001', 32);
  const pick = (msb: number, program: number) => {
    synth.controllerChange(0, MIDIControllers.bankSelect, msb);
    synth.controllerChange(0, MIDIControllers.bankSelectLSB, 0);
    synth.programChange(0, program);
    return synth.midiChannels[0].preset;
  };
  assert.equal(pick(32, 40)?.parentSoundBank, second, 'bank select 32 is the second bank\'s bank 0');
  assert.equal(pick(0, 40)?.parentSoundBank, main, 'bank select 0 stays on the bundled bank');
  assert.equal(pick(40, 4)?.parentSoundBank, second, "the second bank's bank 8 at 32 + 8");
}

console.log('bankRegistry: ok');
