/**
 * node:assert invariants for the feature registry. Run from `frontend/`:
 *   npx tsx src/onboarding/featureRegistry.test.ts
 *
 * The registry is a DOM contract written down as data, and nothing about it
 * fails loudly at runtime — a typo'd id or a selector for an element that was
 * renamed just makes a spotlight quietly find nothing. This is where that gets
 * caught instead.
 */
import assert from 'node:assert/strict';
import { CENTER_TABS } from '../state/appUiStore';
import { FEATURES, featureById } from './featureRegistry';
import { FEATURE_NOTES } from './featureNoteList';

/**
 * Every dock tab, restated. Keep in step with `BottomPanelTab` in
 * state/bottomPanelStore.ts — it is a type union with no runtime list, and
 * restating it here is exactly what makes a new tab with no registry entry
 * (and so no tooltip and no way to find it) fail.
 */
const DOCK_TABS = [
  'levels', 'spectral', 'details', 'score', 'sing', 'lyric',
  'midi', 'step-seq', 'draw', 'slide',
] as const;

const ids = new Set<string>();
for (const f of FEATURES) {
  assert.ok(!ids.has(f.id), `duplicate id: ${f.id}`);
  ids.add(f.id);
  assert.ok(f.name.trim().length > 0, `${f.id}: has a name`);
  assert.ok(f.what.trim().length > 0, `${f.id}: says what it is`);
  assert.ok(f.where.trim().length > 0, `${f.id}: says where it lives`);
  assert.ok(f.how.length > 0, `${f.id}: says how to use it`);
  for (const step of f.how) assert.ok(step.trim().length > 0, `${f.id}: no blank how-step`);
  assert.equal(featureById(f.id), f, `${f.id}: resolves by id`);
  if (f.locate) {
    assert.ok(/^[[a-zA-Z.#]/.test(f.locate.selector), `${f.id}: plausible selector`);
    assert.ok(f.locate.selector.trim().length > 0, `${f.id}: non-empty selector`);
  }
}
assert.equal(featureById('no-such-feature'), undefined, 'an unknown id resolves to nothing');

// Coverage. A tab with no entry is a tab the help search cannot find and the
// tour cannot point at.
for (const tab of CENTER_TABS) {
  const f = featureById(tab);
  assert.ok(f, `center tab ${tab} has a registry entry`);
  assert.deepEqual(f.surface, { kind: 'center', tab }, `${tab}: surface names its own tab`);
}
for (const tab of DOCK_TABS) {
  const f = featureById(`panel-${tab}`);
  assert.ok(f, `dock tab ${tab} has a registry entry`);
  assert.deepEqual(f.surface, { kind: 'dock', tab }, `panel-${tab}: surface names its own tab`);
}

// Names are what a search matches on, so two entries must not answer to the
// same one. SWAY is the reason: it is both a workspace and a dock tab.
const names = new Set<string>();
for (const f of FEATURES) {
  const key = f.name.toLowerCase();
  assert.ok(!names.has(key), `two features both called "${f.name}"`);
  names.add(key);
}

// Every pinned note names a real entry. A note's own `target` is allowed to
// differ from that entry's `locate` selector — the note points at the
// affordance, the registry at the thing it opens — so nothing here asserts they
// match.
for (const note of FEATURE_NOTES) {
  assert.ok(featureById(note.feature), `feature note ${note.id} names a real feature`);
}

// The library is deliberately NOT among them: its edge tab carries the LIBRARY
// wordmark, and a note is only for a control with no visible label of its own.
assert.ok(
  !FEATURE_NOTES.some((n) => n.feature === 'library'),
  'a labelled control does not get a pinned note',
);
assert.ok(featureById('library')?.locate, 'the library is still findable from the help search');

console.log('featureRegistry tests passed');
