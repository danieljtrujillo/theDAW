/**
 * What two 30 MB user banks cost across the synths a 24-part project plays
 * on, and what loading a bank only into the EDIT synths whose tracks select
 * it saves.
 *
 * SpessaSynth 4.3 cannot share a parsed bank between synths: each worklet's
 * processor parses the buffer it is handed on `addSoundBank`
 * (`SoundBankLoader.fromArrayBuffer`), and no call hands one processor
 * another's bank. So the cost of one copy is measured here the way a worklet
 * pays it (spessasynth_core in node: the transferred buffer, the parse, and
 * every sample decoded as it is when played), and multiplied by the copies
 * the synths hold before and after (lib/editBankBanks).
 *
 *   cd frontend && npx tsx src/lib/editBankBanks.test.ts
 */
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { SoundBankLoader } from 'spessasynth_core';
import { useEditorStore } from '../state/editorStore.ts';
import { planLiveMidi } from '../state/liveMixer.ts';
import { userBanksByEditBank } from './editBankBanks.ts';
import { setBankOffsets, type SoundBank } from './bankRegistry.ts';
import type { GlobalVoice } from './clipProgram.ts';

const MB = 1 << 20;

/** A valid SF2 of one preset and one sample, `sampleBytes` of 16-bit sample data. */
function makeSf2(name: string, sampleBytes: number): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const enc = (t: string, n: number) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < Math.min(t.length, n - 1); i += 1) b[i] = t.charCodeAt(i);
    return b;
  };
  const chunk = (id: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    out.set(enc(id, 5).subarray(0, 4), 0);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const list = (kind: string, ...parts: Uint8Array[]) => chunk('LIST', cat(enc(kind, 5).subarray(0, 4), ...parts));
  const rec = (size: number, write: (v: DataView, b: Uint8Array) => void) => {
    const b = new Uint8Array(size);
    write(new DataView(b.buffer), b);
    return b;
  };
  const frames = Math.floor(sampleBytes / 2);
  const smpl = new Uint8Array(frames * 2 + 92);
  for (let i = 0; i < frames; i += 97) new DataView(smpl.buffer).setInt16(i * 2, (i % 30000) - 15000, true);
  const phdr = cat(
    rec(38, (v, b) => { b.set(enc('Strings', 20)); v.setUint16(20, 48, true); v.setUint16(22, 0, true); v.setUint16(24, 0, true); }),
    rec(38, (v, b) => { b.set(enc('EOP', 20)); v.setUint16(24, 1, true); }),
  );
  const bag = (gens: number) => cat(rec(4, () => undefined), rec(4, (v) => v.setUint16(0, gens, true)));
  const gen = (oper: number, amount: number) => cat(rec(4, (v) => { v.setUint16(0, oper, true); v.setUint16(2, amount, true); }), rec(4, () => undefined));
  const inst = cat(rec(22, (_v, b) => b.set(enc('Strings', 20))), rec(22, (v, b) => { b.set(enc('EOI', 20)); v.setUint16(20, 1, true); }));
  const shdr = cat(
    rec(46, (v, b) => {
      b.set(enc('S', 20));
      v.setUint32(20, 0, true);
      v.setUint32(24, frames, true);
      v.setUint32(28, 8, true);
      v.setUint32(32, frames - 8, true);
      v.setUint32(36, 44100, true);
      b[40] = 60;
      v.setUint16(44, 1, true);
    }),
    rec(46, (_v, b) => b.set(enc('EOS', 20))),
  );
  const info = list('INFO', chunk('ifil', rec(4, (v) => { v.setUint16(0, 2, true); v.setUint16(2, 1, true); })), chunk('isng', enc('EMU8000', 8)), chunk('INAM', enc(name, name.length + 2)));
  const sdta = list('sdta', chunk('smpl', smpl));
  const pdta = list(
    'pdta',
    chunk('phdr', phdr),
    chunk('pbag', bag(1)),
    chunk('pmod', new Uint8Array(10)),
    chunk('pgen', gen(41, 0)),
    chunk('inst', inst),
    chunk('ibag', bag(1)),
    chunk('imod', new Uint8Array(10)),
    chunk('igen', gen(53, 0)),
    chunk('shdr', shdr),
  );
  const body = cat(enc('sfbk', 5).subarray(0, 4), info, sdta, pdta);
  const file = cat(enc('RIFF', 5).subarray(0, 4), rec(4, (v) => v.setUint32(0, body.length, true)), body);
  return file.buffer;
}

// A full collection before each reading, so the numbers are what is held and not what is waiting to be freed.
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;
/** The heap and the memory outside it (`external` counts every ArrayBuffer). */
const used = async (): Promise<number> => {
  // V8 frees an ArrayBuffer's memory after the collection that finds it dead, so wait a turn between collections.
  for (let i = 0; i < 4; i += 1) {
    gc();
    await new Promise((r) => setTimeout(r, 20));
  }
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
};

// ── one copy, as a worklet holds it ────────────────────────────────────────
const bankA = makeSf2('Strings A', 30 * MB);
const bankB = makeSf2('Brass B', 30 * MB);
const held: unknown[] = [];
const before = await used();
const copy = bankA.slice(0); // what addSoundBank transfers to the worklet
const parsed = SoundBankLoader.fromArrayBuffer(copy);
held.push(copy, parsed);
const loaded = await used();
for (const s of parsed.samples) s.getAudioData(); // every sample played once
const played = await used();
const perLoaded = (loaded - before) / MB;
const perPlayed = (played - before) / MB;
assert.equal(parsed.presets[0].name, 'Strings');
assert.ok(perLoaded >= 25, `a 30 MB bank costs at least its bytes per synth: ${perLoaded.toFixed(1)} MB`);
console.log(`  one 30 MB bank in one synth: ${perLoaded.toFixed(1)} MB loaded, ${perPlayed.toFixed(1)} MB once every sample has played`);

// ── the synths a 24-part project plays on ──────────────────────────────────
const ed = () => useEditorStore.getState();
const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const user = (id: string, offset: number): SoundBank => ({
  id,
  name: id,
  kind: 'user',
  format: 'sf2',
  offset,
  span: 1,
  presets: [{ bank: 0, bankLsb: 0, program: 48, name: 'Strings', drum: false }],
  url: '',
});
const banks = [user('sb-strings0000', 32), user('sb-brass000000', 33)];
setBankOffsets(banks);

/** 24 parts; `bankOf(i)` names the user bank part i plays from, or null for the bundled bank. */
function project(bankOf: (i: number) => string | null) {
  ed().loadProject({ tracks: [], clips: [] });
  for (let i = 0; i < 24; i += 1) {
    const b = bankOf(i);
    const t = ed().addTrack({ name: `Part ${i + 1}`, instrumentProgram: 48 });
    if (b) ed().updateTrack(t, { instrumentBankId: b });
    ed().addClipToTrack({
      trackId: t,
      label: `Part ${i + 1}`,
      audioBlob: null,
      mimeType: 'audio/wav',
      sourceDuration: 4,
      offsetIntoSource: 0,
      durationSec: 4,
      startSec: 0,
      color: '#fff',
      sourceKind: 'piano-roll',
      sourcePianoRoll: [{ id: `n${i}`, note: 60, step: 0, length: 4, velocity: 90 }],
      sourceBpm: 120,
    });
  }
  const plan = planLiveMidi(ed().clips, ed().tracks, SF);
  const needs = userBanksByEditBank(plan.channels.channelsOf, ed().clips, ed().tracks, SF, banks);
  return { editSynths: plan.channels.banks, needs };
}

const rows: string[] = [];
function scenario(label: string, bankOf: (i: number) => string | null, expectNeeds: string[][]) {
  const { editSynths, needs } = project(bankOf);
  assert.equal(editSynths, 2, 'a 24-part project plays on two EDIT synths (fifteen melodic channels each)');
  assert.deepEqual(needs.map((s) => [...s].sort()), expectNeeds, label);
  const synths = editSynths + 1; // and the preview synth, which holds every bank
  const copiesBefore = synths * banks.length;
  const copiesAfter = banks.length + needs.reduce((n, s) => n + s.size, 0);
  assert.ok(copiesAfter <= copiesBefore);
  rows.push(
    `  ${label}: ${copiesBefore} copies (${(copiesBefore * perLoaded).toFixed(0)} MB loaded, ${(copiesBefore * perPlayed).toFixed(0)} MB played) before; ` +
      `${copiesAfter} copies (${(copiesAfter * perLoaded).toFixed(0)} MB loaded, ${(copiesAfter * perPlayed).toFixed(0)} MB played) after`,
  );
}

scenario('no part plays a user bank', () => null, []);
scenario('parts 1-12 play bank A', (i) => (i < 12 ? 'sb-strings0000' : null), [['sb-strings0000']]);
scenario('parts 1-12 bank A, 13-24 bank B', (i) => (i < 12 ? 'sb-strings0000' : 'sb-brass000000'), [['sb-brass000000', 'sb-strings0000'], ['sb-brass000000']]);
// A drum track whose kit only a user bank has needs that bank; one the bundled bank has does not.
{
  ed().loadProject({ tracks: [], clips: [] });
  const t = ed().addTrack({ name: 'Kit', instrumentProgram: 90, isPercussion: true });
  ed().addClipToTrack({
    trackId: t, label: 'Kit', audioBlob: null, mimeType: 'audio/wav', sourceDuration: 4, offsetIntoSource: 0, durationSec: 4, startSec: 0, color: '#fff',
    sourceKind: 'piano-roll', sourcePianoRoll: [{ id: 'k', note: 36, step: 0, length: 1, velocity: 90 }], sourceBpm: 120,
  });
  const kitBank: SoundBank = { ...user('sb-kits0000000', 34), presets: [{ bank: 0, bankLsb: 0, program: 90, name: 'Hall Kit', drum: true }] };
  const bundled: SoundBank = { ...user('gm', 0), kind: 'bundled', presets: [{ bank: 0, bankLsb: 0, program: 0, name: 'Standard', drum: true }] };
  const plan = planLiveMidi(ed().clips, ed().tracks, SF);
  assert.deepEqual(userBanksByEditBank(plan.channels.channelsOf, ed().clips, ed().tracks, SF, [bundled, kitBank]).map((s) => [...s]), [['sb-kits0000000']]);
  ed().updateTrack(t, { instrumentProgram: 0 });
  assert.deepEqual(userBanksByEditBank(plan.channels.channelsOf, ed().clips, ed().tracks, SF, [bundled, kitBank]).map((s) => [...s]), []);
}
for (const r of rows) console.log(r);
void bankB;

console.log('editBankBanks: ok');
