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
 *   - the plan request carries the roll's meter and its SATB parts' ranges,
 *     and the plan lands through the roll store's own write (one undo step);
 *   - a symphony greys out the tempo and meter it would ignore;
 *   - a part marked as the cantus firmus is the cantus "the selected part"
 *     sends, and the species answer's cantus goes back into it;
 *   - ORCHESTRATE sends the roll's parts, harmony row and markers; RUN adds
 *     the answer's parts on the registry's instruments with a plan line per
 *     section, and UNDO removes the parts it added;
 *   - CHECK shows the roll's key picker and the roll's last voice-leading
 *     answer, a write's or a check's: the same flags the harmony row shows,
 *     whichever key ran the check. A row selects its notes.
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
const bodies: Record<string, Record<string, unknown>> = {};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : String(input);
  asked.push(url);
  if (init?.body) bodies[url] = JSON.parse(String(init.body));
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
      flags: [{ bar: 1, beat: 1, tick: 3840, parts: ['alto', 'tenor'], rule: 'spacing', message: 'alto and tenor apart' }],
    });
  }
  if (url === '/api/composer/check') {
    return json(200, checkAnswer);
  }
  if (url === '/api/composer/orchestrate') {
    orchestrateSent = bodies[url];
    const one = (note: number, articulation?: string) => [{ note, tick: 0, ticks: 3840, velocity: 90, ...(articulation ? { articulation } : {}) }];
    const part = (name: string, instrument_id: string, note: number, articulation?: string) => ({
      name,
      instrument_id,
      role: 'voice',
      notes: one(note, articulation),
      controls: [{ tick: 0, controller: 1, value: 64 }],
    });
    return json(200, {
      key: 'C major',
      ppq: 960,
      ensemble: 'strings',
      texture: 'chorale',
      density: 0.5,
      melody_part: 'x',
      bass_part: 'x',
      parts: [part('Violin I', 'violin', 72, 'legato'), part('Viola', 'viola', 64, 'legato'), part('Contrabass', 'contrabass', 36, 'pizzicato')],
      sections: [
        { name: 'A', tick: 0, ticks: 3840, dynamic: 'mf', velocity: 90, climax: true, lead: 'strings', plan: 'A, bars 1-1, mf (climax): Violin I carries the melody; Viola holds the harmony; Cello and Contrabass carry the bass pizzicato.' },
      ],
      plan: ['A, bars 1-1, mf (climax): Violin I carries the melody; Viola holds the harmony; Cello and Contrabass carry the bass pizzicato.'],
      chords: [{ tick: 0, ticks: 3840, figure: 'I', key: 'C major' }],
    });
  }
  if (url === '/api/composer/species') {
    const line = (notes: number[]) => notes.map((note, i) => ({ note, tick: i * 3840, ticks: 3840 }));
    return json(200, {
      species: 1,
      position: 'above',
      key: 'D dorian',
      ppq: 960,
      bar_ticks: 3840,
      seed: 0,
      invertible: null,
      inversion: null,
      order: ['counterpoint', 'cantus'],
      parts: { counterpoint: line([62, 64]), cantus: line([50, 52]) },
      suspensions: [],
      rhythm: [],
      violations: [],
      flags: [],
    });
  }
  return json(404, { detail: `no route ${url}` });
}) as typeof fetch;

let orchestrateSent: unknown = null;
let checkAnswer: unknown = {
  count: 2,
  flags: [
    { bar: 1, beat: 1, tick: 3840, parts: ['soprano', 'bass'], rule: 'parallel_octaves', message: 'parallel octaves' },
    { bar: 0, beat: 1, tick: 0, parts: ['alto', 'tenor'], rule: 'spacing', message: 'more than an octave' },
  ],
};

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { ComposerPanel } = await import('./ComposerPanel.tsx');
const { usePianoRollStore, rollTracksOf } = await import('../../state/pianoRollStore.ts');
const { useLogStore } = await import('../../state/logStore.ts');

const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const roll = () => usePianoRollStore.getState();
// Each write is its own undo step: the history joins writes closer than 300 ms.
let clock = performance.now();
performance.now = () => (clock += 1000);
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
assert.deepEqual(tabs.map((t) => t.textContent), ['Harmony', 'Form', 'Counter', 'Orchestrate', 'Check', 'Profile']);
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
const undoBefore = roll()._undo.length;
await press(key('Write'));
await settle();
assert.ok(statusWord().startsWith('Flagged'), `then written, with the plan's one flag (got "${statusWord()}")`);
assert.deepEqual(rollTracksOf(roll()).map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass'], "the roll's spare empty part gives way to the plan");
assert.equal(useLogStore.getState().entries.at(-1)?.level, 'warn');
const planBody = bodies['/api/composer/plan'];
assert.deepEqual(planBody.meter_map, [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], "on the roll's meter");
assert.equal(planBody.ranges, undefined, 'no SATB parts yet, so no ranges: the backend uses its own');
assert.equal(roll().voiceLeading?.source, 'plan', "the plan's flags are the roll's");
assert.equal(roll()._undo.length, undoBefore + 1, 'one undo step');
// The second WRITE plans in the ranges of the roll's SATB parts.
await press(key('Write'));
await settle();
assert.deepEqual((bodies['/api/composer/plan'].ranges as Record<string, number[]>).soprano, [60, 84], "the Soprano part's registry range");
assert.deepEqual(rollTracksOf(roll()).map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass'], 'the same four parts, their notes replaced');

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

// A part marked as the cantus firmus is the cantus "the selected part" sends, and gets it back.
const bassPart = rollTracksOf(roll()).find((t) => t.name === 'Bass')!;
await step(() => roll().setCantusFirmus(bassPart.id));
const cantusSelect = () => win.document.getElementById(idFor('Cantus')) as HTMLSelectElement;
assert.equal(cantusSelect().options[0].textContent, 'Cantus firmus part: Bass', 'the option names the marked part');
await choose(idFor('Cantus'), 'part');
assert.ok(host.textContent?.includes('The cantus is read from Bass, the part marked Cantus firmus, and written back into it.'));
await press($$<HTMLButtonElement>('button').filter((b) => b.textContent?.trim() === 'Write')[0]);
await settle();
assert.ok(statusWord().startsWith('Done'), `species written (got "${statusWord()}")`);
assert.deepEqual((bodies['/api/composer/species'].cantus as { note: number }[]).map((n) => n.note), [48, 50], "the Bass part's notes");
assert.deepEqual(rollTracksOf(roll()).find((t) => t.id === bassPart.id)?.notes.map((n) => n.note), [50, 52], "the answer's cantus back in Bass");
assert.ok(rollTracksOf(roll()).some((t) => t.name === 'Counterpoint'));
const lagMax = (win.document.getElementById(idFor('Lag (beats)')) as HTMLInputElement).max;
assert.equal(lagMax, '16');

// ── ORCHESTRATE ─────────────────────────────────────────────────────────────
await press(tab('Orchestrate'));
assertLabelled('ORCHESTRATE');
assert.ok(!host.innerHTML.match(/[\u{1F300}-\u{1FAFF}]/u), 'no emoji in the section');
for (const k of ['Run', 'Undo']) assert.ok(key(k), `a ${k} key`);
const density = win.document.getElementById(idFor('Density')) as HTMLInputElement;
assert.equal(density.type, 'range', 'the density is a native slider');
assert.equal((key('Undo') as HTMLButtonElement).disabled, true, 'nothing to undo before a run');
const partsBefore = rollTracksOf(roll()).length;
await choose(idFor('Ensemble'), 'strings');
await choose(idFor('Texture'), 'chorale');
await press(key('Run'));
await settle();
assert.ok(statusWord().startsWith('Done'), `the orchestration lands (got "${statusWord()}")`);
const sentO = orchestrateSent as { parts: { id: string; notes: unknown[] }[]; ensemble: string; texture: string; density: number; harmony: unknown[]; markers: unknown[]; key: string };
assert.equal(sentO.ensemble, 'strings');
assert.equal(sentO.texture, 'chorale');
assert.equal(sentO.density, 0.5);
assert.ok(sentO.parts.length >= 1 && sentO.parts.every((p) => p.notes.length > 0), "the roll's parts with notes are the sketch");
assert.ok(Array.isArray(sentO.harmony) && Array.isArray(sentO.markers), 'the harmony row and the markers go along');
const orchestrated = rollTracksOf(roll());
assert.equal(orchestrated.length, partsBefore + 3, 'three parts added');
const violinI = orchestrated.find((t) => t.name === 'Violin I');
assert.ok(violinI && violinI.instrumentId === 'violin' && violinI.program === 40, 'Violin I is the registry violin');
assert.equal(violinI?.notes[0]?.articulation, 'legato');
assert.equal(violinI?.notes[0]?.velocity, 90, 'the section dynamic is the velocity');
assert.deepEqual(violinI?.controls, [{ tick: 0, controller: 1, value: 64 }], 'the CC 1 swell comes along');
assert.equal(orchestrated.find((t) => t.name === 'Contrabass')?.notes[0]?.articulation, 'pizzicato');
const planList = $('[aria-label="Orchestration plan"]');
assert.ok(planList && planList.textContent?.includes('Violin I carries the melody'), 'the plan is shown, one line per section');
assert.equal((key('Undo') as HTMLButtonElement).disabled, false);
await press(key('Undo'));
await settle();
assert.equal(rollTracksOf(roll()).length, partsBefore, 'UNDO removes the parts the orchestration added');
assert.ok(!rollTracksOf(roll()).some((t) => t.name === 'Violin I'));
assert.ok(statusWord().startsWith('Removed'), `the status says so (got "${statusWord()}")`);

// ── CHECK ───────────────────────────────────────────────────────────────────
await press(tab('Check'));
assertLabelled('CHECK');
assert.ok(win.document.getElementById(idFor('Key')), "the roll's key picker, the one the harmony row's check reads");
const source = () => $('[data-compose-flags-source]')?.textContent ?? '';
assert.equal(source(), 'From the orchestration written, in C major. The parts changed since.', "before any check, the last write's answer, stale since UNDO took its parts");
await press(key('Check'));
await settle();
assert.ok(statusWord().startsWith('Flagged'), `flags read as Flagged (got "${statusWord()}")`);
assert.deepEqual(bodies['/api/composer/check'].order, ['soprano', 'alto', 'tenor', 'bass'], 'the SATB parts');
assert.deepEqual([bodies['/api/composer/check'].key, bodies['/api/composer/check'].mode], ['C', 'major'], "in the roll's key");
assert.equal(source(), 'From the last check, in C major.');
const counts = $$('ul[aria-label="Flags by rule"] li').map((li) => li.textContent);
assert.deepEqual(counts, ['Parallel octaves1', 'Spacing1']);
const rows = () => $$<HTMLButtonElement>('ul[aria-label="Voice-leading flags"] button');
assert.equal(rows().length, 2);
assert.ok(rows()[0].textContent?.includes('Bar 2, beat 1 · Soprano, Bass'), 'the flag names the roll parts as the roll does');
assert.deepEqual(roll().voiceLeading?.flags.map((f) => f.rule), ['parallel_octaves', 'spacing'], "the list is the store's voiceLeading");
await press(rows()[0]);
const s = roll();
assert.equal(rollTracksOf(s).find((t) => t.id === s.activeTrackId)?.name, 'Soprano', 'the row opens the part it names');
assert.deepEqual([...s.selectedIds].map((id) => s.notes.find((n) => n.id === id)?.note), [74], 'and selects its note there');
assert.ok(statusWord().startsWith('Selected'));

// The HARMONY key, when asked for, is the key the check reads in.
await press(tab('Harmony'));
await choose(idFor('Key'), 'D');
await choose(idFor('Mode'), 'minor');
await press(tab('Check'));
const inHarmonyKey = win.document.getElementById(idFor('Read in D minor (the HARMONY key) instead')) as HTMLInputElement;
assert.equal(inHarmonyKey.checked, false, "the roll's key unless asked");
await step(() => inHarmonyKey.click());
await press(key('Check'));
await settle();
assert.deepEqual([bodies['/api/composer/check'].key, bodies['/api/composer/check'].mode], ['D', 'minor']);
assert.equal(source(), 'From the last check, in D minor.');
assert.equal(roll().rollKey?.tonic, 'C', "the roll's own key stays");

// A check from the harmony row's corner (the store's own) is what this list shows next: one source.
checkAnswer = { count: 1, flags: [{ bar: 0, beat: 1, tick: 0, parts: ['tenor', 'bass'], rule: 'hidden_fifths', message: 'hidden fifths' }] };
await step(async () => {
  await roll().runVoiceLeadingCheck();
});
assert.deepEqual(rows().map((r) => r.textContent?.includes('Tenor, Bass')), [true]);
// An edit to a checked part says so.
await step(() => roll().setPartNotes(rollTracksOf(roll()).find((t) => t.name === 'Tenor')!.id, []));
assert.equal(source(), 'From the last check, in C major. The parts changed since.');
// Undo takes the edit back, and the list reads current again.
await step(() => roll().undo());
assert.equal(source(), 'From the last check, in C major.');

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
