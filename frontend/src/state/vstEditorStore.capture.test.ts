/**
 * captureLiveVstStates — the save-time "ask every stale plugin what it holds"
 * pass.
 *
 * Without it a project file records whatever state happened to be captured the
 * last time an editor was open: a plugin driven from the FX row's own controls,
 * or left running for an hour with its window closed, saves at settings it left
 * long ago and loads back sounding different.
 *
 * Four rules are pinned here, and all four are about not making a save worse:
 *
 *  - ONLY WHAT IS STALE is asked. `get_state` parks the host's audio thread, so
 *    an idle plugin nobody has touched is left alone.
 *  - BOUNDED AND PARALLEL. Every plugin is asked at once and each gets one
 *    timeout, so N slow plugins cost about ONE timeout, not N.
 *  - A TIMEOUT KEEPS THE PREVIOUS STATE. Nothing is cleared, nothing empty is
 *    written, and the pass still resolves — a save must never fail or hang
 *    because a plugin was slow.
 *  - THE SINK IS RESTORED. The editor's own 5 s capture keeps working after the
 *    pass borrowed the session's state sink.
 *
 * Run: npx tsx src/state/vstEditorStore.capture.test.ts
 */
import assert from 'node:assert/strict';

import type { VstLiveSession } from '../lib/vstLive/sessionRegistry.ts';

const { captureLiveVstStates } = await import('./vstEditorStore.ts');

/* ── fakes ─────────────────────────────────────────────────────────────────── */

interface FakeSession extends VstLiveSession {
  asked: number;
  /** Answer `get_state` after this many ms; -1 never answers. */
  answerAfterMs: number;
  answer: string;
}

const session = (entryId: string, over: Partial<FakeSession> = {}): FakeSession => {
  const s: FakeSession = {
    entryId,
    sessionId: `s-${entryId}`,
    wsUrl: 'ws://x',
    pid: 1,
    stateDirty: false,
    userMovedOnRejectedState: false,
    stateSent: true,
    asked: 0,
    answerAfterMs: 0,
    answer: `STATE-${entryId}`,
    client: null as never,
  };
  Object.assign(s, over);
  s.client = {
    getState: () => {
      s.asked += 1;
      if (s.answerAfterMs < 0) return;
      setTimeout(() => s.stateSink?.(s.answer), s.answerAfterMs);
    },
  } as never;
  return s;
};

type Row = { status: string; editorOpen: boolean };

function run(
  sessions: FakeSession[],
  rows: Record<string, Row>,
  timeoutMs = 40,
): { captured: [string, string][]; done: Promise<void> } {
  const captured: [string, string][] = [];
  const done = captureLiveVstStates({
    sessions: () => sessions,
    liveRow: (id) => rows[id],
    sink: (entryId, rawState) => {
      captured.push([entryId, rawState]);
      return true;
    },
    timeoutMs,
  });
  return { captured, done };
}

const LIVE = { status: 'live', editorOpen: false };

/* ── only stale sessions are asked ─────────────────────────────────────────── */
{
  const idle = session('idle');
  const dirty = session('dirty', { stateDirty: true });
  const open = session('open');
  const notLive = session('starting', { stateDirty: true });

  const { captured, done } = run([idle, dirty, open, notLive], {
    idle: LIVE,
    dirty: LIVE,
    open: { status: 'live', editorOpen: true },
    starting: { status: 'starting', editorOpen: true },
  });
  await done;

  assert.equal(idle.asked, 0, 'an idle plugin is not asked — get_state parks its audio thread');
  assert.equal(notLive.asked, 0, 'and neither is a session that is not live yet');
  assert.equal(dirty.asked, 1, 'a plugin whose parameters moved is asked');
  assert.equal(open.asked, 1, 'and so is one the user has open');
  assert.deepEqual(
    captured.sort(),
    [
      ['dirty', 'STATE-dirty'],
      ['open', 'STATE-open'],
    ],
    'both answers land on their entries',
  );
  assert.equal(dirty.stateDirty, false, 'a captured session is no longer behind its stored state');
}

/* ── an entry with nothing running is simply not asked ─────────────────────── */
{
  const { captured, done } = run([], {});
  await done;
  assert.deepEqual(captured, [], 'no sessions, no work');
}

/* ── a timeout keeps the previous state, and never blocks the save ─────────── */
{
  const silent = session('silent', { stateDirty: true, answerAfterMs: -1 });
  const { captured, done } = run([silent], { silent: LIVE }, 20);
  await done;
  assert.equal(silent.asked, 1);
  assert.deepEqual(captured, [], 'nothing is written, so the entry keeps the state it had');
  assert.equal(silent.stateDirty, true, 'and it stays marked, so the next save tries again');
}

/* ── slow plugins are waited for IN PARALLEL, not one after another ────────── */
{
  const slow = [0, 1, 2, 3].map((i) => session(`slow${i}`, { stateDirty: true, answerAfterMs: -1 }));
  const rows = Object.fromEntries(slow.map((s) => [s.entryId, LIVE]));
  const started = Date.now();
  const { done } = run(slow, rows, 60);
  await done;
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 4 * 60,
    `four 60 ms timeouts overlapped (took ${elapsed} ms, sequential would be >= 240 ms)`,
  );
  for (const s of slow) assert.equal(s.asked, 1);
}

/* ── the editor's own capture sink survives the pass ───────────────────────── */
{
  const seenByEditor: string[] = [];
  const withEditor = session('e', { stateDirty: true });
  withEditor.stateSink = (s) => seenByEditor.push(s);
  const { captured, done } = run([withEditor], { e: LIVE });
  await done;
  assert.deepEqual(captured, [['e', 'STATE-e']], 'the pass wrote the state itself');
  assert.deepEqual(seenByEditor, [], 'so the borrowed sink did not ALSO write it');
  assert.equal(typeof withEditor.stateSink, 'function', 'and it was put back');
  withEditor.stateSink?.('LATER');
  assert.deepEqual(seenByEditor, ['LATER'], 'the editor keeps capturing afterwards');
}

/* ── a session whose socket is already dead is a timeout that happened ─────── */
{
  const dead = session('dead', { stateDirty: true });
  dead.client = {
    getState: () => {
      throw new Error('socket closed');
    },
  } as never;
  const { captured, done } = run([dead], { dead: LIVE }, 1000);
  // The point is that this resolves IMMEDIATELY rather than burning the full
  // timeout: a save must not wait a second per dead plugin.
  const started = Date.now();
  await done;
  assert.ok(Date.now() - started < 500, 'a throwing getState does not wait out the timeout');
  assert.deepEqual(captured, []);
}

console.log('vstEditorStore.capture: ok');
