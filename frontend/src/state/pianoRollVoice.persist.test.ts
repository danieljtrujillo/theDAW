// The roll's own voice survives a reload.
//
// The Vocal2MIDI panel's Roll voice (pianoRollStore voiceProgram) is a
// setting beside Q, SWING and the groove, and rides in their localStorage
// record. Before this it lived only in memory, so a reload put the roll back on
// the instrument picker. The sequence: the voice is chosen, the page reloads
// (a fresh copy of the store module reads the record), the voice is back; a
// record an earlier build wrote, with no voice in it, loads its feel and
// follows the picker.
import assert from 'node:assert/strict';

const saved = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, String(v)),
  removeItem: (k: string) => void saved.delete(k),
  clear: () => saved.clear(),
  key: () => null,
  length: 0,
};
const FEEL_KEY = 'thedaw.roll.feel.v1';

type Store = typeof import('./pianoRollStore.ts');
let reloads = 0;
/** The store as a page load evaluates it: a module copy of its own. */
const load = async (): Promise<Store> => (await import(`./pianoRollStore.ts?reload=${(reloads += 1)}`)) as Store;

{
  const first = await load();
  const st = () => first.usePianoRollStore.getState();
  assert.equal(st().voiceProgram, null, 'nothing saved: the roll follows the picker');
  st().setQuantizePct(70);
  st().setVoiceProgram(48);
  st().setSwingPct(12);
  const record = JSON.parse(saved.get(FEEL_KEY) ?? '{}');
  assert.equal(record.voiceProgram, 48, 'a swing change keeps the voice in the record');

  const second = await load();
  const back = second.usePianoRollStore.getState();
  assert.equal(back.voiceProgram, 48, 'the voice comes back after a reload');
  assert.deepEqual([back.quantizePct, back.swingPct], [70, 12], 'and so does the feel');

  back.setVoiceProgram(null);
  const third = await load();
  assert.equal(third.usePianoRollStore.getState().voiceProgram, null, 'following the picker is saved too');
}

// Undo and redo of a voice choice write the record too: a reload after an undo
// comes back on the voice the undo put back, and restoring a project's voice
// saves it the same way.
{
  saved.delete(FEEL_KEY);
  const page = await load();
  const st = () => page.usePianoRollStore.getState();
  st().setVoiceProgram(40);
  st().setVoiceProgram(48);
  st().undo();
  assert.equal(st().voiceProgram, 40);
  assert.equal((await load()).usePianoRollStore.getState().voiceProgram, 40, 'the undone voice is the saved one');
  st().redo();
  assert.equal((await load()).usePianoRollStore.getState().voiceProgram, 48, 'and the redone one after a redo');
  st().restoreVoiceProgram(24);
  assert.equal(st()._undo.every((step) => step.voiceProgram === 24), true, 'the history takes the opened voice');
  assert.equal((await load()).usePianoRollStore.getState().voiceProgram, 24, 'a project voice is saved as well');
}

// A record an earlier build wrote: its feel loads, and the roll follows the picker.
{
  saved.set(FEEL_KEY, JSON.stringify({ quantizePct: 40, swingPct: -6, grooveId: 'pocket:a' }));
  const older = (await load()).usePianoRollStore.getState();
  assert.deepEqual([older.quantizePct, older.swingPct, older.grooveId, older.voiceProgram], [40, -6, 'pocket:a', null]);
}

// A hand-edited record: a program outside 0-127 is held to it, and junk follows the picker.
{
  saved.set(FEEL_KEY, JSON.stringify({ quantizePct: 100, swingPct: 0, grooveId: 'swing', voiceProgram: 300 }));
  assert.equal((await load()).usePianoRollStore.getState().voiceProgram, 127);
  saved.set(FEEL_KEY, JSON.stringify({ quantizePct: 100, swingPct: 0, grooveId: 'swing', voiceProgram: 'strings' }));
  assert.equal((await load()).usePianoRollStore.getState().voiceProgram, null);
}

console.log('pianoRollVoice.persist: ok');
