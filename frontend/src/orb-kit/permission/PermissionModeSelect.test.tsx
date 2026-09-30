/**
 * Render smoke test for PermissionModeSelect (node, no DOM): the control is a
 * native <select> whose id is the target of a real <label htmlFor>, every mode
 * is an <option> carrying its explanation as a title, and the current store
 * mode is the selected one.
 *
 *   cd frontend && npx tsx src/orb-kit/permission/PermissionModeSelect.test.tsx
 */
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

const store = new Map<string, string>();
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

// Imported through the SAME specifier the component uses, so the test and the
// component share one store instance.
const { PERMISSION_MODE_OPTIONS, useAssistantPermissionStore } = await import(
  './assistantPermissionStore'
);
const { PermissionModeSelect } = await import('./PermissionModeSelect.tsx');

const html = renderToStaticMarkup(<PermissionModeSelect />);

// The select id and the label's htmlFor are the contract ids, and they match.
assert.ok(html.includes('id="assistant-permission-mode"'), 'select carries the contract id');
assert.ok(html.includes('for="assistant-permission-mode"'), 'a real label points at it');
assert.ok(html.includes('name="assistantPermissionMode"'), 'select carries the form name');
// The custom-control escape hatch must NOT be used here: this is a native
// select, so it gets a native label and no redundant aria-label.
assert.ok(!html.includes('aria-label='), 'a native labelled select needs no aria-label');

// Every mode is an option, and its explanation rides along as the title.
for (const option of PERMISSION_MODE_OPTIONS) {
  assert.ok(html.includes(`value="${option.value}"`), `${option.value} is an option`);
  assert.ok(html.includes(option.label), `${option.value} shows its label`);
}
assert.equal(
  html.split('<option').length - 1,
  PERMISSION_MODE_OPTIONS.length,
  'one option per mode, no more',
);
assert.equal(
  html.split('title="').length - 1,
  PERMISSION_MODE_OPTIONS.length,
  'every option explains itself with a title',
);

// The select is driven by the store's value, so exactly one option is
// selected and it is the store's default. (Only the default can be asserted
// here: under renderToStaticMarkup, zustand's useSyncExternalStore reads the
// server snapshot — the store's INITIAL state — so a setMode() before a
// render is invisible to SSR. The store test covers setMode itself.)
assert.match(html, /value="ask"[^>]*selected=""/, 'the default mode starts selected');
assert.equal(html.split('selected=""').length - 1, 1, 'exactly one option is selected');
assert.equal(useAssistantPermissionStore.getState().mode, 'ask');

// compact hides the visible label text but keeps the label element (a11y).
const compactHtml = renderToStaticMarkup(<PermissionModeSelect compact />);
assert.ok(compactHtml.includes('for="assistant-permission-mode"'), 'compact keeps the label');
assert.ok(compactHtml.includes('sr-only'), 'compact hides the label visually only');

// Readable in both forms: the visible label is bold sans at 12px and the
// select text is 12px, never a 10px/11px arbitrary size.
for (const rendered of [html, compactHtml]) {
  assert.ok(!/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/.test(rendered), 'no text under 12px');
  assert.ok(/<select[^>]*class="[^"]*\btext-xs\b/.test(rendered), 'the select text is 12px');
}
assert.ok(/<label[^>]*class="[^"]*\btext-xs\b[^"]*\bfont-bold\b/.test(html), 'the label is bold 12px');

console.log('PermissionModeSelect regression passed');
