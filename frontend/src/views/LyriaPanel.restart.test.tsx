/**
 * The Lyria tab with a Lyria this backend did not start -- one an earlier
 * session left on the port, still running with that session's keys.
 *
 * Replayed as it happens: the panel opens, GET /api/lyria/url adopts the
 * leftover (`external: true`) and reports a checkout an earlier Update left
 * alone. The panel must say why, and offer "Restart with current keys". A
 * first press is refused by the backend (a Lyria from another folder holds
 * the port): the reason is shown and the button stays. A second press
 * succeeds: the panel switches to the fresh child (mock badge, no restart
 * button) and reloads the frame.
 *
 * Then theDAW's own child on an old checkout. On open the panel asks GET
 * /api/lyria/update?check=true, which says GitHub has a newer commit, and
 * shows it beside "Update Lyria". The first press finds local changes: the
 * backend leaves the checkout alone and the panel shows why, once, and
 * offers "Restart with current keys", which runs the checkout as it is now.
 * The user discards the edit and presses Update again: the backend
 * fast-forwards the checkout and restarts Lyria, the panel says what moved,
 * the checkout note, the restart button and the "new commit" label go, and
 * the frame reloads against the restarted child. A refused Update shows the backend's reason as an alert,
 * and one whose restart failed says so and re-reads Lyria.
 *
 * Buttons are found by their visible text, the name they have for a screen
 * reader and for speech input alike.
 *
 * Also holds the type scale: no text under 12px and no small mono labels in
 * the panel's own chrome.
 *
 * Real component, real React (react-dom/client + act) under jsdom; `fetch`
 * is stubbed and every call recorded. LyriaPanel reaches `state/playerStore`
 * (through libraryStore), which reads the Vite-only `import.meta.env.DEV`
 * behind a `typeof window !== 'undefined'` guard, so the panel is imported
 * BEFORE the jsdom globals exist -- the same order MetronomeVolumeControl.test
 * and MixerStrips.b12.test use.
 *
 * Run: `npx tsx src/views/LyriaPanel.restart.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const { LyriaPanel, lyriaCheckoutNote, lyriaUpdateNote } = await import('./LyriaPanel.tsx');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement',
    'HTMLIFrameElement', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'navigator',
  ]) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const dirty =
    'The Lyria checkout at C:\\lyria has local changes to tracked files, so theDAW left it at 192032e. Commit or discard them, then press Update again.';
  const calls: Array<{ url: string; method: string }> = [];
  let urlReply: unknown = {
    url: 'http://127.0.0.1:5188',
    mode: 'external',
    mock: null,
    external: true,
    checkout: { state: 'dirty', commit: '192032e', reason: dirty },
  };
  const updateCheckReply: unknown = {
    job: { status: 'idle', message: '' },
    checkout: { state: 'unchecked', reason: '' },
    latest: {
      head: '192032e000000000000000000000000000000000',
      latest: 'ef8b16f4f167a85654dd3138bee9168ef54644ca',
      available: true,
    },
  };
  let updateStartReply: { status: number; body: unknown } = { status: 200, body: { status: 'running' } };
  let updatePollReply: unknown = updateCheckReply;
  let restartReply: { status: number; body: unknown } = {
    status: 409,
    body: { detail: 'The Lyria on port 5188 runs from D:\\other, not from C:\\lyria. Stop it there, then press Restart again.' },
  };
  g.fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/lyria/url') return json(200, urlReply);
    if (url === '/api/lyria/restart') return json(restartReply.status, restartReply.body);
    if (url === '/api/lyria/update?check=true') return json(200, updateCheckReply);
    if (url === '/api/lyria/update' && method === 'POST') return json(updateStartReply.status, updateStartReply.body);
    if (url === '/api/lyria/update') return json(200, updatePollReply);
    if (url === '/api/lyria/import-new') return json(200, { imported: [], skipped: 0 });
    return json(404, { detail: 'not stubbed' });
  };

  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');

  const doc = dom.window.document;
  const host = doc.getElementById('root')!;
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(LyriaPanel));
  });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  // Long enough for one Update poll (UPDATE_POLL_MS in the panel).
  const settleForPoll = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1700));
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  await settle();

  // The panel adopted the leftover: it says why the checkout stayed, offers
  // the restart, and claims no cost mode for a process it did not start.
  assert.ok(host.textContent?.includes('has local changes to tracked files'), host.textContent ?? '');
  const restart = () =>
    Array.from<HTMLButtonElement>(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Restart with current keys' && !b.hasAttribute('aria-label'),
    ) ?? null;
  assert.ok(restart(), 'the restart button renders for an adopted Lyria');
  assert.ok(!host.textContent?.includes('Live $0.08') && !/\bMock\b/.test(host.textContent ?? ''));
  const frameBefore = host.querySelector('iframe');
  assert.ok(frameBefore, 'the adopted Lyria is framed');

  // The type scale: nothing under 12px, nothing in small mono.
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(host.innerHTML), 'text under 12px in the Lyria panel');
  assert.ok(!host.innerHTML.includes('font-mono'), 'small mono label in the Lyria panel');

  // First press: refused, reason shown, the button stays.
  await act(async () => {
    restart()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/lyria/restart' && c.method === 'POST').length, 1);
  assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes('runs from D:\\other'), host.textContent ?? '');
  assert.ok(restart(), 'a refused restart keeps the button');

  // Second press: the fresh child is ours, in mock mode.
  restartReply = {
    status: 200,
    body: {
      ok: true,
      url: 'http://127.0.0.1:5188',
      mode: 'mock',
      mock: true,
      external: false,
      checkout: { state: 'managed', reason: '' },
    },
  };
  await act(async () => {
    restart()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  assert.equal(restart(), null, 'no restart button once the child is ours and the checkout has nothing to say');
  assert.equal(host.querySelector('[role="alert"]'), null, 'the refusal clears');
  assert.ok(/\bMock\b/.test(host.textContent ?? ''), 'the cost mode is shown for our own child');
  assert.ok(!host.textContent?.includes('has local changes'), 'an empty reason shows no note');
  assert.notEqual(host.querySelector('iframe'), frameBefore, 'the frame reloads against the fresh child');

  assert.equal(lyriaCheckoutNote(undefined), '');
  assert.equal(lyriaCheckoutNote({ state: 'updated', reason: 'Moved from 192032e.' }), '');
  assert.equal(lyriaCheckoutNote({ state: 'failed', reason: 'Could not fetch.' }), 'Could not fetch.');
  assert.equal(lyriaCheckoutNote({ state: 'diverged', reason: 'Has commits of its own.' }), 'Has commits of its own.');
  assert.equal(lyriaUpdateNote({ job: { status: 'error', error: 'npm install failed' } }), 'npm install failed');
  assert.equal(
    lyriaUpdateNote({ job: { status: 'done', message: 'x' }, checkout: { state: 'dirty', reason: 'x' } }),
    '',
    'a checkout left alone says why in the checkout note, once',
  );
  assert.equal(
    lyriaUpdateNote({
      job: { status: 'done', message: 'Lyria is at the latest commit, ef8b16f.' },
      checkout: { state: 'current' },
    }),
    'Lyria is at the latest commit, ef8b16f.',
  );

  await act(async () => root.unmount());

  // ── theDAW's own child on an old checkout: Update ───────────────────────
  urlReply = {
    url: 'http://127.0.0.1:5188',
    mode: 'mock',
    mock: true,
    external: false,
    checkout: { state: 'unchecked', reason: '' },
  };
  const ownRoot = createRoot(host);
  await act(async () => {
    ownRoot.render(React.createElement(LyriaPanel));
  });
  await settle();
  const update = () =>
    Array.from<HTMLButtonElement>(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Update Lyria' && !b.hasAttribute('aria-label'),
    ) ?? null;
  assert.ok(update(), 'the Update button renders');
  assert.ok(host.textContent?.includes('New commit ef8b16f'), host.textContent ?? '');
  assert.equal(restart(), null, 'our own child needs no restart');

  // First press: local changes, left alone, the reason shown once.
  updatePollReply = {
    job: { status: 'done', message: dirty, restarted: false },
    checkout: { state: 'dirty', commit: '192032e', reason: dirty },
  };
  await act(async () => {
    update()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settleForPoll();
  assert.equal(calls.filter((c) => c.url === '/api/lyria/update' && c.method === 'POST').length, 1);
  assert.ok(host.textContent?.includes('then press Update again'), host.textContent ?? '');
  assert.equal(host.textContent?.split('has local changes').length, 2, 'the reason is shown once');
  // The checkout note is up, so Restart is offered for our own child too:
  // it runs the checkout as it is now, edits included, with the current keys.
  assert.ok(restart(), 'a checkout left alone offers the restart for our own child');
  assert.ok(
    restart()!.title.startsWith('Stop Lyria and start it again from the checkout as it is now'),
    restart()!.title,
  );
  assert.ok(host.textContent?.includes('New commit ef8b16f'), 'the newer commit is still waiting');
  const frameBeforeUpdate = host.querySelector('iframe');

  // The user discarded the edit; the second press moves and restarts.
  const moved = 'Updated Lyria from 192032e to ef8b16f.';
  updatePollReply = {
    job: { status: 'done', message: moved, restarted: true },
    checkout: { state: 'updated', commit: 'ef8b16f', reason: moved },
  };
  const urlCallsBefore = calls.filter((c) => c.url === '/api/lyria/url').length;
  await act(async () => {
    update()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settleForPoll();
  assert.equal(calls.filter((c) => c.url === '/api/lyria/update' && c.method === 'POST').length, 2);
  assert.ok(host.textContent?.includes(moved), host.textContent ?? '');
  assert.ok(!host.textContent?.includes('local changes'), 'the note goes once the checkout moved');
  assert.ok(!host.textContent?.includes('New commit'), 'nothing newer is waiting');
  assert.equal(restart(), null, 'no restart button once the note is gone and the child is ours');
  assert.ok(
    calls.filter((c) => c.url === '/api/lyria/url').length > urlCallsBefore,
    'the panel re-reads the restarted Lyria',
  );
  assert.ok(host.querySelector('iframe'), 'the restarted Lyria is framed');
  assert.notEqual(host.querySelector('iframe'), frameBeforeUpdate, 'the frame reloads against the restarted child');

  // A refused Update (no checkout) is an alert with the backend's reason.
  updateStartReply = {
    status: 409,
    body: { detail: 'There is no Lyria checkout at C:\\lyria to update.' },
  };
  await act(async () => {
    update()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes('no Lyria checkout'), host.textContent ?? '');
  assert.ok(update() && !update()!.disabled, 'the button is usable again');

  // An Update whose restart fails: the error is an alert, and the panel
  // re-reads Lyria instead of framing the server it stopped.
  updateStartReply = { status: 200, body: { status: 'running' } };
  updatePollReply = {
    job: {
      status: 'error',
      error: 'Updated Lyria from ef8b16f to 1a2b3c4. Lyria did not start again: npm install failed (rc=1).',
      restarted: false,
      stopped: true,
    },
    checkout: { state: 'updated', commit: '1a2b3c4', reason: 'Updated Lyria from ef8b16f to 1a2b3c4.' },
  };
  const urlCallsBeforeFailure = calls.filter((c) => c.url === '/api/lyria/url').length;
  await act(async () => {
    update()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settleForPoll();
  assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes('did not start again'), host.textContent ?? '');
  assert.ok(
    calls.filter((c) => c.url === '/api/lyria/url').length > urlCallsBeforeFailure,
    'a stopped Lyria is re-read, not left framed',
  );

  // The type scale holds for the Update chrome too.
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(host.innerHTML), 'text under 12px in the Lyria panel');
  assert.ok(!host.innerHTML.includes('font-mono'), 'small mono label in the Lyria panel');
  await act(async () => ownRoot.unmount());
  console.log('LyriaPanel.restart.test.tsx: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
