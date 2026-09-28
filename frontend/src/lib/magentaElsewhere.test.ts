/**
 * A Magenta engine another copy of theDAW started keeps running after this
 * copy stops its own. The backend used to kill every engine on the machine;
 * it now stops only this copy's and reports the rest (`left_running`), and
 * refuses a Stable Audio load or an engine start beside one (409,
 * `state: "engine_elsewhere"`).
 *
 * The client used to throw the stop reply away, set the pill to off and log
 * "Engine stopped; SA3 restored to the GPU" while the other engine still held
 * the GPU. These sequences replay what the user does: switch the model back to
 * Stable Audio (stopMagentaEngine), read the card, press "Stop that engine",
 * confirm, and see the engine stopped; and a CREATE refused with the 409.
 *
 * Run: `npx tsx src/lib/magentaElsewhere.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

// The params store persists to window.localStorage; give it one before it
// loads.
if (typeof window === 'undefined') Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
    key: (i: number) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size;
    },
  },
});

const { useFeatureGateStore } = await import('../notices/featureGateStore');
const { useLogStore } = await import('../state/logStore');
const {
  MAGENTA_ELSEWHERE_CONFIRM_ID,
  MAGENTA_ELSEWHERE_GATE_ID,
  describeEngines,
  engineFolder,
  enginesLeftRunning,
  handleEngineElsewhere,
  readEngineElsewhere,
} = await import('./magentaElsewhere');
const { stopMagentaEngine } = await import('./magentaEngineClient');

const THEIRS = '/home/u/mrt2/.venv/bin/python /mnt/g/Users/me/Dev/theDAW/sidecars/magenta/server.py';
const OTHER = { pid: 202, args: THEIRS, owner: 'other' as const };

interface Call {
  url: string;
  body: string | null;
}
const calls: Call[] = [];
let answer: (url: string) => Response = () => new Response('{}', { status: 200 });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, body: typeof init?.body === 'string' ? init.body : null });
  return answer(url);
}) as typeof fetch;

const notice = (id: string) => useFeatureGateStore.getState().notices.find((n) => n.id === id);
const logText = () =>
  useLogStore
    .getState()
    .entries.map((e) => `${e.level} ${e.source} ${e.msg}`)
    .join('\n');

// ── the parsers ─────────────────────────────────────────────────────────────
assert.equal(engineFolder(THEIRS), '/mnt/g/Users/me/Dev/theDAW');
assert.equal(engineFolder('python C:\\theDAW\\sidecars\\magenta\\server.py'), 'C:/theDAW');
assert.equal(engineFolder('something else'), 'something else');
assert.equal(describeEngines([OTHER]), 'pid 202 (/mnt/g/Users/me/Dev/theDAW)');
assert.equal(readEngineElsewhere({ detail: 'A generation is running' }), null);
assert.equal(readEngineElsewhere({ detail: { state: 'engine_elsewhere', engines: [] } }), null, 'no engine, no card');
assert.deepEqual(readEngineElsewhere({ detail: { state: 'engine_elsewhere', engines: [OTHER], message: 'm' } }), {
  state: 'engine_elsewhere',
  engines: [OTHER],
  message: 'm',
});
assert.equal(readEngineElsewhere({ state: 'not_running', blocked: { state: 'engine_elsewhere', engines: [OTHER] } })?.engines[0].pid, 202);
assert.deepEqual(
  enginesLeftRunning({ survivors: [{ pid: 101, args: 'a', owner: 'this' }], left_running: [OTHER] }).map((e) => e.pid),
  [101, 202],
);

// ── 1. Back to Stable Audio while another copy's engine runs ────────────────
answer = (url) => {
  assert.equal(url, '/api/magenta/engine/stop');
  return new Response(
    JSON.stringify({
      ok: true,
      terminated: true,
      reaped: [101],
      survivors: [],
      left_running: [OTHER],
      listed: true,
      sa3: { skipped: 'Stable Audio stays parked' },
      state: 'not_running',
    }),
    { status: 200 },
  );
};
await stopMagentaEngine();
assert.ok(!logText().includes('SA3 restored to the GPU'), 'the GPU is not restored while the other engine runs');
assert.match(logText(), /warn magenta .*still running, pid 202 \(\/mnt\/g\/Users\/me\/Dev\/theDAW\)/);
const card = notice(MAGENTA_ELSEWHERE_GATE_ID);
assert.ok(card, 'the card that names the engine is up');
assert.match(card.message, /pid 202 \(\/mnt\/g\/Users\/me\/Dev\/theDAW\)/);
assert.equal(card.action?.label, 'Stop that engine');

// ── 2. "Stop that engine" asks first; nothing is stopped yet ────────────────
calls.length = 0;
await card.action?.run();
assert.equal(calls.length, 0, 'the first press only asks');
const confirm = notice(MAGENTA_ELSEWHERE_CONFIRM_ID);
assert.ok(confirm, 'the confirmation card is up');
assert.equal(confirm.title, 'Stop pid 202?');

// ── 3. A refused stop keeps the confirmation for another try ────────────────
answer = () => new Response(JSON.stringify({ detail: 'pid 202 is not running a Magenta engine' }), { status: 404 });
await assert.rejects(async () => confirm.action?.run(), /not running a Magenta engine/);
assert.match(logText(), /error magenta Could not stop the Magenta engine at pid 202/);

// ── 4. Confirmed: that pid, and only it, is stopped ─────────────────────────
calls.length = 0;
answer = () => new Response(JSON.stringify({ ok: true, pid: 202, args: THEIRS, stopped: true }), { status: 200 });
await confirm.action?.run();
assert.deepEqual(calls, [{ url: '/api/magenta/engine/stop-process', body: JSON.stringify({ pid: 202 }) }]);
assert.equal(notice(MAGENTA_ELSEWHERE_GATE_ID), undefined, 'the engine card is gone');
assert.ok(notice('magenta:elsewhere-stopped'), 'the stop is confirmed');

// ── 5. A stop with nothing left running still restores Stable Audio ─────────
useLogStore.getState().clear();
answer = () =>
  new Response(JSON.stringify({ ok: true, reaped: [101], survivors: [], left_running: [], listed: true }), {
    status: 200,
  });
await stopMagentaEngine();
assert.match(logText(), /info magenta Engine stopped; SA3 restored to the GPU/);

// ── 6. A CREATE refused with the 409 raises the same card ───────────────────
useFeatureGateStore.getState().clear();
assert.equal(handleEngineElsewhere({ detail: 'HTTP 500' }, 'x'), false);
assert.equal(
  handleEngineElsewhere(
    { detail: { state: 'engine_elsewhere', engines: [OTHER], message: 'refused' } },
    'Stable Audio cannot load beside it.',
  ),
  true,
);
assert.match(notice(MAGENTA_ELSEWHERE_GATE_ID)?.message ?? '', /Stable Audio cannot load beside it\./);


console.log('magentaElsewhere: ok');
