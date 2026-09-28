import assert from 'node:assert/strict';

// Minimal in-memory localStorage for the node/tsx test env. Must exist BEFORE
// the store module is imported: zustand's persist middleware resolves its
// storage when the store is created, i.e. at module evaluation time.
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

const {
  ASSISTANT_PERMISSION_MODE_STORAGE_KEY,
  PERMISSION_MODE_OPTIONS,
  normalizePermissionMode,
  postPermissionMode,
  sendPermissionMode,
  useAssistantPermissionStore,
} = await import('./assistantPermissionStore.ts');

// -- Storage key is the contract ('thedaw:assistant-permission-mode') -------
assert.equal(ASSISTANT_PERMISSION_MODE_STORAGE_KEY, 'thedaw:assistant-permission-mode');

// -- The four modes, in the order the dropdown shows them ------------------
assert.deepEqual(
  PERMISSION_MODE_OPTIONS.map((o) => o.value),
  ['ask', 'accept_edits', 'readonly', 'trusted'],
);
for (const option of PERMISSION_MODE_OPTIONS) {
  assert.equal(typeof option.label, 'string');
  assert.ok(option.label.length > 0, `${option.value} needs a label`);
  assert.equal(typeof option.description, 'string');
  assert.ok(option.description.length > 0, `${option.value} needs a description`);
}

// -- Default is Ask ---------------------------------------------------------
assert.equal(useAssistantPermissionStore.getState().mode, 'ask');

// -- setMode moves the mode and persists under the contract key ------------
useAssistantPermissionStore.getState().setMode('trusted');
assert.equal(useAssistantPermissionStore.getState().mode, 'trusted');

const raw = localStorage.getItem(ASSISTANT_PERMISSION_MODE_STORAGE_KEY);
assert.ok(raw, 'the mode must be written to localStorage under the contract key');
assert.equal(JSON.parse(raw!).state.mode, 'trusted');

// -- Unknown values never corrupt the mode ---------------------------------
useAssistantPermissionStore.getState().setMode('bypassPermissions' as never);
assert.equal(useAssistantPermissionStore.getState().mode, 'trusted');
useAssistantPermissionStore.getState().setMode('readonly');
assert.equal(useAssistantPermissionStore.getState().mode, 'readonly');

// -- normalizePermissionMode ------------------------------------------------
assert.equal(normalizePermissionMode('ask'), 'ask');
assert.equal(normalizePermissionMode('accept_edits'), 'accept_edits');
assert.equal(normalizePermissionMode('nope'), null);
assert.equal(normalizePermissionMode(undefined), null);
assert.equal(normalizePermissionMode(7), null);

// -- postPermissionMode speaks contract C2 ----------------------------------
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return { ok: true, status: 200 } as Response;
}) as typeof globalThis.fetch;

const ok = await postPermissionMode('conv-42', 'accept_edits');
assert.equal(ok, true);
assert.equal(calls.length, 1);
assert.equal(calls[0].url, '/api/assistant/permission-mode');
assert.equal(calls[0].init?.method, 'POST');
assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
  conversationId: 'conv-42',
  mode: 'accept_edits',
});

// No conversation yet -> nothing to tell the backend about.
assert.equal(await postPermissionMode(null, 'ask'), false);
assert.equal(await postPermissionMode(undefined, 'ask'), false);
assert.equal(calls.length, 1);

// A failing backend is reported, never thrown: the dropdown must still move.
globalThis.fetch = (async () => {
  throw new Error('network down');
}) as typeof globalThis.fetch;
assert.equal(await postPermissionMode('conv-42', 'ask'), false);

globalThis.fetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof globalThis.fetch;
assert.equal(await postPermissionMode('conv-42', 'ask'), false);

// A switch that stopped a running turn says so; an older backend's reply
// without the field, or one with no JSON body, reads as not interrupted.
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, interrupted: true }), { status: 200 })) as typeof globalThis.fetch;
assert.deepEqual(await sendPermissionMode('conv-42', 'ask'), { ok: true, interrupted: true });
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof globalThis.fetch;
assert.deepEqual(await sendPermissionMode('conv-42', 'ask'), { ok: true, interrupted: false });
globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof globalThis.fetch;
assert.deepEqual(await sendPermissionMode('conv-42', 'ask'), { ok: true, interrupted: false });
assert.deepEqual(await sendPermissionMode(null, 'ask'), { ok: false, interrupted: false });

globalThis.fetch = originalFetch;

console.log('assistantPermissionStore regression passed');
