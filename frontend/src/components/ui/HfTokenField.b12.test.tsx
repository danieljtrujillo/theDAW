/**
 * T22 FETCH/CACHE HYGIENE — HfTokenField drops transport errors
 * (HfTokenField.tsx:94-96): `fetchHfStatus()` never throws — a status call
 * that failed comes back as `{ logged_in: null, error: { message } }`
 * precisely so a dead backend is distinguishable from "not signed in"
 * (hfAuthClient.ts). The mount `useEffect` stored that status but the
 * component never read `status.error`, so a transport failure silently
 * rendered the ordinary "paste your token" form with no explanation —
 * exactly the outage the `error` field exists to report.
 *
 * Client-rendered (createRoot), not renderToStaticMarkup — same reasoning as
 * AutosaveRecoveryNotice.test.tsx: state set after mount needs a live
 * subscription to be visible.
 *
 * Run: cd frontend && npx tsx src/components/ui/HfTokenField.b12.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement,
  HTMLInputElement: win.HTMLInputElement,
  Node: win.Node,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// fetchHfStatus's own network call fails — the exact condition the field must
// not swallow. It never throws (see hfAuthClient.ts); it resolves with
// `error` set instead, which is what the component has to render.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { BACKEND_UNREACHABLE } = await import('../../lib/httpError.ts');
const { HfTokenField } = await import('./HfTokenField.tsx');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await step(() => {});
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Awaits `promise`, but fails with a clear message instead of hanging forever
 *  if it never settles within `ms`. Used for explicit synchronization signals
 *  (never for guessing how many microtask ticks something needs). */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out (${ms}ms) waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ── Full (non-compact) layout ───────────────────────────────────────────────
{
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await step(() => root.render(React.createElement(HfTokenField, { idPrefix: 'full-test' })));

  await waitFor(
    () => (host.textContent ?? '').includes(BACKEND_UNREACHABLE),
    'the status fetch failure to be reported',
  );
  const alertEl = host.querySelector('[role="alert"]');
  assert.ok(alertEl, 'the transport error is announced as an alert, not silently dropped');
  assert.ok(
    (alertEl?.textContent ?? '').includes(BACKEND_UNREACHABLE),
    'the alert names the actual failure (backend unreachable), not a generic message',
  );
  // The field must still be usable — a status check failing must not block
  // pasting a token.
  assert.ok(host.querySelector('input[type="password"]'), 'the token input still renders despite the status failure');

  await step(() => root.unmount());
  host.remove();
}

// ── Compact layout ───────────────────────────────────────────────────────────
{
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await step(() => root.render(React.createElement(HfTokenField, { idPrefix: 'compact-test', compact: true })));

  await waitFor(
    () => !!host.querySelector('[aria-label="Could not check sign-in status"]') || !!host.querySelector('[role="alert"]'),
    'the compact layout to surface the status failure',
  );
  const marker = host.querySelector('[aria-label="Could not check sign-in status"]') ?? host.querySelector('[role="alert"]');
  assert.ok(marker, 'the compact layout surfaces the transport error too, not just the full layout');

  // Audit fix 4 (a11y): the compact alert is icon-only visually — a screen
  // reader must still get the SPECIFIC reason, not just the icon's generic
  // aria-label summary, and the icon itself must announce as an image.
  const icon = host.querySelector('[role="alert"] svg');
  assert.ok(icon, 'the warning icon renders inside the alert');
  assert.equal(icon?.getAttribute('role'), 'img', 'the icon is announced as an image, not decorative/ignored');
  const srText = host.querySelector('[role="alert"] .sr-only')?.textContent ?? '';
  assert.ok(srText.includes(BACKEND_UNREACHABLE), 'an sr-only span carries the actual failure text, not just the icon label');

  await step(() => root.unmount());
  host.remove();
}

// ── Audit fix 5: recovers on window focus, without a remount ───────────────
// While a status error is showing, the field must re-check on focus (the
// user alt-tabbing back after restarting theDAW is exactly this moment) and
// clear the alert itself once the backend answers healthy again — no manual
// "retry" affordance, no remount.
{
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await step(() => root.render(React.createElement(HfTokenField, { idPrefix: 'focus-test' })));

  await waitFor(
    () => (host.textContent ?? '').includes(BACKEND_UNREACHABLE),
    'the initial status failure to be reported',
  );
  assert.ok(host.querySelector('[role="alert"]'), 'error alert showing before focus recovery');

  // The backend is back: swap the fetch mock to a healthy answer, then focus.
  // Response/Event come from Node's own globals — jsdom's `win` does not
  // implement fetch/Response, only the DOM event machinery.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ logged_in: false, username: null, token_source: 'none', checking: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  await step(() => win.dispatchEvent(new win.Event('focus')));

  await waitFor(
    () => !host.querySelector('[role="alert"]'),
    'the alert to clear once a focus re-check succeeds',
  );
  assert.ok(!(host.textContent ?? '').includes(BACKEND_UNREACHABLE), 'the stale failure text is gone, not just the alert role');

  await step(() => root.unmount());
  host.remove();
}

// ── Follow-up fix 1: a stale focus refetch cannot clobber a fresher save() ──
// The focus-refetch effect (audit fix 5) can still be in flight when the user
// pastes a token and hits Save. If that stale status check's `setStatus` call
// lands AFTER save()'s own, it must not overwrite it and resurrect the error
// alert. A request-generation counter bumped synchronously inside save() —
// not dependent on any render/effect-cleanup timing — makes the stale write a
// guaranteed no-op.
//
// The interleaving is forced with an EXPLICIT signal, not by guessing how
// many microtask ticks a promise chain needs (that was this block's original
// design, and it was flaky under `npm test`'s parallel worker load — the
// exact tick count native `fetch`/`Response`/`describeHttpError` settle in
// is an implementation detail, not something a test should depend on).
// `onSignedIn` is called by `save()` immediately after the generation bump
// and the fresh `setStatus` — see HfTokenField.tsx's `save()`, where
// `setStatus(...)` is followed, with no further `await` in between, by
// `await onSignedIn?.(username)`. So resolving our own deferred promise
// FROM `onSignedIn` is a hard synchronization point: "the bump has
// definitely already happened", true regardless of process/CPU load,
// V8 version, or how many hops fetch/Response internals need. Every wait
// below has an explicit, bounded deadline — nothing can hang forever.
{
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  const statusCalls: { resolve: (r: Response) => void }[] = [];
  const loginCalls: { resolve: (r: Response) => void }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/hfauth/status')) {
      return await new Promise<Response>((resolve) => {
        statusCalls.push({ resolve });
      });
    }
    if (url.includes('/api/hfauth/login')) {
      return await new Promise<Response>((resolve) => {
        loginCalls.push({ resolve });
      });
    }
    throw new Error(`unexpected fetch in this block: ${url}`);
  }) as typeof fetch;

  let signalSaveCommitted: () => void = () => undefined;
  const saveCommitted = new Promise<void>((resolve) => {
    signalSaveCommitted = resolve;
  });

  await step(() =>
    root.render(
      React.createElement(HfTokenField, {
        idPrefix: 'race-test',
        onSignedIn: () => {
          signalSaveCommitted();
        },
      }),
    ),
  );

  // The mount check is pending — fail it so the alert shows and the focus
  // listener (audit fix 5) registers.
  await waitFor(() => statusCalls.length >= 1, 'the mount status check to start');
  await step(() => statusCalls[0].resolve(new Response(null, { status: 502 })));
  await waitFor(() => !!host.querySelector('[role="alert"]'), 'the initial failure to show the alert');

  // Focus fires a SECOND status check — leave it pending (the slow, soon-to-be-stale one).
  await step(() => win.dispatchEvent(new win.Event('focus')));
  await waitFor(() => statusCalls.length >= 2, 'the focus refetch to start');

  // While that second check is still in flight, the user pastes a token and saves.
  const input = host.querySelector('input[type="password"]') as InstanceType<typeof win.HTMLInputElement> | null;
  const form = host.querySelector('form');
  assert.ok(input && form, 'the token input and its form are present');
  const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  await step(() => {
    nativeSetter.call(input, 'hf_faketoken');
    input!.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
  await step(() => form!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })));
  await waitFor(() => loginCalls.length >= 1, 'save() to start its login fetch');

  loginCalls[0].resolve(
    new Response(JSON.stringify({ username: 'skream' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  // Deterministic: waits for the EXPLICIT signal that save() has bumped the
  // generation counter and written the fresh status — not for a guessed
  // number of ticks. Bounded: fails loudly (not a hang) if it never fires.
  await withDeadline(saveCommitted, 5000, "save() to call onSignedIn (generation bump + fresh setStatus done)");

  // NOW resolve the stale, still-in-flight focus check — proven, not merely
  // timed, to be chronologically after save() already ran. This is the
  // literal scenario reported: "a focus refetch still in flight when the
  // user saves a token can overwrite the fresher status that save set."
  statusCalls[1].resolve(new Response(null, { status: 502 }));

  // Bounded, condition-based settle (real timers, retried, not a single
  // fragile macrotask guess) — safe to be generous here: the fix's guard is
  // a synchronous check at the moment save() runs, so giving React MORE time
  // to commit cannot un-protect an already-decided outcome.
  await waitFor(
    () => (host.textContent ?? '').includes('skream'),
    'the fresh "signed in" status from save() to be showing',
  );
  assert.ok(
    (host.textContent ?? '').includes('skream'),
    'the fresh "signed in" status from save() is showing, undisturbed by the stale check',
  );
  assert.ok(!host.querySelector('[role="alert"]'), 'no error alert remains once everything has settled');

  await step(() => root.unmount());
  host.remove();
}

globalThis.fetch = realFetch;
console.log('HfTokenField: a status-check transport failure is reported, not dropped');
