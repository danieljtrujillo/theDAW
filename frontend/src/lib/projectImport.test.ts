// The .tasmo mapping projectImport.ts uses for piano-roll clips. These mappers
// live in projectClient.ts alongside the rest of the .tasmo types; projectImport.ts
// itself loads fine under node (see projectImport.routing.test.ts, which drives it).
import assert from 'node:assert/strict';
import { clipMeterToTasmo, pianoNoteToTasmo, tasmoMeterToClip, tasmoNotesToPiano } from './projectClient.ts';
import {
  applyTasmoMarkersAndLoop,
  applyTasmoMasterAndAutomation,
  automationLanesToTasmo,
  automationTargetResolver,
  captureEditorSession,
  captureProjectDocument,
  chainEntryToTasmo,
  loadProjectIntoEditor,
  locatorsToMarkers,
  loopToTasmo,
  markersToLocators,
  tasmoToAutomationLanes,
  tasmoToChainEntries,
  tasmoToLoop,
  TASMO_UNSAVED_STATE,
} from './projectImport.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { useProjectStore } from '../state/projectStore.ts';
import { projectApi, type TasmoProjectInput } from './projectClient.ts';
import { placesApi } from './placesClient.ts';
import type { MeterSegment, PolyLane } from './meterMap.ts';
import type { LaneBend } from './pitchBend.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

const MAP: MeterSegment[] = [
  { bar: 0, meter: { num: 4, den: 4, groups: [] } },
  { bar: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } },
];
const LANES: PolyLane[] = [
  { id: 0, name: 'A', cycleSteps: null },
  { id: 1, name: 'B', cycleSteps: 12 },
];
const withoutIds = (notes: readonly PianoNote[] = []) => notes.map(({ id: _id, ...n }) => n);

// A note keeps its lane when it has one, and gains none when it does not.
{
  assert.deepEqual(pianoNoteToTasmo({ id: 'a', note: 60, step: 3, length: 2, velocity: 90, lane: 1 }), {
    note: 60, step: 3, length: 2, velocity: 90, lane: 1,
  });
  assert.deepEqual(pianoNoteToTasmo({ id: 'b', note: 62, step: 0, length: 1, velocity: 80 }), {
    note: 62, step: 0, length: 1, velocity: 80,
  });
}

// Grid length, meter map, pickup and lanes round-trip through the JSON shape.
{
  const clip = { sourceTotalSteps: 46, sourceMeterMap: MAP, sourcePickupSteps: 4, sourceLanes: LANES };
  const saved = clipMeterToTasmo(clip);
  assert.deepEqual(saved, {
    total_steps: 46,
    meter_map: MAP,
    pickup_steps: 4,
    lanes: [{ id: 0, name: 'A', cycle_steps: null }, { id: 1, name: 'B', cycle_steps: 12 }],
  });
  // The payload goes to the backend as JSON and comes back from it as JSON.
  const loaded = tasmoMeterToClip(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded, clip);
  // The saved map is a copy.
  assert.notEqual(saved.meter_map?.[1].meter.groups, MAP[1].meter.groups);
}

// A lane limited to part of the clip (MATCH's span, the METER face's SPAN) saves
// its span and loads it back; one that runs to the clip's end saves a null end;
// a file from before spans loads its lanes with none.
{
  const spanned: PolyLane[] = [
    { id: 0, name: 'A', cycleSteps: null },
    { id: 1, name: 'Low', cycleSteps: 20, span: { start: 58, end: 114 } },
    { id: 2, name: 'High', cycleSteps: 6, span: { start: 64, end: null } },
  ];
  const saved = clipMeterToTasmo({ sourceLanes: spanned });
  assert.deepEqual(saved.lanes, [
    { id: 0, name: 'A', cycle_steps: null },
    { id: 1, name: 'Low', cycle_steps: 20, span_start: 58, span_end: 114 },
    { id: 2, name: 'High', cycle_steps: 6, span_start: 64, span_end: null },
  ]);
  assert.deepEqual(tasmoMeterToClip(JSON.parse(JSON.stringify(saved))).sourceLanes, spanned);
  const older = tasmoMeterToClip({ lanes: [{ id: 0, name: 'A', cycle_steps: null }, { id: 1, name: 'B', cycle_steps: 12 }] });
  assert.deepEqual(older.sourceLanes, LANES);
  // A span that ends before it starts is no span.
  const broken = tasmoMeterToClip({ lanes: [{ id: 1, name: 'B', cycle_steps: 12, span_start: 40, span_end: 20 }] });
  assert.deepEqual(broken.sourceLanes, [{ id: 1, name: 'B', cycleSteps: 12 }]);
}

// The roll's own notes round-trip with their lanes. The file stores no ids, so loaded notes get new ones.
{
  const rollNotes: PianoNote[] = [
    { id: 'a', note: 60, step: 0, length: 2, velocity: 90 },
    { id: 'b', note: 64, step: 3.5, length: 1, velocity: 80, lane: 1 },
  ];
  const saved = clipMeterToTasmo({ sourceRollNotes: rollNotes, sourceLanes: LANES });
  assert.deepEqual(saved.roll_notes, [
    { note: 60, step: 0, length: 2, velocity: 90 },
    { note: 64, step: 3.5, length: 1, velocity: 80, lane: 1 },
  ]);
  const loaded = tasmoMeterToClip(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(withoutIds(loaded.sourceRollNotes), withoutIds(rollNotes));
  assert.deepEqual(loaded.sourceRollNotes?.map((n) => n.id), ['rn-0', 'rn-1']);
  assert.deepEqual(loaded.sourceLanes, LANES);
}

// A clip without the fields writes none, and a file without them loads none.
{
  assert.deepEqual(clipMeterToTasmo({}), {});
  assert.deepEqual(tasmoMeterToClip({}), {});
  assert.deepEqual(tasmoMeterToClip({ roll_notes: null, total_steps: null, meter_map: null, pickup_steps: null, lanes: null }), {});
  assert.deepEqual(tasmoMeterToClip({ roll_notes: [] }), {});
  assert.deepEqual(JSON.parse(JSON.stringify(clipMeterToTasmo({ sourceTotalSteps: undefined }))), {});
  // A file written after the meter fields and before roll_notes: the meter loads, no stored notes.
  const meterOnly = tasmoMeterToClip({ total_steps: 32, lanes: [{ id: 0, name: 'A', cycle_steps: null }] });
  assert.deepEqual(meterOnly, { sourceTotalSteps: 32, sourceLanes: [{ id: 0, name: 'A', cycleSteps: null }] });
}

// Malformed values from a hand-edited file stay out.
{
  const loaded = tasmoMeterToClip({
    total_steps: -3,
    pickup_steps: Number.NaN,
    meter_map: [{ bar: 0, meter: { num: 7, den: 8, groups: [4, 4] } }],
    lanes: [{ id: 1.5, name: 'x', cycle_steps: 8 }, { id: 2, name: 'C', cycle_steps: 0 }],
  });
  assert.equal(loaded.sourceTotalSteps, undefined);
  assert.equal(loaded.sourcePickupSteps, undefined);
  assert.deepEqual(loaded.sourceMeterMap, [{ bar: 0, meter: { num: 7, den: 8, groups: [] } }]);
  assert.deepEqual(loaded.sourceLanes, [{ id: 2, name: 'C', cycleSteps: null }]);
  assert.deepEqual(
    tasmoNotesToPiano(
      [
        { note: 60, step: 0, length: 0, velocity: 90 },
        { note: 128, step: 0, length: 1, velocity: 90 },
        { note: 'C4', step: 0, length: 1 },
        null,
        { note: 61, step: 2, length: 1, velocity: 300, lane: -1 },
        { note: 62, step: 4, length: 1, lane: 2 },
      ],
      'x',
    ),
    [
      { id: 'x-0', note: 61, step: 2, length: 1, velocity: 127 },
      { id: 'x-1', note: 62, step: 4, length: 1, velocity: 100, lane: 2 },
    ],
  );
}

// Each lane's pitch bend round-trips through the JSON shape: a linear point stores no shape, and loaded points get new ids.
{
  const bends: LaneBend[] = [
    { lane: 0, range: 2, points: [{ id: 'a', step: 0, value: 0, shape: 'linear' }, { id: 'b', step: 4.5, value: 1, shape: 'hold' }] },
    { lane: 1, range: 12, points: [{ id: 'c', step: 2, value: -0.5, shape: 'smooth' }] },
  ];
  const saved = clipMeterToTasmo({ sourceBends: bends });
  assert.deepEqual(saved, {
    roll_bends: [
      { lane: 0, range: 2, points: [{ step: 0, value: 0 }, { step: 4.5, value: 1, shape: 'hold' }] },
      { lane: 1, range: 12, points: [{ step: 2, value: -0.5, shape: 'smooth' }] },
    ],
  });
  const loaded = tasmoMeterToClip(JSON.parse(JSON.stringify(saved)));
  const strip = (list: readonly LaneBend[] = []) => list.map((b) => ({ ...b, points: b.points.map(({ id: _id, ...p }) => p) }));
  assert.deepEqual(strip(loaded.sourceBends), strip(bends));
  assert.deepEqual(loaded.sourceBends?.map((b) => b.points.map((p) => p.id)), [['rb0-0', 'rb0-1'], ['rb1-0']]);
  // No bend writes none, and a file without one loads none.
  assert.deepEqual(clipMeterToTasmo({ sourceBends: [] }), {});
  assert.deepEqual(tasmoMeterToClip({ roll_bends: [] }), {});
  assert.deepEqual(tasmoMeterToClip({ roll_bends: null }), {});
}

// Malformed bends from a hand-edited file stay out.
{
  const loaded = tasmoMeterToClip({
    roll_bends: [
      null,
      { lane: -1, range: 2, points: [{ step: 0, value: 1 }] },
      { lane: 1, range: 'x', points: [{ step: 'a', value: 1 }, null, { step: 3, value: 9, shape: 'zigzag' }] },
      { lane: 2, range: 2, points: 'nope' },
    ],
  } as unknown as Parameters<typeof tasmoMeterToClip>[0]);
  assert.deepEqual(loaded.sourceBends, [{ lane: 1, range: 2, points: [{ id: 'rb1-2', step: 3, value: 1, shape: 'linear' }] }]);
}

// ── Markers + the loop region survive the .tasmo write/read ──────────────────
//
// Before this, `captureEditorSession` wrote neither, so every save dropped the
// markers and the cycle region and `loadProject` reopened the session with both
// cleared. These pin the four pure mappers and the restore step.

// A marker list maps to `locators` and back; a junk entry is dropped, not fatal.
{
  const markers = [
    { id: 'm1', t: 0, label: 'Intro' },
    { id: 'm2', t: 12.5, label: 'Drop' },
  ];
  const saved = markersToLocators(markers);
  assert.deepEqual(saved, [
    { id: 'm1', name: 'Intro', position: 0 },
    { id: 'm2', name: 'Drop', position: 12.5 },
  ]);
  // The payload goes to the backend as JSON and comes back from it as JSON.
  assert.deepEqual(locatorsToMarkers(JSON.parse(JSON.stringify(saved))), markers);
  // A negative or non-finite position never makes it into the file...
  assert.deepEqual(markersToLocators([{ id: 'x', t: -1, label: 'a' }, { id: 'y', t: NaN, label: 'b' }]), []);
  // ...and never comes out of a hand-edited one. An unnamed entry gets an index label.
  const read = locatorsToMarkers([null, { position: 'nope' }, { position: -2 }, { id: 'k', position: 4 }]);
  assert.deepEqual(read, [{ id: 'k', t: 4, label: '1' }]);
  // Out-of-order entries load sorted, the way the store keeps them.
  assert.deepEqual(locatorsToMarkers([{ id: 'b', name: 'B', position: 9 }, { id: 'a', name: 'A', position: 2 }]).map((m) => m.id), ['a', 'b']);
}

// The loop region round-trips, `enabled` independently of the bounds.
{
  assert.deepEqual(loopToTasmo({ loopEnabled: true, loopStart: 2, loopEnd: 6 }), { enabled: true, start_sec: 2, end_sec: 6 });
  // A region the user switched OFF is still kept — that is the whole point of
  // storing `enabled` separately from the bounds.
  const off = loopToTasmo({ loopEnabled: false, loopStart: 2, loopEnd: 6 });
  assert.deepEqual(off, { enabled: false, start_sec: 2, end_sec: 6 });
  assert.deepEqual(tasmoToLoop(JSON.parse(JSON.stringify(off))), { enabled: false, start: 2, end: 6 });
  // An empty or inverted region is no region at all, written or read.
  assert.equal(loopToTasmo({ loopEnabled: true, loopStart: 4, loopEnd: 4 }), null);
  assert.equal(loopToTasmo({ loopEnabled: true, loopStart: 8, loopEnd: 1 }), null);
  assert.equal(tasmoToLoop(null), null);
  assert.equal(tasmoToLoop(undefined), null);
  assert.equal(tasmoToLoop({ enabled: true, start_sec: 1, end_sec: 1 }), null);
  assert.equal(tasmoToLoop({ enabled: true, start_sec: 'x', end_sec: 4 }), null);
  // A cycle shorter than the store's own 0.05 s floor is refused on BOTH sides,
  // so a hand-edited file cannot ask for one the UI would never make.
  assert.equal(loopToTasmo({ loopEnabled: true, loopStart: 1, loopEnd: 1.02 }), null);
  assert.equal(tasmoToLoop({ enabled: true, start_sec: 1, end_sec: 1.02 }), null);
  assert.deepEqual(tasmoToLoop({ enabled: true, start_sec: 1, end_sec: 1.2 }), { enabled: true, start: 1, end: 1.2 });
  // A locators value that is not a list at all is no markers, not a throw.
  assert.deepEqual(locatorsToMarkers('nope'), []);
  assert.deepEqual(locatorsToMarkers({ 0: { position: 1 } }), []);
}

// The capture the save POST sends carries both keys.
{
  useEditorStore.setState({
    bpm: 120,
    tracks: [{ id: 't1', name: 'Drums', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }] as never,
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        label: 'take',
        audioBlob: new Blob([new Uint8Array([0])], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        startSec: 0,
        durationSec: 1,
        sourceDuration: 1,
      },
    ] as never,
    markers: [{ id: 'm1', t: 3, label: 'Verse' }],
    loopEnabled: true,
    loopStart: 1,
    loopEnd: 5,
  });
  const session = captureEditorSession();
  assert.equal(session.clipCount, 1, 'the session is non-empty, so save would not skip it');
  assert.deepEqual(session.locators, [{ id: 'm1', name: 'Verse', position: 3 }]);
  assert.deepEqual(session.loop, { enabled: true, start_sec: 1, end_sec: 5 });
}

// A loaded project with both restores them onto the timeline that loadProject cleared.
{
  useEditorStore.setState({ markers: [], loopEnabled: false, loopStart: 0, loopEnd: 0 });
  applyTasmoMarkersAndLoop({
    locators: [{ id: 'm2', name: 'Drop', position: 12.5 }, { id: 'm1', name: 'Intro', position: 0 }],
    loop: { enabled: true, start_sec: 1, end_sec: 5 },
  });
  const s = useEditorStore.getState();
  assert.deepEqual(s.markers.map((m) => [m.t, m.label]), [[0, 'Intro'], [12.5, 'Drop']]);
  assert.equal(s.loopEnabled, true);
  assert.equal(s.loopStart, 1);
  assert.equal(s.loopEnd, 5);

  // A saved-but-switched-off region comes back off, not on.
  useEditorStore.setState({ markers: [], loopEnabled: false, loopStart: 0, loopEnd: 0 });
  applyTasmoMarkersAndLoop({ loop: { enabled: false, start_sec: 2, end_sec: 8 } });
  const off = useEditorStore.getState();
  assert.equal(off.loopEnabled, false);
  assert.deepEqual([off.loopStart, off.loopEnd], [2, 8]);
}

// A file without either key leaves the post-load state exactly as it was.
{
  const markers = [{ id: 'keep', t: 7, label: 'Kept' }];
  useEditorStore.setState({ markers, loopEnabled: true, loopStart: 3, loopEnd: 9 });
  applyTasmoMarkersAndLoop({});
  const s = useEditorStore.getState();
  assert.deepEqual(s.markers, markers);
  assert.equal(s.loopEnabled, true);
  assert.deepEqual([s.loopStart, s.loopEnd], [3, 9]);
}

// The register of session state a save does not carry is EMPTY: the master FX
// chain, the master VST chain and the automation lanes were the last three, and
// they are written and restored below.
{
  assert.deepEqual([...TASMO_UNSAVED_STATE], []);
}

// Opening a project actually puts the markers and the loop on the timeline — and
// leaves the document CLEAN. `addMarker` is an ordinary mutation, so without the
// markSaved/history reset every .tasmo carrying a marker reopened as "unsaved":
// a New-Project confirm, a beforeunload prompt and an immediate autosave, on a
// project the user had not touched yet.
{
  await loadProjectIntoEditor({
    project_name: 'Opened',
    tempo: 128,
    sample_rate: 48000,
    tracks: [{ id: 't1', name: 'Drums', type: 'audio', clips: [] }],
    locators: [{ id: 'm2', name: 'Drop', position: 12.5 }, { id: 'm1', name: 'Intro', position: 0 }],
    loop: { enabled: true, start_sec: 1, end_sec: 5 },
  });
  const s = useEditorStore.getState();
  assert.deepEqual(s.markers.map((m) => [m.t, m.label]), [[0, 'Intro'], [12.5, 'Drop']]);
  assert.equal(s.bpm, 128);
  assert.equal(s.loopEnabled, true);
  assert.deepEqual([s.loopStart, s.loopEnd], [1, 5]);
  assert.equal(s.dirty, false, 'a freshly opened project is not unsaved');
  assert.equal(s._undo.length, 0, 'and has no undo step that would rewind its markers away');

  // A project with neither key opens clean too, with nothing carried over.
  await loadProjectIntoEditor({
    project_name: 'Bare',
    tempo: 100,
    sample_rate: 48000,
    tracks: [{ id: 't1', name: 'Gtr', type: 'audio', clips: [] }],
  });
  const bare = useEditorStore.getState();
  assert.deepEqual(bare.markers, []);
  assert.equal(bare.loopEnabled, false);
  assert.equal(bare.dirty, false);
  assert.equal(bare._undo.length, 0);
}

// The save POST the store actually sends carries both keys. Driven through
// `useProjectStore.save()` — the real branch — with only the transport stubbed,
// because the payload is assembled in the store, not in captureEditorSession.
{
  useEditorStore.setState({
    bpm: 118,
    tracks: [{ id: 't1', name: 'Drums', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }] as never,
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        label: 'take',
        audioBlob: new Blob([new Uint8Array([0])], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        startSec: 0,
        durationSec: 1,
        sourceDuration: 1,
      },
    ] as never,
    markers: [{ id: 'm1', t: 3, label: 'Verse' }],
    loopEnabled: true,
    loopStart: 1,
    loopEnd: 5,
  });

  let sent: TasmoProjectInput | null = null;
  const realSave = projectApi.saveSession;
  const realRecent = projectApi.recent;
  const realPlaces = placesApi.recent;
  projectApi.saveSession = async (project) => {
    sent = project;
    return { status: 'ok', path: 'X.tasmo', manifest: { format: 'tasmo', format_version: 1, project_name: 'X', audio_mode: 'embedded', total_tracks: 1, sample_rate: 48000 } };
  };
  projectApi.recent = async () => [];
  placesApi.recent = async () => [] as never;
  try {
    useProjectStore.setState({ projectName: 'X', savePath: 'X.tasmo', pendingTracks: [] });
    await useProjectStore.getState().save();
  } finally {
    projectApi.saveSession = realSave;
    projectApi.recent = realRecent;
    placesApi.recent = realPlaces;
  }
  assert.ok(sent, 'the session-save branch ran');
  assert.deepEqual(sent!.locators, [{ id: 'm1', name: 'Verse', position: 3 }]);
  assert.deepEqual(sent!.loop, { enabled: true, start_sec: 1, end_sec: 5 });
}

// ── Takes + the comp survive the .tasmo write/read ───────────────────────────
//
// A clip could carry exactly one audio file, so an alternate take and the comp
// across it lived only in the tab: every save dropped them and the clip
// reopened as a single, un-comped recording. These drive the real writer and
// the real reader end to end — capture (which pushes one embedded file per
// take) → the payload the backend validates → load (which fetches those files
// back) — and assert the takes come back BY CONTENT, not merely by count.
{
  // computePeaks needs an AudioContext; the fake decodes a blob to a buffer
  // whose duration is its byte length, so each take has a distinct, knowable
  // length. Only the clip's own blob is ever decoded on load (an inactive take
  // uses its stored source_duration), which these assertions also pin.
  const decoded: string[] = [];
  class FakeAudioContext {
    async decodeAudioData(buf: ArrayBuffer) {
      const text = new TextDecoder().decode(buf);
      decoded.push(text);
      return {
        duration: text.length,
        getChannelData: () => new Float32Array(text.length).fill(0.5),
      };
    }
    async close() {}
  }
  const realWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

  const mk = (body: string): Blob => new Blob([body], { type: 'audio/wav' });
  const takeBlobs = [mk('AAAA'), mk('BBBBBB'), mk('CCC')];
  const takes = [
    { id: 'tk0', label: 'Take 1', audioBlob: takeBlobs[0], mimeType: 'audio/wav', sourceDuration: 4, offsetIntoSource: 0 },
    { id: 'tk1', label: 'Take 2', audioBlob: takeBlobs[1], mimeType: 'audio/wav', sourceDuration: 6, offsetIntoSource: 0.5 },
    { id: 'tk2', label: 'Take 3', audioBlob: takeBlobs[2], mimeType: 'audio/wav', sourceDuration: 3, offsetIntoSource: 0 },
  ];
  useEditorStore.setState({
    bpm: 120,
    tracks: [{ id: 't1', name: 'Vox', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }] as never,
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        label: 'Vocal',
        // The clip's own media IS the active take — the invariant clipComp states.
        audioBlob: takeBlobs[1],
        mimeType: 'audio/wav',
        startSec: 0,
        durationSec: 5.5,
        sourceDuration: 6,
        offsetIntoSource: 0.5,
        takes,
        comp: [{ startSec: 0, takeIndex: 1 }, { startSec: 2.5, takeIndex: 2, crossfadeSec: 0.02 }],
        activeTakeIndex: 1,
      },
    ] as never,
    markers: [],
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
  });

  const session = captureEditorSession();
  // One embedded file per take, alongside the clip's own.
  assert.deepEqual(session.files.map((f) => f.name), ['c1.wav', 'c1-tk0.wav', 'c1-tk1.wav', 'c1-tk2.wav']);
  const input = session.tracks[0].clips![0];
  assert.deepEqual(input.takes, [
    { id: 'tk0', name: 'Take 1', audio_file: 'audio/c1-tk0.wav', mime_type: 'audio/wav', offset_into_source: 0, source_duration: 4 },
    { id: 'tk1', name: 'Take 2', audio_file: 'audio/c1-tk1.wav', mime_type: 'audio/wav', offset_into_source: 0.5, source_duration: 6 },
    { id: 'tk2', name: 'Take 3', audio_file: 'audio/c1-tk2.wav', mime_type: 'audio/wav', offset_into_source: 0, source_duration: 3 },
  ]);
  assert.deepEqual(input.comp, [
    { start_sec: 0, take_index: 1, crossfade_sec: 0 },
    { start_sec: 2.5, take_index: 2, crossfade_sec: 0.02 },
  ]);
  assert.equal(input.active_take_index, 1);
  // The clip's own audio reference is untouched by any of this.
  assert.equal(input.audio_file, 'audio/c1.wav');
  assert.equal(input.offset_into_source, 0.5);

  // An in-memory active index that names no take is written as 0 — the store's
  // own rule for a nonsense index. Clamping to the LAST take instead would put
  // a file on disk claiming the clip plays a recording it never held.
  {
    const s = useEditorStore.getState();
    useEditorStore.setState({ clips: [{ ...s.clips[0], activeTakeIndex: 9 }] as never });
    assert.equal(captureEditorSession().tracks[0].clips![0].active_take_index, 0);
    useEditorStore.setState({ clips: s.clips });
  }

  // The load half: serve the captured files back the way /clip-audio does.
  const realFetch = globalThis.fetch;
  const served: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    served.push(path);
    const file = session.files.find((f) => path.endsWith(f.name));
    return file ? new Response(file.blob, { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;

  try {
    await loadProjectIntoEditor({
      project_name: 'Comped',
      tempo: 120,
      sample_rate: 48000,
      tracks: [{ id: 't1', name: 'Vox', type: 'audio', clips: [JSON.parse(JSON.stringify(input))] }],
    });
    const loaded = useEditorStore.getState().clips[0];
    assert.ok(loaded, 'the comped clip loaded rather than being skipped');
    assert.equal(loaded.takes?.length, 3, 'every take came back');
    assert.deepEqual(
      await Promise.all((loaded.takes ?? []).map((t) => t.audioBlob.text())),
      ['AAAA', 'BBBBBB', 'CCC'],
      'and each one holds ITS OWN audio, not the clip’s three times over',
    );
    assert.deepEqual((loaded.takes ?? []).map((t) => t.label), ['Take 1', 'Take 2', 'Take 3']);
    assert.deepEqual((loaded.takes ?? []).map((t) => t.sourceDuration), [4, 6, 3]);
    assert.deepEqual((loaded.takes ?? []).map((t) => t.offsetIntoSource), [0, 0.5, 0]);
    assert.equal(loaded.activeTakeIndex, 1);
    assert.deepEqual(loaded.comp, [
      { startSec: 0, takeIndex: 1 },
      { startSec: 2.5, takeIndex: 2, crossfadeSec: 0.02 },
    ]);
    // THE INVARIANT: the clip's own media is the active take — the same Blob
    // OBJECT, which is the key lib/decodeCache caches decoded audio under.
    assert.equal(loaded.audioBlob, loaded.takes?.[1].audioBlob, 'clip audio IS the active take');
    assert.equal(loaded.mimeType, loaded.takes?.[1].mimeType);
    assert.equal(loaded.sourceDuration, loaded.takes?.[1].sourceDuration);
    assert.equal(loaded.offsetIntoSource, loaded.takes?.[1].offsetIntoSource);
    // The active take is NOT fetched twice: the clip's own file supplies it.
    assert.deepEqual(served, ['audio/c1.wav', 'audio/c1-tk0.wav', 'audio/c1-tk2.wav']);
    assert.deepEqual(decoded, ['BBBBBB'], 'and only the clip’s own blob is decoded');

    // A take whose file has gone takes the COMP with it — a comp indexes takes
    // by position, so loading a subset would repoint regions at the wrong
    // recording. The clip still plays the active take it already has.
    const broken = JSON.parse(JSON.stringify(input));
    broken.takes[0].audio_file = 'audio/missing.wav';
    await loadProjectIntoEditor({
      project_name: 'Gappy',
      tempo: 120,
      sample_rate: 48000,
      tracks: [{ id: 't1', name: 'Vox', type: 'audio', clips: [broken] }],
    });
    const partial = useEditorStore.getState().clips[0];
    assert.equal(partial.takes, undefined, 'no half take list');
    assert.equal(partial.comp, undefined, 'and no comp indexing into one');
    assert.equal(await partial.audioBlob.text(), 'BBBBBB', 'the clip itself is unharmed');

    // A .tasmo written before takes existed loads exactly as it always did.
    const legacy = JSON.parse(JSON.stringify(input));
    delete legacy.takes;
    delete legacy.comp;
    delete legacy.active_take_index;
    await loadProjectIntoEditor({
      project_name: 'Legacy',
      tempo: 120,
      sample_rate: 48000,
      tracks: [{ id: 't1', name: 'Vox', type: 'audio', clips: [legacy] }],
    });
    const old = useEditorStore.getState().clips[0];
    assert.equal(old.takes, undefined);
    assert.equal(old.comp, undefined);
    assert.equal(old.activeTakeIndex, undefined);
    assert.equal(await old.audioBlob.text(), 'BBBBBB');
    assert.equal(old.offsetIntoSource, 0.5, 'and the fields it always had are untouched');

    // A clip with no takes writes none of the three keys, so the payload a
    // takes-free session sends is the one it sent before takes existed.
    useEditorStore.setState({ clips: [{ ...old, takes: undefined, comp: undefined }] as never });
    const plain = captureEditorSession().tracks[0].clips![0];
    assert.ok(!('takes' in plain) && !('comp' in plain) && !('active_take_index' in plain));
  } finally {
    globalThis.fetch = realFetch;
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
  }
}

// ── The master chains + automation lanes survive the .tasmo write/read ───────
//
// The last three pieces of session state a save could not carry. The master
// chains failed the OTHER way round from everything else here: `loadProject`
// does not clear them, so opening a project left the PREVIOUS one's master rack
// in place and then saved it into the new file.

// A chain entry round-trips, VST plugin state and all; junk is dropped.
{
  const rack = { id: 'fx1', effect: 'reverb_delay', params: { decay: 0.4 }, enabled: true };
  assert.deepEqual(chainEntryToTasmo(rack), {
    id: 'fx1', effect: 'reverb_delay', params: { decay: 0.4 }, enabled: true,
  });
  const vst = {
    id: 'v1',
    effect: 'vst3',
    params: {},
    enabled: false,
    vst: { plugin_path: 'C:/p/Pro-Q.vst3', plugin_name: 'Pro-Q', raw_state: 'YmFzZTY0' },
    label: 'Pro-Q 4',
  };
  const savedVst = chainEntryToTasmo(vst);
  assert.deepEqual(savedVst, {
    id: 'v1',
    effect: 'vst3',
    params: {},
    enabled: false,
    vst: { plugin_path: 'C:/p/Pro-Q.vst3', plugin_name: 'Pro-Q', raw_state: 'YmFzZTY0' },
    label: 'Pro-Q 4',
  });
  // The payload goes to the backend as JSON and comes back from it as JSON.
  assert.deepEqual(tasmoToChainEntries(JSON.parse(JSON.stringify([rack, savedVst]))), [rack, vst]);
  // A plugin that has never had its editor opened writes no raw_state — which
  // is not the same as an empty one.
  assert.deepEqual(
    chainEntryToTasmo({ id: 'v2', effect: 'vst3', params: {}, enabled: true, vst: { plugin_path: 'p', plugin_name: 'n' } }).vst,
    { plugin_path: 'p', plugin_name: 'n' },
  );
  // A hand-edited file: no id, no effect, NaN params, a nonsense entry.
  assert.deepEqual(
    tasmoToChainEntries([
      null,
      { effect: 'delay' },
      { id: 'x' },
      { id: 'ok', effect: 'delay', params: { a: Number.NaN, b: 2, c: 'x' } },
    ] as never),
    [{ id: 'ok', effect: 'delay', params: { b: 2 }, enabled: true }],
  );
  assert.deepEqual(tasmoToChainEntries('nope'), []);
  // The master VST chain refuses an entry that names no plugin to host.
  assert.deepEqual(tasmoToChainEntries([{ id: 'v', effect: 'vst3' }], true), []);
  assert.equal(tasmoToChainEntries([{ id: 'v', effect: 'vst3', vst: { plugin_path: 'p' } }], true)[0].vst?.plugin_name, 'p');
}

// Automation lanes round-trip, per-point curve included.
{
  const lanes = [
    {
      id: 'l1',
      target: { kind: 'trackVolume' as const, trackId: 't1' },
      points: [{ t: 0, v: 0.8 }, { t: 4, v: 0.2, curve: 0.5 }],
      enabled: true,
    },
    {
      id: 'l2',
      target: { kind: 'masterFx' as const, entryId: 'fx1', paramKey: 'decay' },
      points: [{ t: 1, v: 0.3 }],
      enabled: false,
    },
  ];
  const saved = automationLanesToTasmo(lanes);
  assert.deepEqual(saved, [
    {
      id: 'l1',
      target: { kind: 'trackVolume', track_id: 't1' },
      points: [{ t: 0, v: 0.8 }, { t: 4, v: 0.2, curve: 0.5 }],
      enabled: true,
    },
    {
      id: 'l2',
      target: { kind: 'masterFx', entry_id: 'fx1', param_key: 'decay' },
      points: [{ t: 1, v: 0.3 }],
      enabled: false,
    },
  ]);
  const resolve = automationTargetResolver(
    [{ id: 't1', name: 'Drums', nameAutoGenerated: false, volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }],
    [{ id: 'fx1', effect: 'reverb_delay', params: {}, enabled: true }],
  );
  assert.deepEqual(tasmoToAutomationLanes(JSON.parse(JSON.stringify(saved)), resolve), lanes);

  // A lane with nothing to write to is dropped, not restored as a lane riding a
  // control that does not exist — which is exactly why loadProject clears them.
  assert.deepEqual(
    tasmoToAutomationLanes(
      [
        { id: 'a', target: { kind: 'trackPan', track_id: 'gone' }, points: [{ t: 0, v: 0 }] },
        { id: 'b', target: { kind: 'trackFx', track_id: 't1', entry_id: 'nope', param_key: 'decay' }, points: [] },
        { id: 'c', target: { kind: 'masterFx', entry_id: 'fx1' }, points: [] },
        { id: 'd', target: { kind: 'whatIsThis', track_id: 't1' }, points: [] },
        { id: 'e', target: { kind: 'trackPan', track_id: 't1' }, points: [] },
      ],
      resolve,
    ).map((l) => l.id),
    ['e'],
    'an emptied lane is still a lane; a dangling or unknown target is not',
  );

  // Points that cannot be sampled never reach the file, and never come out of a
  // hand-edited one: non-finite, or not advancing the curve.
  const messy = automationLanesToTasmo([
    {
      id: 'l3',
      target: { kind: 'trackPan' as const, trackId: 't1' },
      points: [
        { t: 0, v: 0 },
        { t: Number.NaN, v: 1 },
        { t: 0, v: 0.5 },
        { t: 2, v: 1, curve: 9 },
        { t: 1, v: 1 },
        { t: 3, v: Number.POSITIVE_INFINITY },
        { t: 4, v: 0, curve: 0 },
      ],
      enabled: true,
    },
  ]);
  assert.deepEqual(messy[0].points, [{ t: 0, v: 0 }, { t: 2, v: 1, curve: 1 }, { t: 4, v: 0 }]);
  assert.deepEqual(
    tasmoToAutomationLanes(
      [{ id: 'l4', target: { kind: 'trackPan', track_id: 't1' }, points: [{ t: 5, v: 0 }, { t: 5, v: 1 }, 'x', { t: 6, v: 1 }] }],
      resolve,
    )[0].points,
    [{ t: 5, v: 0 }, { t: 6, v: 1 }],
  );
  assert.deepEqual(tasmoToAutomationLanes('nope', resolve), []);

  // The `only` filter: a lane whose track will not be in the payload is left
  // out rather than saved as a dangler (the imported-DAW save branch).
  assert.deepEqual(automationLanesToTasmo(lanes, new Set(['other'])).map((l) => l.id), ['l2']);
}

// The capture the save POST sends carries all three, and restores them again.
{
  const masterFx = [{ id: 'mfx1', effect: 'reverb_delay', params: { decay: 0.4 }, enabled: true }];
  const masterVst = [
    { id: 'mv1', effect: 'vst3', params: {}, enabled: true, vst: { plugin_path: 'C:/p/Q.vst3', plugin_name: 'Q', raw_state: 'Wg==' } },
  ];
  const lanes = [
    { id: 'l1', target: { kind: 'masterFx' as const, entryId: 'mfx1', paramKey: 'decay' }, points: [{ t: 0, v: 0.4 }, { t: 8, v: 0.9 }], enabled: true },
  ];
  useEditorStore.setState({
    tracks: [{ id: 't1', name: 'Drums', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }] as never,
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        label: 'take',
        audioBlob: new Blob([new Uint8Array([0])], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        startSec: 0,
        durationSec: 1,
        sourceDuration: 1,
      },
    ] as never,
    masterFxChain: masterFx,
    masterVstChain: masterVst,
    automationLanes: lanes,
    markers: [],
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
  });
  const session = captureEditorSession();
  assert.deepEqual(session.masterFxChain, [{ id: 'mfx1', effect: 'reverb_delay', params: { decay: 0.4 }, enabled: true }]);
  assert.equal(session.masterVstChain[0].vst?.raw_state, 'Wg==');
  assert.deepEqual(session.automationLanes.map((l) => l.target), [
    { kind: 'masterFx', entry_id: 'mfx1', param_key: 'decay' },
  ]);
  // The document helper on its own agrees with the session capture.
  assert.deepEqual(captureProjectDocument().masterFxChain, session.masterFxChain);

  // Restoring what was captured: an empty chain CLEARS (the file says this
  // project has none), and a file that says nothing leaves the live state.
  applyTasmoMasterAndAutomation({
    master_fx_chain: JSON.parse(JSON.stringify(session.masterFxChain)),
    master_vst_chain: JSON.parse(JSON.stringify(session.masterVstChain)),
    automation_lanes: JSON.parse(JSON.stringify(session.automationLanes)),
  });
  const back = useEditorStore.getState();
  assert.deepEqual(back.masterFxChain, masterFx);
  assert.deepEqual(back.masterVstChain, masterVst);
  assert.deepEqual(back.automationLanes, lanes);
  assert.equal(back.frozenMaster, null);

  applyTasmoMasterAndAutomation({});
  const untouched = useEditorStore.getState();
  assert.deepEqual(untouched.masterFxChain, masterFx, 'a legacy file leaves the master rack alone');
  assert.deepEqual(untouched.masterVstChain, masterVst);

  applyTasmoMasterAndAutomation({ master_fx_chain: [], master_vst_chain: [], automation_lanes: [] });
  const cleared = useEditorStore.getState();
  assert.deepEqual(cleared.masterFxChain, []);
  assert.deepEqual(cleared.masterVstChain, []);
  assert.deepEqual(cleared.automationLanes, []);
}

// Opening a project puts all three back — and a lane targeting a TRACK FX slot
// resolves, because chain-entry ids round-trip.
{
  useEditorStore.setState({ masterFxChain: [], masterVstChain: [], automationLanes: [] });
  await loadProjectIntoEditor({
    project_name: 'Mastered',
    tempo: 120,
    sample_rate: 48000,
    tracks: [
      {
        id: 't1',
        name: 'Drums',
        type: 'audio',
        clips: [],
        effect_chain: [{ id: 'tfx1', node_type: 'builtin', effect_name: 'eq_mid', parameters: { gain: 3 } }],
      },
    ],
    master_fx_chain: [{ id: 'mfx1', effect: 'reverb_delay', params: { decay: 0.4 }, enabled: true }],
    master_vst_chain: [{ id: 'mv1', effect: 'vst3', params: {}, enabled: true, vst: { plugin_path: 'p', plugin_name: 'Q', raw_state: 'Wg==' } }],
    automation_lanes: [
      { id: 'l1', target: { kind: 'trackFx', track_id: 't1', entry_id: 'tfx1', param_key: 'gain' }, points: [{ t: 0, v: 3 }], enabled: true },
      { id: 'l2', target: { kind: 'trackVolume', track_id: 'ghost' }, points: [{ t: 0, v: 1 }], enabled: true },
    ],
  });
  const s = useEditorStore.getState();
  assert.deepEqual(s.masterFxChain.map((e) => e.id), ['mfx1']);
  assert.equal(s.masterVstChain[0].vst?.raw_state, 'Wg==');
  assert.deepEqual(s.automationLanes.map((l) => l.id), ['l1'], 'the ghost track’s lane is dropped');
  assert.deepEqual(s.automationLanes[0].points, [{ t: 0, v: 3 }]);
  assert.equal(s.dirty, false, 'a freshly opened project is still not unsaved');
  assert.equal(s._undo.length, 0);

  // A .tasmo written before any of this loads unchanged: the lanes stay cleared
  // (loadProject clears them) and the master chains are left exactly as they are.
  await loadProjectIntoEditor({
    project_name: 'Legacy',
    tempo: 100,
    sample_rate: 48000,
    tracks: [{ id: 't1', name: 'Gtr', type: 'audio', clips: [] }],
  });
  const legacy = useEditorStore.getState();
  assert.deepEqual(legacy.masterFxChain.map((e) => e.id), ['mfx1']);
  assert.deepEqual(legacy.masterVstChain.map((e) => e.id), ['mv1']);
  assert.deepEqual(legacy.automationLanes, []);
  assert.equal(legacy.dirty, false);
}

// The IMPORTED-DAW save branch writes the same document. It used to build its
// own payload from four fields, so saving an imported project dropped the
// markers, the loop, the buses, the master chains and the automation.
{
  useEditorStore.setState({
    tracks: [{ id: 'editor-t', name: 'Drums', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }] as never,
    masterFxChain: [{ id: 'mfx1', effect: 'reverb_delay', params: {}, enabled: true }],
    masterVstChain: [],
    automationLanes: [
      { id: 'l1', target: { kind: 'masterFx', entryId: 'mfx1', paramKey: 'decay' }, points: [{ t: 0, v: 0.4 }], enabled: true },
      { id: 'l2', target: { kind: 'trackVolume', trackId: 'editor-t' }, points: [{ t: 0, v: 0.8 }], enabled: true },
    ] as never,
    markers: [{ id: 'm1', t: 3, label: 'Verse' }],
    loopEnabled: true,
    loopStart: 1,
    loopEnd: 5,
  });

  let sent: TasmoProjectInput | null = null;
  const realSave = projectApi.save;
  const realRecent = projectApi.recent;
  const realPlaces = placesApi.recent;
  projectApi.save = async (project) => {
    sent = project;
    return { status: 'ok', path: 'I.tasmo', manifest: { format: 'tasmo', format_version: 1, project_name: 'I', audio_mode: 'linked', total_tracks: 1, sample_rate: 48000 } };
  };
  projectApi.recent = async () => [];
  placesApi.recent = async () => [] as never;
  try {
    useProjectStore.setState({
      projectName: 'I',
      savePath: 'I.tasmo',
      pendingTracks: [{ id: 'imported-t', name: 'Imported', type: 'audio', clips: [] }],
    });
    await useProjectStore.getState().save();
  } finally {
    projectApi.save = realSave;
    projectApi.recent = realRecent;
    placesApi.recent = realPlaces;
    useProjectStore.setState({ pendingTracks: [] });
  }
  assert.ok(sent, 'the imported-DAW save branch ran');
  assert.deepEqual(sent!.tracks?.map((t) => t.id), ['imported-t'], 'and still saves the IMPORTED tracks');
  assert.deepEqual(sent!.locators, [{ id: 'm1', name: 'Verse', position: 3 }]);
  assert.deepEqual(sent!.loop, { enabled: true, start_sec: 1, end_sec: 5 });
  assert.deepEqual(sent!.master_fx_chain?.map((e) => e.id), ['mfx1']);
  assert.deepEqual(sent!.master_vst_chain, []);
  assert.deepEqual(sent!.buses, []);
  // The master lane is written; the one naming an EDITOR track is not, because
  // that track will not be in this file.
  assert.deepEqual(sent!.automation_lanes?.map((l) => l.id), ['l1']);
}

console.log('projectImport mapping tests passed');
