/**
 * The UNDERFIT assistant orb says when its backend is not running and starts
 * it from a labelled key.
 *
 * The orb posted every request to underfit/assistant-backend on :5473, which
 * nothing launched, so it failed silently. theDAW's backend now starts that
 * server with the dashboard; when it is down anyway, the orb shows a dot, one
 * word and the reason, and Start calls POST /api/underfit/assistant/start.
 *
 * Replays what a user sees, in order: the orb opens while the backend is
 * down (theDAW reports the npm install failure from auto-start), the user
 * presses Start, theDAW answers once the server is up, the next health check
 * sees it, and the status strip disappears and the catalog reloads. Then theDAW
 * itself is unreachable, and the strip says Start cannot work from here. Then
 * a first launch, where theDAW is still running npm install: the strip says
 * Starting and Installing, never Offline. Last, the server runs but the
 * browser refuses its /api/health response (a build without CORS on that
 * route): theDAW's status says it runs, so the strip goes and the catalog loads.
 *
 * Run: npx tsx src/views/underfit/assistantBackendStatus.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:8791/?_t=1&assistant_api=http%3A%2F%2Flocalhost%3A5473',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'navigator']) {
  Object.defineProperty(g, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const {
  AssistantBackendStatusBar,
  assistantStatusDetail,
  thedawApiBase,
  useAssistantBackendStatus,
  STATE_WORD,
} = await import('./assistantBackendStatus.tsx');
const { underfitFrameSrc } = await import('../UnderfitView.tsx');

/* ── where the orb looks ─────────────────────────────────────────────────── */
assert.equal(thedawApiBase('', undefined), 'http://localhost:8600', 'theDAW’s fixed backend port by default');
assert.equal(thedawApiBase('?thedaw_api=http%3A%2F%2F127.0.0.1%3A8600%2F', undefined), 'http://127.0.0.1:8600');
assert.equal(
  underfitFrameSrc('http://localhost:8791', 3, 'http://localhost:5480'),
  'http://localhost:8791/?_t=3&assistant_api=http%3A%2F%2Flocalhost%3A5480',
  'the Underfit tab tells the orb the port the backend reported',
);
assert.equal(underfitFrameSrc('http://localhost:8791', 3, null), 'http://localhost:8791/?_t=3');

/* ── the sequence ────────────────────────────────────────────────────────── */
const ASSISTANT = 'http://localhost:5473';
const THEDAW = 'http://localhost:8600';
let assistantUp = false;
let thedawUp = true;
let installingNow = false;
let healthBlocked = false;
let startCalls = 0;
const calls: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url === `${ASSISTANT}/api/health`) {
    if (!assistantUp || healthBlocked) throw new TypeError('Failed to fetch');
    return json({ app: 'underfit-assistant', status: 'ok' });
  }
  if (!thedawUp) throw new TypeError('Failed to fetch');
  if (url === `${THEDAW}/api/underfit/assistant/status`) {
    return json({
      running: assistantUp,
      starting: installingNow,
      installing: installingNow,
      installed: false,
      issues: [],
      error: assistantUp ? null : 'npm install in underfit/assistant-backend exited 1.',
    });
  }
  if (url === `${THEDAW}/api/underfit/assistant/start` && init?.method === 'POST') {
    startCalls += 1;
    assistantUp = true;
    return json({ ok: true, url: ASSISTANT });
  }
  return json({ detail: 'Not Found' }, 404);
}) as typeof fetch;

let onlineCount = 0;
function Harness() {
  const b = useAssistantBackendStatus(ASSISTANT, () => { onlineCount += 1; }, fetcher, THEDAW);
  return (
    <AssistantBackendStatusBar
      state={b.state}
      detail={assistantStatusDetail(b.state, b.sidecar, b.startError, b.thedawReachable)}
      onStart={() => void b.start()}
    />
  );
}

const host = document.getElementById('root')!;
const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
const root = createRoot(host);
await act(async () => root.render(<Harness />));
await settle();

// 1. Down: dot + one word + theDAW's reason + a labelled Start key.
const status = host.querySelector('[role="status"]');
assert.ok(status, 'the orb shows a status while the backend is down');
assert.ok(host.textContent?.includes(STATE_WORD.offline), `one word: ${host.textContent}`);
assert.ok(host.textContent?.includes('npm install in underfit/assistant-backend exited 1.'), 'the reason from theDAW');
const start = host.querySelector('button[aria-label="Start the UNDERFIT assistant backend"]') as HTMLButtonElement | null;
assert.ok(start, 'a labelled Start key');
assert.equal(start!.textContent, 'Start');
assert.equal(onlineCount, 0);
for (const el of Array.from(host.querySelectorAll('*'))) {
  const cls = el.getAttribute('class') ?? '';
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]|font-mono/.test(cls), `no small or mono type: ${cls}`);
}

// 2. Start: theDAW starts it, the next health check sees it, the strip goes.
await act(async () => start!.click());
await settle();
assert.equal(startCalls, 1, 'Start posts to theDAW once');
assert.ok(calls.includes(`POST ${THEDAW}/api/underfit/assistant/start`));
assert.equal(host.querySelector('[role="status"]'), null, 'the strip disappears once the backend answers');
assert.equal(onlineCount, 1, 'the orb reloads its catalog when the backend comes online');

// 3. theDAW unreachable while the assistant is down: say Start cannot work here.
assistantUp = false;
thedawUp = false;
await act(async () => root.unmount());
const root2 = createRoot(host);
await act(async () => root2.render(<Harness />));
await settle();
assert.ok(host.textContent?.includes('theDAW did not answer'), `explains the dead end: ${host.textContent}`);
await act(async () => root2.unmount());

// 4. First launch: theDAW's auto-start is running npm install.
thedawUp = true;
installingNow = true;
const root3 = createRoot(host);
await act(async () => root3.render(<Harness />));
await settle();
assert.ok(host.textContent?.includes(STATE_WORD.starting), `Starting during the install: ${host.textContent}`);
assert.ok(!host.textContent?.includes(STATE_WORD.offline), 'never Offline while installing');
assert.ok(host.textContent?.includes('Installing the assistant’s packages'), `says it is installing: ${host.textContent}`);
const busyStart = host.querySelector('button[aria-label="Start the UNDERFIT assistant backend"]') as HTMLButtonElement | null;
assert.ok(busyStart?.disabled, 'Start waits while the install runs');
await act(async () => root3.unmount());

// 5. The server runs, but the browser refuses its health response.
installingNow = false;
assistantUp = true;
healthBlocked = true;
const onlineBefore = onlineCount;
const root4 = createRoot(host);
await act(async () => root4.render(<Harness />));
await settle();
assert.equal(host.querySelector('[role="status"]'), null, 'theDAW saying it runs is enough');
assert.equal(onlineCount, onlineBefore + 1, 'the catalog loads');
await act(async () => root4.unmount());

console.log('assistantBackendStatus: ok');
