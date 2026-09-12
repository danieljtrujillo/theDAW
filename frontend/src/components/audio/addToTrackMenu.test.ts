// Run with: npx tsx src/components/audio/addToTrackMenu.test.ts
import assert from 'node:assert/strict';
import {
  ADD_SOURCE_ENTRY_IDS,
  addToTrackGroupLabel,
  buildAddToTrackMenu,
  isAddSourceEntry,
  type AddToTrackCapabilities,
  type AddToTrackEntry,
  type AddToTrackEntryId,
  type AddToTrackTarget,
} from './addToTrackMenu.ts';

const ALL_IDS: AddToTrackEntryId[] = [
  'audio-library',
  'audio-system',
  'midi-library',
  'midi-system',
  'paste',
  'new-track',
];

/** A loaded library with everything available. */
const fullCaps: AddToTrackCapabilities = {
  libraryAudioCount: 12,
  libraryMidiCount: 4,
  clipboardClipCount: 2,
  trackCount: 3,
};

/** A fresh install: nothing in the library, nothing copied, no tracks. */
const emptyCaps: AddToTrackCapabilities = {
  libraryAudioCount: 0,
  libraryMidiCount: 0,
  clipboardClipCount: 0,
  trackCount: 0,
};

const onTrack: AddToTrackTarget = { trackId: 'trk-1', trackName: 'Bassline', atSec: 12.5 };
const belowAllTracks: AddToTrackTarget = { trackId: null, trackName: null, atSec: 0 };

const ids = (entries: AddToTrackEntry[]) => entries.map((e) => e.id);
const byId = (entries: AddToTrackEntry[], id: AddToTrackEntryId) => {
  const hit = entries.find((e) => e.id === id);
  assert.ok(hit, `entry ${id} present`);
  return hit;
};

// (a) Right-click ON a track: the header names that track, nothing claims to
// create one, and the hover text says where the clip lands. This is the bug the
// rebuild fixes — the old flow said "add to track" and always made a new one.
{
  const menu = buildAddToTrackMenu(onTrack, fullCaps);
  assert.deepEqual(ids(menu), ALL_IDS);
  assert.equal(addToTrackGroupLabel(onTrack), 'Add to Bassline');
  for (const id of ADD_SOURCE_ENTRY_IDS) {
    assert.equal(byId(menu, id).createsTrack, false, `${id} reuses the clicked track`);
    assert.ok(byId(menu, id).title.includes('onto Bassline'), `${id} names the track`);
    assert.ok(byId(menu, id).title.includes('12.50s'), `${id} names the time`);
  }
  // 'New empty track' is the one add entry that always makes a track.
  assert.equal(byId(menu, 'new-track').createsTrack, true);
  assert.equal(byId(menu, 'paste').createsTrack, false);
}

// (b) Right-click BELOW all tracks: the same entries, but every add creates a
// track — matching what dropping a file in that band already does.
{
  const menu = buildAddToTrackMenu(belowAllTracks, fullCaps);
  assert.deepEqual(ids(menu), ALL_IDS);
  assert.equal(addToTrackGroupLabel(belowAllTracks), 'Add to a new track');
  for (const id of ADD_SOURCE_ENTRY_IDS) {
    assert.equal(byId(menu, id).createsTrack, true, `${id} creates a track`);
    assert.ok(byId(menu, id).title.includes('onto a new track'));
  }
}

// (c) Every source x kind combination is present exactly once, and each is
// tagged with the kind and source its handler routes on.
{
  const menu = buildAddToTrackMenu(onTrack, fullCaps);
  const combos = menu
    .filter(isAddSourceEntry)
    .map((e) => `${e.kind}/${e.source}`)
    .sort();
  assert.deepEqual(combos, [
    'audio/library',
    'audio/system',
    'midi/library',
    'midi/system',
  ]);
  assert.equal(byId(menu, 'audio-library').kind, 'audio');
  assert.equal(byId(menu, 'audio-library').source, 'library');
  assert.equal(byId(menu, 'audio-system').kind, 'audio');
  assert.equal(byId(menu, 'audio-system').source, 'system');
  assert.equal(byId(menu, 'midi-library').kind, 'midi');
  assert.equal(byId(menu, 'midi-library').source, 'library');
  assert.equal(byId(menu, 'midi-system').kind, 'midi');
  assert.equal(byId(menu, 'midi-system').source, 'system');
  // The two non-clip entries carry neither, so no handler can mistake them.
  assert.equal(byId(menu, 'paste').kind, null);
  assert.equal(byId(menu, 'paste').source, null);
  assert.equal(byId(menu, 'new-track').kind, null);
  assert.equal(byId(menu, 'new-track').source, null);
  assert.equal(isAddSourceEntry(byId(menu, 'paste')), false);
  assert.equal(isAddSourceEntry(byId(menu, 'new-track')), false);
}

// (d) Empty everything: the two LIBRARY rows are disabled with a reason, the
// two SYSTEM rows stay live (a file picker needs no library), paste is
// disabled, and 'New empty track' still works — a fresh install must not be a
// dead menu.
{
  const menu = buildAddToTrackMenu(belowAllTracks, emptyCaps);
  assert.deepEqual(ids(menu), ALL_IDS);
  assert.equal(byId(menu, 'audio-library').enabled, false);
  assert.match(byId(menu, 'audio-library').title, /No audio in the library/);
  assert.equal(byId(menu, 'midi-library').enabled, false);
  assert.match(byId(menu, 'midi-library').title, /No MIDI in the library/);
  assert.equal(byId(menu, 'audio-system').enabled, true);
  assert.equal(byId(menu, 'midi-system').enabled, true);
  assert.equal(byId(menu, 'paste').enabled, false);
  assert.match(byId(menu, 'paste').title, /Copy or cut a clip first/);
  assert.equal(byId(menu, 'new-track').enabled, true);
}

// (e) An UNREAD index (null) is not an empty one: the row stays offered,
// because disabling it on "we haven't fetched yet" would hide a working library
// behind a race with the index request. The library store loads on an idle
// callback after boot, so this is the state of a right-click in the first
// second of the app's life, not a hypothetical.
{
  const unread = buildAddToTrackMenu(onTrack, { ...fullCaps, libraryMidiCount: null });
  assert.equal(byId(unread, 'midi-library').enabled, true);
  const known = buildAddToTrackMenu(onTrack, { ...fullCaps, libraryMidiCount: 0 });
  assert.equal(byId(known, 'midi-library').enabled, false);

  const unreadAudio = buildAddToTrackMenu(onTrack, { ...fullCaps, libraryAudioCount: null });
  assert.equal(byId(unreadAudio, 'audio-library').enabled, true);
  const knownEmptyAudio = buildAddToTrackMenu(onTrack, { ...fullCaps, libraryAudioCount: 0 });
  assert.equal(byId(knownEmptyAudio, 'audio-library').enabled, false);

  // Both unread at once — a cold boot — must leave a fully usable menu.
  const cold = buildAddToTrackMenu(belowAllTracks, {
    ...emptyCaps,
    libraryAudioCount: null,
    libraryMidiCount: null,
  });
  for (const id of ADD_SOURCE_ENTRY_IDS) {
    assert.equal(byId(cold, id).enabled, true, `${id} stays offered on a cold boot`);
  }
}

// (f) Paste: needs clips on the clipboard AND somewhere to put them. Clicking a
// track is somewhere; clicking below all tracks with no tracks at all is not.
{
  const noTracksBelow = buildAddToTrackMenu(belowAllTracks, {
    ...fullCaps,
    trackCount: 0,
  });
  assert.equal(byId(noTracksBelow, 'paste').enabled, false);
  assert.match(byId(noTracksBelow, 'paste').title, /no track to paste onto/);

  // Paste never makes a track, so its hover text must not borrow the add
  // entries' "onto a new track" — below all lanes the clips go back where they
  // were cut from.
  const pasteBelow = byId(buildAddToTrackMenu(belowAllTracks, fullCaps), 'paste');
  assert.ok(!pasteBelow.title.includes('new track'), pasteBelow.title);
  assert.match(pasteBelow.title, /on the tracks it came from/);
  assert.match(byId(buildAddToTrackMenu(onTrack, fullCaps), 'paste').title, /onto Bassline/);

  // Same empty project, but the click landed on a lane: that lane is the target.
  const onLaneNoTracks = buildAddToTrackMenu(onTrack, { ...fullCaps, trackCount: 0 });
  assert.equal(byId(onLaneNoTracks, 'paste').enabled, true);

  // Clipboard count drives the label so the user knows how much is coming.
  assert.equal(byId(buildAddToTrackMenu(onTrack, fullCaps), 'paste').label, 'Paste 2 clips here');
  assert.equal(
    byId(buildAddToTrackMenu(onTrack, { ...fullCaps, clipboardClipCount: 1 }), 'paste').label,
    'Paste clip here',
  );
}

// (g) A track with no name (an auto-named track the user cleared) still gets a
// readable header and hover text instead of "Add to ".
{
  const nameless: AddToTrackTarget = { trackId: 'trk-9', trackName: '', atSec: 4 };
  assert.equal(addToTrackGroupLabel(nameless), 'Add to this track');
  assert.ok(byId(buildAddToTrackMenu(nameless, fullCaps), 'audio-library').title.includes('onto this track'));
}

console.log('addToTrackMenu: all assertions passed');
