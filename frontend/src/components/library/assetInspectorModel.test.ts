import assert from 'node:assert/strict';
import {
  ASSET_INSPECTOR_TAB_STORAGE_KEY,
  INSPECTOR_TABS,
  filterPrettyJson,
  formatBytes,
  formatChannels,
  formatDateLabel,
  formatDurationLabel,
  formatSampleRate,
  formatUnknown,
  headerFacts,
  isSecretKey,
  overviewGroups,
  redactSecrets,
  sanitizeTab,
  setlistsReferencing,
  stemParentId,
  stemsOfParent,
  tabAfterKey,
  toRedactedJson,
  type InspectorEntryFacts,
} from './assetInspectorModel';

// ---------------------------------------------------------------- tab list

// Five tabs, in the order the dialog shows them, each with a stable id.
assert.deepEqual(
  INSPECTOR_TABS.map((t) => t.id),
  ['overview', 'stems', 'lineage', 'usedIn', 'raw'],
);
assert.deepEqual(
  INSPECTOR_TABS.map((t) => t.label),
  ['Overview', 'Stems', 'Lineage', 'Used in', 'Raw metadata'],
);
// Every tab has a non-empty label and no duplicate ids.
assert.equal(new Set(INSPECTOR_TABS.map((t) => t.id)).size, INSPECTOR_TABS.length);
assert.ok(INSPECTOR_TABS.every((t) => t.label.trim().length > 0));

// ------------------------------------------------- persisted-tab sanitizing

assert.equal(ASSET_INSPECTOR_TAB_STORAGE_KEY, 'thedaw.assetinspector.tab.v1');

// A remembered tab comes back as itself.
assert.equal(sanitizeTab('lineage'), 'lineage');
assert.equal(sanitizeTab('raw'), 'raw');
// Anything else — a tab id from an older build, a stray type, a trashed
// localStorage value — falls back instead of leaving the dialog blank.
assert.equal(sanitizeTab('files'), 'overview');
assert.equal(sanitizeTab(''), 'overview');
assert.equal(sanitizeTab(null), 'overview');
assert.equal(sanitizeTab(undefined), 'overview');
assert.equal(sanitizeTab(7), 'overview');
assert.equal(sanitizeTab({ id: 'raw' }), 'overview');
assert.equal(sanitizeTab(['raw']), 'overview');
// Surrounding whitespace and case from a hand-edited value still resolve.
assert.equal(sanitizeTab('  Lineage \n'), 'lineage');
assert.equal(sanitizeTab('USEDIN'), 'usedIn');
// An explicit fallback is honoured, and a junk fallback cannot escape.
assert.equal(sanitizeTab('nope', 'stems'), 'stems');

// ------------------------------------------------- arrow-key tab navigation

assert.equal(tabAfterKey('overview', 'ArrowRight'), 'stems');
assert.equal(tabAfterKey('overview', 'ArrowDown'), 'stems');
assert.equal(tabAfterKey('overview', 'ArrowLeft'), 'raw'); // wraps backwards
assert.equal(tabAfterKey('raw', 'ArrowRight'), 'overview'); // wraps forwards
assert.equal(tabAfterKey('lineage', 'ArrowLeft'), 'stems');
assert.equal(tabAfterKey('lineage', 'ArrowUp'), 'stems');
assert.equal(tabAfterKey('lineage', 'Home'), 'overview');
assert.equal(tabAfterKey('lineage', 'End'), 'raw');
// Keys the tablist does not own are left to the rest of the dialog.
assert.equal(tabAfterKey('lineage', 'Escape'), null);
assert.equal(tabAfterKey('lineage', 'Tab'), null);
assert.equal(tabAfterKey('lineage', 'a'), null);

// -------------------------------------------------- unknown-value formatting

// Nothing known reads "Unknown" — never an empty cell and never a zero.
assert.equal(formatUnknown(null), 'Unknown');
assert.equal(formatUnknown(undefined), 'Unknown');
assert.equal(formatUnknown(''), 'Unknown');
assert.equal(formatUnknown('   '), 'Unknown');
assert.equal(formatUnknown([]), 'Unknown');
assert.equal(formatUnknown(Number.NaN), 'Unknown');
assert.equal(formatUnknown(Number.POSITIVE_INFINITY), 'Unknown');
// Real values survive, trimmed; zero and false are facts, not absences.
assert.equal(formatUnknown(' htdemucs '), 'htdemucs');
assert.equal(formatUnknown(0), '0');
assert.equal(formatUnknown(-1), '-1');
assert.equal(formatUnknown(true), 'yes');
assert.equal(formatUnknown(false), 'no');
assert.equal(formatUnknown(['rock', 'live']), 'rock, live');
assert.equal(formatUnknown(['', ' ', 'rock']), 'rock');

// Duration: a missing or zero length says so rather than claiming 0:00.
assert.equal(formatDurationLabel(0), 'Unknown');
assert.equal(formatDurationLabel(-4), 'Unknown');
assert.equal(formatDurationLabel(Number.NaN), 'Unknown');
assert.equal(formatDurationLabel(null), 'Unknown');
assert.equal(formatDurationLabel(undefined), 'Unknown');
assert.equal(formatDurationLabel('185'), 'Unknown'); // a string is not a duration
assert.equal(formatDurationLabel(5), '0:05');
assert.equal(formatDurationLabel(65), '1:05');
assert.equal(formatDurationLabel(125.9), '2:05');
assert.equal(formatDurationLabel(600), '10:00');
assert.equal(formatDurationLabel(3600), '1:00:00');
assert.equal(formatDurationLabel(3725), '1:02:05');

assert.equal(formatSampleRate(44100), '44.1 kHz');
assert.equal(formatSampleRate(48000), '48 kHz');
assert.equal(formatSampleRate(96000), '96 kHz');
assert.equal(formatSampleRate(0), 'Unknown');
assert.equal(formatSampleRate(-1), 'Unknown');
assert.equal(formatSampleRate(null), 'Unknown');
assert.equal(formatSampleRate('44100'), 'Unknown');

assert.equal(formatChannels(1), 'Mono');
assert.equal(formatChannels(2), 'Stereo');
assert.equal(formatChannels(6), '6 channels');
assert.equal(formatChannels(0), 'Unknown');
assert.equal(formatChannels(2.5), 'Unknown');
assert.equal(formatChannels(null), 'Unknown');

assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(512), '512 B');
assert.equal(formatBytes(2048), '2.0 KB');
assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
assert.equal(formatBytes(-1), 'Unknown');
assert.equal(formatBytes(Number.NaN), 'Unknown');
assert.equal(formatBytes(null), 'Unknown');

assert.equal(formatDateLabel(''), 'Unknown');
assert.equal(formatDateLabel(null), 'Unknown');
assert.equal(formatDateLabel('not a date'), 'Unknown');
assert.equal(formatDateLabel(0), 'Unknown');
// A real ISO stamp formats to something locale-shaped that names the year.
assert.ok(formatDateLabel('2026-09-18T10:30:00.000Z').includes('2026'));

// ------------------------------------------------------------ field grouping

const ENTRY: InspectorEntryFacts = {
  id: 'entry-42',
  title: 'Night Drive',
  prompt: 'synthwave night drive',
  negativePrompt: '',
  model: 'small',
  duration: 125,
  steps: 8,
  cfg: 1,
  seed: -1,
  mimeType: 'audio/wav',
  fileSizeBytes: 5 * 1024 * 1024,
  timestamp: '2026-09-18T10:30:00.000Z',
  favorite: true,
  rating: 'like',
  tags: ['synthwave', 'night'],
  notes: '',
  lyrics: 'first line\nsecond line',
  source: 'generate',
  audioFilename: 'night-drive.wav',
  playCount: 3,
  lastPlayedAt: null,
  analysis: { sample_rate: 44100, channels: 2, container: 'wav', bpm: 118.44, key: 'A', scale: 'minor' },
};

const header = headerFacts(ENTRY);
const headerBy = (label: string) => header.find((f) => f.label === label)?.value;
assert.equal(headerBy('Kind'), 'audio');
assert.equal(headerBy('Duration'), '2:05');
assert.equal(headerBy('Format'), 'wav');
assert.equal(headerBy('Sample rate'), '44.1 kHz');
assert.equal(headerBy('Channels'), 'Stereo');
assert.equal(headerBy('Size'), '5.00 MB');

// A bare entry with no analysis still renders every header row, as "Unknown"
// where the fact is missing — and the duration never reads 0:00.
const bare: InspectorEntryFacts = {
  ...ENTRY,
  duration: 0,
  fileSizeBytes: 0,
  mimeType: '',
  analysis: undefined,
};
const bareHeader = headerFacts(bare);
assert.deepEqual(
  bareHeader.map((f) => f.label),
  header.map((f) => f.label),
);
assert.equal(bareHeader.find((f) => f.label === 'Duration')?.value, 'Unknown');
assert.equal(bareHeader.find((f) => f.label === 'Sample rate')?.value, 'Unknown');
assert.equal(bareHeader.find((f) => f.label === 'Channels')?.value, 'Unknown');
assert.equal(bareHeader.find((f) => f.label === 'Format')?.value, 'Unknown');
// The falls-back-to-the-MIME-type path, when ffprobe never ran.
assert.equal(headerFacts({ ...ENTRY, analysis: undefined }).find((f) => f.label === 'Format')?.value, 'audio/wav');

const groups = overviewGroups(ENTRY, { style: 'synthwave' });
const groupNames = groups.map((g) => g.title);
assert.deepEqual(groupNames, ['Dates', 'Prompt', 'Lyrics', 'Generation', 'Analysis', 'Library']);
const field = (group: string, label: string) =>
  groups.find((g) => g.title === group)?.fields.find((f) => f.label === label)?.value;
assert.equal(field('Prompt', 'Prompt'), 'synthwave night drive');
assert.equal(field('Prompt', 'Negative prompt'), 'Unknown');
assert.equal(field('Prompt', 'Style'), 'synthwave');
// Lyrics keep their line breaks; the field says so, so the view can preserve them.
assert.equal(field('Lyrics', 'Lyrics'), 'first line\nsecond line');
assert.equal(groups.find((g) => g.title === 'Lyrics')?.fields[0].multiline, true);
assert.equal(field('Generation', 'Model'), 'small');
assert.equal(field('Generation', 'Seed'), 'random');
assert.equal(field('Generation', 'Steps'), '8');
assert.equal(field('Generation', 'CFG'), '1.00');
assert.equal(field('Generation', 'File'), 'night-drive.wav');
assert.equal(field('Analysis', 'BPM'), '118.4');
assert.equal(field('Analysis', 'Key'), 'A minor');
assert.equal(field('Analysis', 'Loudness'), 'Unknown');
assert.equal(field('Library', 'Tags'), 'synthwave, night');
assert.equal(field('Library', 'Rating'), 'like');
assert.equal(field('Library', 'Favorite'), 'yes');
assert.equal(field('Library', 'Notes'), 'Unknown');
assert.equal(field('Dates', 'Plays'), '3');
assert.equal(field('Dates', 'Last played'), 'Unknown');
assert.ok((field('Dates', 'Created') ?? '').includes('2026'));

// A seed of 0 is a real seed, not "random".
assert.equal(overviewGroups({ ...ENTRY, seed: 0 }).find((g) => g.title === 'Generation')?.fields.find((f) => f.label === 'Seed')?.value, '0');

// A group in which nothing at all is known is dropped rather than shown as a
// wall of "Unknown" — here: no analysis, no lyrics, no style/prompt.
const emptyish = overviewGroups({
  ...ENTRY,
  prompt: '',
  negativePrompt: '',
  lyrics: '',
  analysis: {},
});
assert.deepEqual(
  emptyish.map((g) => g.title),
  ['Dates', 'Generation', 'Library'],
);

// ------------------------------------------------------ secret-key redaction

assert.equal(isSecretKey('Cookie'), true);
assert.equal(isSecretKey('set-cookie'), true);
assert.equal(isSecretKey('access_token'), true);
assert.equal(isSecretKey('Authorization'), true);
assert.equal(isSecretKey('client_secret'), true);
assert.equal(isSecretKey('PASSWORD'), true);
assert.equal(isSecretKey('x-amz-signature'), true);
assert.equal(isSecretKey('bpm'), false);
assert.equal(isSecretKey('title'), false);

assert.deepEqual(
  redactSecrets({
    title: 'Night Drive',
    Authorization: 'Bearer abc.def',
    nested: { cookieJar: 'sid=1', bpm: 118 },
    list: [{ api_token: 'tok_live_1' }, 'plain'],
  }),
  {
    title: 'Night Drive',
    Authorization: '[redacted]',
    nested: { cookieJar: '[redacted]', bpm: 118 },
    list: [{ api_token: '[redacted]' }, 'plain'],
  },
);

// Signed URLs lose their query string wherever they appear.
assert.equal(
  redactSecrets('https://cdn.example.com/a.wav?X-Amz-Signature=deadbeef&X-Amz-Expires=900'),
  'https://cdn.example.com/a.wav?[signed query removed]',
);
assert.equal(
  redactSecrets('/api/library/audio/entry-42?token=abc'),
  '/api/library/audio/entry-42?[signed query removed]',
);
// A plain query is left alone, and so is ordinary prose that happens to
// contain a question mark.
assert.equal(redactSecrets('/api/library/audio/entry-42?v=7'), '/api/library/audio/entry-42?v=7');
assert.equal(redactSecrets('is this a token? probably not'), 'is this a token? probably not');
// Non-objects pass straight through.
assert.equal(redactSecrets(118), 118);
assert.equal(redactSecrets(null), null);

// A self-referencing payload must not hang or throw.
const cyclic: Record<string, unknown> = { title: 'loop' };
cyclic.self = cyclic;
assert.deepEqual(redactSecrets(cyclic), { title: 'loop', self: '[circular]' });

// --------------------------------------------------------- raw JSON + search

const pretty = toRedactedJson({ title: 'Night Drive', bpm: 118, cookie: 'sid=1' });
assert.ok(pretty.includes('"title": "Night Drive"'));
assert.ok(pretty.includes('"cookie": "[redacted]"'));
assert.ok(!pretty.includes('sid=1'));
assert.equal(toRedactedJson(cyclic).includes('[circular]'), true);

const all = filterPrettyJson(pretty, '');
assert.equal(all.text, pretty);
assert.equal(all.matched, all.total);
assert.equal(all.total, pretty.split('\n').length);

const hit = filterPrettyJson(pretty, 'BPM'); // case-insensitive
assert.equal(hit.matched, 1);
assert.equal(hit.text, '  "bpm": 118,');
assert.equal(hit.total, pretty.split('\n').length);

const miss = filterPrettyJson(pretty, 'nothing-here');
assert.equal(miss.matched, 0);
assert.equal(miss.text, '');

// Whitespace-only search is no search at all.
assert.equal(filterPrettyJson(pretty, '   ').text, pretty);

// ------------------------------------------------------------------- stems

const STEM_ROWS = [
  { id: 'entry-42__vocals', entry_id: 'entry-42', parent_id: 'entry-42', stem_name: 'vocals', model: 'demucs', file_size_bytes: 1024 },
  { id: 'entry-42__drums', entry_id: 'entry-42', parent_id: 'entry-42', stem_name: 'drums', model: 'demucs' },
  { id: 'other__bass', entry_id: 'other', parent_id: 'other', stem_name: 'bass' },
  { id: '', entry_id: 'entry-42', stem_name: 'broken' },
];
assert.deepEqual(stemsOfParent(STEM_ROWS, 'entry-42'), [
  { id: 'entry-42__drums', name: 'drums', model: 'demucs', sizeBytes: null },
  { id: 'entry-42__vocals', name: 'vocals', model: 'demucs', sizeBytes: 1024 },
]);
assert.deepEqual(stemsOfParent(STEM_ROWS, 'nobody'), []);
assert.deepEqual(stemsOfParent([], 'entry-42'), []);

// An entry that IS a stem has an incoming `stem_of` edge naming its parent.
const EDGES = [
  { from_id: 'parent-1', to_id: 'entry-42', kind: 'stem_of' },
  { from_id: 'entry-42', to_id: 'child-9', kind: 'derived_from' },
];
assert.equal(stemParentId(EDGES, 'entry-42'), 'parent-1');
assert.equal(stemParentId(EDGES, 'child-9'), null);
assert.equal(stemParentId([], 'entry-42'), null);
// The outgoing direction is the parent side, so it is NOT a stem.
assert.equal(stemParentId([{ from_id: 'entry-42', to_id: 'entry-42__vocals', kind: 'stem_of' }], 'entry-42'), null);

// ------------------------------------------------------------------ used in

const SETLISTS = [
  { id: 'set-a', name: 'Friday', entries: [{ entryId: 'entry-42' }, { entryId: 'other' }, { entryId: 'entry-42' }] },
  { id: 'set-b', name: 'Sunday', entries: [{ entryId: 'other' }] },
  { id: 'set-c', name: 'Ad hoc', entries: [{ entryId: null }] },
];
assert.deepEqual(setlistsReferencing(SETLISTS, 'entry-42'), [
  { id: 'set-a', name: 'Friday', positions: [1, 3] },
]);
// Every set that names the entry is listed, in the order the sets come in.
assert.deepEqual(setlistsReferencing(SETLISTS, 'other'), [
  { id: 'set-a', name: 'Friday', positions: [2] },
  { id: 'set-b', name: 'Sunday', positions: [1] },
]);
assert.deepEqual(setlistsReferencing(SETLISTS, 'missing'), []);
// An empty id never matches the ad-hoc, entry-less slots.
assert.deepEqual(setlistsReferencing(SETLISTS, ''), []);

console.log('assetInspectorModel: ok');
