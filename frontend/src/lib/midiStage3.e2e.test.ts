/**
 * MIDI stage 3 end to end: an orchestral MIDI file opens with each part on its
 * own instrument, its tempo and meter changes intact, and twenty-four parts
 * play live on the audio clock.
 *
 * 1. FIXTURE: a type-1 file of 24 named tracks at 480 PPQ, written here byte by
 *    byte (running status, note-offs as note-on velocity 0 on half the tracks,
 *    a GM reset SysEx), with nothing of lib/midi's encoder in it. Each track has
 *    its own program, four send a bank select (MSB and LSB), the percussion
 *    track is on channel 10, and CC 1, 7, 10, 11 and 64 are used. Tempo 96, 120
 *    at bar 5, then a ritardando from bar 11 to 80 in eighth-note steps; 4/4,
 *    3/4 at bar 5, 7/8 at bar 9 with `theDAW:groups=2+2+3`; two markers. 24
 *    tracks on 16 channels share channels, as orchestral files do.
 * 2. IMPORT: the roll's multi-part import (PianoRoll's IMPORT: parseMidi and
 *    importMidiParts) and EDIT's "Import as tracks" (importMidiBytesAsTracks,
 *    the MIDI tab's flyout and EDIT's add-to-track menu).
 * 3. SCHEDULE: EDIT's lookahead scheduler (lib/editMidiScheduler), planned as
 *    play() plans it (liveMixer planLiveMidi), against a fake audio clock that
 *    moves in 128-sample render quanta, with the 25 ms timer firing up to 20 ms
 *    late and stalling 60 ms now and then, and the rAF loop that wraps a loop.
 *    Every note-on's context time is measured against the time the FILE's
 *    tempo map gives its tick, from the file's own microseconds. A whole pass,
 *    three loop wraps and two seeks: no note dropped or doubled.
 * 4. EXPORT: the arrangement's MIDI export (exportArrangementMidi, the export
 *    dialog's path) at 960 PPQ, read back: notes tick-exact, programs, banks,
 *    channels, controllers, the tempo map, the meter map with its groups and
 *    the markers.
 * 6. PERFORMANCE: import, a scheduler pass and the export, timed for the
 *    24-part file and for a 100,000-note version of it.
 *
 * Check 5 (a CC0 quartet from the sheet side) is tests/test_midi_stage3_e2e.py.
 *
 *   cd frontend && npx tsx src/lib/midiStage3.e2e.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from '../state/editorStore.ts';
import { planLiveMidi } from '../state/liveMixer.ts';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { exportArrangementMidi } from './arrangementMidiApp.ts';
import type { GlobalVoice } from './clipProgram.ts';
import { EDIT_MIDI_LATE_SEC, EDIT_MIDI_LOOKAHEAD_SEC, EDIT_MIDI_TICK_MS, EditMidiScheduler, type EditMidiPass } from './editMidiScheduler.ts';
import { parseMidi } from './midi.ts';
import { importMidiBytesAsTracks } from './midiImportTracksApp.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { isPercussionPart } from './rollTracks.ts';

const GLOBAL: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const FILE_PPQ = 480;
const ROLL_PPQ = 960;
const ed = () => useEditorStore.getState();
const report: Record<string, unknown> = {};

// =============================================================================
// 1. The fixture, written byte by byte
// =============================================================================

interface Instrument {
  name: string;
  /** Zero-based channel. */
  ch: number;
  program: number;
  low: number;
  bank?: number;
  bankLsb?: number;
  drums?: boolean;
  pedal?: boolean;
}

/** 24 parts on 16 channels: eight pairs share one, as a 24-track orchestral file must. */
const ORCHESTRA: Instrument[] = [
  { name: 'Piccolo', ch: 0, program: 72, low: 76 },
  { name: 'Flute 1', ch: 1, program: 73, low: 72 },
  { name: 'Flute 2', ch: 1, program: 73, low: 67 },
  { name: 'Oboe 1', ch: 2, program: 68, low: 69, bank: 0, bankLsb: 1 },
  { name: 'Oboe 2', ch: 2, program: 68, low: 64 },
  { name: 'Clarinet in B♭ 1', ch: 3, program: 71, low: 62 },
  { name: 'Clarinet in B♭ 2', ch: 3, program: 71, low: 57 },
  { name: 'Bassoon 1', ch: 4, program: 70, low: 48 },
  { name: 'Contrabassoon', ch: 4, program: 70, low: 36 },
  { name: 'Horn in F 1', ch: 5, program: 60, low: 60 },
  { name: 'Horn in F 2', ch: 5, program: 60, low: 55 },
  { name: 'Trumpet in B♭', ch: 6, program: 56, low: 67, bank: 8, bankLsb: 0 },
  { name: 'Trombone', ch: 7, program: 57, low: 50 },
  { name: 'Tuba', ch: 8, program: 58, low: 36 },
  { name: 'Timpani', ch: 10, program: 47, low: 43 },
  { name: 'Percussion', ch: 9, program: 48, low: 36, drums: true },
  { name: 'Harp', ch: 11, program: 46, low: 55, bank: 0, bankLsb: 2, pedal: true },
  { name: 'Celesta', ch: 12, program: 8, low: 79, pedal: true },
  { name: 'Violin I', ch: 13, program: 40, low: 76 },
  { name: 'Violin II', ch: 13, program: 40, low: 69 },
  { name: 'Viola', ch: 14, program: 41, low: 60 },
  { name: 'Violoncello', ch: 15, program: 42, low: 48 },
  { name: 'Contrabass', ch: 15, program: 43, low: 36 },
  { name: 'Choir Aahs', ch: 14, program: 52, low: 60, bank: 8, bankLsb: 1 },
];
const STRINGS_FROM = 18;

interface FixNote { tick: number; dur: number; midi: number; vel: number }
interface FixCc { tick: number; cc: number; value: number }
interface FixPart extends Instrument { notes: FixNote[]; ccs: FixCc[] }
interface Bar { tick: number; num: number; den: number; groups: number[] }
interface Fixture {
  bytes: Uint8Array;
  parts: FixPart[];
  bars: Bar[];
  endTick: number;
  /** Every FF 51 as written: its tick and its microseconds a quarter. */
  tempos: Array<{ tick: number; micros: number }>;
  signatures: Array<{ tick: number; num: number; den: number; groups: number[] }>;
  markers: Array<{ tick: number; text: string }>;
  noteCount: number;
}

const vlq = (value: number): number[] => {
  let v = value;
  const out = [v & 0x7f];
  v = Math.floor(v / 128);
  while (v > 0) {
    out.unshift(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  return out;
};
const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));
const meta = (type: number, data: number[]): number[] => [0xff, type, ...vlq(data.length), ...data];

interface RawEv { tick: number; order: number; bytes: number[] }

/** One MTrk: events by tick then order, channel messages in running status (a meta or SysEx cancels it, as SMF 1.0 says). */
function trackChunk(events: RawEv[], out: number[]): void {
  const sorted = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.tick - b.tick || a.order - b.order || a.i - b.i);
  const body: number[] = [];
  let last = 0;
  let running = -1;
  const put = (bytes: number[]) => {
    for (const b of bytes) body.push(b);
  };
  for (const e of sorted) {
    put(vlq(e.tick - last));
    last = e.tick;
    const status = e.bytes[0];
    if (status < 0xf0) {
      if (status === running) put(e.bytes.slice(1));
      else {
        put(e.bytes);
        running = status;
      }
    } else {
      put(e.bytes);
      running = -1;
    }
  }
  put([0x00, 0xff, 0x2f, 0x00]);
  for (const b of [...utf8('MTrk'), ...u32(body.length)]) out.push(b);
  for (const b of body) out.push(b);
}

/**
 * The orchestra over `blocks` repeats of a 14-bar form: bars 1-4 in 4/4 at 96,
 * 5-8 in 3/4 at 120, 9-14 in 7/8 (2+2+3), a ritardando from bar 11 to 80.
 * `dense` puts a 16th note on every step of every part (the 100,000-note file).
 */
function buildFixture(blocks: number, dense: boolean): Fixture {
  const bars: Bar[] = [];
  let tick = 0;
  for (let b = 0; b < blocks; b += 1) {
    for (let i = 0; i < 14; i += 1) {
      const meter = i < 4 ? { num: 4, den: 4, groups: [] } : i < 8 ? { num: 3, den: 4, groups: [] } : { num: 7, den: 8, groups: [2, 2, 3] };
      bars.push({ tick, ...meter });
      tick += (meter.num * 4 * FILE_PPQ) / meter.den;
    }
  }
  const endTick = tick;
  const barLen = (i: number) => (i + 1 < bars.length ? bars[i + 1].tick : endTick) - bars[i].tick;

  const tempos: Fixture['tempos'] = [];
  const signatures: Fixture['signatures'] = [];
  const markers: Fixture['markers'] = [];
  const micros = (bpm: number) => Math.round(60_000_000 / bpm);
  for (let b = 0; b < blocks; b += 1) {
    const at = (i: number) => bars[b * 14 + i].tick;
    tempos.push({ tick: at(0), micros: micros(96) });
    tempos.push({ tick: at(4), micros: micros(120) });
    // The ritardando: an FF 51 every eighth from bar 11 to the block's end, 120 down to 80.
    const ritFrom = at(10);
    const ritTo = b + 1 < blocks ? bars[(b + 1) * 14].tick : endTick;
    const steps = (ritTo - ritFrom) / (FILE_PPQ / 2);
    for (let i = 1; i <= steps; i += 1) tempos.push({ tick: ritFrom + (i - 1) * (FILE_PPQ / 2), micros: micros(120 - (40 * i) / steps) });
    signatures.push({ tick: at(0), num: 4, den: 4, groups: [] });
    signatures.push({ tick: at(4), num: 3, den: 4, groups: [] });
    signatures.push({ tick: at(8), num: 7, den: 8, groups: [2, 2, 3] });
    if (b === 0) {
      markers.push({ tick: at(8), text: 'Coda' });
      markers.push({ tick: at(10), text: 'Ritardando – più lento' });
    }
  }

  const parts: FixPart[] = ORCHESTRA.map((o, k) => {
    const notes: FixNote[] = [];
    const vel = (a: number, b: number) => 40 + ((a * 7 + b * 5 + k * 3) % 80);
    const pitch = (a: number, b: number) => (o.drums ? [36, 38, 42, 46, 49, 51][(a + b + k) % 6] : o.low + ((a + b + k) % 7));
    bars.forEach((bar, i) => {
      const len = barLen(i);
      const form = i % 14;
      if (dense) {
        for (let t = 0; t < len; t += FILE_PPQ / 4) notes.push({ tick: bar.tick + t, dur: FILE_PPQ / 4 - 12, midi: pitch(i, t / 120), vel: vel(i, t / 120) });
        return;
      }
      if (bar.den === 8) {
        // 7/8: a note on each group's first eighth, as long as its group.
        let at = 0;
        bar.groups.forEach((g, gi) => {
          notes.push({ tick: bar.tick + at, dur: Math.round(g * (FILE_PPQ / 2) * 0.9), midi: pitch(i, gi), vel: vel(i, gi) });
          at += g * (FILE_PPQ / 2);
        });
        return;
      }
      for (let beat = 0; beat < bar.num; beat += 1) {
        const at = bar.tick + beat * FILE_PPQ;
        if (form === 1 && beat === 2 && k < 9) {
          // Woodwinds play an eighth-note triplet on beat 3 of bar 2.
          for (let j = 0; j < 3; j += 1) notes.push({ tick: at + j * 160, dur: 150, midi: pitch(i, beat + j), vel: vel(i, beat + j) });
          continue;
        }
        if (form === 2 && k >= STRINGS_FROM && k < 23) {
          // Strings play bar 3 off the grid, a few ticks either side of the beat.
          notes.push({ tick: at + ((beat * 3 + k) % 11) - 5 + (beat === 0 ? 5 : 0), dur: 420 + ((beat + k) % 9), midi: pitch(i, beat), vel: vel(i, beat) });
          continue;
        }
        if (o.name === 'Celesta' && form === 3 && beat === 0) {
          // A repeated note played legato: the second starts before the first ends.
          notes.push({ tick: at, dur: 600, midi: o.low, vel: 70 });
          notes.push({ tick: at + FILE_PPQ, dur: 432, midi: o.low, vel: 72 });
          continue;
        }
        if (o.name === 'Celesta' && form === 3 && beat === 1) continue;
        notes.push({ tick: at, dur: 432, midi: pitch(i, beat), vel: vel(i, beat) });
        if (o.name === 'Harp') notes.push({ tick: at, dur: 432, midi: pitch(i, beat) + 7, vel: vel(i, beat) });
      }
    });

    const ccs: FixCc[] = [
      { tick: 0, cc: 7, value: 70 + ((k * 3) % 50) },
      { tick: 0, cc: 10, value: (k * 11) % 128 },
    ];
    bars.forEach((bar, i) => {
      const form = i % 14;
      if (form === 4 || form === 5) {
        for (let beat = 0; beat < bar.num; beat += 1) ccs.push({ tick: bar.tick + beat * FILE_PPQ, cc: 11, value: 60 + ((form - 4) * 3 + beat) * 11 });
      }
      if (k >= STRINGS_FROM && (form === 8 || form === 10 || form === 12)) ccs.push({ tick: bar.tick, cc: 1, value: form === 8 ? 40 : form === 10 ? 80 : 0 });
      if (o.pedal) {
        ccs.push({ tick: bar.tick, cc: 64, value: 127 });
        ccs.push({ tick: bar.tick + barLen(i) - 10, cc: 64, value: 0 });
      }
    });
    return { ...o, notes, ccs };
  });

  const out: number[] = [...utf8('MThd'), ...u32(6), 0, 1, 0, 1 + parts.length, (FILE_PPQ >> 8) & 0xff, FILE_PPQ & 0xff];
  // The conductor: a GM reset, the title, every tempo, signature (with its groups text) and marker.
  const conductor: RawEv[] = [
    { tick: 0, order: -2, bytes: [0xf0, ...vlq(5), 0x7e, 0x7f, 0x09, 0x01, 0xf7] },
    { tick: 0, order: -1, bytes: meta(0x03, utf8('Stage 3 orchestra')) },
    { tick: 0, order: -1, bytes: meta(0x02, utf8('CC0')) },
  ];
  for (const t of tempos) conductor.push({ tick: t.tick, order: 0, bytes: meta(0x51, [(t.micros >> 16) & 0xff, (t.micros >> 8) & 0xff, t.micros & 0xff]) });
  for (const s of signatures) {
    conductor.push({ tick: s.tick, order: 1, bytes: meta(0x58, [s.num, Math.log2(s.den), 24, 8]) });
    if (s.groups.length) conductor.push({ tick: s.tick, order: 2, bytes: meta(0x01, utf8(`theDAW:groups=${s.groups.join('+')}`)) });
  }
  for (const m of markers) conductor.push({ tick: m.tick, order: 3, bytes: meta(0x06, utf8(m.text)) });
  trackChunk(conductor, out);
  parts.forEach((p, k) => {
    const ch = p.ch;
    const evs: RawEv[] = [{ tick: 0, order: -1, bytes: meta(0x03, utf8(p.name)) }];
    if (p.bank !== undefined) evs.push({ tick: 0, order: 1, bytes: [0xb0 | ch, 0, p.bank] });
    if (p.bankLsb !== undefined) evs.push({ tick: 0, order: 1, bytes: [0xb0 | ch, 32, p.bankLsb] });
    evs.push({ tick: 0, order: 1, bytes: [0xc0 | ch, p.program] });
    for (const c of p.ccs) evs.push({ tick: c.tick, order: 2, bytes: [0xb0 | ch, c.cc, c.value] });
    for (const n of p.notes) {
      evs.push({ tick: n.tick, order: 3, bytes: [0x90 | ch, n.midi, n.vel] });
      // Half the tracks end notes with note-on velocity 0, the other half with note-off.
      evs.push({ tick: n.tick + n.dur, order: 0, bytes: k % 2 ? [0x90 | ch, n.midi, 0] : [0x80 | ch, n.midi, 64] });
    }
    trackChunk(evs, out);
  });
  return {
    bytes: Uint8Array.from(out),
    parts,
    bars,
    endTick,
    tempos,
    signatures,
    markers,
    noteCount: parts.reduce((n, p) => n + p.notes.length, 0),
  };
}

/** Seconds at `tick` under the fixture's own FF 51 microseconds (integer arithmetic until the last division). */
function fileClock(fx: Fixture): (tick: number) => number {
  const segs: Array<{ tick: number; micros: number; startUs: number }> = [];
  let us = 0;
  let prev = { tick: 0, micros: 500_000 };
  for (const t of fx.tempos) {
    us += ((t.tick - prev.tick) * prev.micros) / FILE_PPQ;
    segs.push({ tick: t.tick, micros: t.micros, startUs: us });
    prev = t;
  }
  return (tick: number) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return (s.startUs + ((tick - s.tick) * s.micros) / FILE_PPQ) / 1e6;
  };
}

/** A part's controller changes as a MIDI channel holds them: every track on its channel, the later of two at one tick. */
function channelCcs(fx: Fixture, ch: number, scale = 1): string[] {
  const byKey = new Map<string, number>();
  for (const p of fx.parts) if (p.ch === ch) for (const c of p.ccs) byKey.set(`${c.tick * scale}:${c.cc}`, c.value);
  return [...byKey.entries()].map(([k, v]) => `${k}:${v}`).sort();
}

const ccKeys = (controls: ReadonlyArray<{ tick: number; controller: number; value: number }> | undefined): string[] =>
  (controls ?? []).map((c) => `${c.tick}:${c.controller}:${c.value}`).sort();

const fx = buildFixture(1, false);
const fileSec = fileClock(fx);
const tempoOf = (micros: number) => 60_000_000 / micros;
console.log(`  fixture: ${fx.parts.length} tracks, ${fx.noteCount} notes, ${fx.tempos.length} tempos, ${fx.signatures.length} signatures, ${fx.bytes.length} bytes`);

// =============================================================================
// 2a. The roll's multi-part import (PianoRoll's IMPORT)
// =============================================================================
{
  useEditorStore.getState().loadProject({ tracks: [], clips: [] });
  const t0 = performance.now();
  const data = parseMidi(fx.bytes);
  const done = importMidiParts(data, 'imp');
  report.rollImportMs = performance.now() - t0;
  assert.equal(done.into, 'parts');
  assert.equal(done.parts, 24, '24 parts');
  assert.equal(done.notes, fx.noteCount, 'every note arrives');
  const roll = usePianoRollStore.getState();
  const parts = rollTracksOf(roll);
  assert.equal(parts.length, 24);
  fx.parts.forEach((f, k) => {
    const p = parts[k];
    assert.equal(p.name, f.name, `part ${k + 1} is named after its track`);
    assert.equal(p.program, f.program, `${f.name}: program`);
    assert.equal(p.bank, f.drums ? 0 : (f.bank ?? 0), `${f.name}: bank MSB`);
    assert.equal(p.bankLsb, f.drums ? undefined : f.bankLsb, `${f.name}: bank LSB`);
    assert.equal(p.channel, f.ch + 1, `${f.name}: channel ${f.ch + 1}`);
    assert.equal(isPercussionPart(p), !!f.drums, `${f.name}: drums flag`);
    assert.deepEqual(
      p.notes.map((n) => `${n.tick}:${n.ticks}:${n.note}:${n.velocity}`).sort(),
      f.notes.map((n) => `${n.tick * 2}:${n.dur * 2}:${n.midi}:${n.vel}`).sort(),
      `${f.name}: every note at its own tick and length, on the 960 clock`,
    );
    assert.deepEqual(ccKeys(p.controls), channelCcs(fx, f.ch, 2), `${f.name}: the controller changes of its channel`);
  });
  assert.equal(parts[15].instrumentId, 'drum-kit', 'the channel-10 track is the kit');
  assert.equal(parts[18].instrumentId, 'violin');
  assert.equal(parts[11].instrumentId, 'trumpet-bb', 'a part in bank 8 still names its registry instrument');
  assert.deepEqual(
    roll.tempoMap.map((e) => [e.beat, e.bpm]),
    fx.tempos.map((t) => [t.tick / FILE_PPQ, tempoOf(t.micros)]),
    'the tempo map: every FF 51 at its beat, at its own microseconds',
  );
  assert.deepEqual(
    roll.meterMap.map((s) => [s.bar, s.meter.num, s.meter.den, s.meter.groups.join('+')]),
    [[0, 4, 4, ''], [4, 3, 4, ''], [8, 7, 8, '2+2+3']],
    'the meter map with its groups',
  );
  assert.deepEqual(
    roll.markers.map((m) => [m.tick, m.name]),
    fx.markers.map((m) => [m.tick * 2, m.text]),
    'the markers',
  );
  console.log('  ok - the roll opens 24 parts, each on its program, bank and channel, with the tempo map, meter map and markers');
}

// =============================================================================
// 2b. EDIT's "Import as tracks"
// =============================================================================
useEditorStore.getState().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
const importStarted = performance.now();
const imported = await importMidiBytesAsTracks(fx.bytes.slice().buffer, 'orchestra', 0);
report.editImportMs = performance.now() - importStarted;
assert.ok(imported, 'the file lands as tracks');
{
  assert.equal(await imported.rendered, 0, 'every part plays live: nothing is queued to render');
  assert.equal(imported.parts.length, 24);
  assert.equal(new Set(ed().clips.map((c) => c.trackId)).size, 24, 'on 24 tracks of their own');
  fx.parts.forEach((f, k) => {
    const landed = imported.parts[k];
    const track = ed().tracks.find((t) => t.id === landed.trackId);
    const clip = ed().clips.find((c) => c.id === landed.clipId);
    assert.ok(track && clip);
    assert.equal(track.name, f.name);
    assert.equal(!!track.isPercussion, !!f.drums, `${f.name}: a drum track exactly when the part is percussion`);
    assert.equal(clip.instrumentProgram, f.program, `${f.name}: the clip plays its program`);
    assert.equal(clip.instrumentBank, f.drums || !f.bank ? undefined : f.bank, `${f.name}: in its bank`);
    assert.equal(clip.sourceRollPart?.bankLsb, f.drums ? undefined : f.bankLsb, `${f.name}: the part keeps its LSB`);
    assert.equal(clip.sourceRollPart?.channel, f.drums ? 10 : f.ch + 1, `${f.name}: the part keeps its channel`);
    assert.equal(landed.noteCount, f.notes.length);
    assert.deepEqual(ccKeys(clip.sourceRollPart?.controls), channelCcs(fx, f.ch, 2), `${f.name}: its channel's controllers`);
  });
  assert.deepEqual(
    ed().tempoMap.map((e) => [e.beat, e.bpm]),
    fx.tempos.map((t) => [t.tick / FILE_PPQ, tempoOf(t.micros)]),
    "EDIT takes the file's whole tempo map",
  );
  assert.deepEqual(
    ed().meterMap.map((s) => [s.bar, s.meter.num, s.meter.den, s.meter.groups.join('+')]),
    [[0, 4, 4, ''], [4, 3, 4, ''], [8, 7, 8, '2+2+3']],
    "EDIT takes the file's meter map with its groups",
  );
  const markers = ed().markers.map((m) => [m.label, m.t]);
  assert.equal(markers.length, 2, 'both markers on the timeline');
  fx.markers.forEach((m, i) => {
    assert.equal(markers[i][0], m.text);
    assert.ok(Math.abs((markers[i][1] as number) - fileSec(m.tick)) < 1e-9, `${m.text} at ${fileSec(m.tick)} s`);
  });
  console.log('  ok - "Import as tracks" puts 24 parts on 24 tracks with their programs, banks, channels, controllers, maps and markers');
}

// =============================================================================
// 3. The live scheduler on a fake audio clock
// =============================================================================

type Msg =
  | { k: 'on'; ch: number; midi: number; program: number; bank: number; vel: number; t: number; pass: number; tick: number; seq: number }
  | { k: 'off'; ch: number; midi: number; t: number; pass: number; tick: number; seq: number; cancel: boolean }
  /** liveMixer's editAllNotesOff after a pass stops: every voice ends now, and the synth's note ids start again. */
  | { k: 'stopAll'; t: number; pass: number; tick: number; seq: number };

interface Segment {
  pass: number;
  from: number;
  anchor: number;
  /** The scheduler's window end after its last tick (its cursor), in transport seconds. */
  until: number;
  /** Where the transport was when the pass stopped. */
  stopAt: number;
  end: number;
}

interface Expected { part: number; ch: number; midi: number; on: number; off: number; drums: boolean }

/** The song as the file says it sounds: every note's seconds from its ticks and the file's microseconds. */
function expectedNotes(f: Fixture, sec: (tick: number) => number, channelOfPart: (k: number) => number): Expected[] {
  const out: Expected[] = [];
  f.parts.forEach((p, k) => {
    for (const n of p.notes) out.push({ part: k, ch: channelOfPart(k), midi: n.midi, on: sec(n.tick), off: sec(n.tick + n.dur), drums: !!p.drums });
  });
  return out.sort((a, b) => a.on - b.on);
}

const QUANTUM = 128 / 48000;

/** liveMixer's transport around one EditMidiScheduler: a jittery 25 ms timer, a 60 Hz rAF loop that wraps the loop, and seeks. */
class Transport {
  real = 3.0;
  msgs: Msg[] = [];
  segments: Segment[] = [];
  pass = 0;
  tickIndex = 0;
  ticks = 0;
  tickCostMs = 0;
  private seq = 0;
  private stopping = false;
  private seed = 11;
  private nextTimer = 0;
  private nextFrame = 0;
  private seg: Segment | null = null;
  readonly sched: EditMidiScheduler;

  constructor(private readonly passPlan: EditMidiPass, private readonly totalSec: number) {
    this.sched = new EditMidiScheduler({
      now: () => this.now(),
      sink: {
        noteOn: (ch, program, midi, vel, t, bank) =>
          this.msgs.push({ k: 'on', ch, midi, program, bank, vel, t, pass: this.pass, tick: this.tickIndex, seq: this.seq++ }),
        noteOff: (ch, midi, t) =>
          this.msgs.push({ k: 'off', ch, midi, t, pass: this.pass, tick: this.tickIndex, seq: this.seq++, cancel: this.stopping }),
        wheel: () => {},
        wheelRange: () => {},
        control: () => {},
      },
      clips: () => ed().clips,
      tracks: () => ed().tracks,
      global: () => GLOBAL,
      projectBpm: () => ed().bpm,
    });
  }

  now(): number {
    return Math.floor(this.real / QUANTUM) * QUANTUM;
  }

  private rand(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
    return this.seed / 2147483648;
  }

  /** How late a timer callback runs: up to 20 ms, and a 60 ms stall about one tick in a hundred. */
  private lateBy(): number {
    return this.rand() < 0.01 ? 0.06 : this.rand() * 0.02;
  }

  /** Where the transport is now. */
  position(): number {
    const s = this.seg as Segment;
    return s.from + (this.now() - s.anchor);
  }

  private tickOnce(): void {
    const began = performance.now();
    this.sched.tick();
    this.tickCostMs += performance.now() - began;
    this.ticks += 1;
    const s = this.seg as Segment;
    s.until = Math.max(s.until, Math.min(this.position() + EDIT_MIDI_LOOKAHEAD_SEC, s.end));
    this.tickIndex += 1;
  }

  /** play() / a seek / a loop wrap: stop the pass, then start one from `fromSec` with the anchor where the audio starts. */
  start(fromSec: number, end: number): void {
    if (this.seg) this.stop();
    this.pass += 1;
    this.tickIndex = 0;
    this.sched.prepare(this.passPlan);
    const anchor = this.now();
    this.seg = { pass: this.pass, from: fromSec, anchor, until: fromSec, stopAt: fromSec, end };
    this.segments.push(this.seg);
    const began = performance.now();
    this.sched.start(this.passPlan, fromSec, anchor, () => end);
    this.tickCostMs += performance.now() - began;
    this.ticks += 1;
    this.seg.until = Math.max(fromSec, Math.min(fromSec + EDIT_MIDI_LOOKAHEAD_SEC, end));
    this.tickIndex = 1;
    // setInterval starts with the pass; rAF keeps its own phase.
    this.nextTimer = this.real + EDIT_MIDI_TICK_MS / 1000;
    if (this.nextFrame < this.real) this.nextFrame = this.real + 1 / 60;
  }

  /** liveMixer clearMidiTimers: the scheduler stops, then editAllNotesOff silences EDIT's synths. */
  stop(): void {
    const s = this.seg as Segment;
    s.stopAt = this.position();
    this.stopping = true;
    this.sched.stop();
    this.stopping = false;
    this.msgs.push({ k: 'stopAll', t: this.now(), pass: this.pass, tick: this.tickIndex, seq: this.seq++ });
    this.seg = null;
  }

  /** Run for `forSec` of real time (to the song's end when left out), wrapping at `loop.end` back to `loop.start` `loop.wraps` times. */
  run(opts: { forSec?: number; loop?: { start: number; end: number; wraps: number } }): void {
    const realEnd = opts.forSec !== undefined ? this.real + opts.forSec : Infinity;
    let wraps = 0;
    for (;;) {
      if (!this.seg) return;
      const timerAt = this.nextTimer;
      if (timerAt <= this.nextFrame) {
        // A timer callback runs late; the next one is due on the interval's own grid.
        this.real = Math.max(this.real, timerAt + this.lateBy());
        this.nextTimer = timerAt + EDIT_MIDI_TICK_MS / 1000;
        if (this.real >= realEnd) return;
        this.tickOnce();
      } else {
        this.real = Math.max(this.real, this.nextFrame);
        this.nextFrame += 1 / 60;
        if (this.real >= realEnd) return;
        const elapsed = this.position();
        const loop = opts.loop;
        if (loop && wraps < loop.wraps && elapsed >= loop.end) {
          // liveMixer tick(): past the loop's end, start(loopStart); start() awaits a little before its anchor.
          wraps += 1;
          this.stop();
          this.real += 0.004;
          this.start(loop.start, wraps < loop.wraps ? loop.end : this.totalSec);
          continue;
        }
        if (elapsed >= this.totalSec) {
          this.stop();
          return;
        }
      }
    }
  }
}

interface SegmentCheck {
  onsets: number;
  chased: number;
  cancelled: number;
  drifts: number[];
}

/**
 * One pass against the song: every note the transport reached in [from, stop)
 * is struck exactly once at its context time, every note handed over past the
 * stop is cancelled at its own time, a note sounding at `from` is chased once
 * (a melodic part) and nothing else is struck.
 */
function checkSegment(tr: Transport, seg: Segment, expected: readonly Expected[], programOf: (ch: number) => { program: number; bank: number }): SegmentCheck {
  const EPS = 1e-9;
  const ons = tr.msgs.filter((m): m is Extract<Msg, { k: 'on' }> => m.k === 'on' && m.pass === seg.pass);
  const cancelsHere = tr.msgs.filter((m): m is Extract<Msg, { k: 'off' }> => m.k === 'off' && m.cancel && m.pass === seg.pass);
  const ctxOf = (sec: number) => seg.anchor + (sec - seg.from);
  // Chases: the melodic notes sounding where the pass starts, struck at the anchor on its first tick.
  const chaseWanted = expected.filter((n) => !n.drums && n.on < seg.from - EPS && n.off > seg.from + EPS);
  const chased = new Set<Msg>();
  for (const n of chaseWanted) {
    const hit = ons.find((m) => !chased.has(m) && m.tick === 0 && m.ch === n.ch && m.midi === n.midi && Math.abs(m.t - Math.max(seg.anchor, ctxOf(seg.from))) < 1e-9);
    assert.ok(hit, `pass ${seg.pass}: the note ${n.midi} sounding at ${seg.from} s is chased`);
    chased.add(hit);
  }
  const struck = ons.filter((m) => !chased.has(m));
  const wanted = expected.filter((n) => n.on >= seg.from - EPS && n.on < seg.until - EPS);
  const key = (ch: number, midi: number) => `${ch}:${midi}`;
  const byKeyWanted = new Map<string, Expected[]>();
  for (const n of wanted) byKeyWanted.set(key(n.ch, n.midi), [...(byKeyWanted.get(key(n.ch, n.midi)) ?? []), n]);
  const byKeyStruck = new Map<string, Array<Extract<Msg, { k: 'on' }>>>();
  for (const m of struck) byKeyStruck.set(key(m.ch, m.midi), [...(byKeyStruck.get(key(m.ch, m.midi)) ?? []), m]);
  assert.equal(struck.length, wanted.length, `pass ${seg.pass} from ${seg.from} s: ${struck.length} notes struck, ${wanted.length} due before ${seg.until.toFixed(3)} s`);
  const drifts: number[] = [];
  let cancelled = 0;
  for (const [k, list] of byKeyWanted) {
    const got = (byKeyStruck.get(k) ?? []).sort((a, b) => a.t - b.t);
    list.sort((a, b) => a.on - b.on);
    assert.equal(got.length, list.length, `pass ${seg.pass}: key ${k} struck ${got.length} times for ${list.length} notes`);
    list.forEach((n, i) => {
      const m = got[i];
      drifts.push(Math.abs(m.t - ctxOf(n.on)));
      const voice = programOf(m.ch);
      assert.equal(m.program, voice.program, `channel ${m.ch} plays program ${voice.program}`);
      assert.equal(m.bank, voice.bank, `channel ${m.ch} selects bank ${voice.bank}`);
      if (n.on >= seg.stopAt + EPS) {
        // Handed over but past the stop: cancelled by a note-off at its own time.
        assert.ok(cancelsHere.some((c) => c.ch === m.ch && c.midi === m.midi && c.t === m.t), `pass ${seg.pass}: a queued note past the stop is cancelled`);
        cancelled += 1;
      }
    });
  }
  return { onsets: struck.length, chased: chased.size, cancelled, drifts };
}

/**
 * The synth's side of a whole session, as SpessaSynth's queue plays it: every
 * timed message in time order (a stable sort, so messages at one time keep the
 * order they were sent in), a note-off ending the OLDEST sounding note-on of
 * its channel and key (SpessaSynth pairs them by note id), and stopAll ending
 * every voice and starting the note ids again while the queue keeps what it
 * holds. Where each pass stops, the voices still sounding on each key must be
 * exactly the notes of that pass sounding there: a voice more is a note left
 * hanging, a voice fewer is a note cut short.
 */
function checkVoices(tr: Transport, expected: readonly Expected[]): { hanging: number; cut: number } {
  const events = [...tr.msgs].sort((a, b) => a.t - b.t || a.seq - b.seq);
  const sounding = new Map<string, number>();
  let hanging = 0;
  let cut = 0;
  for (const e of events) {
    if (e.k === 'on') sounding.set(`${e.ch}:${e.midi}`, (sounding.get(`${e.ch}:${e.midi}`) ?? 0) + 1);
    else if (e.k === 'off') {
      const k = `${e.ch}:${e.midi}`;
      const n = sounding.get(k) ?? 0;
      if (n > 0) sounding.set(k, n - 1);
    } else {
      const seg = tr.segments.find((s) => s.pass === e.pass) as Segment;
      const pos = seg.stopAt;
      const want = new Map<string, number>();
      for (const n of expected) {
        // Sounding at the stop: struck in this pass before its window closed (or chased at its start), and not over.
        if (n.off <= pos + 1e-9 || n.on >= Math.min(pos, seg.until) - 1e-9 || n.off <= seg.from + 1e-9) continue;
        if (n.on < seg.from - 1e-9 && n.drums) continue;
        want.set(`${n.ch}:${n.midi}`, (want.get(`${n.ch}:${n.midi}`) ?? 0) + 1);
      }
      for (const k of new Set([...sounding.keys(), ...want.keys()])) {
        const have = sounding.get(k) ?? 0;
        // A key struck again while held ends the held note first (EditMidiScheduler pushOn), so one voice a key.
        const need = Math.min(1, want.get(k) ?? 0);
        if (have > need) hanging += have - need;
        if (have < need) cut += need - have;
      }
      sounding.clear();
    }
  }
  return { hanging, cut };
}

function schedulePlan() {
  const plan = planLiveMidi(ed().clips, ed().tracks, GLOBAL);
  const pass: EditMidiPass = { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf };
  return { plan, pass };
}

const { plan, pass: livePass } = schedulePlan();
{
  assert.equal(plan.liveClipIds.size, 24, 'all 24 clips play live');
  assert.deepEqual(plan.channels.dropped, [], 'no track is past the last live channel');
  const chans = [...plan.channels.channelsOf.values()].map((c) => c[0]);
  assert.equal(new Set(chans).size, 24, 'each part on a live channel of its own');
}
const trackIdOfPart = (k: number) => (imported as NonNullable<typeof imported>).parts[k].trackId;
const liveChannelOfPart = (k: number) => (plan.channels.channelsOf.get(trackIdOfPart(k)) as number[])[0];
const voiceOfChannel = new Map<number, { program: number; bank: number }>();
fx.parts.forEach((p, k) => voiceOfChannel.set(liveChannelOfPart(k), { program: p.program, bank: p.drums ? 0 : (p.bank ?? 0) }));
const voiceOf = (ch: number) => voiceOfChannel.get(ch) as { program: number; bank: number };
fx.parts.forEach((p, k) => {
  if (p.drums) assert.equal(liveChannelOfPart(k) % 16, 9, 'the percussion part is on a drum channel');
  else assert.notEqual(liveChannelOfPart(k) % 16, 9, `${p.name} is never on a drum channel`);
});
const songSec = fileSec(fx.endTick);
const expected = expectedNotes(fx, fileSec, liveChannelOfPart);

const summarize = (drifts: number[]) => ({
  maxMs: drifts.reduce((m, d) => Math.max(m, d), 0) * 1000,
  meanMs: (drifts.reduce((a, b) => a + b, 0) / Math.max(1, drifts.length)) * 1000,
});

{
  // A whole pass from the top.
  const whole = new Transport(livePass, songSec);
  whole.start(0, songSec);
  whole.run({});
  assert.equal(whole.segments.length, 1);
  const r = checkSegment(whole, whole.segments[0], expected, voiceOf);
  assert.equal(r.onsets, fx.noteCount, `every note of the file is struck once (${r.onsets} of ${fx.noteCount})`);
  assert.equal(whole.sched.stats.late + whole.sched.stats.skipped, 0, 'no tick fell behind the clock');
  assert.deepEqual(checkVoices(whole, expected), { hanging: 0, cut: 0 }, 'no voice hangs or is cut');
  const d = summarize(r.drifts);
  report.wholePass = { notes: r.onsets, ticks: whole.ticks, maxDriftMs: d.maxMs, meanDriftMs: d.meanMs, tickCostMsTotal: whole.tickCostMs, songSec };
  report.schedulePassMs = whole.tickCostMs;
  assert.ok(d.maxMs < EDIT_MIDI_TICK_MS, `max drift ${d.maxMs} ms is under one scheduler tick (${EDIT_MIDI_TICK_MS} ms)`);
  console.log(`  ok - a whole pass: ${r.onsets} notes over ${songSec.toFixed(2)} s in ${whole.ticks} ticks, drift max ${d.maxMs.toExponential(3)} ms, mean ${d.meanMs.toExponential(3)} ms`);
}

{
  // A loop from bar 5 (the 3/4 at 120) to bar 9 (the 7/8), wrapped three times, entered from 8 s.
  const loopStart = fileSec(fx.bars[4].tick);
  const loopEnd = fileSec(fx.bars[8].tick);
  const looped = new Transport(livePass, songSec);
  looped.start(8, loopEnd);
  looped.run({ loop: { start: loopStart, end: loopEnd, wraps: 3 } });
  assert.equal(looped.segments.length, 4, 'the first pass and three wraps');
  const all: number[] = [];
  let struck = 0;
  looped.segments.forEach((seg, i) => {
    const r = checkSegment(looped, seg, expected, voiceOf);
    struck += r.onsets;
    all.push(...r.drifts);
    if (i < 3) {
      assert.ok(seg.until <= loopEnd + 1e-12, 'nothing is handed over at or past the loop end');
      const due = expected.filter((n) => n.on >= seg.from - 1e-9 && n.on < loopEnd - 1e-9).length;
      assert.equal(r.onsets, due, `pass ${seg.pass}: every note of the loop, once (${r.onsets} of ${due})`);
    }
  });
  assert.equal(looped.sched.stats.late + looped.sched.stats.skipped, 0);
  assert.deepEqual(checkVoices(looped, expected), { hanging: 0, cut: 0 }, 'no voice hangs or is cut across the wraps');
  const d = summarize(all);
  report.loop = { loopStart, loopEnd, wraps: 3, notes: struck, maxDriftMs: d.maxMs, meanDriftMs: d.meanMs };
  assert.ok(d.maxMs < EDIT_MIDI_TICK_MS);
  console.log(`  ok - a loop ${loopStart}-${loopEnd} s wrapped three times: ${struck} notes, none dropped or doubled, drift max ${d.maxMs.toExponential(3)} ms`);
}

{
  // Seeks, each made while note-ons are still queued ahead of the clock: play
  // from 20 s, seek back into held notes at 12.37 s, seek to where the playhead
  // already is (the cancelled note-ons are the very notes the new pass strikes),
  // then forward to 25 s and on to the end.
  const seeking = new Transport(livePass, songSec);
  const justBefore = (sec: number) => (expected.find((n) => n.on > sec) as Expected).on - 0.05;
  seeking.start(20, songSec);
  seeking.run({ forSec: justBefore(21) - 20 });
  seeking.start(12.37, songSec);
  seeking.run({ forSec: justBefore(14.2) - 12.37 });
  seeking.start(seeking.position(), songSec);
  seeking.run({ forSec: 1.2 });
  seeking.start(25, songSec);
  seeking.run({});
  assert.equal(seeking.segments.length, 4);
  const all: number[] = [];
  let chased = 0;
  let cancelled = 0;
  let struck = 0;
  for (const seg of seeking.segments) {
    const r = checkSegment(seeking, seg, expected, voiceOf);
    all.push(...r.drifts);
    chased += r.chased;
    cancelled += r.cancelled;
    struck += r.onsets;
  }
  assert.ok(chased > 0, 'the seek into held notes chases them');
  assert.ok(cancelled > 0, 'a seek cancels the note-ons still queued');
  assert.equal(seeking.sched.stats.late + seeking.sched.stats.skipped, 0);
  const voices = checkVoices(seeking, expected);
  assert.deepEqual(voices, { hanging: 0, cut: 0 }, 'no voice hangs or is cut across the seeks');
  const d = summarize(all);
  report.seek = { notes: struck, chased, cancelled, maxDriftMs: d.maxMs, meanDriftMs: d.meanMs };
  assert.ok(d.maxMs < EDIT_MIDI_TICK_MS);
  console.log(`  ok - three seeks: ${struck} notes, ${chased} chased, ${cancelled} cancelled, no voice left hanging, drift max ${d.maxMs.toExponential(3)} ms`);
}

// =============================================================================
// 4. Export at 960 PPQ and read back
// =============================================================================

/** The value a General MIDI channel starts at for each controller a part keeps. */
const GM_DEFAULT: Record<number, number> = { 1: 0, 7: 100, 10: 64, 11: 127, 64: 0 };

async function exportBytes(): Promise<{ bytes: Uint8Array; ms: number; shared: string[] }> {
  let captured: Blob | null = null;
  const began = performance.now();
  const outcome = await exportArrangementMidi({ name: 'orchestra' }, {
    global: GLOBAL,
    save: async (blob) => {
      captured = blob;
      return { path: 'memory://orchestra.mid', cancelled: false, downloaded: false };
    },
  });
  const ms = performance.now() - began;
  assert.ok(outcome.ok, `the export writes the file (${outcome.error ?? ''})`);
  assert.ok(captured);
  return { bytes: new Uint8Array(await (captured as Blob).arrayBuffer()), ms, shared: outcome.result.sharedTracks };
}

{
  const out = await exportBytes();
  report.exportMs = out.ms;
  const back = parseMidi(out.bytes);
  assert.equal(back.ppq, ROLL_PPQ, 'written at 960 PPQ');
  assert.equal(back.tracks.length, 24, 'one track per part');
  const failures: string[] = [];
  fx.parts.forEach((f, k) => {
    const t = back.tracks[k];
    assert.equal(t.name, f.name);
    // Notes: tick-exact on the 960 clock.
    const got = t.notes.map((n) => `${n.tick}:${n.durationTicks}:${n.note}:${n.velocity}`).sort();
    const want = f.notes.map((n) => `${n.tick * 2}:${n.dur * 2}:${n.midi}:${n.vel}`).sort();
    assert.deepEqual(got, want, `${f.name}: every note tick-exact`);
    const channel = f.drums ? 9 : f.ch;
    const noteChannels = [...new Set(t.notes.map((n) => n.channel))];
    if (noteChannels.length !== 1 || noteChannels[0] !== channel) failures.push(`${f.name}: channel ${f.ch + 1} came back as ${noteChannels.map((c) => c + 1).join(',')}`);
    const p = t.programs?.[0];
    assert.equal(p?.program, f.program, `${f.name}: program`);
    assert.equal(p?.bank, f.drums || !f.bank ? undefined : f.bank, `${f.name}: bank MSB`);
    assert.equal(p?.bankLsb, f.drums ? undefined : f.bankLsb, `${f.name}: bank LSB`);
    // Controllers: the channel's, tick-exact, plus the resets to the General MIDI default where the clip ends.
    const endTick = fx.endTick * 2;
    const wantCc = channelCcs(fx, f.ch, 2);
    const gotCc = ccKeys(t.controls?.map((c) => ({ tick: c.tick, controller: c.controller, value: c.value })));
    const extra = gotCc.filter((c) => !wantCc.includes(c));
    const missing = wantCc.filter((c) => !gotCc.includes(c));
    if (missing.length) failures.push(`${f.name}: controller changes lost ${missing.slice(0, 3).join(' ')}`);
    const badExtra = extra.filter((c) => Number(c.split(':')[0]) !== endTick || GM_DEFAULT[Number(c.split(':')[1])] !== Number(c.split(':')[2]));
    if (badExtra.length) failures.push(`${f.name}: controller changes added ${badExtra.slice(0, 3).join(' ')}`);
  });
  const reread = parseMidi(out.bytes);
  const again = importMidiParts(reread, 'rt');
  assert.equal(again.parts, 24);
  const partsBack = rollTracksOf(usePianoRollStore.getState());
  fx.parts.forEach((f, k) => {
    const p = partsBack[k];
    if (p.channel !== (f.drums ? 10 : f.ch + 1)) failures.push(`${f.name}: the reimported part is on channel ${p.channel}, not ${f.ch + 1}`);
    assert.equal(p.program, f.program);
    assert.equal(p.bank, f.drums ? 0 : (f.bank ?? 0));
    assert.equal(p.bankLsb, f.drums ? undefined : f.bankLsb);
    assert.equal(isPercussionPart(p), !!f.drums);
    // The reimported part's controllers: its channel's, and the General MIDI defaults where the clip ends.
    const wantCc = channelCcs(fx, f.ch, 2);
    const gotCc = ccKeys(p.controls);
    const lost = wantCc.filter((c) => !gotCc.includes(c));
    const added = gotCc.filter((c) => !wantCc.includes(c) && (Number(c.split(':')[0]) !== fx.endTick * 2 || GM_DEFAULT[Number(c.split(':')[1])] !== Number(c.split(':')[2])));
    if (lost.length || added.length) failures.push(`${f.name}: reimported controllers lost ${lost.slice(0, 3).join(' ')} added ${added.slice(0, 3).join(' ')}`);
  });
  assert.deepEqual(
    (back.tempos ?? []).map((t) => [t.tick / ROLL_PPQ, Math.round(60_000_000 / t.bpm)]),
    fx.tempos.map((t) => [t.tick / FILE_PPQ, t.micros]),
    'every tempo at its beat, at its own microseconds',
  );
  assert.deepEqual(
    usePianoRollStore.getState().tempoMap.map((e) => [e.beat, e.bpm]),
    fx.tempos.map((t) => [t.tick / FILE_PPQ, tempoOf(t.micros)]),
    'the tempo map reads back',
  );
  assert.deepEqual(
    (back.timeSignatures ?? []).map((s) => [s.tick, s.num, s.den, (s.groups ?? []).join('+')]),
    fx.signatures.map((s) => [s.tick * 2, s.num, s.den, s.groups.join('+')]),
    'every time signature with its groups',
  );
  assert.deepEqual(
    usePianoRollStore.getState().meterMap.map((s) => [s.bar, s.meter.num, s.meter.den, s.meter.groups.join('+')]),
    [[0, 4, 4, ''], [4, 3, 4, ''], [8, 7, 8, '2+2+3']],
  );
  assert.deepEqual((back.markers ?? []).map((m) => [m.tick, m.text]), fx.markers.map((m) => [m.tick * 2, m.text]), 'the markers, at their ticks');
  report.exportSharedTracks = out.shared;
  assert.deepEqual(failures, [], `the round trip keeps channels and controllers:\n  ${failures.join('\n  ')}`);
  console.log('  ok - the export at 960 PPQ reads back tick-exact with programs, banks, channels, controllers, tempo map, meter map and markers');
}

// =============================================================================
// 6. Performance: the 24-part file and a 100,000-note version
// =============================================================================
{
  const big = buildFixture(22, true);
  assert.ok(big.noteCount >= 100_000, `the big file holds ${big.noteCount} notes`);
  const bigSec = fileClock(big);

  useEditorStore.getState().loadProject({ tracks: [], clips: [] });
  let began = performance.now();
  const rolled = importMidiParts(parseMidi(big.bytes), 'big');
  const rollMs = performance.now() - began;
  assert.equal(rolled.notes, big.noteCount);

  useEditorStore.getState().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
  began = performance.now();
  const landed = await importMidiBytesAsTracks(big.bytes.slice().buffer, 'big orchestra', 0);
  const editMs = performance.now() - began;
  assert.ok(landed);
  assert.equal(landed.noteCount, big.noteCount);

  const { pass: bigPass } = schedulePlan();
  const chOf = (k: number) => (bigPass.channelsOf.get(landed.parts[k].trackId) as number[])[0];
  const want = expectedNotes(big, bigSec, chOf);
  const total = bigSec(big.endTick);
  const tr = new Transport(bigPass, total);
  began = performance.now();
  tr.start(0, total);
  tr.run({});
  const passWallMs = performance.now() - began;
  const bigVoices = new Map<number, { program: number; bank: number }>();
  big.parts.forEach((p, k) => bigVoices.set(chOf(k), { program: p.program, bank: p.drums ? 0 : (p.bank ?? 0) }));
  const r = checkSegment(tr, tr.segments[0], want, (ch) => bigVoices.get(ch) as { program: number; bank: number });
  assert.deepEqual(checkVoices(tr, want), { hanging: 0, cut: 0 });
  assert.equal(r.onsets, big.noteCount);
  const d = summarize(r.drifts);
  assert.ok(d.maxMs < EDIT_MIDI_TICK_MS);

  const out = await exportBytes();
  began = performance.now();
  const back = parseMidi(out.bytes);
  const reparseMs = performance.now() - began;
  assert.equal(back.tracks.reduce((n, t) => n + t.notes.length, 0), big.noteCount, 'the export holds every note');
  report.big = {
    notes: big.noteCount,
    songSec: total,
    rollImportMs: rollMs,
    editImportMs: editMs,
    scheduleTicks: tr.ticks,
    scheduleTickCostMs: tr.tickCostMs,
    scheduleWallMs: passWallMs,
    maxDriftMs: d.maxMs,
    meanDriftMs: d.meanMs,
    exportMs: out.ms,
    reparseMs,
  };
}

report.tickMs = EDIT_MIDI_TICK_MS;
report.lookaheadSec = EDIT_MIDI_LOOKAHEAD_SEC;
report.lateSec = EDIT_MIDI_LATE_SEC;
console.log(`  report ${JSON.stringify(report)}`);
console.log('midiStage3.e2e: ok');
