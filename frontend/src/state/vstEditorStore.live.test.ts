/**
 * vstEditorStore — the LIVE editor routing paths (F1b3 / R1 findings 7 and 8).
 *
 * Two bugs, one root cause: `open()` only ever checked for a live session that
 * was ALREADY `live`, and `setMode()` only ever knew how to relaunch the
 * OFFLINE sidecar editor. Together: clicking 'Edit GUI' while a live session
 * was still spawning opened a SECOND copy of the plugin (and could stamp a
 * `pedalboard` origin onto an entry a live host was about to own), and
 * toggling embedded/floating on an already-open LIVE editor did nothing.
 *
 * This drives `open()` and `setMode()` through the seams F1b3 added for it —
 * `__setLiveSessionLookupForTest` (the live-session source) and
 * `__setLiveWaitClockForTest` (the bounded wait's clock) — because the store
 * reaches both through module-level state, not constructor arguments.
 *
 * `window` is stubbed as a Proxy: real timers plus a fake Electron handle for
 * the handful of properties `openLiveEditor` touches (`setInterval`,
 * `devicePixelRatio`, `electronAPI`), and a harmless no-op function for
 * anything else this file's import graph pokes at (`effectChainStore` and
 * `editorStore` are both `persist`-wrapped and pull in browser-only setup the
 * moment `window` exists at all — giving every one of those a real
 * implementation is not this ticket's job). The shim has to exist BEFORE any
 * of those stores rehydrate in their MODULE BODY, hence the dynamic imports
 * below (same constraint as effectChainStore.test.ts).
 *
 * No real WebSocket, host process or AudioContext: every VstLiveSession here
 * is a plain object whose `client` just records calls, and `fetch` is stubbed
 * to fail loudly so an accidental reach for the offline sidecar's backend
 * surfaces immediately instead of hanging on a nonexistent server.
 *
 * Run: npx tsx src/state/vstEditorStore.live.test.ts
 */
import assert from 'node:assert/strict';

import type { ChainEntry } from './effectChainStore.ts';
import type { VstLiveSession } from '../lib/vstLive/sessionRegistry.ts';
import type { LiveWaitClock } from './vstEditorStore.ts';

/* ── window/localStorage shim, installed BEFORE any store import rehydrates ── */

const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
} as Storage;

/** What a truthy Electron parent-window handle looks like here — enough to
 *  drive setMode's embedded relaunch (F1b3 / R1 finding 8) through the same
 *  `getNativeWindowHandle()` path the real app uses. */
const TEST_HWND = 'FAKE-HWND-1';

const windowCore: Record<string, unknown> = {
  localStorage: storage,
  devicePixelRatio: 1,
  electronAPI: { getNativeWindowHandle: async () => TEST_HWND },
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};
// A Proxy rather than a plain object: this file's import graph is a web of
// `persist`-wrapped stores that only probe `typeof window !== 'undefined'` for
// browser-only setup (gesture listeners, etc.) the moment `window` exists —
// so anything not listed in `windowCore` becomes a harmless no-op instead of
// "window.x is not a function".
const windowShim = new Proxy(windowCore, {
  get: (target, prop, receiver) =>
    Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
});
const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
if (typeof g.window === 'undefined') {
  g.localStorage = storage;
  g.window = windowShim;
}

// Network never happens for a live session, and the offline scenario below
// wants to PROVE the sidecar path still fires (not just that the live path
// didn't) — so `fetch` is stubbed to count calls and fail loudly rather than
// reach an actual (nonexistent, in this test) backend.
let fetchCalls = 0;
(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
  fetchCalls += 1;
  throw new Error('network disabled in this test');
}) as typeof fetch;

const {
  useVstEditorStore,
  __setLiveSessionLookupForTest,
  __setLiveWaitClockForTest,
  __setLiveHolderForTest,
  LIVE_STARTING_WAIT_MS,
  LIVE_COLD_START_WAIT_MS,
  NO_EDITOR_WINDOWS_KEY,
} = await import('./vstEditorStore.ts');
const { useVstLiveStore } = await import('./vstLiveStore.ts');
const { useVstEditorPrefs } = await import('./vstEditorPrefsStore.ts');
const { useEditorStore } = await import('./editorStore.ts');
const { useStatusBarStore } = await import('./statusBarStore.ts');

/* ── fakes ─────────────────────────────────────────────────────────────────── */

interface FakeSession extends VstLiveSession {
  /** Every call the store made on this session's wire client, in order. */
  calls: string[];
}

function fakeSession(entryId: string): FakeSession {
  const s: FakeSession = {
    entryId,
    sessionId: `s-${entryId}`,
    wsUrl: 'ws://x',
    pid: 1,
    stateDirty: false,
    userMovedOnRejectedState: false,
    stateSent: true,
    calls: [],
    client: null as never,
  };
  const record =
    (label: string) =>
    (...args: unknown[]): void => {
      s.calls.push(args.length ? `${label}(${JSON.stringify(args[0])})` : label);
    };
  s.client = {
    openEditor: record('openEditor'),
    closeEditor: record('closeEditor'),
    editorRect: record('editorRect'),
    getState: record('getState'),
    setParams: record('setParams'),
    setState: record('setState'),
  } as never;
  return s;
}

const chainEntry = (id: string, pluginPath: string): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: pluginPath, plugin_name: `Plugin ${id}` },
});

/** A controllable stand-in for the real 5 s wait: `fire()` runs the scheduled
 *  timeout synchronously instead of waiting out `LIVE_STARTING_WAIT_MS`. */
function fakeClock(): LiveWaitClock & { fire: () => void; scheduledMs: number[]; canceled: boolean } {
  let fn: (() => void) | null = null;
  const scheduledMs: number[] = [];
  const clock = {
    scheduledMs,
    canceled: false,
    schedule: (f: () => void, ms: number) => {
      fn = f;
      scheduledMs.push(ms);
      return 1;
    },
    cancel: () => {
      fn = null;
      clock.canceled = true;
    },
    fire: () => {
      const f = fn;
      fn = null;
      f?.();
    },
  };
  return clock;
}

const liveSessions = new Map<string, VstLiveSession>();
__setLiveSessionLookupForTest((id) => liveSessions.get(id));

const store = () => useVstEditorStore.getState();
/** Flushes every pending microtask (promise continuations) — enough for any
 *  of this store's async paths, since nothing here uses real timers or
 *  network delays; the fakes above settle immediately. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const failIfCalled = () => assert.fail('the OFFLINE sidecar sink must never be called for a live entry');

/* ── starting -> waits, then opens the LIVE editor once it goes live ───────── */
{
  const id = 'e-starting-live';
  const path = 'C:/VST3/Alpha.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating'); // sidesteps getNativeWindowHandle
  const session = fakeSession(id);
  liveSessions.set(id, session);
  useVstLiveStore.getState().setStatus(id, 'starting');
  const clock = fakeClock();
  __setLiveWaitClockForTest(clock);

  store().open(chainEntry(id, path), failIfCalled);

  assert.equal(store().entryId, id, 'the row tracks this entry while it waits');
  assert.equal(store().mode, null, 'nothing is open yet');
  assert.deepEqual(session.calls, [], 'the live client has not been touched while still starting');
  assert.equal(fetchCalls, 0, 'and neither has the offline sidecar');
  assert.deepEqual(clock.scheduledMs, [LIVE_STARTING_WAIT_MS], 'the wait is bounded');

  useVstLiveStore.getState().setStatus(id, 'live');
  await flush();

  assert.equal(store().mode, 'floating', 'the LIVE editor opened once the session was ready');
  assert.equal(store().entryId, id);
  assert.equal(store().error, null);
  assert.deepEqual(
    session.calls,
    [`openEditor(${JSON.stringify({ title: `Plugin ${id}` })})`],
    'the LIVE client is what opened it -- never the offline sidecar',
  );
  assert.equal(fetchCalls, 0);

  clock.fire(); // a late timeout after going live must do nothing (cancelled)
  assert.equal(store().error, null, 'the bounded wait was cancelled once the session went live');

  store().close(); // stop the 5 s state-capture interval before the next case
}

/* ── starting -> the session object does not exist yet (F1b3 rework round 2) ─ */
{
  // sessionRegistry.open() sets status to 'starting' as the FIRST thing it
  // does -- store().setStatus(entry.id, 'starting') runs before `probeHost()`
  // and `spawn()` -- so the session object itself does not exist for the
  // whole probe/spawn/connect window. The guard this ticket replaced was
  // `session && liveStatus === 'starting'`, which stayed false for that
  // entire window (no session yet) and fell through to the offline sidecar,
  // exactly what this case reproduces by never registering a session in
  // `liveSessions` before calling `open()`.
  const id = 'e-starting-no-session-yet';
  const path = 'C:/VST3/Eta.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating');
  assert.equal(liveSessions.get(id), undefined, 'the session object does not exist yet');
  useVstLiveStore.getState().setStatus(id, 'starting');
  const clock = fakeClock();
  __setLiveWaitClockForTest(clock);

  const before = fetchCalls;
  store().open(chainEntry(id, path), failIfCalled);

  assert.deepEqual(
    clock.scheduledMs,
    [LIVE_STARTING_WAIT_MS],
    'open() must wait on liveStatus alone -- a not-yet-existing session must not fall through to the offline sidecar',
  );
  assert.equal(store().entryId, id, 'the row tracks this entry while it waits, synchronously');
  assert.equal(store().mode, null, 'nothing is open yet');

  await flush();
  assert.equal(fetchCalls, before, 'the offline sidecar was never asked to open');

  // The registry assigns the session object, then flips status to 'live' --
  // waitForLiveThenOpen looks the session up lazily at that point.
  const session = fakeSession(id);
  liveSessions.set(id, session);
  useVstLiveStore.getState().setStatus(id, 'live');
  await flush();

  assert.equal(store().mode, 'floating', 'the LIVE editor opened once the session was ready');
  assert.deepEqual(
    session.calls,
    [`openEditor(${JSON.stringify({ title: `Plugin ${id}` })})`],
    'the LIVE client is what opened it -- never the offline sidecar',
  );
  assert.equal(fetchCalls, before, 'still never touched the offline sidecar');

  store().close();
}

/* ── starting -> timeout -> a visible error, and NO offline open ───────────── */
{
  const id = 'e-starting-timeout';
  const path = 'C:/VST3/Beta.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating');
  const session = fakeSession(id);
  liveSessions.set(id, session);
  useVstLiveStore.getState().setStatus(id, 'starting');
  const clock = fakeClock();
  __setLiveWaitClockForTest(clock);

  store().open(chainEntry(id, path), failIfCalled);
  assert.deepEqual(clock.scheduledMs, [LIVE_STARTING_WAIT_MS]);

  clock.fire(); // simulate LIVE_STARTING_WAIT_MS elapsing with no `live` status
  await flush();

  assert.match(store().error ?? '', /still starting/, 'a visible error, not a silent failure (MUST DO 3)');
  assert.equal(store().mode, null, 'the live editor never opened');
  assert.deepEqual(session.calls, [], 'and neither did its client');
  assert.equal(fetchCalls, 0, 'nor was the offline sidecar opened as a fallback (MUST DO 1)');
}

/* ── setMode on an open LIVE editor closes it and reopens in the new mode ──── */
{
  const id = 'e-live-setmode';
  const path = 'C:/VST3/Gamma.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating');
  const session = fakeSession(id);
  liveSessions.set(id, session);
  useVstLiveStore.getState().setStatus(id, 'live');

  store().open(chainEntry(id, path), failIfCalled);
  await flush();
  assert.equal(store().mode, 'floating');
  assert.deepEqual(session.calls, [`openEditor(${JSON.stringify({ title: `Plugin ${id}` })})`]);

  session.calls.length = 0;
  store().setMode('embedded');
  await flush();

  assert.equal(store().mode, 'embedded', 'setMode relaunched the LIVE editor, not the offline one (R1 finding 8)');
  assert.equal(store().entryId, id, 'still the same entry');
  assert.equal(useVstEditorPrefs.getState().modeFor(path), 'embedded', 'the preference is recorded either way');
  assert.ok(session.calls.includes('closeEditor'), 'the outgoing LIVE editor was closed -- "at most one at a time"');
  assert.ok(
    session.calls.some((c) => c.startsWith('openEditor(') && c.includes(`"parentHwnd":"${TEST_HWND}"`)),
    'and a NEW live editor opened embedded, reusing the SAME session',
  );
  assert.equal(fetchCalls, 0, 'the relaunch never touches the offline sidecar');

  store().close();
}

/* ── open() on a DIFFERENT entry retires a wait already in flight for A ────── */
{
  // Rework round 1 (R1 finding, major): waitForLiveThenOpen's own entry point
  // and close() were the ONLY places that retired `activeLiveWaitStop` --
  // open()'s `liveStatus === 'live'` branch and its offline fall-through both
  // skipped it, so a wait armed for entry A kept its vstLiveStore
  // subscription and timer alive after the user opened a DIFFERENT entry B.
  // This drives B straight into the 'live' branch, one of the two the finding
  // named, which reaches openLiveEditor without ever calling
  // waitForLiveThenOpen (the only place that used to retire A's wait).
  const idA = 'e-starting-superseded';
  const idB = 'e-live-supersedes';
  const pathA = 'C:/VST3/Epsilon.vst3';
  const pathB = 'C:/VST3/Zeta.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(pathA, 'floating');
  useVstEditorPrefs.getState().setModeForPlugin(pathB, 'floating');

  const sessionA = fakeSession(idA);
  const sessionB = fakeSession(idB);
  liveSessions.set(idA, sessionA);
  liveSessions.set(idB, sessionB);
  useVstLiveStore.getState().setStatus(idA, 'starting');
  useVstLiveStore.getState().setStatus(idB, 'live');

  const clockA = fakeClock();
  __setLiveWaitClockForTest(clockA);
  store().open(chainEntry(idA, pathA), failIfCalled);
  assert.equal(store().entryId, idA, 'waiting on A');
  assert.equal(clockA.canceled, false, 'not retired yet -- A is still waiting');

  // B is already `live`, so opening it reaches openLiveEditor directly and
  // never runs waitForLiveThenOpen at all.
  store().open(chainEntry(idB, pathB), failIfCalled);
  await flush();

  assert.equal(clockA.canceled, true, "opening a DIFFERENT entry must retire entry A's stale wait");
  assert.equal(store().entryId, idB, 'the row now tracks entry B');
  assert.ok(sessionB.calls.some((c) => c.startsWith('openEditor')), 'B opened live as normal');

  // Prove the retirement was real (unsubscribed), not just a flag flip: if A
  // later goes live, the torn-down subscription must not fire and reach into
  // a session that is no longer the one being edited.
  useVstLiveStore.getState().setStatus(idA, 'live');
  await flush();
  assert.deepEqual(sessionA.calls, [], "a superseded wait must not open entry A's live editor once it goes live");
  assert.equal(store().entryId, idB, 'B is still what is open');

  store().close();
}

/* ── no live session AND no live host on this machine -> the offline sidecar path runs ──── */
{
  __setLiveHolderForTest({
    hostAvailable: () => false,
    hold: () => assert.fail('a machine without the host must never try to start a live session'),
    unhold: () => {},
  });
  const id = 'e-offline';
  const path = 'C:/VST3/Delta.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating');
  // No entry in `liveSessions`, and vstLiveStore has never heard of this id
  // either -- exactly what a `vst3` entry with no host binary looks like.
  assert.equal(liveSessions.get(id), undefined);
  assert.equal(useVstLiveStore.getState().entries[id], undefined);

  const before = fetchCalls;
  const sunk: [string, string][] = [];
  store().open(chainEntry(id, path), (entryId, rawState) => sunk.push([entryId, rawState]));

  // Nothing live-specific happens SYNCHRONOUSLY: unlike waitForLiveThenOpen
  // (which sets entryId/mode before returning), the offline open() only
  // starts its async open-editor round trip and returns.
  assert.equal(store().entryId, null, 'no synchronous "waiting" state -- this is the pre-existing sidecar flow');

  await flush();

  assert.equal(fetchCalls, before + 1, 'the offline sidecar WAS asked to open -- the fallback still works');
  assert.equal(store().entryId, null, 'the failed fetch (no backend in this test) left nothing open');
  assert.deepEqual(sunk, [], 'nothing was captured either');
}

/* ── decision D-F: no session yet + a live host here -> START the live plugin and open ITS window ── */
{
  const id = 'e-cold';
  const path = 'C:/VST3/Epsilon.vst3';
  const clock = fakeClock();
  __setLiveWaitClockForTest(clock);
  const held: string[] = [];
  const unheld: string[] = [];
  const session = fakeSession(id);
  let resolveHold: (s: unknown) => void = () => {};
  __setLiveHolderForTest({
    hostAvailable: () => null, // never probed: exactly the state right after the app starts
    hold: (entry) => {
      held.push(entry.id);
      return new Promise((resolve) => {
        resolveHold = resolve as (s: unknown) => void;
      }) as never;
    },
    unhold: (entryId) => {
      unheld.push(entryId);
    },
  });
  const before = fetchCalls;
  store().open(chainEntry(id, path), failIfCalled);
  assert.deepEqual(held, [id], 'the editor asked the registry to start (and hold) the live session');
  assert.equal(store().entryId, id, 'the UI shows the plugin as starting');
  assert.deepEqual(clock.scheduledMs, [LIVE_COLD_START_WAIT_MS], 'a cold start gets the long wait, not the 5 s warm one');
  assert.equal(fetchCalls, before, 'the OFFLINE editor was not asked to open');

  // the registry reports progress through the live store, then hands the session over
  useVstLiveStore.getState().setStatus(id, 'starting');
  liveSessions.set(id, session as never);
  useVstLiveStore.getState().setStatus(id, 'live');
  resolveHold(session);
  await flush();
  assert.ok(
    session.calls.some((c) => c.startsWith('openEditor')),
    'the window that opens belongs to the LIVE instance',
  );
  assert.equal(fetchCalls, before, 'still no offline editor: one plugin instance, one state');
  assert.deepEqual(unheld, [], 'the session stays held while the window is open');

  store().close();
  assert.deepEqual(unheld, [id], 'closing the window gives the hold back exactly once');
  store().close();
  assert.deepEqual(unheld, [id], 'a second close does not unhold twice');
  liveSessions.delete(id);
}

/* ── D-F: the host turns out to be unavailable -> fall back to the offline copy, hold released ── */
{
  const id = 'e-nohost';
  const path = 'C:/VST3/Zeta.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating');
  __setLiveWaitClockForTest(fakeClock());
  const unheld: string[] = [];
  __setLiveHolderForTest({
    hostAvailable: () => null,
    hold: async () => null,
    unhold: (entryId) => {
      unheld.push(entryId);
    },
  });
  const before = fetchCalls;
  store().open(chainEntry(id, path), () => {});
  useVstLiveStore.getState().setStatus(id, 'unavailable', 'the live plugin host is not built');
  await flush();
  assert.equal(fetchCalls, before + 1, 'the offline editor was asked to open instead');
  assert.deepEqual(unheld, [id], 'the hold went back before falling through');
  store().close();
}

/* ── D-F: a superseding open() for another entry releases the first hold ── */
{
  const idA = 'e-hold-a';
  const idB = 'e-hold-b';
  __setLiveWaitClockForTest(fakeClock());
  const unheld: string[] = [];
  __setLiveHolderForTest({
    hostAvailable: () => true,
    hold: () => new Promise(() => {}) as never, // never settles: both stay "starting"
    unhold: (entryId) => {
      unheld.push(entryId);
    },
  });
  store().open(chainEntry(idA, 'C:/VST3/A.vst3'), failIfCalled);
  store().open(chainEntry(idB, 'C:/VST3/B.vst3'), failIfCalled);
  assert.deepEqual(unheld, [idA], 'entry A is no longer being edited: its hold is released');
  store().close();
  assert.deepEqual(unheld, [idA, idB]);
}

/* ── the test switch lives BELOW the store: the offline window request is withheld, nothing is recorded ── */
{
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  mem.set(NO_EDITOR_WINDOWS_KEY, '1');
  __setLiveHolderForTest({
    hostAvailable: () => false, // no live host here: open() takes the offline path
    hold: () => assert.fail('a machine without the host must never try to start a live session'),
    unhold: () => {},
  });
  const before = fetchCalls;
  store().open(chainEntry('e-suppressed', 'C:/VST3/Eta.vst3'), failIfCalled);
  await flush();
  assert.equal(fetchCalls, before, 'the open-editor POST is never made while the switch is set');
  assert.equal(store().entryId, null, 'an editor that never opened is not recorded as open');
  mem.delete(NO_EDITOR_WINDOWS_KEY);
}

/* ── the plugin leaves the project while its window is open -> the window closes, whatever removed it ── */
{
  const id = 'e-removed';
  const entry = chainEntry(id, 'C:/VST3/Theta.vst3');
  useEditorStore.setState({ tracks: [{ id: 't-removed', fxChain: [entry] }] as never });
  const session = fakeSession(id);
  liveSessions.set(id, session as never);
  useVstLiveStore.getState().setStatus(id, 'live');
  store().open(entry, failIfCalled);
  await flush();
  assert.equal(store().entryId, id, 'setup: the live editor is open');

  // An unrelated edit to the tracks leaves it alone.
  useEditorStore.setState({ tracks: [{ id: 't-removed', fxChain: [entry], name: 'renamed' }] as never });
  assert.equal(store().entryId, id, 'an edit that keeps the plugin keeps its window');

  // A track delete, an undo of the add, a remove from the Mix view: the chain no longer has it.
  useEditorStore.setState({ tracks: [{ id: 't-removed', fxChain: [] }] as never });
  assert.equal(store().entryId, null, 'the window of a plugin that left the project is closed');
  assert.ok(session.calls.some((c) => c.startsWith('closeEditor')), 'the host is told to close its window');
  liveSessions.delete(id);
  useEditorStore.setState({ tracks: [] as never });
}

/* ── the open status line reports the real outcome, not an optimistic
   constant (T18 fourth audit, MINOR 5) ── */
{
  // Normal case: no rejection on the row, so the line still says the plugin
  // is processing the signal.
  const id = 'e-open-status-live';
  const path = 'C:/VST3/Theta2.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating');
  const session = fakeSession(id);
  liveSessions.set(id, session);
  useVstLiveStore.getState().setStatus(id, 'live');

  store().open(chainEntry(id, path), failIfCalled);
  await flush();

  assert.match(
    useStatusBarStore.getState().text,
    /processing the signal now/,
    'a plugin holding its saved state gets the normal message',
  );
  store().close();
  liveSessions.delete(id);
}
{
  // The host rejected the restore: the row's stateOrigin already knows the
  // plugin is on its factory defaults, so the open line must say so instead
  // of the unconditional "processing the signal now" it used to post.
  const id = 'e-open-status-rejected';
  const path = 'C:/VST3/Theta3.vst3';
  useVstEditorPrefs.getState().setModeForPlugin(path, 'floating');
  const session = fakeSession(id);
  liveSessions.set(id, session);
  useVstLiveStore.getState().setStateOrigin(id, 'state-rejected', 'plugin refused the state');
  useVstLiveStore.getState().setStatus(id, 'live');

  store().open(chainEntry(id, path), failIfCalled);
  await flush();

  assert.match(
    useStatusBarStore.getState().text,
    /factory defaults/,
    'a plugin whose saved state was rejected says so, not that it is "processing the signal"',
  );
  assert.doesNotMatch(
    useStatusBarStore.getState().text,
    /processing the signal now/,
    'the optimistic constant is not shown for a rejected restore',
  );
  store().close();
  liveSessions.delete(id);
}

__setLiveHolderForTest(null);
console.log('vstEditorStore.live: ok');
