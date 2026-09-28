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
  usePianoRollStore.setState({ _undo: [{ notes: s.notes, bpm: s.bpm, tempoMap: s.tempoMap, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote, meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends, voiceProgram: s.voiceProgram }], _redo: [] });
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
  st().loadFromClip('clip-vn', [note(0, 67)], 100, 64, undefined, undefined, undefined, {
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
    _undo: [{ notes: [note(1), note(3), note(5)], bpm: s.bpm, tempoMap: s.tempoMap, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote, meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends, voiceProgram: s.voiceProgram }],
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

console.log('pianoRollParts: ok');
