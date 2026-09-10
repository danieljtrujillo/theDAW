/**
 * node:assert invariants for the chaptered feature tour. Run from `frontend/`:
 *   npx tsx src/onboarding/tourSteps.test.ts
 *
 * Two classes of thing go wrong here and neither fails loudly at runtime.
 *
 * The chapter grouping is arithmetic on array indices: `chapterRange` assumes
 * each chapter is one contiguous run, and a step dropped into the wrong place
 * would silently vanish from the progress bar and from the picker's jump. That
 * is checked below against the array itself, not against a restated list.
 *
 * The targets are a DOM contract. A `data-tour` hook looks like a dead
 * attribute to anyone tidying JSX, and deleting one only makes a spotlight
 * quietly find nothing. So the source tree is read back and every hook a step
 * names has to still exist in a component. That check cannot cover the
 * aria-label, id and data-keyscope selectors the tour also uses — reword one of
 * those labels for accessibility and the step goes quiet with nothing to catch
 * it. They are listed in tourSteps.tsx's docstring for that reason.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CENTER_TABS } from '../state/appUiStore';
import {
  chapterRange,
  stepIndexById,
  TOUR_CHAPTERS,
  TOUR_STEPS,
  type ChapterId,
} from './tourSteps';

// ── Steps ──────────────────────────────────────────────────────────────────
const ids = new Set<string>();
const selectors = new Set<string>();
for (const s of TOUR_STEPS) {
  assert.ok(!ids.has(s.id), `duplicate step id: ${s.id}`);
  ids.add(s.id);
  assert.ok(s.title.trim().length > 0, `${s.id}: has a title`);
  assert.ok(s.body, `${s.id}: has a body`);
  assert.equal(stepIndexById(s.id), TOUR_STEPS.indexOf(s), `${s.id}: resolves by id`);
  if (s.tab) assert.ok(CENTER_TABS.includes(s.tab), `${s.id}: ${s.tab} is a real center tab`);
  if (s.targetSelector) {
    assert.ok(s.targetSelector.trim().length > 0, `${s.id}: non-empty selector`);
    assert.ok(!selectors.has(s.targetSelector), `${s.id}: two steps spotlight ${s.targetSelector}`);
    selectors.add(s.targetSelector);
  }
}

// The first step is the picker (a forty-step march is not a first run) and the
// last one hands you back to MAKE rather than to a dimmed screen.
const first = TOUR_STEPS[0];
const last = TOUR_STEPS[TOUR_STEPS.length - 1];
assert.ok(first.chapterPicker, 'the tour opens on the chapter picker');
assert.ok(first.primaryLabel, 'the picker names its own primary button');
assert.ok(last.finishTab, 'the last step lands somewhere');

// ── Chapters ───────────────────────────────────────────────────────────────
const chapterIds = TOUR_CHAPTERS.map((c) => c.id);
assert.equal(new Set(chapterIds).size, chapterIds.length, 'chapter ids are unique');
for (const c of TOUR_CHAPTERS) {
  assert.ok(c.title.trim().length > 0, `${c.id}: has a title`);
  assert.ok(c.blurb.trim().length > 0, `${c.id}: says what is inside`);
}

// Every chapter occupies exactly one contiguous run, in the order TOUR_CHAPTERS
// declares. This is what chapterRange is arithmetic on top of.
const seen: ChapterId[] = [];
for (const s of TOUR_STEPS) {
  if (seen[seen.length - 1] !== s.chapter) {
    assert.ok(!seen.includes(s.chapter), `chapter ${s.chapter} is split into two runs`);
    seen.push(s.chapter);
  }
}
assert.deepEqual(seen, chapterIds, 'the steps run through the chapters in declared order');

for (const c of TOUR_CHAPTERS) {
  const range = chapterRange(c.id);
  const mine = TOUR_STEPS.map((s, i) => (s.chapter === c.id ? i : -1)).filter((i) => i >= 0);
  assert.ok(mine.length > 0, `chapter ${c.id} has steps`);
  assert.equal(range.start, mine[0], `${c.id}: range starts at its first step`);
  assert.equal(range.end, mine[mine.length - 1], `${c.id}: range ends at its last step`);
  // The reason chapters exist at all: a run you can read on one progress bar
  // and finish in one sitting.
  assert.ok(mine.length >= 4 && mine.length <= 8, `${c.id}: ${mine.length} steps is outside 4-8`);
}

// ── The hooks the steps point at still exist in the app ─────────────────────
/**
 * Every dock tab, restated — `BottomPanelTab` is a type union with no runtime
 * list, and BottomMultiTabPanel builds its hooks with a template literal, so
 * the names have to be reconstructed to be checked. Keep in step with
 * state/bottomPanelStore.ts, exactly as featureRegistry.test.ts does.
 */
const DOCK_TABS = [
  'levels', 'spectral', 'details', 'score', 'sing', 'lyric',
  'midi', 'step-seq', 'draw', 'slide', 'sway', 'xrbus',
];

const SRC = path.resolve(import.meta.dirname, '..');
/** The tour's own files write these names inside selector STRINGS; scanning
 *  them would make this test assert that the list agrees with itself. */
const SKIP_DIR = path.join(SRC, 'onboarding');

const files: string[] = [];
(function walk(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (full !== SKIP_DIR && e.name !== 'node_modules') walk(full);
    } else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) {
      files.push(full);
    }
  }
})(SRC);

const hooks = new Set<string>();
const notes = new Set<string>();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/data-tour="([^"]+)"/g)) hooks.add(m[1]);
  for (const m of src.matchAll(/data-feature-note="([^"]+)"/g)) notes.add(m[1]);
  // The two template-literal families, reconstructed from their own lists.
  if (/data-tour=\{`tab-\$\{/.test(src)) for (const t of CENTER_TABS) hooks.add(`tab-${t}`);
  if (/data-tour=\{`bottom-tab-\$\{/.test(src)) for (const t of DOCK_TABS) hooks.add(`bottom-tab-${t}`);
}
assert.ok(hooks.size > 10, 'the source scan actually found hooks');

for (const s of TOUR_STEPS) {
  const sel = s.targetSelector;
  if (!sel) continue;
  const tour = /^\[data-tour="([^"]+)"\]$/.exec(sel);
  if (tour) assert.ok(hooks.has(tour[1]), `${s.id}: no component carries data-tour="${tour[1]}"`);
  const note = /^\[data-feature-note="([^"]+)"\]$/.exec(sel);
  if (note) {
    assert.ok(notes.has(note[1]), `${s.id}: no component carries data-feature-note="${note[1]}"`);
  }
}

// Coverage, the thing this whole change was about: every workspace and every
// shipping dock panel is named by some step. A new tab with no step is a tab
// nobody is ever shown.
const allSelectors = TOUR_STEPS.map((s) => s.targetSelector ?? '').join(' ');
const allTabs = TOUR_STEPS.map((s) => s.tab ?? '');
for (const t of CENTER_TABS) {
  assert.ok(
    allTabs.includes(t) || allSelectors.includes(`tab-${t}`),
    `center tab ${t} appears in no tour step`,
  );
}
for (const t of DOCK_TABS.filter((d) => d !== 'xrbus')) {
  assert.ok(
    allSelectors.includes(`bottom-tab-${t}`) || TOUR_STEPS.some((s) => s.id === t),
    `dock panel ${t} appears in no tour step`,
  );
}

console.log('tourSteps tests passed');
