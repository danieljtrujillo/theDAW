/**
 * vstParamStore — the plugin's own parameter list, as the app keeps it.
 *
 * Run: npx tsx src/state/vstParamStore.test.ts
 */
import assert from 'node:assert/strict';

import {
  isVstChoiceParam,
  paramFromWire,
  useVstParamStore,
  visibleVstParams,
  vstParamKey,
  vstStepValue,
  vstTextKey,
  type VstParamWire,
} from './vstParamStore.ts';

const wire = (index: number, over: Partial<VstParamWire> = {}): VstParamWire => ({
  index,
  name: `Param ${index}`,
  label: '',
  default: 0.5,
  value: 0.5,
  steps: 0,
  automatable: true,
  discrete: false,
  boolean: false,
  ...over,
});
const st = () => useVstParamStore.getState();

/* ── an older host sends no flags and no text: nothing is hidden, nothing is read-only ── */
{
  const p = paramFromWire(wire(3));
  assert.deepEqual(
    { hidden: p.hidden, readOnly: p.readOnly, bypass: p.bypass, programChange: p.programChange, text: p.text },
    { hidden: false, readOnly: false, bypass: false, programChange: false, text: '' },
  );
  assert.equal(vstParamKey(3), 'p3', 'the key is the one ChainEntry.params already uses');
}

/* ── the list keeps EVERY parameter (the index is the plugin's own); the panel shows the visible ones ── */
{
  st().setList('e1', [wire(0), wire(1, { hidden: true }), wire(2, { read_only: true, text: '-3.1 dB' })]);
  const list = st().lists.e1;
  assert.deepEqual(list.map((p) => p.index), [0, 1, 2]);
  assert.deepEqual(visibleVstParams(list).map((p) => p.index), [0, 2]);
  assert.equal(list[2].readOnly, true);
  assert.equal(list[2].text, '-3.1 dB');
}

/* ── a value that moved carries its text; an unchanged one does not swap the list ── */
{
  const before = st().lists.e1;
  st().setValue('e1', 0, 0.5);
  assert.equal(st().lists.e1, before, 'same value, no text: nothing to re-render');
  st().setValue('e1', 0, 0.25, '-12.0 dB');
  assert.equal(st().lists.e1[0].value, 0.25);
  assert.equal(st().lists.e1[0].text, '-12.0 dB');
  assert.notEqual(st().lists.e1, before);
  st().setValue('e1', 0, 0.3); // moved, the host said nothing about text yet: keep the old words
  assert.equal(st().lists.e1[0].text, '-12.0 dB');
  st().setValue('nope', 0, 0.1); // unknown entry / index: no throw, no change
  st().setValue('e1', 99, 0.1);
}

/* ── a late text answer never labels a newer value ── */
{
  st().setValue('e1', 0, 0.8);
  st().setText('e1', 0, 0.3, 'stale words'); // asked while the slider was at 0.3
  assert.equal(st().lists.e1[0].text, '-12.0 dB', 'the answer for 0.3 is dropped: the value is 0.8 now');
  st().setText('e1', 0, 0.8, '-1.9 dB');
  assert.equal(st().lists.e1[0].text, '-1.9 dB');
}

/* ── a program list or a mode is a LIST of the plugin's own names; a slider's texts are not hoarded ── */
{
  st().setList('e2', [
    wire(0, { steps: 3, discrete: true, text: 'Hall' }), // four named positions
    wire(1, { steps: 1, boolean: true, discrete: true }), // two positions = a switch, not a list
    wire(2), // continuous
    wire(3, { steps: 12, program_change: true }),
    wire(4, { steps: 4000, discrete: true }), // stepped, but far too many to list
  ]);
  const list = st().lists.e2;
  assert.deepEqual(list.map(isVstChoiceParam), [true, false, false, true, false]);
  assert.deepEqual([0, 1, 2, 3].map((i) => vstStepValue(list[0], i)), [0, 1 / 3, 2 / 3, 1]);

  st().setText('e2', 0, 1 / 3, 'Room');
  st().setText('e2', 0, 1, 'Plate');
  assert.equal(st().texts.e2[0][vstTextKey(1 / 3)], 'Room');
  assert.equal(st().texts.e2[0][vstTextKey(1)], 'Plate');
  assert.equal(st().lists.e2[0].text, 'Hall', 'naming OTHER positions never relabels the current one');

  for (let i = 0; i < 50; i += 1) st().setText('e2', 2, i / 50, `${i} %`);
  assert.equal(st().texts.e2[2], undefined, 'a continuous slider passing fifty values leaves nothing behind');
  st().clear('e2');
  assert.equal(st().texts.e2, undefined);
}

/* ── clear ── */
{
  st().clear('e1');
  assert.equal(st().lists.e1, undefined);
  const same = st();
  st().clear('e1');
  assert.equal(st().lists, same.lists, 'clearing twice changes nothing');
}

console.log('vstParamStore: ok');
