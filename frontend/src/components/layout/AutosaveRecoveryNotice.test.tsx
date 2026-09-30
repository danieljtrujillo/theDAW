/**
 * Render test for AutosaveRecoveryNotice: the crash recovery `alertdialog`
 * still shows exactly when an `offer` is published, the T57B ownership
 * reader shows a one-line `status` notice exactly when THIS tab is
 * `observer` (another theDAW window owns autosave) — never for `owner` or
 * `unsupported` — and neither blocks clicks meant for whatever is under it.
 *
 * Third re-audit finding fixed here: the always-mounted status container
 * (z-45, between the header's z-40 and the modal layer's z-50) and the
 * recovery dialog are SEPARATE top-level fixed layers, not nested — a
 * child's z-index only matters within its parent's own stacking context
 * (a `position: fixed` + `z-index` parent creates one), so nesting the
 * dialog inside the z-45 status container could never lift it above
 * HomeScreen (`components/home/HomeScreen.tsx`, `fixed inset-0 z-60`,
 * opaque, opens on every returning launch by default) or the boot cinematic
 * (`components/layout/ParticleSplash.tsx`, `fixed inset-0 z-200`) — the
 * whole subtree paints at the parent's z-45 regardless of a child's own
 * z-index. The dialog's own wrapper uses z-300: the codebase's existing
 * next full-screen-overlay tier above the boot cinematic's z-200 (already
 * used by `ThemeModal`), clearing both HomeScreen and the boot cinematic
 * while staying below the ephemeral utility tier (tooltips/context menus at
 * z-9999/z-10000) that legitimately draws over every modal.
 *
 * Earlier re-audit findings kept here:
 *   1. `pointer-events-none` lives on each fixed wrapper, with
 *      `pointer-events-auto` on the `alertdialog` overriding it back on —
 *      it has Restore/Discard buttons.
 *   2. The status container and its `role="status"` node are ALWAYS
 *      rendered; only the dialog and the status text are conditional. A
 *      live region announces a CHANGE to its content, not its own arrival,
 *      so recreating the node on every ownership flip would lose the
 *      announcement — checked by asserting the SAME DOM node survives an
 *      owner -> observer -> owner round trip, and the real handover below.
 *
 * Client-rendered (createRoot), not renderToStaticMarkup: zustand's SSR
 * snapshot is the store's INITIAL state (`getInitialState`, zustand/react
 * `useStore`), so a `setState()` made after the store is created is invisible
 * to `renderToStaticMarkup` — only a live subscription sees it.
 *
 *   cd frontend && npx tsx src/components/layout/AutosaveRecoveryNotice.test.tsx
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
  Node: win.Node,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
// Imported through the SAME specifier the component uses, so the test and
// the component share one store instance. Types come straight from the
// module rather than being redeclared here.
const {
  useAutosaveRecoveryStore,
  initEditorAutosave,
}: {
  useAutosaveRecoveryStore: typeof import('../../lib/editorAutosave').useAutosaveRecoveryStore;
  initEditorAutosave: typeof import('../../lib/editorAutosave').initEditorAutosave;
} = await import('../../lib/editorAutosave');
import type { AutosaveRecoveryInfo, AutosaveOwnership } from '../../lib/editorAutosave';
const { AutosaveRecoveryNotice } = await import('./AutosaveRecoveryNotice.tsx');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });
const setStore = (patch: Partial<{ offer: AutosaveRecoveryInfo | null; busy: boolean; ownership: AutosaveOwnership }>) =>
  step(() => useAutosaveRecoveryStore.setState(patch));

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);

const dialogEl = () => host.querySelector('[role="alertdialog"]') as HTMLElement | null;
const statusEl = () => host.querySelector('[role="status"]') as HTMLElement | null;
const dialogWrapper = () => dialogEl()?.parentElement ?? null;
const statusWrapper = () => statusEl()?.parentElement ?? null;

await setStore({ offer: null, busy: false, ownership: 'unsupported' });
await step(() => root.render(<AutosaveRecoveryNotice />));

// ── The status layer is ALWAYS mounted; the dialog layer is not ─────────────
assert.ok(!dialogEl(), 'no offer means no alertdialog, and no dialog wrapper at all');
assert.ok(statusEl(), 'the status node is present even when this tab is not an observer');
assert.equal(statusEl()?.textContent, '', 'and empty');
const persistentStatusNode = statusEl();

// ── Finding: two SEPARATE fixed layers, not one nested tree ─────────────────
assert.ok(statusWrapper()?.className.includes('fixed'), 'status sits in its own fixed wrapper');
assert.ok(statusWrapper()?.className.includes('z-45'), 'status wrapper sits at z-45: above the z-40 header, below z-50 modals');
assert.ok(!statusWrapper()?.className.includes('z-100'), 'no longer floats above the modal layer');
assert.ok(statusWrapper()?.className.includes('pointer-events-none'), 'the status wrapper is non-blocking');

// ── owner: still nothing to show, but the SAME status node persists ─────────
await setStore({ ownership: 'owner' });
assert.ok(!dialogEl(), 'owner + no offer still shows no alertdialog');
assert.ok(statusEl() === persistentStatusNode, 'the status node is not recreated on an ownership change');
assert.equal(statusEl()?.textContent, '', 'still empty');

// ── observer (another window owns autosave): one-line status notice ─────────
await setStore({ ownership: 'observer' });
assert.ok(statusEl() === persistentStatusNode, 'still the SAME node once it has something to say — required for the live region to announce it');
assert.equal(
  statusEl()?.textContent,
  'Autosave is running in another theDAW tab — changes here are not autosaved.',
  'exact wording from the audit',
);
assert.equal(statusEl()?.getAttribute('aria-live'), null, 'role="status" already implies aria-live=polite, no redundant attribute');

// ── owner again: the SAME node goes back to empty ────────────────────────────
await setStore({ ownership: 'owner' });
assert.ok(statusEl() === persistentStatusNode, 'round trip owner -> observer -> owner never recreates the node');
assert.equal(statusEl()?.textContent, '', 'empty again');

// ── Recovery offer: dialog gets its OWN wrapper, above HomeScreen (z-60) and
//    the boot cinematic (z-200), not nested under the status container's z-45
await setStore({ offer: { savedAt: '2026-09-19T00:00:00.000Z', trackCount: 3, clipCount: 7 } });
assert.ok(dialogEl(), 'a published offer shows the recovery dialog');
assert.ok(host.textContent?.includes('Restore'), 'restore action present');
assert.ok(host.textContent?.includes('Discard'), 'discard action present');
assert.ok(dialogWrapper() !== statusWrapper(), 'the dialog is NOT nested inside the status container — z-index only lifts within its own stacking context');
assert.ok(dialogWrapper()?.className.includes('fixed'), 'dialog sits in its own fixed wrapper');
assert.ok(dialogWrapper()?.className.includes('z-300'), 'dialog wrapper clears HomeScreen (z-60) and the boot cinematic (z-200)');
assert.ok(dialogWrapper()?.className.includes('pointer-events-none'), 'the dialog WRAPPER itself is non-blocking...');
assert.ok(dialogEl()?.className.includes('pointer-events-auto'), '...but the dialog opts back in — it has buttons');
assert.ok(statusEl() === persistentStatusNode, 'the status node is unaffected by the offer appearing');
assert.equal(statusEl()?.textContent, '', 'still empty — not an observer');
assert.ok(statusWrapper()?.className.includes('z-45'), 'status wrapper is untouched by the dialog appearing');

// ── Both at once: offer AND observer (this tab is recovery-only) ────────────
await setStore({ ownership: 'observer' });
assert.ok(dialogEl(), 'recovery dialog still shows');
assert.equal(
  statusEl()?.textContent,
  'Autosave is running in another theDAW tab — changes here are not autosaved.',
  'ownership status notice text shows alongside the dialog',
);
assert.ok(statusEl() === persistentStatusNode, 'still the same node');

// ── Finding 3 (kept): the REAL observer -> owner handover ────────────────────
// A minimal Web Locks polyfill: one named lock, `ifAvailable` answers
// immediately, a queued (non-`ifAvailable`) request is granted on release —
// enough to drive `acquireOwnership` -> `waitForHandover`
// (editorAutosave.ts:190-262) for real, through the only exported entry
// point that reaches it.
class FakeLockManager {
  private held = false;
  private queue: Array<() => void> = [];

  request(
    name: string,
    optionsOrCallback: { ifAvailable?: boolean } | ((lock: { name: string } | null) => unknown),
    maybeCallback?: (lock: { name: string } | null) => unknown,
  ): Promise<unknown> {
    const isFn = typeof optionsOrCallback === 'function';
    const options = isFn ? {} : optionsOrCallback;
    const callback = (isFn ? optionsOrCallback : maybeCallback) as (lock: { name: string } | null) => unknown;

    if (options.ifAvailable) {
      if (this.held) return Promise.resolve(callback(null));
      this.held = true;
      return Promise.resolve(callback({ name }));
    }
    return new Promise((resolve) => {
      const grant = () => {
        this.held = true;
        Promise.resolve(callback({ name })).then(resolve);
      };
      if (!this.held) grant();
      else this.queue.push(grant);
    });
  }

  /** Test-only: the external holder releases the lock, granting the queue. */
  release(): void {
    this.held = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

const fakeLocks = new FakeLockManager();
Object.defineProperty(win.navigator, 'locks', { value: fakeLocks, configurable: true });
// A getDirectory that never resolves: OPFS reads/writes stay pending forever
// (harmless — no timer, no I/O), so the manifest read and any scheduled save
// never run, and the handover test stays about ownership, not OPFS.
Object.defineProperty(win.navigator, 'storage', {
  value: { getDirectory: () => new Promise(() => undefined) },
  configurable: true,
});

// Another tab already holds the lock, exactly like the scenario above.
void fakeLocks.request('thedaw-editor-autosave', () => new Promise(() => undefined));

await setStore({ offer: null, ownership: 'unsupported' });
const nodeBeforeHandover = statusEl();
await step(() => initEditorAutosave());
assert.equal(useAutosaveRecoveryStore.getState().ownership, 'observer', 'acquireOwnership found the lock held and became observer');
assert.equal(
  statusEl()?.textContent,
  'Autosave is running in another theDAW tab — changes here are not autosaved.',
  'the observer notice is up',
);
assert.ok(statusEl() === nodeBeforeHandover, 'still the same persistent node');

// The other tab releases the lock — the REAL handover in
// waitForHandover's queued request callback (editorAutosave.ts:251) fires.
await step(() => fakeLocks.release());
assert.equal(useAutosaveRecoveryStore.getState().ownership, 'owner', 'the real handover promoted this tab to owner');
assert.ok(statusEl() === nodeBeforeHandover, 'the node survives the real handover too — never unmounted');
assert.equal(statusEl()?.textContent, '', 'empty again once this tab is no longer an observer and there is no offer');

await step(() => root.unmount());
useAutosaveRecoveryStore.setState({ offer: null, busy: false, ownership: 'unsupported' });
console.log('AutosaveRecoveryNotice regression passed');
