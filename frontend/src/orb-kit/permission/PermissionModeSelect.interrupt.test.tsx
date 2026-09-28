/**
 * A switch into Ask while a turn runs says the turn was stopped.
 *
 * The CLI's child keeps the ask rules it was started with, so a switch into
 * Ask or Read-only mid-turn left every call a Claude allow rule matches
 * running unasked for the rest of the turn. The backend now interrupts that
 * turn and answers `interrupted: true`; the dropdown shows a notice saying so
 * until the user dismisses it. A switch that needs no new rule shows nothing.
 *
 * Run: npx tsx src/orb-kit/permission/PermissionModeSelect.interrupt.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'navigator']) {
  Object.defineProperty(g, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const posted: Array<{ conversationId: string; mode: string }> = [];
let interruptNext = true;
globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  posted.push(JSON.parse(String(init?.body)));
  const interrupted = interruptNext;
  return new Response(JSON.stringify({ ok: true, interrupted }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { PermissionModeSelect, interruptedNotice } = await import('./PermissionModeSelect.tsx');
const { useAssistantPermissionStore } = await import('./assistantPermissionStore');

useAssistantPermissionStore.getState().setMode('trusted');

const host = document.getElementById('root')!;
const root = createRoot(host);
await act(async () => root.render(<PermissionModeSelect conversationId="conv-1" compact />));

const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
const choose = async (value: string) => {
  const select = host.querySelector('#assistant-permission-mode') as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await settle();
};

// 1. A turn runs in Trusted; the user switches to Ask. The backend stopped it.
await choose('ask');
assert.deepEqual(posted.at(-1), { conversationId: 'conv-1', mode: 'ask' });
const notice = host.querySelector('[role="status"]');
assert.ok(notice, 'a notice says the turn was stopped');
assert.ok(notice!.textContent?.includes(interruptedNotice('ask')), notice!.textContent ?? '');
assert.ok(notice!.textContent?.includes('Ask before acting'), 'it names the mode');
for (const el of Array.from(notice!.querySelectorAll('*'))) {
  const cls = el.getAttribute('class') ?? '';
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]|font-mono/.test(cls), `no small or mono type: ${cls}`);
}

// 2. Dismiss clears it.
const dismiss = host.querySelector('button[aria-label="Dismiss the permission mode notice"]') as HTMLButtonElement;
assert.ok(dismiss, 'a labelled Dismiss key');
await act(async () => dismiss.click());
assert.equal(host.querySelector('[role="status"]'), null);

// 3. A switch that needs no new rule leaves the turn running: no notice.
interruptNext = false;
await choose('trusted');
assert.deepEqual(posted.at(-1), { conversationId: 'conv-1', mode: 'trusted' });
assert.equal(host.querySelector('[role="status"]'), null);

await act(async () => root.unmount());
console.log('PermissionModeSelect interrupt notice: ok');
