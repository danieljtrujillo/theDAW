/**
 * The standing notice that explains a page with no AudioWorklet.
 *
 * What is pinned here: it says nothing on a page that works, it explains and
 * offers both ways out on a plain-http LAN page, its dismiss control has an
 * accessible name, and dismissal survives a remount within the session (but is
 * recorded in sessionStorage, not localStorage — the condition belongs to this
 * address, so a fresh session must be told again).
 *
 * jsdom supplies the DOM, same pattern as TabErrorBoundary.test.tsx.
 *
 * Run: `npx tsx src/components/layout/AudioWorkletUnavailableNotice.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const win = dom.window;

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  MouseEvent: win.MouseEvent,
  sessionStorage: win.sessionStorage,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AudioWorkletUnavailableNotice, AUDIO_WORKLET_NOTICE_DISMISS_KEY } = await import(
  './AudioWorkletUnavailableNotice'
);
const { describeAudioWorkletProblem } = await import('../../lib/audioWorkletSupport');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });

/** A page that can run worklets. */
const OK_ENV = (() => {
  class Base {}
  Object.defineProperty(Base.prototype, 'audioWorklet', { get: () => ({}), configurable: true });
  return { isSecureContext: true, BaseAudioContext: Base, AudioContext: class extends Base {} };
})();

/** A plain-http LAN page: Web Audio exists, `audioWorklet` does not. */
const INSECURE_ENV = { isSecureContext: false, BaseAudioContext: class {}, AudioContext: class {} };

const mount = async (env: object, secureUrl?: string | null) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (url?: string | null) => {
    await step(() => {
      root.render(React.createElement(AudioWorkletUnavailableNotice, { env, secureUrl: url }));
    });
  };
  await render(secureUrl);
  return {
    host,
    render,
    unmount: async () => {
      await step(() => root.unmount());
      host.remove();
    },
  };
};

// ── a healthy page is told nothing ──────────────────────────────────────────
{
  assert.equal(describeAudioWorkletProblem(OK_ENV), null, 'precondition: this env is fine');
  const { host, unmount } = await mount(OK_ENV);
  assert.equal(host.textContent, '', 'no notice on a page that works');
  assert.equal(host.querySelector('[role="status"]'), null);
  await unmount();
}

// ── the LAN page gets the whole explanation ─────────────────────────────────
{
  win.sessionStorage.clear();
  const { host, unmount } = await mount(INSECURE_ENV);
  const status = host.querySelector('[role="status"]');
  assert.ok(status, 'an ambient status region, as AutosaveRecoveryNotice uses');

  const text = status.textContent ?? '';
  assert.match(text, /audio/i, 'names what is wrong');
  assert.match(text, /secure/i, 'names the browser rule');
  assert.match(text, /https:\/\//, 'way out 1: https');
  assert.match(text, /localhost/, 'way out 1: localhost');
  assert.match(text, /ssh -L/, 'way out 2: forward the port from another computer');
  assert.match(text, /mark this address as secure/i, 'way out 2: or mark the origin secure');

  const button = host.querySelector('button');
  assert.ok(button, 'a real <button>, not a clickable div');
  assert.equal(button.getAttribute('type'), 'button');
  const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
  assert.match(name.trim(), /dismiss/i, 'the dismiss control has an accessible name');
  await unmount();
}

// ── the LAN https address, once Shell has learned one ───────────────────────
//
// Shell fetches `GET /api/network/lan` AFTER this notice has mounted, so the
// address arrives as a prop change on an already-visible notice. A notice that
// froze its text at mount would keep telling a phone to "arrange a secure
// context" while the exact address to open was already known.
{
  win.sessionStorage.clear();
  const { host, render, unmount } = await mount(INSECURE_ENV);
  const before = host.querySelector('[role="status"]')?.textContent ?? '';
  assert.doesNotMatch(before, /192\.168\.1\.34/, 'precondition: nothing to offer yet');

  await render('https://192.168.1.34:5443');
  const after = host.querySelector('[role="status"]')?.textContent ?? '';
  assert.match(after, /https:\/\/192\.168\.1\.34:5443/, 'the notice names the secure address when it lands');
  assert.match(after, /certificate warning/i, 'and says the first visit warns, so the user proceeds');
  assert.match(after, /ssh -L/, 'the generic ways out are still there for everyone else');
  await unmount();
}

// ── dismissal: closes now, and stays closed for this session ────────────────
{
  win.sessionStorage.clear();
  const first = await mount(INSECURE_ENV);
  const button = first.host.querySelector('button');
  assert.ok(button);
  await step(() => {
    button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(first.host.querySelector('[role="status"]'), null, 'it closes on click');
  assert.equal(
    win.sessionStorage.getItem(AUDIO_WORKLET_NOTICE_DISMISS_KEY),
    '1',
    'remembered in sessionStorage',
  );
  assert.equal(
    win.localStorage.getItem(AUDIO_WORKLET_NOTICE_DISMISS_KEY),
    null,
    'not remembered forever',
  );
  await first.unmount();

  const second = await mount(INSECURE_ENV);
  assert.equal(second.host.querySelector('[role="status"]'), null, 'a remount in the same session stays quiet');
  await second.unmount();

  // A new session (storage cleared, as a new tab would be) is told again.
  win.sessionStorage.clear();
  const third = await mount(INSECURE_ENV);
  assert.ok(third.host.querySelector('[role="status"]'), 'a fresh session sees it again');
  await third.unmount();
}

console.log('AudioWorkletUnavailableNotice: ok');
