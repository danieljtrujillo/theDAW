/**
 * Virtuoso's SONG build writes its phrasing as TEMPO: each section's last bar
 * is a linear ritardando in the song's tempo map, deeper at the final cadence,
 * a section can hold a tempo of its own, and every note stays on its step.
 *
 * At 30a3edf buildSong wrote the ritardando into note positions: every note
 * after a section end moved later by the rubato depth, so with ten sections and
 * Humanize at 0 the tenth section started 4.5 sixteenths after its bar line,
 * and a bounce or a MIDI file put every later note off its bar. The first block
 * below fails there.
 *
 * The store blocks replay the UI's order: notes in the roll, CAPTURE, a form
 * with section tempos, SONG, undo and redo, a slider move (a debounced
 * rebuild), a point drawn in the TEMPO lane, RESET. The roll's own map (a slow
 * introduction drawn by hand) is what sections without a tempo follow, and
 * RESET puts it back.
 * Run from `frontend/`:
 *   npx tsx src/state/virtuosoTempo.test.ts
 */
import assert from 'node:assert/strict';

// The persisted sections a user saved: a valid tempo, a tempo past 300 and a
// junk tempo. They load before the store is imported.
const saved = new Map<string, string>([
  ['thedaw-virtuoso-v1', JSON.stringify({ state: { sections: [{ role: 'intro', bars: 2, bpm: 58.5 }, { role: 'theme', bars: 2, bpm: 999 }, { role: 'outro', bars: 2, bpm: 'fast' }] }, version: 0 })],
]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  },
});


const { usePianoRollStore } = await import('./pianoRollStore.ts');
const { buildSong, ritDepth, RIT_FINAL_MULT, ZERO_AMOUNTS } = await import('../lib/virtuosoTransform.ts');
const { stepClock } = await import('../lib/rollTempo.ts');
const { PPQ } = await import('../lib/noteClock.ts');
type PianoNote = import('./pianoRollStore.ts').PianoNote;
type TempoEvent = import('../lib/tempoMap.ts').TempoEvent;
// The store's persisted state loads through window.localStorage, so window exists before the
// virtuoso store is imported and after the roll store, whose graph arms window listeners only
// in a real browser.
if (typeof window === 'undefined') Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
const { useVirtuosoStore } = await import('./virtuosoStore.ts');

const TICK = 1 / PPQ;
const close = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const phrase: PianoNote[] = [0, 2, 4, 5, 7, 9, 11, 12].map((d, i) => ({ id: `p${i}`, note: 60 + d, step: i * 2, length: 2, velocity: 90 }));
const tempoAt = (map: readonly TempoEvent[], beat: number) => map.find((e) => !e.fermata && Math.abs(e.beat - beat) < 1e-9);
/** Seconds of a linear ramp from v0 to v1 over `beats` quarter notes, in closed form. */
const rampSec = (v0: number, v1: number, beats: number) => (v0 === v1 ? (60 * beats) / v0 : (60 * beats * Math.log(v1 / v0)) / (v1 - v0));

// The stored sections load with their tempo kept inside 20..300; a junk tempo is dropped.
assert.deepEqual(useVirtuosoStore.getState().sections, [
  { role: 'intro', bars: 2, bpm: 58.5 },
  { role: 'theme', bars: 2, bpm: 300 },
  { role: 'outro', bars: 2 },
]);

// --- buildSong: the ritardando is tempo, the notes stay on their steps ------- //
{
  // 80 seconds at 120 is 40 bars: ten four-bar sections.
  const song = buildSong(phrase, { key: 'C', mode: 'minor', style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 120, targetSec: 80 });
  for (let k = 0; k < 10; k += 1) {
    const start = k * 64;
    // The section's downbeat: its left hand and its melody start together on the bar line.
    // Humanize's micro-timing stays under a fifth of a step; the old rubato put section 10 at +4.5.
    const downbeat = song.notes.filter((n) => Math.abs(n.step - start) <= 0.2);
    assert.ok(downbeat.length >= 2, `section ${k + 1} starts on its bar line (${downbeat.length} notes at step ${start})`);
    assert.ok(downbeat.some((n) => n.note < 60), `section ${k + 1}'s left hand starts on its bar line`);
  }
  // Every section ramps over its last bar and the next one comes back a tempo.
  const d = ritDepth(0, false);
  const dFinal = ritDepth(0, true);
  close(dFinal, d * RIT_FINAL_MULT, 1e-12, 'the final ritardando is deeper');
  for (let k = 0; k < 10; k += 1) {
    const lastBar = k * 16 + 12;
    const end = k * 16 + 16;
    const from = tempoAt(song.tempoMap, lastBar);
    assert.ok(from && from.curve === 'linear' && from.bpm === 120, `section ${k + 1}'s last bar starts a ramp at 120`);
    const to = tempoAt(song.tempoMap, end - TICK);
    assert.ok(to, `section ${k + 1}'s ramp reaches its end a tick before the bar line`);
    close(to.bpm, 120 * (1 - (k === 9 ? dFinal : d)), 1e-9, `section ${k + 1}'s ritardando depth`);
    if (k < 9) assert.equal(tempoAt(song.tempoMap, end)?.bpm, 120, `section ${k + 2} starts a tempo`);
  }

  // A bounce's clock: bars 1-3 last 2 s each at 120, bar 4 is the ramp plus one tick held.
  const clock = stepClock(120, song.tempoMap);
  close(clock.at(48), 6, 1e-9, 'the first three bars are untouched');
  const bar4 = rampSec(120, 120 * (1 - d), 4 - TICK) + (60 / (120 * (1 - d))) * TICK;
  close(clock.at(64) - clock.at(48), bar4, 1e-9, 'bar 4 is the ramp in closed form');
  assert.ok(bar4 > 2.05, 'the last bar is slower than the others');
  close(clock.at(80) - clock.at(64), 2, 1e-9, 'the next section is a tempo');
  // A note that starts bar 4 sounds at 6 s: the ramp after it moves no note.
  const onBar4 = song.notes.find((n) => Math.abs(n.step - 48) < 0.2);
  assert.ok(onBar4, 'a note starts bar 4');
  close(clock.at(onBar4.step), 6, 0.2 * (60 / 120 / 4), 'bar 4 starts at 6 s');

  // Humanize at 1 deepens every ritardando, and caps the final one at half the tempo.
  const deep = buildSong(phrase, { key: 'C', mode: 'minor', style: 'romantic', amounts: { ...ZERO_AMOUNTS, humanize: 1 }, bpm: 120, targetSec: 80 });
  close(tempoAt(deep.tempoMap, 16 - TICK)!.bpm, 120 * (1 - 0.24), 1e-9, 'Humanize 1 gives a 24% ritardando');
  close(tempoAt(deep.tempoMap, 160 - TICK)!.bpm, 120 * (1 - 0.5), 1e-9, 'the final one stops at half');
}

// A section's own tempo holds until the next change: a later section without
// a tempo keeps it, as in a score, and never falls back to the roll's base
// tempo. Before this, the outro below jumped back to 100.
{
  const base: TempoEvent[] = [{ beat: 0, bpm: 100 }];
  const sections = [
    { role: 'intro' as const, bars: 2, bpm: 56 },
    { role: 'theme' as const, bars: 2, bpm: 132 },
    { role: 'outro' as const, bars: 2 },
  ];
  const song = buildSong(phrase, { key: 'C', mode: 'major', style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 100, sections, tempoMap: base });
  const at = (b: number) => tempoAt(song.tempoMap, b);
  assert.equal(at(0)?.bpm, 56, 'the slow introduction');
  assert.equal(at(4)?.curve, 'linear', "the introduction's last bar ramps");
  close(at(8 - TICK)!.bpm, 56 * 0.94, 1e-9, 'into its cadence');
  assert.equal(at(8)?.bpm, 132, 'the Allegro starts on its bar line');
  close(at(16 - TICK)!.bpm, 132 * 0.94, 1e-9, "the Allegro's ritardando");
  assert.equal(at(16)?.bpm, 132, "the outro keeps the Allegro's tempo, not the roll's 100");
  close(at(24 - TICK)!.bpm, 132 * (1 - 0.06 * 2.2), 1e-9, 'the final cadence slows from 132');
  assert.ok(!song.tempoMap.some((e) => !e.fermata && e.beat > 0 && e.bpm === 100), 'the roll base tempo never comes back');
  // Seconds: bar 1 at 56, then the Allegro's first bar at 132.
  const clock = stepClock(56, song.tempoMap);
  close(clock.at(16), (4 * 60) / 56, 1e-9, 'bar 1 lasts four quarters at 56');
  close(clock.at(48) - clock.at(32), (4 * 60) / 132, 1e-9, 'bar 3 lasts four quarters at 132');
  close(clock.at(80) - clock.at(64), (4 * 60) / 132, 1e-9, 'bar 5, the outro, lasts four quarters at 132');

  // The sections before the first section tempo follow the roll's map; a point
  // of the roll's map past a section with a tempo is the next change.
  const later = buildSong(phrase, {
    key: 'C', mode: 'major', style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 100,
    sections: [{ role: 'intro', bars: 2 }, { role: 'theme', bars: 2, bpm: 132 }, { role: 'interlude', bars: 2 }, { role: 'outro', bars: 2 }],
    tempoMap: [{ beat: 0, bpm: 100 }, { beat: 28, bpm: 90 }],
  });
  const la = (b: number) => tempoAt(later.tempoMap, b);
  assert.equal(la(0)?.bpm, 100, 'section 1 has no tempo and nothing before it: the roll map');
  assert.equal(la(8)?.bpm, 132, 'section 2 sets 132');
  assert.equal(la(16)?.bpm, 132, 'section 3 keeps 132');
  assert.equal(la(28)?.bpm, 90, "the roll map's own change at beat 28 still happens");
  assert.equal(la(24)?.bpm, 132, 'section 4 starts a tempo at 132, the tempo in force at its bar line');
}

// The roll's drawn map is followed: its tempo change and its own ramp stay.
{
  const drawn: TempoEvent[] = [{ beat: 0, bpm: 56 }, { beat: 8, bpm: 120 }, { beat: 24, bpm: 120, curve: 'linear' }, { beat: 32, bpm: 72 }];
  const song = buildSong(phrase, { key: 'C', mode: 'major', style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 56, tempoMap: drawn });
  assert.equal(tempoAt(song.tempoMap, 0)?.bpm, 56);
  assert.equal(tempoAt(song.tempoMap, 8)?.bpm, 120, 'the drawn tempo change stays');
  assert.equal(tempoAt(song.tempoMap, 24)?.curve, 'linear', 'the drawn ramp stays');
  close(tempoAt(song.tempoMap, 28)!.bpm, 96, 1e-9, "section 2's ritardando starts where the drawn ramp is");
  assert.equal(tempoAt(song.tempoMap, 32)?.bpm, 72, 'the drawn ramp still lands on 72');
}

// --- the store: SONG writes the map into the roll, with undo ---------------- //
const roll = () => usePianoRollStore.getState();
const v = () => useVirtuosoStore.getState();
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 220));
/** A user's pause between two presses: longer than the roll's 300 ms undo coalescing. */
const pause = (): Promise<void> => new Promise((done) => setTimeout(done, 350));
const DRAWN: TempoEvent[] = [{ beat: 0, bpm: 56 }, { beat: 8, bpm: 120 }];
{
  roll().applyMeter({ meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  roll().importNotes(phrase, 56, undefined, [], DRAWN);
  const before = roll().tempoMap;
  useVirtuosoStore.setState({ sections: null, style: 'romantic', songMode: false, source: null, amounts: { ...ZERO_AMOUNTS } });
  v().captureSource();
  await pause();
  // FORM: section 1 slow, section 2 an Allegro.
  v().setSectionTempo(0, 60);
  v().setSectionTempo(1, 138.25);
  v().buildSong();
  assert.ok(roll().notes.length > phrase.length, 'the song was built into the roll');
  assert.equal(roll().bpm, 60, "the header shows section 1's tempo");
  assert.equal(tempoAt(roll().tempoMap, 16)?.bpm, 138.25, 'section 2 starts at its tempo');
  assert.equal(tempoAt(roll().tempoMap, 12)?.curve, 'linear', "section 1's last bar ramps");
  assert.equal(tempoAt(roll().tempoMap, 32)?.bpm, 138.25, "section 3 keeps section 2's tempo");
  const built = roll().tempoMap;

  // One undo takes back the notes and the map together; redo brings both back.
  roll().undo();
  assert.deepEqual(roll().tempoMap, before, 'undo restores the map from before the song');
  assert.deepEqual(roll().notes.map((n) => n.step), phrase.map((n) => n.step));
  roll().redo();
  assert.deepEqual(roll().tempoMap, built, 'redo restores the song map');

  // A slider move rebuilds the song; the ritardandos are laid once, never twice.
  v().setAmount('humanize', 0.5);
  await settle();
  const expected = buildSong(v().source ?? [], {
    key: v().key,
    mode: v().mode,
    style: 'romantic',
    amounts: v().amounts,
    bpm: 56,
    sections: v().sections ?? undefined,
    tempoMap: before,
    pickupSteps: 0,
    meterMap: roll().meterMap,
  });
  assert.deepEqual(roll().tempoMap, expected.tempoMap, 'the rebuilt map is a fresh build over the roll map, not a ramp over a ramp');

  // A point drawn in the TEMPO lane during song mode is kept by the next rebuild.
  roll().addTempoEvent({ beat: 40, bpm: 90, curve: 'step' });
  v().setSectionBars(2, 4);
  await settle();
  assert.equal(tempoAt(roll().tempoMap, 40)?.bpm, 90, 'the drawn point survives the rebuild');
  assert.equal(tempoAt(roll().tempoMap, 16)?.bpm, 138.25, 'the section tempo is still written');

  // Removing a section tempo: its bars keep section 1's tempo, the one in force.
  v().setSectionTempo(1, null);
  await settle();
  assert.equal(tempoAt(roll().tempoMap, 16)?.bpm, 60, "section 2 keeps section 1's 60 once its own tempo is gone");

  // RESET: the source phrase under the map it followed, with the point drawn in song mode.
  v().resetToSource();
  assert.deepEqual(roll().notes.map((n) => n.step), phrase.map((n) => n.step));
  assert.equal(roll().bpm, 56);
  assert.equal(tempoAt(roll().tempoMap, 8)?.bpm, 120);
  assert.equal(tempoAt(roll().tempoMap, 40)?.bpm, 90, 'the point drawn by hand stays');
  assert.ok(!roll().tempoMap.some((e) => e.curve === 'linear'), 'no song ritardando is left');
}

console.log('virtuosoTempo: ok');
