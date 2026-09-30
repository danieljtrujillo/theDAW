/**
 * The DJ deck's stem-load pad is the Abort control while a split runs.
 *
 * The old deck rack had an Abort button beside Separate that POSTed
 * `/api/stems/{entry}/abort`; the pad bank that replaced it lost the button,
 * so a wrong press meant sitting through a whole separation. The pad now
 * shows Abort while its split runs (`stemLoadPadFace`), and the split
 * (`runDeckStemSplit`, on an AbortSignal that `ensureStems` turns into the
 * same abort route) ends with the deck as it was: nothing loaded, nothing
 * reported as failed.
 *
 * The cases run the real `prepareStems` / `ensureStems` against a fake stems
 * backend, with the deck load replaced by a recorder, so what they prove is
 * the wire: which routes are called, in what order, and what the split
 * reports.
 *
 * Run: `npx tsx src/views/DJView.stemabort.test.ts` - `npm test` discovers it.
 */
import assert from 'node:assert/strict';

// Imported with no `window`: DJView pulls in playerStore, whose module body
// reads `import.meta.env.DEV` behind a `typeof window` check, and plain tsx
// has no `import.meta.env`.
const { runDeckStemSplit, stemLoadPadFace } = await import('./DJView.tsx');
const { prepareStems, isStemsAborted } = await import('../lib/djStems.ts');
const { useDjAnalysisStore } = await import('../state/djAnalysisStore.ts');

const ENTRY = 'x';

/** The fake stems backend: one run per test, held until the test says how it
 *  ends. Records every abort POST and every run POST. */
interface FakeStems {
  aborts: number;
  runs: number;
  /** What `/progress` answers with. */
  phase: string;
  /** Resolves once the run POST has arrived. */
  runStarted: Promise<void>;
  /** End the held run: a 503 "aborted by user" or a 200 with stems. */
  endRun: (how: 'aborted' | 'completed') => void;
  /** Called on every abort POST, before it answers. */
  onAbort: () => void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const installFakeStems = (): FakeStems => {
  let started!: () => void;
  let end!: (how: 'aborted' | 'completed') => void;
  const fake: FakeStems = {
    aborts: 0,
    runs: 0,
    phase: 'idle',
    runStarted: new Promise<void>((resolve) => { started = resolve; }),
    endRun: (how) => end(how),
    onAbort: () => {},
  };
  const ended = new Promise<'aborted' | 'completed'>((resolve) => { end = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (url === `/api/stems/${ENTRY}` && method === 'GET') return json({ stems: [] });
    if (url === `/api/stems/${ENTRY}/progress`) return json({ phase: fake.phase, progress: 0.4 });
    if (url === `/api/stems/${ENTRY}/abort` && method === 'POST') {
      fake.aborts += 1;
      fake.onAbort();
      return json({ ok: fake.phase !== 'idle', entry_id: ENTRY });
    }
    if (url.startsWith(`/api/stems/${ENTRY}/run?`) && method === 'POST') {
      fake.runs += 1;
      started();
      const how = await ended;
      if (how === 'aborted') return json({ detail: `stem separation aborted by user for ${ENTRY}` }, 503);
      return json({ entry_id: ENTRY, stems: [{ id: 's1', stem_name: 'vocals' }] });
    }
    return json({ detail: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
  return fake;
};

/** The analysis the split runs first is already there. */
const seedAnalysis = () => {
  useDjAnalysisStore.setState({
    byId: {
      [ENTRY]: {
        status: 'ready',
        data: {
          bpm: 120, bpm_confidence: 1, key: 'C', scale: 'major', key_confidence: 1,
          bars_estimated: 64, rms_db: -12, duration_sec: 180, beats: null, analyzed_at: 1,
        },
      },
    },
  });
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

/** A split with a recorder in place of the deck load. */
const startSplit = (signal: AbortSignal) => {
  const loads: string[][] = [];
  const msgs: string[] = [];
  const done = runDeckStemSplit(
    'A',
    ENTRY,
    { stems: 4, device: 'auto', quality: 'balanced', signal },
    (m) => msgs.push(m),
    { prepare: prepareStems, load: async (_deck, refs) => { loads.push(refs.map((r) => r.name)); } },
  );
  return { done, loads, msgs };
};

await test('the pad reads Abort, enabled and named for the deck, while its split runs', async () => {
  const running = stemLoadPadFace(true, ENTRY, 'A', 4, '40%');
  assert.equal(running.label, 'Abort');
  assert.equal(running.disabled, false);
  assert.equal(running.ariaLabel, 'Abort stem separation for Deck A');
  assert.equal(running.title, 'Abort stem separation for Deck A (40%)');
  assert.doesNotMatch(running.label + running.ariaLabel, /[^\x20-\x7e]/, 'plain words, no symbols');
  const idle = stemLoadPadFace(false, ENTRY, 'B', 4, null);
  assert.equal(idle.label, 'Stems');
  assert.equal(idle.disabled, false);
  assert.equal(idle.ariaLabel, 'Load or separate 4 stems for Deck B');
  const empty = stemLoadPadFace(false, null, 'B', 4, null);
  assert.equal(empty.disabled, true, 'no track, nothing to split');
  assert.equal(empty.title, 'Load a track first');
});

await test('pressing Abort mid-run POSTs the abort route and leaves the deck as it was', async () => {
  const fake = installFakeStems();
  seedAnalysis();
  const controller = new AbortController();
  const split = startSplit(controller.signal);
  await fake.runStarted;
  fake.phase = 'separating';
  assert.equal(fake.aborts, 0, 'nothing aborted before the press');
  // The backend marks the run "aborting" and ends it at its next poll tick.
  fake.onAbort = () => { fake.phase = 'aborting'; fake.endRun('aborted'); };
  controller.abort();
  const result = await split.done;
  assert.equal(result.outcome, 'aborted');
  assert.equal(result.error, undefined, 'an abort is not a failure');
  assert.equal(fake.aborts, 1, 'one abort POST for one press');
  assert.equal(fake.runs, 1);
  assert.deepEqual(split.loads, [], 'nothing was loaded on the deck');
});

await test('an abort before the run is submitted never submits it', async () => {
  const fake = installFakeStems();
  seedAnalysis();
  const controller = new AbortController();
  controller.abort();
  const split = startSplit(controller.signal);
  const result = await split.done;
  assert.equal(result.outcome, 'aborted');
  assert.equal(fake.runs, 0, 'no run POST');
  assert.deepEqual(split.loads, []);
});

await test('a run that finishes after a late abort still loads nothing', async () => {
  const fake = installFakeStems();
  seedAnalysis();
  const controller = new AbortController();
  const split = startSplit(controller.signal);
  await fake.runStarted;
  fake.phase = 'separating';
  // The abort lands in the run's write-out: the backend completes anyway.
  fake.onAbort = () => { fake.phase = 'completed'; fake.endRun('completed'); };
  controller.abort();
  const result = await split.done;
  assert.equal(result.outcome, 'aborted');
  assert.equal(fake.aborts, 1);
  assert.deepEqual(split.loads, [], 'the stems stay cached for next time, the deck is untouched');
});

await test('an abort while the run is still queued is re-sent once the run is alive', async () => {
  const fake = installFakeStems();
  seedAnalysis();
  const controller = new AbortController();
  const split = startSplit(controller.signal);
  await fake.runStarted;
  // Queued behind the GPU lane: no progress snapshot, so the backend has
  // nothing to mark (`ok: false`). The run comes alive afterwards.
  fake.phase = 'idle';
  fake.onAbort = () => {
    if (fake.phase === 'idle') fake.phase = 'starting';
    else { fake.phase = 'aborting'; fake.endRun('aborted'); }
  };
  controller.abort();
  await tick();
  assert.equal(fake.aborts, 1, 'the press went out at once');
  // The progress poll (every 1.5 s) sees a live run and an aborted signal.
  const result = await split.done;
  assert.equal(result.outcome, 'aborted');
  assert.equal(fake.aborts, 2, 're-sent when the run came alive');
  assert.deepEqual(split.loads, []);
});

await test('prepareStems rejects with StemsAborted, which the split reads as an abort', async () => {
  installFakeStems();
  seedAnalysis();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareStems(ENTRY, { stems: 4, signal: controller.signal }),
    (e: unknown) => isStemsAborted(e),
  );
});

console.log(`DJView.stemabort: ${passed} passed`);
