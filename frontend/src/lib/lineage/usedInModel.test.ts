import assert from 'node:assert/strict';
import {
  madeFromHeading,
  madeFromRows,
  projectRows,
  rangeLabel,
  renderCountLabel,
  renderKindLabel,
  renderRows,
} from './usedInModel';
import type { LineageSources, LineageUsedIn } from './lineageTypes';

// ---------------------------------------------------------- renderKindLabel
// renderKindLabel covers all four kinds and an unknown one

assert.equal(renderKindLabel('full'), 'Full render');
assert.equal(renderKindLabel('range'), 'Range render');
assert.equal(renderKindLabel('stems'), 'Stems render');
assert.equal(renderKindLabel('clips'), 'Clips render');
assert.equal(renderKindLabel('remix'), 'Render');
assert.equal(renderKindLabel(null), 'Render');
assert.equal(renderKindLabel(undefined), 'Render');
assert.equal(renderKindLabel(7), 'Render');
assert.equal(renderKindLabel({}), 'Render');

// --------------------------------------------------------- renderCountLabel
// renderCountLabel: singular, plural, none

assert.equal(renderCountLabel(1), '1 render');
assert.equal(renderCountLabel(2), '2 renders');
assert.equal(renderCountLabel(11), '11 renders');
assert.equal(renderCountLabel(0), 'No renders');
assert.equal(renderCountLabel(-3), 'No renders');
assert.equal(renderCountLabel(2.5), 'No renders');
assert.equal(renderCountLabel(Number.NaN), 'No renders');
assert.equal(renderCountLabel(Number.POSITIVE_INFINITY), 'No renders');
assert.equal(renderCountLabel('3'), 'No renders');
assert.equal(renderCountLabel(null), 'No renders');
assert.equal(renderCountLabel(undefined), 'No renders');

// --------------------------------------------------------------- rangeLabel
// rangeLabel: whole track, a 0-start pair, one-sided ranges

assert.equal(rangeLabel(undefined, undefined), 'Whole track');
assert.equal(rangeLabel(null, null), 'Whole track');
assert.equal(rangeLabel(Number.NaN, Number.NaN), 'Whole track');
// A 0-start pair: formatDurationLabel(0) alone would read "Unknown".
assert.equal(rangeLabel(0, 90), '0:00 – 1:30');
assert.equal(rangeLabel(65, 125), '1:05 – 2:05');
// One-sided ranges.
assert.equal(rangeLabel(30, undefined), 'from 0:30');
assert.equal(rangeLabel(0, undefined), 'from 0:00');
assert.equal(rangeLabel(undefined, 45), 'up to 0:45');
assert.equal(rangeLabel('30', 45), 'up to 0:45'); // a wrong-typed start is treated as missing, not as 30

// -------------------------------------------------------------- projectRows
// projectRows sorts newest first and falls back to Untitled project
// projectRows skips rows without a project id

const usedIn: LineageUsedIn = {
  entry_id: 'entry-1',
  projects: [
    { project_id: 'p-old', project_name: 'Old Mix', renders: 1, last_render_at: '2026-01-01T00:00:00Z' },
    { project_id: 'p-new', project_name: '   ', renders: 3, last_render_at: '2026-06-01T00:00:00Z' },
    { project_id: '', project_name: 'No id', renders: 2, last_render_at: '2026-05-01T00:00:00Z' },
  ],
  renders: [],
};

const pRows = projectRows(usedIn);
assert.equal(pRows.length, 2); // the id-less project is skipped
assert.equal(pRows[0].id, 'p-new'); // newest last_render_at first
assert.equal(pRows[0].name, 'Untitled project'); // blank project_name falls back
assert.equal(pRows[0].rendersLabel, '3 renders');
assert.equal(pRows[1].id, 'p-old');
assert.equal(pRows[1].name, 'Old Mix');
assert.equal(
  pRows[0].ariaLabel,
  `Open Untitled project — 3 renders, last render ${pRows[0].lastRenderLabel}`,
);
assert.ok(pRows[0].lastRenderAt > pRows[1].lastRenderAt);
assert.deepEqual(projectRows(null), []);
assert.deepEqual(projectRows(undefined), []);

// Ties on last_render_at break by name, ascending.
const tieUsedIn: LineageUsedIn = {
  entry_id: 'e',
  projects: [
    { project_id: 'b', project_name: 'Bravo', renders: 1, last_render_at: '2026-01-01T00:00:00Z' },
    { project_id: 'a', project_name: 'Alpha', renders: 1, last_render_at: '2026-01-01T00:00:00Z' },
  ],
  renders: [],
};
assert.deepEqual(projectRows(tieUsedIn).map((r) => r.name), ['Alpha', 'Bravo']);

// --------------------------------------------------------------- renderRows
// renderRows sorts newest first and marks a missing output entry in the aria label

const usedInRenders: LineageUsedIn = {
  entry_id: 'entry-1',
  projects: [],
  renders: [
    {
      render_id: 'r-old',
      created_at: '2026-01-01T00:00:00Z',
      kind: 'full',
      project_id: 'p1',
      project_name: 'Song A',
      output_entry_id: 'out-1',
      output_path: '/x',
    },
    {
      render_id: 'r-new',
      created_at: '2026-06-01T00:00:00Z',
      kind: 'stems',
      project_id: 'p2',
      project_name: 'Song B',
      output_entry_id: null,
      output_path: null,
    },
    {
      render_id: '',
      created_at: '2026-07-01T00:00:00Z',
      kind: 'full',
      project_id: 'p3',
      project_name: 'No id',
      output_entry_id: 'out-3',
      output_path: '/z',
    },
  ],
};

const rRows = renderRows(usedInRenders);
assert.equal(rRows.length, 2); // the id-less render is skipped
assert.equal(rRows[0].id, 'r-new'); // newest created_at first
assert.equal(rRows[0].outputEntryId, null);
assert.equal(
  rRows[0].ariaLabel,
  `Stems render of Song B from ${rRows[0].dateLabel} — output not in the library`,
);
assert.equal(rRows[1].id, 'r-old');
assert.equal(rRows[1].outputEntryId, 'out-1');
assert.equal(rRows[1].ariaLabel, `Open the full render of Song A from ${rRows[1].dateLabel}`);
assert.deepEqual(renderRows(null), []);
assert.deepEqual(renderRows(undefined), []);

// -------------------------------------------------------------- madeFromRows
// madeFromRows sorts by start time ascending and labels roles

const sources = {
  entry_id: 'out-1',
  render: {
    render_id: 'r-1',
    project_id: 'p-1',
    project_name: 'Song A',
    created_at: '2026-01-01T00:00:00Z',
    output: { library_entry_id: 'out-1', path: '/x', kind: 'full', start_sec: null, end_sec: null },
    contributions: [
      { library_entry_id: 'e-2', clip_id: '', track_id: 't2', start_sec: 30, end_sec: 60, source_offset_sec: 0, role: 'midi' },
      { library_entry_id: 'e-1', clip_id: 'clip-a', track_id: 't1', start_sec: 0, end_sec: 30, source_offset_sec: 5, role: 'audio' },
      { library_entry_id: '', clip_id: 'clip-x', track_id: 't3', start_sec: 10, end_sec: 20, source_offset_sec: 0, role: 'stem' },
      { library_entry_id: 'e-3', clip_id: 'clip-c', track_id: 't3', start_sec: 90, end_sec: 120, source_offset_sec: 0, role: 'drone' },
    ],
  },
} as unknown as LineageSources;

const mRows = madeFromRows(sources);
assert.equal(mRows.length, 3); // the entry-id-less contribution is skipped
assert.deepEqual(mRows.map((r) => r.entryId), ['e-1', 'e-2', 'e-3']); // ascending start time
assert.equal(mRows[0].key, 'e-1:clip-a');
assert.equal(mRows[1].key, 'e-2:0'); // blank clip id falls back to its index (0) in the contributions array
assert.equal(mRows[0].roleLabel, 'Audio');
assert.equal(mRows[1].roleLabel, 'MIDI');
assert.equal(mRows[2].roleLabel, 'Source'); // an unrecognized role
assert.equal(mRows[0].rangeLabel, '0:00 – 0:30');
assert.equal(mRows[0].ariaLabel, 'Open the source used at 0:00 – 0:30');
assert.deepEqual(madeFromRows(null), []);
assert.deepEqual(madeFromRows(undefined), []);
assert.deepEqual(madeFromRows({ entry_id: 'x', render: null }), []);

// ------------------------------------------------------------ madeFromHeading
// madeFromHeading is empty when the entry is not a render output

assert.equal(madeFromHeading(sources), 'Made from (3)');
assert.equal(madeFromHeading({ entry_id: 'x', render: null }), '');
assert.equal(madeFromHeading(null), '');
assert.equal(madeFromHeading(undefined), '');

// ------------------------------------------------- garbage input survives
// every exported function survives null and garbage input

const garbageInputs: unknown[] = [null, undefined, 0, '', 'nope', [], {}, [1, 2, 3], () => {}];
for (const garbage of garbageInputs) {
  assert.doesNotThrow(() => renderKindLabel(garbage));
  assert.doesNotThrow(() => renderCountLabel(garbage));
  assert.doesNotThrow(() => rangeLabel(garbage, garbage));
  assert.doesNotThrow(() => projectRows(garbage as LineageUsedIn | null | undefined));
  assert.doesNotThrow(() => renderRows(garbage as LineageUsedIn | null | undefined));
  assert.doesNotThrow(() => madeFromRows(garbage as LineageSources | null | undefined));
  assert.doesNotThrow(() => madeFromHeading(garbage as LineageSources | null | undefined));
}

// A used-in payload whose nested fields are the wrong type entirely.
const wildUsedIn = {
  entry_id: 123,
  projects: 'not an array',
  renders: [
    {
      render_id: 42,
      created_at: null,
      kind: {},
      project_id: null,
      project_name: 9,
      output_entry_id: 5,
      output_path: undefined,
    },
  ],
} as unknown as LineageUsedIn;
assert.deepEqual(projectRows(wildUsedIn), []);
assert.deepEqual(renderRows(wildUsedIn), []); // render_id is not a string, so the row is dropped

const wildSources = {
  entry_id: 1,
  render: {
    render_id: 1,
    project_id: 1,
    project_name: 1,
    created_at: 1,
    output: {},
    contributions: 'nope',
  },
} as unknown as LineageSources;
assert.deepEqual(madeFromRows(wildSources), []);
assert.equal(madeFromHeading(wildSources), 'Made from (0)');

console.log('usedInModel: ok');
