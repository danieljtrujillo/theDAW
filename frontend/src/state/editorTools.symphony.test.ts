/**
 * The "Symphony orchestra" template (editorTools createSymphonyTemplate,
 * lib/symphonyTemplate), replayed against the real editor store: the tracks,
 * their programs, seats and buses, the shared hall, the synth reverb send, the
 * undo step, and what the live synth and the MIDI export get from it.
 *
 *   cd frontend && npx tsx src/state/editorTools.symphony.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore, type AudioClip } from './editorStore.ts';
import * as tools from './editorTools.ts';
import { CONN_OUTPUT, CONN_SEND, MASTER_ID } from './routingGraph.ts';
import { orchestraInstrument } from '../lib/orchestra.ts';
import { HALL_REVERB_PARAMS, SECTION_BUSES, symphonyTracks } from '../lib/symphonyTemplate.ts';
import { hallIrUrl, hallIrUrlsInChains } from '../lib/hallIrs.ts';
import { arrangementToMidiFile } from '../lib/arrangementMidi.ts';
import { EditMidiScheduler } from '../lib/editMidiScheduler.ts';
import { planLiveMidi } from './liveMixer.ts';

const ed = () => useEditorStore.getState();
const GLOBAL = { useSoundfont: true, activeProgram: 0 };

const outputOf = (id: string): string | undefined =>
  ed().routing.edges.find((e) => e.from === id && e.connType === CONN_OUTPUT)?.to;
const sendsOf = (id: string) => ed().routing.edges.filter((e) => e.from === id && e.connType === CONN_SEND);
const busNamed = (name: string) => ed().buses.find((b) => b.name === name)!;
const trackNamed = (name: string) => ed().tracks.find((t) => t.name === name)!;

// ── 1. American seating: every section on its program, seat and bus ─────────
{
  ed().loadProject({ tracks: [], clips: [] });
  const before = ed().tracks.length;
  const r = tools.createSymphonyTemplate({});
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.match(r.message, /16 section tracks on 5 section buses/);

  const folder = ed().tracks[before];
  assert.equal(folder.isFolder, true, 'a folder holds the orchestra');
  const sections = ed().tracks.filter((t) => t.parentTrackId === folder.id);
  assert.deepEqual(sections.map((t) => t.name), symphonyTracks('american').map((t) => t.name), 'in score order');

  for (const plan of symphonyTracks('american')) {
    const t = trackNamed(plan.name);
    const inst = orchestraInstrument(plan.instrumentId)!;
    assert.equal(t.instrumentProgram, inst.program, `${plan.name} plays the registry's program`);
    assert.equal(t.synthReverbSend, 0, `${plan.name}: the synth's reverb is off`);
    assert.equal(t.pan, plan.pan);
    const bus = ed().buses.find((b) => b.id === outputOf(t.id));
    assert.equal(bus?.name, SECTION_BUSES.find((b) => b.id === plan.section)!.name, `${plan.name} feeds its section bus`);
  }
  const perc = trackNamed('Percussion');
  assert.equal(perc.isPercussion, true, 'the percussion track is on the drum channel');
  assert.equal(perc.instrumentProgram, 48, 'on the Orchestral kit');

  // Where the listener hears them: the strings on the left, the low strings right.
  assert.ok(trackNamed('Violin I').pan < 0 && trackNamed('Violin II').pan < 0, 'both violin sections on the left');
  assert.ok(trackNamed('Violoncello').pan > 0 && trackNamed('Contrabass').pan > 0, 'cellos and basses on the right');

  // The hall: one bus, the Konzerthaus Reverb fully wet, fed by every section bus.
  const hall = busNamed('Hall');
  assert.equal(outputOf(hall.id), MASTER_ID, 'the hall returns to the master');
  assert.equal(hall.fxChain.length, 1);
  const verb = hall.fxChain[0];
  assert.equal(verb.effect, 'reverb');
  assert.equal(verb.params.hall, HALL_REVERB_PARAMS.hall);
  assert.equal(verb.params.wet, 1, 'a send return is the hall only');
  assert.deepEqual(hallIrUrlsInChains(ed().buses.map((b) => b.fxChain)), [hallIrUrl(1, 0)], 'a bounce loads the hall response');

  // Depth: a section further back is lower on its fader and sends more to the hall.
  const strings = busNamed('Strings');
  const brass = busNamed('Brass');
  for (const b of SECTION_BUSES) {
    const id = busNamed(b.name).id;
    assert.equal(outputOf(id), MASTER_ID, `${b.name} plays dry to the master`);
    assert.deepEqual(sendsOf(id).map((e) => [e.to, e.gain]), [[hall.id, b.hallSend]], `${b.name} sends to the hall`);
  }
  assert.ok(brass.volume < strings.volume, 'the brass sit further back than the strings');
  assert.ok(sendsOf(brass.id)[0].gain > sendsOf(strings.id)[0].gain, 'and are heard more through the hall');

  // One undo step takes the whole template away.
  ed().undo();
  assert.equal(ed().tracks.length, before, 'undo removes every track');
  assert.equal(ed().buses.length, 0, 'and every bus');
}

// ── 2. European seating: the violins face each other ────────────────────────
{
  ed().loadProject({ tracks: [], clips: [] });
  const r = tools.createSymphonyTemplate({ seating: 'european' });
  assert.ok(r.ok);
  assert.ok(trackNamed('Violin I').pan < 0 && trackNamed('Violin II').pan > 0, 'first violins left, seconds right');
  assert.ok(trackNamed('Contrabass').pan < 0, 'basses on the left');
  assert.match(ed().tracks.find((t) => t.isFolder)!.name, /European seating/);
  const bad = tools.createSymphonyTemplate({ seating: 'theatre' });
  assert.equal(bad.ok, false, 'an unknown seating is refused');
}

// ── 3. What the synth and the export get: CC 91 at 0 on every section ───────
{
  ed().loadProject({ tracks: [], clips: [] });
  tools.createSymphonyTemplate({});
  const vn = trackNamed('Violin I');
  const tpt = trackNamed('Trumpet');
  const base: Omit<AudioClip, 'id' | 'trackId'> = {
    label: 'part',
    audioBlob: new Blob([], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 8,
    offsetIntoSource: 0,
    durationSec: 2,
    startSec: 0,
    color: '#fff',
    sourceKind: 'piano-roll',
    sourceBpm: 120,
    sourceTotalSteps: 16,
  };
  ed().addClipToTrack({ ...base, trackId: vn.id, sourcePianoRoll: [{ id: 'a', note: 67, step: 0, length: 4, velocity: 90 }] as AudioClip['sourcePianoRoll'] });
  ed().addClipToTrack({ ...base, trackId: tpt.id, sourcePianoRoll: [{ id: 'b', note: 60, step: 0, length: 4, velocity: 90 }] as AudioClip['sourcePianoRoll'] });

  const file = arrangementToMidiFile({ bpm: 120, tracks: ed().tracks, clips: ed().clips }).file;
  for (const t of file.tracks.filter((x) => x.notes.length)) {
    const ch = t.notes[0].channel;
    assert.deepEqual(
      (t.controls ?? []).filter((c) => c.controller === 91).map((c) => [c.tick, c.channel, c.value]),
      [[0, ch, 0]],
      `${t.name}: CC 91 at 0 from the start in the export`,
    );
  }

  const plan = planLiveMidi(ed().clips, ed().tracks, GLOBAL);
  const sent: Array<[number, number, number]> = [];
  const clock = { t: 10 };
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: () => {},
      noteOff: () => {},
      wheel: () => {},
      wheelRange: () => {},
      control: (ch, controller, value) => sent.push([ch, controller, value]),
    },
    clips: () => ed().clips,
    tracks: () => ed().tracks,
    global: () => GLOBAL,
    projectBpm: () => 120,
  });
  sched.start({ liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf }, 0, clock.t);
  clock.t += 0.05;
  sched.tick();
  sched.stop();
  for (const id of [vn.id, tpt.id]) {
    for (const ch of plan.channels.channelsOf.get(id) ?? []) {
      assert.deepEqual(sent.filter(([c, cc]) => c === ch && cc === 91).map(([, , v]) => v), [0], 'live: CC 91 at 0 when the pass opens');
    }
  }
  assert.ok((plan.channels.channelsOf.get(vn.id) ?? []).length > 0, 'the violins play live');
}

console.log('editorTools.symphony: ok');
