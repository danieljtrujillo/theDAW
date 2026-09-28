/**
 * The COMPOSE column as a user meets it, client-rendered on jsdom against a
 * stubbed backend:
 *
 *   - every native control in every section has a real <label for>, and the
 *     section keys are a tablist whose tabs control the panel shown;
 *   - the style picker says which styles were measured and which authored;
 *   - WRITE with a plan the backend refuses shows its 422 sentence in the
 *     status line (a dot and the word REFUSED) and puts it in the LOG, then a
 *     plan it accepts lands in the roll as four parts;
 *   - a symphony greys out the tempo and meter it would ignore;
 *   - CHECK lists the flags by rule, and a row selects its notes.
 *
 *   cd frontend && npx tsx src/components/audio/ComposerPanel.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// The backend, as far as this panel asks it.
let planRefusal: string | null = 'no path of pivot chords from C major to F# minor';
const asked: string[] = [];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : String(input);
  asked.push(url);
  if (url === '/api/composer/styles') {
    return json(200, {
      styles: [
        { id: 'bach', name: 'J. S. Bach', era: 'Baroque', source: 'extracted', basis: 'chorales', works: 40, orchestration: 'satb_choir', chords_per_pulse: 1 },
        { id: 'debussy', name: 'Debussy', era: 'Impressionist', source: 'authored', basis: 'textbook', works: 0, orchestration: 'piano', chords_per_pulse: 0.5 },
      ],
    });
  }
  if (url === '/api/composer/plan') {
    if (planRefusal) return json(422, { detail: planRefusal });
    const two = (n: number) => [
      { note: n, tick: 0, ticks: 3840 },
      { note: n + 2, tick: 3840, ticks: 3840 },
    ];
    return json(200, {
      key: 'C major',
      final_key: 'C major',
      bars: 2,
      seed: 0,
      cadence: 'authentic_perfect',
      style: null,
      harmonic_rhythm: 'bar',
      ppq: 960,
      meter_map: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
      chords: [],
      parts: { soprano: two(72), alto: two(67), tenor: two(60), bass: two(48) },
      flags: [],
    });
  }
  if (url === '/api/composer/check') {
    return json(200, {
      count: 2,
      flags: [
        { bar: 1, beat: 1, tick: 3840, parts: ['Soprano', 'Bass'], rule: 'parallel_octaves', message: 'parallel octaves' },
        { bar: 0, beat: 1, tick: 0, parts: ['Alto', 'Tenor'], rule: 'spacing', message: 'more than an octave' },
      ],
    });
  }
  return json(404, { detail: `no route ${url}` });
}) as typeof fetch;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { ComposerPanel } = await import('./ComposerPanel.tsx');
const { usePianoRollStore, rollTracksOf } = await import('../../state/pianoRollStore.ts');
const { useLogStore } = await import('../../state/logStore.ts');

const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const settle = () => step(() => new Promise((r) => setTimeout(r, 0)));

usePianoRollStore.getState().importParts([{ name: 'Part 1', notes: [] }]);
const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
let closed = 0;
await step(() => root.render(<ComposerPanel onClose={() => { closed += 1; }} />));
await settle();

const $ = <T extends Element>(sel: string) => host.querySelector<T>(sel);
const $$ = <T extends Element>(sel: string) => [...host.querySelectorAll<T>(sel)];
const statusWord = () => $('[role="status"]')?.textContent ?? '';
const tab = (word: string) => $$<HTMLButtonElement>('[role="tab"]').find((b) => b.textContent === word)!;
const key = (word: string) =>
  $$<HTMLButtonElement>('button').find((b) => b.textContent?.trim() === word && b.getAttribute('role') !== 'tab')!;
const press = (el: HTMLElement) => step(() => el.click());
const choose = (id: string, value: string) =>
  step(() => {
    const el = win.document.getElementById(id) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
const idFor = (label: string) => $$<HTMLLabelElement>('label').find((l) => l.textContent?.trim() === label)?.htmlFor ?? '';

/** Every native control has an id, a name and a <label for> that names it. */
const assertLabelled = (where: string) => {
  const controls = $$<HTMLInputElement>('input, select, textarea');
  assert.ok(controls.length > 0, `${where}: has controls`);
  for (const c of controls) {
    assert.ok(c.id, `${where}: a ${c.tagName.toLowerCase()} has an id`);
    assert.ok(c.name, `${where}: #${c.id} has a name`);
    const label = host.querySelector(`label[for="${c.id}"]`);
    assert.ok(label && label.textContent?.trim(), `${where}: #${c.id} has a label`);
  }
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(host.innerHTML), `${where}: no text under 12px`);
};

// ── the tablist ─────────────────────────────────────────────────────────────
const tabs = $$<HTMLButtonElement>('[role="tab"]');
assert.deepEqual(tabs.map((t) => t.textContent), ['Harmony', 'Form', 'Counter', 'Check', 'Profile']);
assert.equal($('[role="tablist"]')?.getAttribute('aria-label'), 'Compose sections');
for (const t of tabs) assert.ok(t.getAttribute('aria-label'), 'each section key has a name');
const selected = () => tabs.find((t) => t.getAttribute('aria-selected') === 'true')!;
assert.equal(selected().textContent, 'Harmony');
assert.equal(selected().getAttribute('aria-controls'), $('[role="tabpanel"]')?.id, 'the selected tab controls the panel shown');
assert.equal($('[role="tabpanel"]')?.getAttribute('aria-labelledby'), selected().id);
assert.equal(statusWord(), 'Ready');

// ── HARMONY: the style picker, then a refusal and an answer ─────────────────
assertLabelled('HARMONY');
const styleOptions = [...(win.document.getElementById(idFor('Style')) as HTMLSelectElement).options].map((o) => o.textContent);
assert.deepEqual(styleOptions, ['None', 'J. S. Bach (Baroque): measured, 40 works', 'Debussy (Impressionist): authored']);
const rhythm = () => [...(win.document.getElementById(idFor('Harmonic rhythm')) as HTMLSelectElement).options].map((o) => o.value);
assert.ok(!rhythm().includes('style'), "no 'style' rhythm without a style");
await choose(idFor('Style'), 'bach');
assert.ok(rhythm().includes('style'), "the style's rate once a style is picked");
await choose(idFor('Style'), '');

useLogStore.getState().clear();
await press(key('Write'));
await settle();
assert.equal(statusWord().startsWith('Refused'), true, `the status word says the backend refused (got "${statusWord()}")`);
assert.ok(host.textContent?.includes('Write: no path of pivot chords from C major to F# minor'), 'the 422 sentence is shown');
const logged = useLogStore.getState().entries;
assert.equal(logged.at(-1)?.level, 'error');
assert.equal(logged.at(-1)?.source, 'piano-roll');
assert.ok(logged.at(-1)?.msg.includes('no path of pivot chords'), 'and it goes to the LOG');
assert.equal(rollTracksOf(usePianoRollStore.getState()).length, 1, 'a refused plan writes nothing');

planRefusal = null;
await press(key('Write'));
await settle();
assert.ok(statusWord().startsWith('Done'), `then Done (got "${statusWord()}")`);
assert.deepEqual(rollTracksOf(usePianoRollStore.getState()).map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass']);
assert.equal(useLogStore.getState().entries.at(-1)?.level, 'info');

// Re-roll changes the seed field.
const seedField = () => win.document.getElementById(idFor('Seed')) as HTMLInputElement;
const before = seedField().value;
await press($$<HTMLButtonElement>('button').find((b) => b.getAttribute('aria-label') === 'Re-roll the seed')!);
assert.notEqual(seedField().value, before, 'the seed re-rolls');

// ── FORM ────────────────────────────────────────────────────────────────────
await press(tab('Form'));
assertLabelled('FORM');
const disabled = (label: string) => (win.document.getElementById(idFor(label)) as HTMLInputElement).disabled;
assert.equal(disabled('Tempo (BPM)'), false);
assert.equal(disabled('Rondo pattern'), true, 'only a rondo has a pattern');
await choose(idFor('Form'), 'symphony');
assert.equal(disabled('Tempo (BPM)'), true, "a symphony's movements keep their own tempi");
assert.equal(disabled('Meter'), true);
const bars = win.document.getElementById(idFor('Bars')) as HTMLInputElement;
assert.equal(bars.max, '800', 'a symphony takes up to 800 bars');
await choose(idFor('Form'), 'sonata');
assert.equal((win.document.getElementById(idFor('Bars')) as HTMLInputElement).max, '400');

// ── COUNTERPOINT ────────────────────────────────────────────────────────────
await press(tab('Counter'));
assertLabelled('COUNTERPOINT');
assert.deepEqual($$('legend').map((l) => l.textContent), ['Species', 'Canon', 'Fugue', 'Inversion']);
const cantusOptions = [...(win.document.getElementById(idFor('Cantus')) as HTMLSelectElement).options].map((o) => o.textContent);
assert.equal(cantusOptions[0], 'Selected part: Soprano', 'the cantus can be the part being edited');
assert.equal(cantusOptions.length, 6, 'or one of five Fux cantus firmi');
assert.equal((win.document.getElementById(idFor('Key')) as HTMLSelectElement).disabled, true, "a preset brings its own key");
const lagMax = (win.document.getElementById(idFor('Lag (beats)')) as HTMLInputElement).max;
assert.equal(lagMax, '16');

// ── CHECK ───────────────────────────────────────────────────────────────────
await press(tab('Check'));
assertLabelled('CHECK');
await press(key('Check'));
await settle();
assert.ok(statusWord().startsWith('Flagged'), `flags read as Flagged (got "${statusWord()}")`);
const counts = $$('ul[aria-label="Flags by rule"] li').map((li) => li.textContent);
assert.deepEqual(counts, ['Parallel octaves1', 'Spacing1']);
const rows = $$<HTMLButtonElement>('ul[aria-label="Voice-leading flags"] button');
assert.equal(rows.length, 2);
assert.ok(rows[0].textContent?.includes('Bar 2, beat 1 · Soprano, Bass'), rows[0].textContent ?? '');
await press(rows[0]);
const s = usePianoRollStore.getState();
assert.equal(rollTracksOf(s).find((t) => t.id === s.activeTrackId)?.name, 'Soprano', 'the row opens the part it names');
assert.deepEqual([...s.selectedIds].map((id) => s.notes.find((n) => n.id === id)?.note), [74], 'and selects its note there');
assert.ok(statusWord().startsWith('Selected'));

// ── PROFILE ─────────────────────────────────────────────────────────────────
await press(tab('Profile'));
assertLabelled('PROFILE (corpus)');
await step(() => (win.document.getElementById(idFor('A shipped style')) as HTMLInputElement).click());
assertLabelled('PROFILE (style)');

// ── close ───────────────────────────────────────────────────────────────────
await press($$<HTMLButtonElement>('button').find((b) => b.getAttribute('aria-label') === 'Close the COMPOSE column')!);
assert.equal(closed, 1);
assert.ok(asked.includes('/api/composer/styles'), 'the styles are asked for on open');

await step(() => root.unmount());
console.log('ComposerPanel: ok');
