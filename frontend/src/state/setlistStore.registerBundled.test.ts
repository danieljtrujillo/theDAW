// Run with: npx tsx src/state/setlistStore.registerBundled.test.ts
//
// Opening a bundled set registers its files (the listing is read-only), and
// the ids it gets back are patched INTO the set the user has. The set is
// theirs by then: the DJ tab lets them reorder it, drop their own tracks in
// and take tracks out, and an earlier version of this replaced the whole
// entries array with the backend's answer -- silently undoing all of it.
// Also: no request at all for a locally-created set or for one that is
// already registered, and a failure says so instead of looking like success.
import assert from 'node:assert/strict';
import { useSetlistStore, type Setlist, type SetlistEntry } from './setlistStore.ts';
import { useLogStore } from './logStore.ts';

type Reply = { status: number; body: unknown } | 'network-error';

const requests: string[] = [];
let handler: () => Reply = () => ({ status: 200, body: {} });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  requests.push(`${init?.method ?? 'GET'} ${url}`);
  const reply = handler();
  if (reply === 'network-error') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const BUNDLED_ID = 'zad-night-ride-abcd1234';

const track = (label: string, entryId: string | null = null, file?: string): SetlistEntry =>
  ({ entryId, label, kind: 'audio', ...(file ? { file } : {}) });

const seed = (id: string, entries: SetlistEntry[]): void => {
  const setlist: Setlist = {
    id,
    name: 'NIGHT RIDE',
    entries,
    createdAt: 1,
    updatedAt: 1,
    notes: '',
  };
  useSetlistStore.setState({ setlists: { [id]: setlist }, activeId: id });
};

const entriesOf = (id: string): SetlistEntry[] =>
  useSetlistStore.getState().setlists[id]?.entries ?? [];

/** Only the register calls: patching ids also kicks background analysis for
 *  the tracks that just became real, which is its own GET. */
const registerCalls = (): string[] => requests.filter((r) => r.includes('/register'));

const reset = (): void => {
  requests.length = 0;
  handler = () => ({ status: 200, body: {} });
  useSetlistStore.setState({ setlists: {}, activeId: null });
  useLogStore.setState({ entries: [] });
};

/** What the backend answers: every bundled track, in ITS order, registered.
 *  `files`, when given, is the file name each row came from. */
const registered = (labels: string[], files?: string[]): Reply => ({
  status: 200,
  body: {
    setlist: {
      id: BUNDLED_ID,
      name: 'NIGHT RIDE',
      entries: labels.map((label, i) => ({
        entryId: `entry-${i}`,
        label,
        kind: 'audio',
        ...(files ? { file: files[i] } : {}),
      })),
    },
  },
});

async function theUsersEditsSurviveRegistration(): Promise<void> {
  reset();
  // The user reordered the bundled tracks (B before A), deleted C, and dragged
  // one of their own library tracks in.
  seed(BUNDLED_ID, [
    track('B'),
    { entryId: 'mine-42', label: 'My own track', kind: 'audio' },
    track('A'),
  ]);
  handler = () => registered(['A', 'B', 'C']);

  const out = await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.deepEqual(registerCalls(), [`POST /api/library/setlists/${BUNDLED_ID}/register`]);
  assert.deepEqual(
    entriesOf(BUNDLED_ID).map((e) => [e.label, e.entryId]),
    [
      ['B', 'entry-1'],
      ['My own track', 'mine-42'],
      ['A', 'entry-0'],
    ],
    'registration must patch ids in place, not replace the array',
  );
  assert.equal(entriesOf(BUNDLED_ID).length, 3, 'C must not come back');
  assert.deepEqual(out?.map((e) => e.entryId), ['entry-1', 'mine-42', 'entry-0']);
}

async function twoTracksSharingALabelGetTheirOwnEntry(): Promise<void> {
  reset();
  seed(BUNDLED_ID, [track('Untitled'), track('Untitled')]);
  handler = () => registered(['Untitled', 'Untitled']);

  await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.deepEqual(entriesOf(BUNDLED_ID).map((e) => e.entryId), ['entry-0', 'entry-1']);
}

async function sameLabelReorderedStillBindsToItsOwnFile(): Promise<void> {
  reset();
  // Two untitled tracks, and the user moved the SECOND file to the top before
  // opening the set. Matching by label alone in the backend's order would hand
  // each row the other one's entry -- the wrong audio on the wrong slot.
  seed(BUNDLED_ID, [track('Untitled', null, 'b.wav'), track('Untitled', null, 'a.wav')]);
  handler = () => registered(['Untitled', 'Untitled'], ['a.wav', 'b.wav']);

  await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.deepEqual(
    entriesOf(BUNDLED_ID).map((e) => [e.file, e.entryId]),
    [
      ['b.wav', 'entry-1'],
      ['a.wav', 'entry-0'],
    ],
    'each row must get the id of ITS file, not of the row in that position',
  );
}

async function fillingIdsIsNotAnEdit(): Promise<void> {
  reset();
  seed(BUNDLED_ID, [track('A', null, 'a.wav'), track('B', null, 'b.wav')]);
  const before = useSetlistStore.getState().setlists[BUNDLED_ID].updatedAt;
  handler = () => registered(['A', 'B'], ['a.wav', 'b.wav']);

  await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.equal(
    useSetlistStore.getState().setlists[BUNDLED_ID].updatedAt,
    before,
    'the DJ set list is sorted by updatedAt; opening a set must not reorder it',
  );
  assert.deepEqual(entriesOf(BUNDLED_ID).map((e) => e.entryId), ['entry-0', 'entry-1']);
}

async function aLocalSetIsNeverPosted(): Promise<void> {
  reset();
  seed('set-1730000000000-42', [track('A'), track('B')]);

  const out = await useSetlistStore.getState().registerBundled('set-1730000000000-42');

  assert.deepEqual(registerCalls(), [], 'a locally-created set has no folder to register');
  assert.equal(out?.length, 2);
}

async function anAlreadyRegisteredSetIsNeverPosted(): Promise<void> {
  reset();
  seed(BUNDLED_ID, [track('A', 'entry-0'), track('B', 'entry-1')]);

  await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.deepEqual(registerCalls(), [], 'nothing was pending; the open must be free');
}

async function adHocRowsAreNotWaitingOnTheBackend(): Promise<void> {
  reset();
  // A VJ archive clip referenced by URL has no library entry and never will.
  seed(BUNDLED_ID, [{ entryId: null, label: 'clip', kind: 'video', url: 'blob:x' }]);

  await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.deepEqual(registerCalls(), []);
}

async function aFailureIsSaidOutLoud(): Promise<void> {
  reset();
  seed(BUNDLED_ID, [track('A'), track('B')]);
  handler = () => ({ status: 404, body: { detail: 'no such bundled performance set' } });

  const out = await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.equal(out, null, 'a failed registration must not read as success');
  assert.deepEqual(entriesOf(BUNDLED_ID).map((e) => e.entryId), [null, null]);
  const logged = useLogStore.getState().entries;
  assert.equal(logged.length, 1, 'the user gets exactly one line about it');
  assert.equal(logged[0].level, 'warn');
  assert.match(logged[0].msg, /2 tracks of "NIGHT RIDE"/);
}

async function aNetworkErrorIsSaidOutLoudToo(): Promise<void> {
  reset();
  seed(BUNDLED_ID, [track('A'), track('B')]);
  handler = () => 'network-error';

  const out = await useSetlistStore.getState().registerBundled(BUNDLED_ID);

  assert.equal(out, null);
  assert.equal(useLogStore.getState().entries.length, 1);
}

const CASES: Array<[string, () => Promise<void>]> = [
  ["the user's reorder, removal and own track survive", theUsersEditsSurviveRegistration],
  ['two tracks sharing a label get their own entry', twoTracksSharingALabelGetTheirOwnEntry],
  ['same-label tracks, reordered, bind to their own file', sameLabelReorderedStillBindsToItsOwnFile],
  ['filling ids in does not count as an edit', fillingIdsIsNotAnEdit],
  ['a locally-created set is never posted', aLocalSetIsNeverPosted],
  ['an already-registered set is never posted', anAlreadyRegisteredSetIsNeverPosted],
  ['ad-hoc URL rows are not waiting on the backend', adHocRowsAreNotWaitingOnTheBackend],
  ['a failed registration is reported', aFailureIsSaidOutLoud],
  ['a network error is reported', aNetworkErrorIsSaidOutLoudToo],
];

let failed = 0;
for (const [name, run] of CASES) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}
console.log(`${CASES.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
