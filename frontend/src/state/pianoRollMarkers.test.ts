/**
 * The piano roll's named markers, replayed through the stores in the order a
 * user makes them:
 *
 *   FORM with a 7/8 intro, a section at its own tempo and a 5/4 chorus, then
 *   SONG: a section marker lands on each section's first bar line, and one undo
 *   takes the song and its markers back together. A movement marker is added,
 *   a FORM marker renamed and another dragged (one undo step per edit), and a
 *   slider move rebuilds the song keeping all three. The roll is bounced to
 *   EDIT: the clip carries the markers, and EDIT's timeline gets them at the
 *   seconds they sound through the clip's tempo map, in the bounce's one undo
 *   step. A rename and a second bounce replace them there instead of doubling
 *   them. The clip goes through a .tasmo save (JSON) and back into the roll
 *   with every marker as it was; a clip and a file from before markers open
 *   with none. RESET takes FORM's markers off and leaves the user's.
 *
 * At afd27bea the roll had no markers at all: the store had no `markers`, SONG
 * wrote none, a bounce carried none and a .tasmo clip had no `roll_markers`, so
 * every block below fails there. Run from `frontend/`:
 *   npx tsx src/state/pianoRollMarkers.test.ts
 */
import assert from 'node:assert/strict';

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  },
});

const { usePianoRollStore, beginRollGesture, endRollGesture } = await import('./pianoRollStore.ts');
const { useEditorStore } = await import('./editorStore.ts');
const { ZERO_AMOUNTS } = await import('../lib/virtuosoTransform.ts');
const { bounceRollToEditor } = await import('../lib/rollBounce.ts');
const { clipRollLoad } = await import('../lib/rollClip.ts');
const { clipNotesToTasmo, tasmoMeterToClip } = await import('../lib/projectClient.ts');
const { editMarkerId, markerBarLabel, markerStep } = await import('../lib/rollMarkers.ts');
const { stepClock } = await import('../lib/rollTempo.ts');
// Before `window` exists: the synth projectImport pulls in reads `document` when it sees a window.
const { applyTasmoMarkersAndLoop, markersToLocators } = await import('../lib/projectImport.ts');
type PianoNote = import('./pianoRollStore.ts').PianoNote;
type RollBounceDeps = import('../lib/rollBounce.ts').RollBounceDeps;
if (typeof window === 'undefined') Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
const { useVirtuosoStore } = await import('./virtuosoStore.ts');

const roll = () => usePianoRollStore.getState();
const ed = () => useEditorStore.getState();
const v = () => useVirtuosoStore.getState();
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 220));
/** A user's pause between two edits: longer than the roll's 300 ms undo coalescing. */
const pause = (): Promise<void> => new Promise((done) => setTimeout(done, 350));
const close = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const names = () => roll().markers.map((m) => m.name);
const bars = () => roll().markers.map((m) => markerBarLabel(m, roll().meterMap, roll().pickupSteps));

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  console.log(`  ok - ${name}`);
}

const phrase: PianoNote[] = [0, 2, 4, 5, 7, 9, 11, 12].map((d, i) => ({ id: `p${i}`, note: 60 + d, step: i * 2, length: 2, velocity: 90 }));
let rendered = 0;
const deps: RollBounceDeps = {
  render: (_notes, bpm, totalSteps, opts) => {
    rendered += 1;
    // The audio lasts as long as the roll plays through its tempo map.
    return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: stepClock(bpm, opts.tempoMap).at(totalSteps) });
  },
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
  global: () => ({ useSoundfont: false, activeProgram: 0 }),
};

async function main(): Promise<void> {
  ed().loadProject({ tracks: [], clips: [] });
  roll().setEditingClip(null);
  roll().applyMeter({ meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 2 });
  roll().importNotes(phrase, 96, undefined, [], undefined, []);
  useVirtuosoStore.setState({
    style: 'romantic',
    songMode: false,
    source: null,
    amounts: { ...ZERO_AMOUNTS },
    sections: [
      { role: 'intro', bars: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } },
      { role: 'theme', bars: 2, bpm: 132 },
      { role: 'chorus', bars: 2, meter: { num: 5, den: 4, groups: [3, 2] } },
      { role: 'theme', bars: 2 },
    ],
  });
  v().captureSource();
  await pause();

  await step('SONG writes a section marker on each FORM section\'s first bar line', () => {
    assert.deepEqual(roll().markers, [], 'the phrase has no markers');
    v().buildSong();
    assert.deepEqual(names(), ['Intro', 'Theme', 'Chorus', 'Theme 2']);
    assert.deepEqual(bars(), ['Bar 1', 'Bar 3', 'Bar 5', 'Bar 7'], 'after the 2-step pickup, through 7/8 and 5/4 bars');
    // Bar 1 starts after the pickup; two 7/8 bars are 14 steps each, two 4/4 bars 16 each.
    assert.deepEqual(roll().markers.map(markerStep), [2, 2 + 28, 2 + 28 + 32, 2 + 28 + 32 + 40]);
    assert.ok(roll().markers.every((m) => m.origin === 'form' && m.kind === 'section'));
  });

  await step('one undo takes back the song and its markers; redo brings both', () => {
    const built = roll().markers;
    roll().undo();
    assert.deepEqual(roll().markers, []);
    assert.equal(roll().notes.length, phrase.length);
    roll().redo();
    assert.deepEqual(roll().markers, built);
  });

  let movementId = '';
  await step('a movement is added, a FORM marker renamed and another dragged, each one undo step', async () => {
    await pause();
    const depth = roll()._undo.length;
    movementId = roll().addMarker({ step: 2, kind: 'movement', name: 'I. Allegro con brio' });
    await pause();
    const chorus = roll().markers.find((m) => m.name === 'Chorus')!;
    roll().updateMarker(chorus.id, { name: 'Development' });
    await pause();
    const theme2 = roll().markers.find((m) => m.name === 'Theme 2')!;
    // A slow drag across three bar lines is one step.
    beginRollGesture();
    roll().updateMarker(theme2.id, { step: markerStep(theme2) + 16 });
    await pause();
    roll().updateMarker(theme2.id, { step: markerStep(theme2) + 32 });
    endRollGesture();
    assert.equal(roll()._undo.length, depth + 3, 'three edits, three steps');
    assert.deepEqual(names(), ['I. Allegro con brio', 'Intro', 'Theme', 'Development', 'Theme 2']);
    const dev = roll().markers.find((m) => m.name === 'Development')!;
    assert.equal(dev.origin, undefined, 'a renamed FORM marker is the user\'s now');
    assert.equal(roll().markers.find((m) => m.name === 'Theme 2')?.origin, undefined, 'so is a moved one');
    roll().undo();
    assert.equal(markerStep(roll().markers.find((m) => m.name === 'Theme 2')!), 2 + 28 + 32 + 40, 'undo puts the dragged marker back');
    roll().redo();
  });

  await step('a slider move rebuilds the song and keeps every marker the user made or edited', async () => {
    v().setAmount('humanize', 0.4);
    await settle();
    assert.deepEqual(names(), ['I. Allegro con brio', 'Intro', 'Theme', 'Development', 'Theme 2']);
    const theme2 = roll().markers.find((m) => m.name === 'Theme 2')!;
    assert.equal(theme2.origin, undefined, 'the dragged Theme 2 is the one there');
    assert.equal(markerStep(theme2), 2 + 28 + 32 + 40 + 32, 'where the user put it; its section gets no second marker');
    assert.equal(roll().markers.filter((m) => m.origin === 'form').length, 2, 'FORM rewrote only the markers nobody edited');
    assert.equal(roll().markers.filter((m) => m.kind === 'movement').length, 1);
  });

  let clipId = '';
  await step('a bounce puts the markers on the clip and on EDIT\'s timeline at their seconds through the tempo map', async () => {
    await pause();
    ed().addMarker(1, 'My EDIT marker');
    const depth = ed()._undo.length;
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'created');
    clipId = done.clipId;
    const clip = ed().clips.find((c) => c.id === clipId)!;
    assert.deepEqual(clip.sourceMarkers, roll().markers, 'the clip carries the roll\'s markers');
    assert.notEqual(clip.sourceMarkers, roll().markers, 'as a copy');
    assert.ok(clip.sourceTempoMap?.length, 'the song changes tempo, so the clip has a map');
    const clock = stepClock(clip.sourceBpm!, clip.sourceTempoMap);
    const edit = ed().markers.filter((m) => m.id.startsWith(`roll:${clipId}:`));
    assert.equal(edit.length, roll().markers.length);
    for (const m of roll().markers) {
      const hit = edit.find((e) => e.id === editMarkerId(clipId, m.id));
      assert.ok(hit, `EDIT has ${m.name}`);
      close(hit.t, clip.startSec + clock.at(markerStep(m)), 1e-9, `${m.name} in seconds`);
      assert.equal(hit.label, m.name);
    }
    // The Theme at 132 BPM starts after the intro's ritardando, later than 96 BPM straight through would put it.
    const theme = roll().markers.find((m) => m.name === 'Theme')!;
    const themeSec = edit.find((e) => e.id === editMarkerId(clipId, theme.id))!.t;
    assert.ok(Math.abs(themeSec - markerStep(theme) * (60 / clip.sourceBpm! / 4)) > 0.01, 'the marker follows the tempo map');
    assert.ok(ed().markers.some((m) => m.label === 'My EDIT marker'), 'EDIT\'s own marker stays');
    assert.equal(ed()._undo.length, depth + 1, 'the new track, the clip and its markers are one EDIT undo step');
  });

  await step('a rename and a second bounce replace the clip\'s markers in EDIT instead of doubling them', async () => {
    await pause();
    roll().updateMarker(movementId, { name: 'I. Allegro' });
    const before = ed().markers.length;
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'updated' && done.clipId === clipId);
    assert.equal(ed().markers.length, before, 'no marker doubled');
    assert.equal(ed().markers.find((m) => m.id === editMarkerId(clipId, movementId))?.label, 'I. Allegro');
    roll().removeMarker(movementId);
    await bounceRollToEditor(deps);
    assert.equal(ed().markers.length, before - 1, 'a marker removed in the roll leaves EDIT on the next bounce');
    assert.ok(ed().markers.some((m) => m.label === 'My EDIT marker'));
    assert.equal(rendered, 3);
  });

  await step("EDIT's markers go through a .tasmo save and reopen with their ids, so a re-bounce after the reopen still replaces them", async () => {
    await pause();
    const before = ed().markers.map((m) => ({ ...m }));
    assert.ok(before.some((m) => m.id.startsWith(`roll:${clipId}:`)), 'the bounce wrote roll markers');
    // What saveProject writes (captureEditorSession's locators) and what the open path runs after loadProject.
    const file = JSON.parse(JSON.stringify({ locators: markersToLocators(ed().markers) }));
    useEditorStore.setState({ markers: [] });
    applyTasmoMarkersAndLoop(file);
    assert.deepEqual(ed().markers, before, 'ids, seconds and names as they were saved');
    // A user's own marker renamed after the reopen, so the re-bounce has a change to carry.
    const own = roll().markers.find((m) => m.name === 'Theme 2')!;
    roll().updateMarker(own.id, { name: 'Theme 2 reprise' });
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'updated');
    assert.equal(ed().markers.length, before.length, 'no marker doubled after the reopen');
    assert.equal(ed().markers.filter((m) => m.label === 'Theme 2 reprise').length, 1);
    assert.ok(!ed().markers.some((m) => m.label === 'Theme 2'), 'the old name went with the old marker');
    roll().updateMarker(own.id, { name: 'Theme 2' });
    await bounceRollToEditor(deps);
    assert.equal(ed().markers.length, before.length);
    // A second save and reopen of the same file is still no double.
    applyTasmoMarkersAndLoop(JSON.parse(JSON.stringify({ locators: markersToLocators(ed().markers) })));
    assert.equal(ed().markers.length, before.length, 'reapplying the same locators replaces them by id');
  });

  await step("moving, slipping, trimming and splitting the clip in EDIT carries its markers with its notes", async () => {
    await pause();
    const clip = (id = clipId) => ed().clips.find((c) => c.id === id)!;
    const own = (id = clipId) => ed().markers.filter((m) => m.id.startsWith(`roll:${id}:`));
    const at = () => Object.fromEntries(ed().markers.filter((m) => m.id.startsWith('roll:')).map((m) => [m.id, m.t]));
    const before = at();
    assert.equal(Object.keys(before).length, 4, 'Intro, Theme, Development (the renamed Chorus) and Theme 2 are on the timeline');
    const mine = ed().markers.find((m) => m.label === 'My EDIT marker')!;
    const depth = ed()._undo.length;
    // A move of 2 s: the clip's markers move 2 s in the same undo step; EDIT's own marker stays.
    ed().updateClip(clipId, { startSec: clip().startSec + 2 });
    for (const [id, t] of Object.entries(before)) close(at()[id], t + 2, 1e-9, `${id} moved with the clip`);
    assert.equal(ed().markers.find((m) => m.id === mine.id)!.t, mine.t, "EDIT's own marker stays");
    assert.equal(ed()._undo.length, depth + 1, 'the move and its markers are one undo step');
    ed().undo();
    for (const [id, t] of Object.entries(before)) close(at()[id], t, 1e-9, `${id} back with the undo`);
    await pause();
    // A left-edge trim moves the edge and the trim together: the notes stay where they sound, so do the markers.
    const c0 = clip();
    ed().updateClip(clipId, { startSec: c0.startSec + 0.1, offsetIntoSource: c0.offsetIntoSource + 0.1, durationSec: c0.durationSec - 0.1 });
    for (const [id, t] of Object.entries(before)) close(at()[id], t, 1e-9, `${id} stays through a left trim`);
    ed().undo();
    await pause();
    // A slip slides the source under a fixed edge: the notes move, and the markers with them.
    ed().updateClip(clipId, { offsetIntoSource: clip().offsetIntoSource + 0.25 });
    for (const [id, t] of Object.entries(before)) close(at()[id], t - 0.25, 1e-9, `${id} slips with the notes`);
    ed().undo();
    await pause();
    // A split between Theme and Development: the markers past the seam belong to the right half.
    const times = own().map((m) => m.t).sort((a, b) => a - b);
    const seam = (times[1] + times[2]) / 2;
    const rightId = ed().splitClipAt(clipId, seam)!;
    assert.ok(rightId, 'the clip splits');
    assert.deepEqual(own().map((m) => m.label).sort(), ['Intro', 'Theme'], 'the left half keeps the markers before the seam');
    assert.deepEqual(own(rightId).map((m) => m.label).sort(), ['Development', 'Theme 2'], 'the right half takes the rest');
    assert.equal(ed().markers.length, Object.keys(before).length + 1, 'no marker doubled or lost');
    await pause();
    // Moving the right half moves only its markers.
    const leftAt = own().map((m) => m.t);
    const rightAt = own(rightId).map((m) => m.t);
    ed().updateClip(rightId, { startSec: clip(rightId).startSec + 1 });
    assert.deepEqual(own().map((m) => m.t), leftAt, "the left half's markers stay");
    own(rightId).forEach((m, i) => close(m.t, rightAt[i] + 1, 1e-9, `${m.label} moved with the right half`));
    ed().undo();
    ed().undo();
    assert.deepEqual(at(), before, 'two undos bring back the one clip and its markers');
    assert.equal(ed().clips.filter((c) => c.id === clipId).length, 1);
  });

  await step('a .tasmo save and reopen brings every marker back into the roll', () => {
    const clip = ed().clips.find((c) => c.id === clipId)!;
    const file = JSON.parse(JSON.stringify({ ...clipNotesToTasmo(clip), id: clip.id }));
    assert.ok(Array.isArray(file.roll_markers) && file.roll_markers.length === roll().markers.length, 'the file has roll_markers');
    const reopened = { ...clip, ...tasmoMeterToClip(file) };
    const want = roll().markers;
    roll().clear();
    roll().setMarkers([]);
    roll().loadFromClip(...clipRollLoad(reopened));
    assert.deepEqual(roll().markers, want, 'ids, ticks, names, kinds and FORM origins as they were');
    // Undoing the open brings back the roll from before it, markers included.
    roll().undo();
    assert.deepEqual(roll().markers, []);
    roll().redo();
    assert.deepEqual(roll().markers, want);
  });

  await step('a clip and a file from before markers open with none', () => {
    const clip = ed().clips.find((c) => c.id === clipId)!;
    const { sourceMarkers: _gone, ...old } = clip;
    roll().loadFromClip(...clipRollLoad(old));
    assert.deepEqual(roll().markers, []);
    const { roll_markers: _none, ...oldFile } = JSON.parse(JSON.stringify(clipNotesToTasmo(clip)));
    assert.equal(tasmoMeterToClip(oldFile).sourceMarkers, undefined);
    roll().undo();
  });

  await step('an import that brings no markers keeps the roll\'s; a new file clears them', () => {
    const had = roll().markers.length;
    assert.ok(had > 0);
    roll().importNotes(roll().notes, roll().bpm);
    assert.equal(roll().markers.length, had, 'AI COMPOSE, the arpeggiator and takes keep the markers');
    roll().importNotes(phrase, 120, undefined, [], undefined, []);
    assert.deepEqual(roll().markers, [], 'a MIDI or sheet file is a new document');
    roll().undo();
    assert.equal(roll().markers.length, had);
  });

  await step("RESET takes FORM's markers off and leaves the user's", () => {
    v().resetToSource();
    assert.ok(roll().markers.length > 0);
    assert.ok(roll().markers.every((m) => m.origin !== 'form'), 'no FORM marker is left');
    assert.deepEqual(names(), ['Development', 'Theme 2']);
  });

  console.log('pianoRollMarkers: ok');
}

await main();
