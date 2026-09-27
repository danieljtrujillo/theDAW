/**
 * Mount test for the stage-2 tempo tools in the MIDI tab, against the real roll,
 * Virtuoso and metronome stores, in the order a user presses them:
 *
 *   1. FORM: a section's tempo field (typed, applied on blur), then SONG, which
 *      writes the slow introduction and its ritardando into the roll's tempo map.
 *   2. TEMPO lane: MODULATE with "quarter = dotted quarter" at the playhead's
 *      bar adds the tempo that keeps the beat; undo takes it back.
 *   3. METER face: ADD a change, then MODULATE beside it with "dotted quarter =
 *      quarter" on that change's bar line.
 *   4. CLICK: the key, the click mode (Groups) and the count-in (1 bar), then
 *      PLAY over a 7/8 3+2+2 roll: the count-in sounds the bar's three group
 *      starts while the key reads STOP, PLAY starts when the bar ends, and the
 *      running click lands on the group starts too.
 *
 * Client-rendered (createRoot on jsdom), in the TempoLane.test.tsx pattern, with
 * a fake AudioContext whose clock the test moves.
 *
 *   cd frontend && npx tsx src/components/audio/TempoTools.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { useVirtuosoStore } = await import('../../state/virtuosoStore.ts');
const { useMetronomeStore } = await import('../../state/metronomeStore.ts');
const { ZERO_AMOUNTS } = await import('../../lib/virtuosoTransform.ts');

/* ── a fake AudioContext: every node connects, the oscillators record their start ── */
class FakeParam {
  value = 0;
  setValueAtTime(): FakeParam { return this; }
  linearRampToValueAtTime(): FakeParam { return this; }
  exponentialRampToValueAtTime(): FakeParam { return this; }
  setTargetAtTime(): FakeParam { return this; }
  cancelScheduledValues(): FakeParam { return this; }
}
class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly detune = new FakeParam();
  fftSize = 2048;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  type = '';
  startedAt: number | null = null;
  connect(d: unknown): unknown { return d; }
  disconnect(): void {}
  start(t = 0): void { this.startedAt = t; }
  stop(): void {}
  getFloatTimeDomainData(): void {}
  getByteFrequencyData(): void {}
  getFloatFrequencyData(): void {}
}
const oscs: FakeNode[] = [];
class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  sampleRate = 48000;
  outputLatency = 0;
  destination = new FakeNode();
  createGain(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createMediaElementSource(): FakeNode { return new FakeNode(); }
  createBiquadFilter(): FakeNode { return new FakeNode(); }
  createDynamicsCompressor(): FakeNode { return new FakeNode(); }
  createOscillator(): FakeNode { const o = new FakeNode(); oscs.push(o); return o; }
  resume(): Promise<void> { return Promise.resolve(); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
Object.defineProperty(win, 'AudioContext', { value: FakeAudioContext, configurable: true });
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  Audio: win.Audio,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { getEngineCtx } = await import('../../state/playerStore.ts');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const wait = (ms: number) => step(() => new Promise<void>((done) => setTimeout(done, ms)));
const button = (name: string, root: ParentNode = win.document): HTMLButtonElement => {
  const hit = [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
  assert.ok(hit, `the MIDI tab shows a "${name}" key`);
  return hit as HTMLButtonElement;
};
const byId = <T extends HTMLElement>(id: string) => {
  const el = win.document.getElementById(id) as T | null;
  assert.ok(el, `#${id} is on the page`);
  return el;
};
const valueSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const selectSetter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!;
const choose = (el: HTMLSelectElement, value: string) => {
  selectSetter.call(el, value);
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
};
const blur = (el: HTMLElement) => el.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
/** Typing: the value changes and an InputEvent says it was typed. */
const type = (el: HTMLInputElement, text: string) => {
  valueSetter.call(el, text);
  el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-1) }));
};
const key = (el: HTMLElement, k: string) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
const labelFor = (id: string) => win.document.querySelector(`label[for="${id}"]`)?.textContent ?? '';
const tempoShape = () => roll().tempoMap.filter((e) => !e.fermata).map((e) => `${e.beat}:${e.bpm}${e.curve === 'linear' ? 'r' : ''}`);
const M44 = { num: 4, den: 4, groups: [] as number[] };

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() => {
  roll().applyMeter({ meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
  roll().importNotes([0, 2, 4, 5, 7, 9, 11, 12].map((d, i) => ({ id: `p${i}`, note: 60 + d, step: i * 2, length: 2, velocity: 90 })), 120);
  useVirtuosoStore.setState({ sections: null, style: 'romantic', songMode: false, source: null, amounts: { ...ZERO_AMOUNTS } });
});
await step(() => root.render(<MidiPanel />));

/* 1. FORM: section 1's tempo, then SONG. */
await step(() => button('Capture the roll as the morph source').click());
await step(() => button('Form: the song structure').click());
const secBpm = byId<HTMLInputElement>('vt-sec-bpm-0');
assert.equal(labelFor('vt-sec-bpm-0'), 'Section 1 tempo in BPM', 'the field has a real label');
assert.equal(secBpm.value, '', 'an empty tempo follows the roll');
await step(() => { valueSetter.call(secBpm, '64'); blur(secBpm); });
assert.equal(useVirtuosoStore.getState().sections?.[0].bpm, 64, 'the typed tempo is the section tempo');
await wait(350);
await step(() => button('Song: build a full arrangement').click());
assert.equal(roll().bpm, 64, 'SONG starts the roll at section 1 tempo');
const sec1 = useVirtuosoStore.getState().effectiveSections()[0];
const lastBarBeat = (sec1.bars - 1) * 4;
assert.ok(tempoShape().includes(`${lastBarBeat}:64r`), `section 1's last bar ramps (${tempoShape().join(' ')})`);
assert.ok(tempoShape().includes(`${sec1.bars * 4}:120`), 'section 2 is back at the roll tempo');
// Clearing the field gives section 1 back to the roll's map.
const secBpmAgain = byId<HTMLInputElement>('vt-sec-bpm-0');
await step(() => { valueSetter.call(secBpmAgain, ''); blur(secBpmAgain); });
assert.equal(useVirtuosoStore.getState().sections?.[0].bpm, undefined);
await wait(300);
assert.equal(roll().bpm, 120, 'the rebuilt song follows the roll tempo');
await step(() => button('Form: the song structure').click());
await step(() => button('Reset to the captured source').click());
assert.deepEqual(tempoShape(), ['0:120'], 'RESET puts the map from before the song back');

/* 2. TEMPO lane: MODULATE at the playhead's bar. */
await step(() => usePianoRollStore.setState({ currentStep: 34, totalSteps: 256 }));
await step(() => button('Tempo').click());
const laneRow = win.document.querySelector('[data-tempo-lane]') as HTMLElement;
await wait(350);
await step(() => button('Metric modulation', laneRow).click());
const laneBar = byId<HTMLInputElement>('tempo-lane-mod-bar');
assert.equal(laneBar.value, '3', 'the card opens on the bar under the playhead');
// Typing 12 into the Bar field: the "1" waits, so it is never clamped to bar 2.
await step(() => type(laneBar, '1'));
assert.equal(laneBar.value, '1', 'the typed digit shows as typed');
assert.match(byId('tempo-lane-mod-card').textContent ?? '', /at bar 3/, 'and the bar stays until Enter');
await step(() => type(laneBar, '12'));
await step(() => key(laneBar, 'Enter'));
assert.equal(laneBar.value, '12');
assert.match(byId('tempo-lane-mod-card').textContent ?? '', /at bar 12/, 'Enter picks bar 12');
// Blur applies a typed bar too, and a bar past the end is held to the last bar.
await step(() => { type(laneBar, '99'); blur(laneBar); });
assert.equal(laneBar.value, '16', 'the roll has 16 bars');
await step(() => { type(laneBar, '3'); blur(laneBar); });
assert.equal(laneBar.value, '3');
assert.equal(labelFor('tempo-lane-mod-before'), 'Before');
assert.equal(labelFor('tempo-lane-mod-after'), 'After');
await step(() => choose(byId<HTMLSelectElement>('tempo-lane-mod-before'), 'quarter'));
await step(() => choose(byId<HTMLSelectElement>('tempo-lane-mod-after'), 'dotted-quarter'));
assert.match(byId('tempo-lane-mod-card').textContent ?? '', /120 BPM becomes 180 BPM at bar 3/);
await step(() => button('Add tempo', byId('tempo-lane-mod-card')).click());
assert.deepEqual(tempoShape(), ['0:120', '8:180'], 'the modulation is a tempo change on bar 3');
await wait(350);
await step(() => roll().undo());
assert.deepEqual(tempoShape(), ['0:120'], 'undo takes it back');

/* 3. METER face: ADD a change at bar 4, then MODULATE on its bar line. */
await step(() => usePianoRollStore.setState({ currentStep: 50 }));
await step(() => button('Meter').click());
await step(() => button('Add a meter change at the playhead').click());
const meterMod = [...win.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-controls') === 'mf-mod-card') as HTMLButtonElement;
assert.ok(meterMod, 'MODULATE sits beside ADD on the METER face');
await step(() => meterMod.click());
assert.equal(win.document.getElementById('mf-mod-bar'), null, 'the bar is the selected change, not a field');
await step(() => choose(byId<HTMLSelectElement>('mf-mod-before'), 'dotted-quarter'));
await step(() => choose(byId<HTMLSelectElement>('mf-mod-after'), 'quarter'));
await step(() => button('Add tempo', byId('mf-mod-card')).click());
assert.deepEqual(tempoShape(), ['0:120', '12:80'], "dotted quarter = quarter on bar 4's line");
await step(() => button('Shape').click());

/* 4. CLICK over a 7/8 3+2+2 roll: count-in, then PLAY. */
await step(() => {
  roll().setTempoMap([{ beat: 0, bpm: 120 }]);
  roll().applyMeter({ meterMap: [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }], pickupSteps: 0 });
  roll().importNotes([], 120);
  usePianoRollStore.setState({ currentStep: 0, totalSteps: 28 });
  useMetronomeStore.setState({ enabled: false, countInBars: 0, clickMode: 'quarter' });
});
const clickKey = button('Click');
assert.equal(clickKey.getAttribute('aria-pressed'), 'false');
await step(() => clickKey.click());
assert.equal(clickKey.getAttribute('aria-pressed'), 'true');
assert.equal(useMetronomeStore.getState().enabled, true, 'CLICK is the metronome switch');
assert.equal(labelFor('piano-roll-click-mode'), 'Beat');
assert.equal(labelFor('piano-roll-count-in'), 'Count');
await step(() => choose(byId<HTMLSelectElement>('piano-roll-click-mode'), 'group'));
await step(() => choose(byId<HTMLSelectElement>('piano-roll-count-in'), '1'));
assert.equal(useMetronomeStore.getState().clickMode, 'group');
assert.equal(useMetronomeStore.getState().countInBars, 1);

const ctx = getEngineCtx() as unknown as FakeAudioContext;
ctx.currentTime = 20;
oscs.length = 0;
await step(() => button('Play').click());
assert.equal(roll().isPlaying, false, 'PLAY waits for the count-in');
assert.ok(button('Stop'), 'the key reads STOP while it counts');
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const t0 = 20.02; // CLICK_LEAD_SEC ahead of the press
assert.deepEqual(oscs.map((o) => round(o.startedAt ?? NaN)), [t0, t0 + 0.75, t0 + 1.25].map(round), 'the count-in clicks 3+2+2');
assert.deepEqual(oscs.map((o) => o.frequency.value > 1200), [true, false, false]);
const counted = oscs.length;
ctx.currentTime = t0 + 1.75;
await wait(40);
assert.equal(roll().isPlaying, true, 'PLAY starts when the counted bar ends');
// The roll's scheduler ticks every 25 ms; walk the audio clock through bar 1.
const playFrom = ctx.currentTime;
for (let k = 1; k <= 60; k += 1) {
  ctx.currentTime = round(playFrom + k * 0.03);
  await wait(26);
}
const origin = playFrom + 0.06;
const clicked = oscs.slice(counted).map((o) => round((o.startedAt ?? NaN) - origin));
assert.deepEqual(clicked.slice(0, 4), [0, 0.75, 1.25, 1.75], `the running click lands on the group starts (${clicked.join(', ')})`);
await step(() => button('Stop').click());
assert.equal(roll().isPlaying, false);

await step(() => root.unmount());
console.log('TempoTools: ok');
