/**
 * An articulation past fifteen melodic channels (stage 4 follow-up): a file
 * has sixteen channels, and a preset articulation (a pizzicato's GM 46)
 * needs one of its own. With none left its notes play on their part's
 * channel in the part's program, and the export says so in the LOG and in
 * its result.
 *
 * The sequence: fifteen string tracks, each with an arco note and a
 * pizzicato. The arrangement export gives each track its channel and has
 * none left for the pizzicatos: every track is named in
 * `articulationFallback`, no channel plays GM 46, the pizzicato notes sit on
 * their tracks' channels and still read back as pizzicato, the LOG carries a
 * warning and the saved export's message names them. The roll's export of
 * fifteen parts reports the same parts; a roll of two parts reports none.
 *
 *   cd frontend && npx tsx src/lib/articulationFallback.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore, type AudioClip, type EditorTrack } from '../state/editorStore.ts';
import { useLogStore } from '../state/logStore.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';
import { exportArrangementMidi } from './arrangementMidiApp.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { partLaneChannels } from './rollMidi.ts';
import { makeRollTrack } from './rollTracks.ts';
import { DEFAULT_LANES, migrateNotes, type PianoNote } from '../state/pianoRollStore.ts';
import type { PolyLane } from './meterMap.ts';

const line = (): PianoNote[] =>
  migrateNotes([
    { id: 'a', note: 67, step: 0, length: 4, velocity: 90 },
    { id: 'p', note: 69, step: 4, length: 4, velocity: 90, articulation: 'pizzicato' },
  ]);
const N = 15;
const tracks = Array.from({ length: N }, (_, i) => ({ id: `t${i}`, name: `Strings ${i + 1}`, color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, fxChain: [], instrumentProgram: 40 }) as unknown as EditorTrack);
const clips = tracks.map(
  (t, i) =>
    ({
      id: `c${i}`,
      trackId: t.id,
      label: t.name,
      mimeType: 'audio/wav',
      sourceDuration: 2,
      offsetIntoSource: 0,
      durationSec: 2,
      startSec: 0,
      color: '#fff',
      sourceKind: 'piano-roll',
      sourcePianoRoll: line(),
      sourceBpm: 120,
      sourceTotalSteps: 16,
      sourceRollPart: { doc: 'd', id: `p${i}`, order: i, name: t.name, program: 40, bank: 0, channel: null, color: '#fff', mute: false, solo: false, instrumentId: 'violin' },
    }) as unknown as AudioClip,
);

// ── The arrangement ─────────────────────────────────────────────────────────
{
  const out = arrangementToMidiFile({ tracks, clips, bpm: 120 });
  assert.equal(out.articulationFallback.length, N, 'every track is named');
  assert.ok(!out.file.tracks.flatMap((t) => t.programs ?? []).some((p) => p.program === 45), 'no channel plays GM 46: none was left');
  for (const t of out.file.tracks) {
    const [arco, pizz] = t.notes;
    assert.equal(pizz.channel, arco.channel, 'the pizzicato plays on its track’s channel');
  }
  const back = parseMidi(encodeMidi(out.file));
  assert.ok(back.tracks.every((t) => t.notes[1].articulation === 'pizzicato'), 'and still reads back as pizzicato');

  // Two tracks: room for both, nothing reported.
  const two = arrangementToMidiFile({ tracks: tracks.slice(0, 2), clips: clips.slice(0, 2), bpm: 120 });
  assert.deepEqual(two.articulationFallback, []);
}

// ── The saved export: a LOG warning, and the message says so ────────────────
{
  useEditorStore.getState().loadProject({ tracks, clips, bpm: 120 } as never);
  useLogStore.getState().clear();
  const outcome = await exportArrangementMidi(
    { name: 'strings' },
    { global: { useSoundfont: true, activeProgram: 0 }, save: async () => ({ path: 'memory://strings.mid', cancelled: false, downloaded: false }) },
  );
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.error);
  assert.match(outcome.message, /the articulations of Strings 1, .*Strings 15 play in their track's program/);
  const warn = useLogStore.getState().entries.find((e) => e.level === 'warn' && /No MIDI channel was left for the articulations/.test(e.msg));
  assert.ok(warn, 'a LOG warning names them');
  assert.match(warn.msg, /Strings 15/);
}

// ── The roll's export of fifteen parts ──────────────────────────────────────
{
  const parts = Array.from({ length: N }, (_, i) => makeRollTrack({ id: `r${i}`, name: `Violin ${i + 1}`, program: 40, instrumentId: 'violin', notes: line() }, i));
  const lanes = [...DEFAULT_LANES] as PolyLane[];
  const plan = partLaneChannels({ lanes, bends: [] }, parts);
  assert.equal(plan.articulationFallback.length, N, 'no channel left once fifteen parts have theirs');
  assert.deepEqual(partLaneChannels({ lanes, bends: [] }, parts.slice(0, 2)).articulationFallback, [], 'two parts: room for both');
}

console.log('articulationFallback: ok');
