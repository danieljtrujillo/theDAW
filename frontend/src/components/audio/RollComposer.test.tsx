/**
 * Mount test for the piano roll's composer controls: the harmony row over the
 * ruler, its corner, the figured-bass lane with the key picker, the parts
 * column's cantus firmus key, the dock keys the MIDI tab lays out (HARMONY
 * and FIGURES on the strip beside BEND and TEMPO, TRANSFORM on the rail after
 * COMPOSE), and the COMPOSE column's CHECK showing the flags the harmony row
 * shows.
 *
 * The sequence: a roll with Soprano and Bass parts is checked (the route
 * answers one flag); the row opens with a marker named for its rule and
 * place, focus opens its tip, and a click selects the notes it is about. A
 * plan written into the roll puts its roman figures in the row. An edit to a
 * checked part marks the flags as changed since. The figured-bass lane takes
 * a figure under a bass note (a labelled field, one undo step on blur, Escape
 * puts it back), and the key picker sets the roll's key. The TRANSFORM key is
 * off with nothing selected and opens a menu of six that inverts the
 * selection in one undo step. The COMPOSE column's CHECK lists the row's
 * flags (changed since, as the row says), and its own CHECK puts a new marker
 * in the row. Every word is 12px or larger.
 *
 * Client-rendered (createRoot on jsdom), in the RollPartControls.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/audio/RollComposer.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { endRollGesture, rollTracksOf, usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { rollTransformMenuItems } = await import('./RollTransforms.tsx');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLSelectElement: win.HTMLSelectElement,
  Node: win.Node,
  Event: win.Event,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}
let answer: unknown = {};
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (url: RequestInfo | URL) =>
    String(url) === '/api/composer/styles'
      ? new Response(JSON.stringify({ styles: [] }), { status: 200 })
      : String(url).startsWith('/api/composer/')
        ? new Response(JSON.stringify(answer), { status: 200 })
        : new Response('{}', { status: 404 }),
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const q = <T extends Element>(sel: string): T | null => win.document.querySelector(sel) as T | null;
const buttons = () => [...win.document.querySelectorAll('button')];
const byLabel = (start: string): HTMLButtonElement => {
  const hit = buttons().find((b) => (b.getAttribute('aria-label') ?? '').startsWith(start));
  assert.ok(hit, `a key named "${start}..."`);
  return hit as HTMLButtonElement;
};
const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const setSelect = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!;
const note = (id: string, pitch: number, tick: number, ticks = 3840) => ({ id, note: pitch, tick, ticks, step: tick / 240, length: ticks / 240, velocity: 80 });

/** Every class on the subtree that sets a text size under 12px. */
const smallText = (el: Element | null): string[] =>
  el ? [...el.querySelectorAll('*'), el].flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/)).filter((c) => /^text-\[(\d+)px\]$/.test(c) && Number(/\d+/.exec(c)![0]) < 12 || /^text-(xs|2xs|3xs)$/.test(c)) : [];

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  roll().setPartsOpen(true);
  roll().setShowHarmony(false);
  roll().setShowFiguredBass(false);
  roll().importParts(
    [
      { name: 'Soprano', notes: [note('s1', 72, 0), note('s2', 74, 3840)] },
      { name: 'Bass', notes: [note('b1', 48, 0), note('b2', 50, 3840)] },
    ],
    100,
  );
});
await step(() => root.render(<MidiPanel />));
assert.equal(q('[data-roll-harmony]'), null, 'the row starts closed');

// ── CHECK: the row opens with a marker per flag ─────────────────────────────
answer = { flags: [{ bar: 1, beat: 1, tick: 3840, parts: ['soprano', 'bass'], rule: 'parallel_octaves', message: 'Parallel octaves between soprano and bass' }], count: 1 };
await step(async () => {
  await roll().runVoiceLeadingCheck();
});
const row = q('[data-roll-harmony]');
assert.ok(row, 'the harmony row is open');
assert.equal(row.getAttribute('aria-label'), 'Harmony row: 1 voice-leading flag');
const marker = byLabel('Parallel octaves at bar 2, beat 1: Parallel octaves between soprano and bass. Select its notes');
assert.equal(marker.getAttribute('aria-label')?.includes('changed'), false);
assert.ok(byLabel('Check voice leading: 1 flag'), "the corner's CHECK key says what it found");
assert.ok(byLabel('Hide the harmony row'));

// Focus opens the tip, blur closes it.
await step(() => marker.focus());
const tip = q('[data-roll-harmony] [role="tooltip"]');
assert.ok(tip, 'focus opens the tip');
assert.equal(marker.getAttribute('aria-describedby'), tip.id, 'the marker is described by it');
assert.ok(tip.textContent?.includes('Parallel octaves between soprano and bass'));
await step(() => marker.blur());
assert.equal(q('[data-roll-harmony] [role="tooltip"]'), null);

// A click selects the notes it is about.
await step(() => marker.click());
const soprano = rollTracksOf(roll()).find((t) => t.name === 'Soprano')!;
assert.equal(roll().activeTrackId, soprano.id, 'the soprano is the part being edited');
assert.deepEqual([...roll().selectedIds], ['s2'], 'its note at the flag');

// ── A plan's figures in the row ─────────────────────────────────────────────
await step(() => {
  roll().writePlanToRoll({
    key: 'C major',
    chords: [{ tick: 0, figure: 'I', key: 'C major' }, { tick: 3840, figure: 'V7', key: 'C major' }],
    parts: { soprano: [{ note: 72, tick: 0, ticks: 3840 }, { note: 74, tick: 3840, ticks: 3840 }] },
    flags: [],
  } as never);
});
const figures = [...(q('[data-roll-harmony]')?.querySelectorAll('span') ?? [])].map((s) => s.textContent);
assert.deepEqual(figures, ['I', 'V7'], 'the roman figures at their chords');

// An edit to a checked part marks the flags as changed since the check.
answer = { flags: [{ bar: 1, beat: 1, tick: 3840, parts: ['soprano', 'bass'], rule: 'parallel_octaves', message: 'Parallel octaves' }], count: 1 };
await step(async () => {
  await roll().runVoiceLeadingCheck();
});
await step(() => roll().setActiveTrack(rollTracksOf(roll()).find((t) => t.name === 'Bass')!.id));
await step(() => roll().setPartNotes(roll().activeTrackId, [note('b1', 48, 0), note('b2', 43, 3840)]));
assert.ok(byLabel('Parallel octaves at bar 2, beat 1').getAttribute('aria-label')?.endsWith('The parts changed since the check'));
assert.ok(byLabel('Check voice leading: 1 flag, parts changed since'));

// ── The figured-bass lane and the key ───────────────────────────────────────
await step(() => roll().setShowFiguredBass(true));
const lane = q('[data-figured-bass-lane]');
assert.ok(lane, 'the lane is open');
const field = q<HTMLInputElement>('#roll-figure-3840');
assert.ok(field, 'a field under the second bass note');
assert.equal(field.getAttribute('name'), 'roll-figure-3840');
assert.equal(q('label[for="roll-figure-3840"]')?.textContent, 'Figure under G2 at bar 2, beat 1', 'named by its label');
endRollGesture();
const before = roll()._undo.length;
await step(() => {
  setValue.call(field, '6/4');
  field.dispatchEvent(new win.Event('input', { bubbles: true }));
});
assert.equal(rollTracksOf(roll()).find((t) => t.name === 'Bass')?.figuredBass, undefined, 'nothing written while typing');
await step(() => {
  field.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
});
assert.deepEqual(rollTracksOf(roll()).find((t) => t.name === 'Bass')?.figuredBass, [{ tick: 3840, figure: '6/4' }], 'written on blur');
assert.equal(roll()._undo.length, before + 1, 'one undo step');
await step(() => {
  setValue.call(field, '7');
  field.dispatchEvent(new win.Event('input', { bubbles: true }));
  field.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
assert.equal(q<HTMLInputElement>('#roll-figure-3840')?.value, '6/4', 'Escape puts the figure back');
assert.ok(byLabel('Realize the figured bass of Bass in four parts'));

const keySelect = q<HTMLSelectElement>('#roll-key');
assert.ok(keySelect, 'the key picker');
assert.equal(q('label[for="roll-key"]')?.textContent, 'Key');
assert.equal(keySelect.value, '0:major', "the plan's key");
await step(() => {
  setSelect.call(keySelect, '7:minor');
  keySelect.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.deepEqual(roll().rollKey, { tonic: 'G', mode: 'minor' });
await step(() => {
  setSelect.call(keySelect, 'auto');
  keySelect.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.equal(roll().rollKey, null);
assert.ok(keySelect.options[0].textContent?.startsWith('Auto: '), 'Auto names the key it reads');

// ── The cantus firmus key in the parts column ───────────────────────────────
const cantus = byLabel('Bass is the cantus firmus');
assert.equal(cantus.getAttribute('aria-pressed'), 'false');
await step(() => cantus.click());
assert.equal(rollTracksOf(roll()).find((t) => t.name === 'Bass')?.cantusFirmus, true);
assert.equal(byLabel('Bass is the cantus firmus').getAttribute('aria-pressed'), 'true');

assert.deepEqual(smallText(q('[data-roll-harmony]')), [], 'no text under 12px in the row');
assert.deepEqual(smallText(lane), [], 'nor in the lane');

// ── The dock keys, where the MIDI tab lays them out ─────────────────────────
// HARMONY and FIGURES on the strip after the lane keys BEND and TEMPO; TRANSFORM on the rail after COMPOSE.
const stripKey = (word: string): HTMLButtonElement => {
  const hit = buttons().find((b) => b.textContent === word && b.hasAttribute('aria-pressed') && b.closest('[role="group"]') === null);
  assert.ok(hit, `the strip's ${word} key`);
  return hit as HTMLButtonElement;
};
const strip = stripKey('Bend').parentElement!;
const stripWords = [...strip.querySelectorAll(':scope > button')].map((b) => b.textContent);
const at = stripWords.indexOf('Bend');
assert.deepEqual(stripWords.slice(at, at + 4), ['Bend', 'Tempo', 'Harmony', 'Figures'], 'the composer rows beside the other lanes');
const rail = q('[role="group"][aria-label="MIDI actions"]');
assert.ok(rail, 'the action rail');
const railNames = [...rail.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
const composeAt = railNames.findIndex((n) => n?.startsWith('Compose:'));
assert.ok(railNames[composeAt + 1]?.startsWith('Transform'), `TRANSFORM follows COMPOSE on the rail (${railNames.join(' | ')})`);

// ── COMPOSE's CHECK and the harmony row: one list of flags ──────────────────
await step(() => byLabel('Compose:').click());
const compose = q('aside[aria-label="Compose"]');
assert.ok(compose, 'the COMPOSE column is open beside the roll');
const composeTab = [...compose.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === 'Check')!;
await step(() => composeTab.click());
const composeRows = () => [...compose.querySelectorAll<HTMLButtonElement>('ul[aria-label="Voice-leading flags"] button')];
assert.deepEqual(
  composeRows().map((b) => b.getAttribute('aria-label')),
  ['Select the notes: Bar 2, beat 1, Soprano and Bass, Parallel octaves'],
  "the column lists the check the row's markers show",
);
assert.equal(compose.querySelector('[data-compose-flags-source]')?.textContent?.endsWith('The parts changed since.'), true, 'and says the parts changed, as the row does');
assert.equal(compose.querySelectorAll('select[name$="k-key"]').length, 1, "the roll's key picker in CHECK");
assert.ok(q('#roll-key'), 'beside the one in the figured-bass lane');
// CHECK in the column: the row shows its answer.
answer = { flags: [{ bar: 0, beat: 1, tick: 0, parts: ['soprano', 'bass'], rule: 'voice_crossing', message: 'Soprano under the bass' }], count: 1 };
const composeCheck = [...compose.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Check' && b.getAttribute('role') !== 'tab')!;
await step(async () => {
  composeCheck.click();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
});
assert.ok(byLabel('Voice crossing at bar 1, beat 1: Soprano under the bass'), "the harmony row's marker for the column's check");
assert.equal(byLabel('Voice crossing at bar 1, beat 1').getAttribute('aria-label')?.includes('changed'), false);
assert.deepEqual(composeRows().map((b) => b.getAttribute('aria-label')), ['Select the notes: Bar 1, beat 1, Soprano and Bass, Voice crossing']);
assert.deepEqual(smallText(compose), [], 'no text under 12px in the column');
await step(() => byLabel('Close the COMPOSE column').click());

// HARMONY and FIGURES latch their rows.
const harmonyKey = stripKey('Harmony');
assert.equal(harmonyKey.getAttribute('aria-pressed'), 'true');
await step(() => harmonyKey.click());
assert.equal(roll().showHarmony, false, 'HARMONY closes the row');
assert.equal(q('[data-roll-harmony]'), null);
await step(() => harmonyKey.click());
assert.ok(q('[data-roll-harmony]'), 'and opens it');
const figuresKey = stripKey('Figures');
assert.equal(figuresKey.getAttribute('aria-pressed'), 'true');
await step(() => figuresKey.click());
assert.equal(q('[data-figured-bass-lane]'), null, 'FIGURES closes the lane');
await step(() => figuresKey.click());
assert.ok(q('[data-figured-bass-lane]'));

await step(() => roll().clearSelection());
const transformKey = rail.querySelector<HTMLButtonElement>('button[aria-controls="piano-roll-transform-menu"]');
assert.ok(transformKey);
assert.equal(transformKey.disabled, true, 'TRANSFORM is off with nothing selected');
assert.equal(transformKey.getAttribute('aria-label'), 'Transform: select notes first');
await step(() => roll().setSelection(['b1', 'b2']));
assert.equal(transformKey.disabled, false);
assert.equal(transformKey.getAttribute('aria-label'), 'Transform the 2 selected notes');
await step(() => transformKey.click());
assert.equal(transformKey.getAttribute('aria-expanded'), 'true');
const items = [...win.document.querySelectorAll('#piano-roll-transform-menu [role="menuitem"]')];
assert.deepEqual(items.map((i) => i.textContent), ['Invert', 'Retrograde', 'Augment ×2', 'Diminish ÷2', 'Sequence, down a step', 'Fragment, first half']);
endRollGesture();
const steps = roll()._undo.length;
await step(() => (items[0] as HTMLButtonElement).click());
assert.deepEqual(roll().notes.map((n) => n.note), [48, 53], 'inverted about the first note, by degree in the key read from the notes');
assert.equal(roll()._undo.length, steps + 1, 'one undo step');
await step(() => roll().undo());
assert.deepEqual(roll().notes.map((n) => n.note), [48, 43]);

// The note menu's Transform section.
const menu = rollTransformMenuItems(2);
assert.equal(menu[0].type, 'header');
assert.deepEqual(menu.slice(1).map((i) => (i.type === 'item' ? i.disabled : null)), [false, false, false, false, false, false]);
assert.ok(rollTransformMenuItems(0).slice(1).every((i) => i.type === 'item' && i.disabled), 'off with nothing selected');

await step(() => root.unmount());
console.log('RollComposer: ok');
