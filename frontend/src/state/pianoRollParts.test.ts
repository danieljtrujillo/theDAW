// The piano roll's parts (RollTrack): adding, switching, renaming, sounds,
// mute and solo, moving and removing, and undo over every one of them; the
// link each part keeps to its EDIT clip; and a roll written before parts.
//
// Each block starts from a reset coalesce clock (beginBlock, as in
// pianoRollHistory.test.ts), so the edit under test records its own step.
//
//   cd frontend && npx tsx src/state/pianoRollParts.test.ts
import assert from 'node:assert/strict';
import { partLinkOf, rollTracksOf, usePianoRollStore, type PianoNote } from './pianoRollStore.ts';
import { audiblePartIds, isPercussionPart } from '../lib/rollTracks.ts';

const st = () => usePianoRollStore.getState();
const note = (step: number, pitch = 60, id = `n${step}-${pitch}`): PianoNote => ({ id, note: pitch, step, length: 2, velocity: 90 });
const parts = () => rollTracksOf(st());
const part = (i: number) => parts()[i];

/** Empty both stacks and reset the coalesce clock (an undo resets it). */
const beginBlock = () => {
  const s = st();
  usePianoRollStore.setState({ _undo: [{ notes: s.notes, bpm: s.bpm, tempoMap: s.tempoMap, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote, meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends, voiceProgram: s.voiceProgram, markers: s.markers }], _redo: [] });
  st().undo();
  assert.equal(st()._undo.length, 0);
};

// A new roll is one part, and its notes are the roll's notes.
{
  assert.equal(st().tracks.length, 1, 'a new roll holds one part');
  assert.equal(part(0).notes, st().notes, "the active part's notes are the store's notes");
  assert.equal(part(0).name, 'Part 1');
  assert.equal(part(0).program, null, 'the first part follows the roll voice');
}

// Adding a part turns to it; the first part keeps its notes; one undo step
// takes the part away and turns back to the first part with its notes.
{
  st().importNotes([note(0), note(4, 64)], 120);
  beginBlock();
  const first = st().activeTrackId;
  const id = st().addTrack();
  assert.ok(id, 'a part was added');
  assert.equal(st().activeTrackId, id, 'the new part is the one being edited');
  assert.equal(st().notes.length, 0, 'the new part starts empty');
  assert.equal(st()._undo.length, 1, 'adding a part is one undo step');
  assert.deepEqual(parts().map((t) => t.notes.length), [2, 0], 'the first part keeps its two notes');
  assert.equal(part(1).name, 'Part 2');
  assert.notEqual(part(1).color, part(0).color, 'the new part takes a colour of its own');
  st().addNote({ note: 72, step: 8, length: 2, velocity: 100 });
  assert.deepEqual(parts().map((t) => t.notes.length), [2, 1], 'a drawn note goes into the part being edited');
  st().undo();
  st().undo();
  assert.equal(st().tracks.length, 1, 'undo takes the part away');
  assert.equal(st().activeTrackId, first, 'and turns back to the first part');
  assert.equal(st().notes.length, 2, "with the first part's notes");
  st().redo();
  assert.equal(st().tracks.length, 2, 'redo puts the part back');
}

// Switching parts is not an undo step, and undoing an edit made in another
// part changes that part without moving the view.
{
  const [a, b] = parts().map((t) => t.id);
  st().setActiveTrack(b);
  beginBlock();
  st().replaceAll([note(0, 50), note(2, 52)]);
  assert.equal(st()._undo.length, 1);
  st().setActiveTrack(a);
  assert.equal(st()._undo.length, 1, 'switching parts records no step');
  assert.equal(st().notes.length, 2, "part A's notes are in view");
  st().undo();
  assert.equal(st().activeTrackId, a, 'undo keeps the part in view');
  assert.equal(parts().find((t) => t.id === b)?.notes.length, 1, "undo put part B's single note back");
  assert.equal(st().notes.length, 2, 'part A is untouched');
  st().redo();
  assert.equal(parts().find((t) => t.id === b)?.notes.length, 2, "redo put part B's two notes back");
}

// Every field of a part is one undo step: name, program, bank, channel,
// colour, mute, solo, instrument, and moving.
{
  const b = part(1).id;
  const cases: Array<[string, () => void, (t: ReturnType<typeof part>) => unknown, unknown, unknown]> = [
    ['rename', () => st().renameTrack(b, '  Violin I  '), (t) => t.name, 'Part 2', 'Violin I'],
    ['program', () => st().setTrackProgram(b, 40), (t) => t.program, null, 40],
    ['bank', () => st().setTrackBank(b, 8), (t) => t.bank, 0, 8],
    ['channel', () => st().setTrackChannel(b, 3), (t) => t.channel, null, 3],
    ['colour', () => st().setTrackColor(b, '#123ABC'), (t) => t.color, part(1).color, '#123abc'],
    ['mute', () => st().setTrackMute(b, true), (t) => t.mute, false, true],
    ['solo', () => st().setTrackSolo(b, true), (t) => t.solo, false, true],
  ];
  for (const [name, edit, read, before, after] of cases) {
    beginBlock();
    edit();
    const now = parts().find((t) => t.id === b)!;
    assert.deepEqual(read(now), after, `${name} is set`);
    assert.equal(st()._undo.length, 1, `${name} is one undo step`);
    st().undo();
    assert.deepEqual(read(parts().find((t) => t.id === b)!), before, `undo puts ${name} back`);
    st().redo();
    assert.deepEqual(read(parts().find((t) => t.id === b)!), after, `redo sets ${name} again`);
  }
  beginBlock();
  st().moveTrack(b, 0);
  assert.equal(part(0).id, b, 'the part moved to the top');
  assert.equal(st()._undo.length, 1, 'a move is one undo step');
  st().undo();
  assert.equal(part(1).id, b, 'undo moves it back');
}

// An orchestral instrument sets the program and bank, names a part that still
// has its default name, and a kit puts the part on channel 10.
{
  const id = st().addTrack() as string;
  beginBlock();
  st().setTrackInstrument(id, 'clarinet-bb');
  let t = parts().find((x) => x.id === id)!;
  assert.deepEqual([t.program, t.bank, t.instrumentId, t.name], [71, 0, 'clarinet-bb', 'Clarinet in B♭']);
  assert.equal(st()._undo.length, 1, 'choosing an instrument is one undo step');
  st().setTrackInstrument(id, 'snare-drum');
  t = parts().find((x) => x.id === id)!;
  assert.equal(t.channel, 10, 'an unpitched instrument goes on the percussion channel');
  assert.ok(isPercussionPart(t));
  assert.equal(t.program, 48, 'the Orchestral kit');
  assert.equal(t.name, 'Clarinet in B♭', 'a part named by an instrument keeps its name');
  st().setTrackProgram(id, 41, false);
  t = parts().find((x) => x.id === id)!;
  assert.deepEqual([t.program, t.channel, t.instrumentId], [41, null, undefined], 'a GM program by hand takes the part off the kit and its instrument');
  st().removeTrack(id);
}

// Solo and mute decide what sounds; AUDITION solos one part alone and, pressed
// again, clears every solo.
{
  const ids = parts().map((t) => t.id);
  for (const id of ids) {
    st().setTrackSolo(id, false);
    st().setTrackMute(id, false);
  }
  assert.equal(audiblePartIds(st().tracks).size, ids.length, 'every part sounds');
  st().setTrackMute(ids[0], true);
  assert.equal(audiblePartIds(st().tracks).has(ids[0]), false, 'a muted part is silent');
  st().soloOnly(ids[1]);
  assert.deepEqual([...audiblePartIds(st().tracks)], [ids[1]], 'audition sounds that part alone');
  st().soloOnly(ids[1]);
  assert.ok(st().tracks.every((t) => !t.solo), 'pressed again it clears every solo');
  st().setTrackMute(ids[0], false);
}

// Removing the part being edited turns to its neighbour; undo brings it back
// with its notes and its link to its EDIT clip.
{
  const [a, b] = parts().map((t) => t.id);
  st().setActiveTrack(b);
  st().bindPartClip(b, 'clip-b');
  st().bindPartClip(a, 'clip-a');
  assert.equal(st().editingClipId, 'clip-b', "the active part's link is the roll's link");
  assert.equal(partLinkOf(st(), a), 'clip-a', 'another part keeps its own');
  beginBlock();
  const bNotes = st().notes.length;
  st().removeTrack(b);
  assert.equal(st().tracks.length, 1);
  assert.equal(st().activeTrackId, a, 'the neighbour is active');
  assert.equal(st().editingClipId, 'clip-a', "and the roll's link is its clip");
  st().undo();
  assert.equal(st().activeTrackId, b, 'undo brings the removed part back as the one being edited');
  assert.equal(st().notes.length, bNotes, 'with its notes');
  assert.equal(st().editingClipId, 'clip-b', 'and linked to its own clip');
  assert.equal(partLinkOf(st(), a), 'clip-a');
  st().setActiveTrack(a);
  assert.equal(st().editingClipId, 'clip-a', 'switching parts switches the link');
  assert.equal(partLinkOf(st(), b), 'clip-b');
}

// The last part cannot be removed.
{
  while (st().tracks.length > 1) st().removeTrack(st().tracks[st().tracks.length - 1].id);
  st().removeTrack(st().tracks[0].id);
  assert.equal(st().tracks.length, 1, 'the roll keeps one part');
}

// An import into one part never shrinks the grid below another part's notes.
{
  st().importNotes([note(0)], 120);
  const id = st().addTrack({ notes: [note(120)] }) as string;
  assert.equal(st().activeTrackId, id);
  st().setActiveTrack(st().tracks[0].id);
  st().importNotes([note(0), note(2)], 120);
  assert.ok(st().totalSteps >= 122, `the grid still holds the other part's note at step 120 (${st().totalSteps})`);
  st().removeTrack(id);
}

// Opening a clip with its sibling parts, and undoing the open: the previous
// parts come back linked to the clips they came from.
{
  st().importNotes([note(0)], 120);
  st().bindPartClip(st().activeTrackId, 'old-clip');
  const before = st().activeTrackId;
  beginBlock();
  st().loadFromClip('clip-vn', [note(0, 67)], 100, 64, undefined, undefined, undefined, [], {
    doc: 'doc-1',
    activeTrackId: 'p-vn',
    links: { 'p-vn': 'clip-vn', 'p-vc': 'clip-vc' },
    tracks: [
      { id: 'p-vn', name: 'Violin', program: 40, bank: 0, channel: null, color: '#a855f7', mute: false, solo: false, notes: [] },
      { id: 'p-vc', name: 'Cello', program: 42, bank: 0, channel: null, color: '#22d3ee', mute: false, solo: false, notes: [note(0, 36)] },
    ],
  });
  assert.deepEqual(parts().map((t) => t.name), ['Violin', 'Cello']);
  assert.equal(st().activeTrackId, 'p-vn');
  assert.equal(st().notes[0].note, 67, "the opened clip's notes are the active part's");
  assert.equal(st().editingClipId, 'clip-vn');
  assert.equal(partLinkOf(st(), 'p-vc'), 'clip-vc');
  assert.equal(st().rollDocId, 'doc-1', 'the roll is the clips’ document');
  st().undo();
  assert.equal(st().activeTrackId, before, 'undo brings the previous parts back');
  assert.equal(st().editingClipId, 'old-clip', 'linked to the clip they came from');
  st().redo();
  assert.equal(st().editingClipId, 'clip-vn', 'redo relinks the opened clip');
  assert.equal(partLinkOf(st(), 'p-vc'), 'clip-vc');
}

// A clip opened with no parts (bounced before parts) is the roll's one part.
{
  st().loadFromClip('legacy', [note(0), note(4)], 120, 64);
  assert.equal(st().tracks.length, 1, 'one part');
  assert.equal(st().notes.length, 2);
  assert.equal(st().editingClipId, 'legacy');
}

// An undo step written before parts existed (no `tracks`) puts its notes into
// the active part and leaves the parts alone.
{
  st().addTrack({ notes: [note(8)] });
  const active = st().activeTrackId;
  const s = st();
  usePianoRollStore.setState({
    _undo: [{ notes: [note(1), note(3), note(5)], bpm: s.bpm, tempoMap: s.tempoMap, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote, meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends, voiceProgram: s.voiceProgram, markers: s.markers }],
    _redo: [],
  });
  st().undo();
  assert.equal(st().tracks.length, 2, 'the parts stay');
  assert.equal(st().activeTrackId, active);
  assert.equal(st().notes.length, 3, "the old step's notes are in the active part");
}

// Replacing every part (a multi-track import) is one undo step and starts a new document.
{
  const doc = st().rollDocId;
  beginBlock();
  st().importParts(
    [
      { name: 'Flute', program: 73, notes: [note(0, 72)] },
      { name: 'Oboe', program: 68, notes: [note(4, 70)] },
      { name: 'Horn in F', program: 60, notes: [note(8, 60)] },
    ],
    96,
  );
  assert.deepEqual(parts().map((t) => [t.name, t.program, t.notes.length]), [['Flute', 73, 1], ['Oboe', 68, 1], ['Horn in F', 60, 1]]);
  assert.equal(st().bpm, 96);
  assert.equal(st().editingClipId, null, 'the new parts save into no clip');
  assert.notEqual(st().rollDocId, doc, 'a new document');
  assert.equal(st()._undo.length, 1, 'one undo step');
  st().undo();
  assert.equal(st().rollDocId, doc, 'undo puts the document back');
}

/** The tempo map as "beat:bpm" pairs. */
const tempoText = () => st().tempoMap.map((e) => `${e.beat}:${e.bpm}`).join(' ');
/** Every bend point of every lane. */
const bendCount = () => st().bends.reduce((n, b) => n + b.points.length, 0);
/** A Violin part with two notes and a Cello part with one, the Cello active, a tempo change at beat 8 and two bend points on lane A. */
const orchestra = () => {
  st().importParts(
    [
      { name: 'Violin', program: 40, notes: [note(0, 76), note(4, 79)] },
      { name: 'Cello', program: 42, notes: [note(0, 48)] },
    ],
    120,
    { lanes: [{ id: 0, name: 'A', cycleSteps: null }] },
  );
  st().setTempoMap([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 80 }]);
  st().addBendPoint(0, { step: 0, value: 0.5 });
  st().addBendPoint(0, { step: 4, value: 0 });
  st().setActiveTrack(part(1).id);
  assert.equal(tempoText(), '0:120 8:80');
  assert.equal(bendCount(), 2);
};

// A generator writing into one part (the ARP's "send to roll" is
// importNotes(notes, cfg.bpm); AI COMPOSE adds the meter it asked in) keeps the
// tempo map, the meter and the bends every other part plays by.
{
  orchestra();
  const meterBefore = st().meterMap;
  const done = st().importNotes([note(0, 43), note(2, 45), note(4, 47)], 120);
  assert.equal(done.keptDocument, true, 'the write says it kept the document');
  assert.equal(tempoText(), '0:120 8:80', "the ARP's bpm does not flatten the tempo map");
  assert.equal(bendCount(), 2, "the Violin's bend survives");
  assert.deepEqual(parts().map((t) => t.notes.length), [2, 3], 'the notes went into the Cello; the Violin keeps its two');
  const composed = st().importNotes([note(0, 40)], 96, { meterMap: [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }], pickupSteps: 0 });
  assert.equal(composed.keptDocument, true);
  assert.equal(st().meterMap, meterBefore, 'the meter handed in does not replace the roll’s');
  assert.equal(tempoText(), '0:120 8:80');
}

// A one-track MIDI file into one part: the file's tempo map, meter, lanes and
// bends stay out, and a note on a lane the roll does not have (or has with
// another loop) goes to lane A.
{
  orchestra();
  st().addLane(12);
  const done = st().importNotes(
    [note(0, 50), { ...note(2, 52), lane: 1 }, { ...note(4, 53), lane: 7 }],
    100,
    {
      meterMap: [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }],
      pickupSteps: 0,
      lanes: [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 8 }, { id: 7, name: 'H', cycleSteps: null }],
    },
    [{ lane: 0, range: 2, points: [{ id: 'f', step: 0, value: -1, shape: 'linear' }] }],
    [{ beat: 0, bpm: 100 }],
  );
  assert.equal(done.keptDocument, true);
  assert.equal(tempoText(), '0:120 8:80', "the file's tempo map is not applied");
  assert.equal(st().meterMap[0].meter.num, 4, 'nor its meter');
  assert.deepEqual(st().lanes.map((l) => [l.id, l.cycleSteps]), [[0, null], [1, 12]], 'nor its lanes');
  assert.equal(st().bends.find((b) => b.lane === 0)?.points[0].value, 0.5, 'nor its bend');
  assert.deepEqual(st().notes.map((n) => n.lane), [undefined, undefined, undefined], "a note of the file's 8-step lane B and of its lane H goes to lane A");
}

// Virtuoso's song build owns the maps of its sections: its tempo map applies
// while other parts hold notes, and the bends it leaves out stay.
{
  orchestra();
  const done = st().importNotes([note(0, 55)], 90, undefined, undefined, [{ beat: 0, bpm: 90 }, { beat: 4, bpm: 110 }], { document: true });
  assert.equal(done.keptDocument, false);
  assert.equal(tempoText(), '0:90 4:110', "the song's tempo map is the roll's");
  assert.equal(bendCount(), 2, 'the bends it left out stay');
}

// With no notes in any other part, a write sets the document as a roll of one part does.
{
  orchestra();
  st().setPartNotes(part(0).id, []);
  const done = st().importNotes([note(0, 43)], 132);
  assert.equal(done.keptDocument, false);
  assert.equal(tempoText(), '0:132', 'one tempo at the bpm given');
  assert.equal(bendCount(), 0, 'and the points go with the notes they bent');
}

// A take (the vocal column, LOAD, the track menu) into one part converts
// through the roll's tempo map and leaves it: a note heard at 5 s lands on the
// step it sounds at under 120 then 80 BPM.
{
  orchestra();
  const { importTake } = await import('../lib/rollTakes.ts');
  const bpm = importTake([{ note: 60, velocity: 90, startSec: 5, endSec: 5.75 }], 97.3, 'take');
  assert.equal(bpm, 120, "the roll's own tempo comes back");
  assert.equal(tempoText(), '0:120 8:80', 'the tempo map stays');
  // 8 beats at 120 take 4 s; the 5th second is 1 s into 80 BPM, 4/3 of a beat: beat 9.333, step 37.333.
  assert.ok(Math.abs(st().notes[0].step - (8 + 4 / 3) * 4) < 0.01, `the note sits where 5 s falls on the map (${st().notes[0].step})`);
  assert.equal(parts()[0].notes.length, 2, 'the Violin is untouched');
}

// CLEAR in one part keeps the other parts' notes and the bends they play through.
{
  orchestra();
  st().clear();
  assert.equal(st().notes.length, 0, 'the Cello is empty');
  assert.equal(parts()[0].notes.length, 2, 'the Violin keeps its notes');
  assert.equal(bendCount(), 2, 'and the bend points stay');
  // With the last notes gone the points go too, as they always have.
  st().setActiveTrack(part(0).id);
  st().clear();
  assert.equal(bendCount(), 0, 'CLEAR of the last part with notes clears the points');
}

// Removing a lane while another part is being edited moves every part's notes
// on it to lane A, so a lane added next never takes them over.
{
  orchestra();
  const lane = st().addLane(null);
  st().setActiveTrack(part(0).id);
  st().replaceAll([note(0, 76), { ...note(4, 79), lane }]);
  st().setActiveTrack(part(1).id);
  beginBlock();
  st().removeLane(lane);
  assert.equal(st()._undo.length, 1, 'one undo step');
  assert.deepEqual(parts()[0].notes.map((n) => n.lane), [undefined, undefined], "the Violin's lane-B note is on lane A");
  const added = st().addLane(8);
  assert.equal(added, lane, 'the next lane takes the free id');
  assert.ok(parts()[0].notes.every((n) => n.lane === undefined), 'and none of the Violin’s notes joins the new looping lane');
  st().undo();
  st().undo();
  assert.equal(parts()[0].notes[1].lane, lane, 'undo puts the note back on its lane');
  // A note that still names a lane the roll lost (a clip saved before this) keeps new lanes off its id.
  st().setPartNotes(part(0).id, [{ ...note(0, 76), lane: 5 }]);
  assert.equal(st().addLane(4), 6, 'a new lane takes an id past every lane a note names');
}

console.log('pianoRollParts: ok');
