/**
 * "Use my Claude settings and MCP servers" — the assistant panel's switch for
 * whether the Claude Code session loads the user's own Claude setup.
 *
 * Replays what a real install goes through, in order:
 *   1. the browser still holds a settings mirror saved by the previous build,
 *      which has no `assistant` section at all;
 *   2. the backend answers GET /api/settings from a build that also lacks it;
 *   3. the user unchecks the box (PATCH, confirmed);
 *   4. a phone on the LAN tries to check it again and the backend refuses (403),
 *      and the notice says the backend refused it (it did receive it);
 *   5. the backend is unreachable, and the notice says it never received it.
 * Plus the static markup: a native checkbox with a real <label htmlFor>.
 *
 *   cd frontend && npx tsx src/orb-kit/permission/UserClaudeConfigToggle.test.tsx
 */
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

const MIRROR_KEY = 'thedaw-feature-settings';

// 1. The mirror the previous build's featureToggleStore persisted: its whole
//    `settings` object, with no `assistant` section, and a real user choice.
const previousBuildSettings = {
  schema_version: 10,
  app: { launch_mode: 'desktop' },
  analysis: { auto_on_import: true, auto_on_generate: true, include_genre: false, include_key: true },
  stems: { auto_on_import: false, auto_on_generate: false, default_count: 4, device: 'cuda', quality: 'balanced' },
  midi: { auto_on_import: false, auto_on_generate: false, from_stems: true },
  idle: { min_idle_seconds: 30, respect_vram_pressure: true },
  vj: { export_root: 'exports/vj' },
  notation: { artist: 'SOMEONE', musescore_path: '' },
  io: {
    audio_output: { id: '', label: '' },
    cue_output: { id: '', label: '' },
    audio_input: { id: '', label: '' },
    midi_inputs: { mode: 'all', ports: [] },
    midi_output: { id: '', label: '' },
    visual_display: { id: '', label: '' },
    overrides: {},
  },
  models: { extra_folders: [] },
  library: { media_roots: [] },
};

const storage = new Map<string, string>([
  [MIRROR_KEY, JSON.stringify({ state: { settings: previousBuildSettings }, version: 0 })],
]);
const localStorageStub = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => {
    storage.set(k, String(v));
  },
  removeItem: (k: string) => {
    storage.delete(k);
  },
  clear: () => storage.clear(),
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() {
    return storage.size;
  },
} as Storage;
(globalThis as unknown as { localStorage: Storage }).localStorage = localStorageStub;
// featureToggleStore persists through state/persistStorage.ts, which reads
// `localStorage` (or `window.localStorage`) on every call; both are the stub, so
// step 1 reads the mirror above and cannot pass by falling back to memory.
(globalThis as unknown as { window: { localStorage: Storage } }).window = {
  localStorage: localStorageStub,
};

// Every request the store makes, and what the "backend" answers.
type Answer = { status: number; body: unknown };
const requests: Array<{ method: string; url: string; body: unknown }> = [];
let answer: Answer = { status: 200, body: {} };
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
  url: string,
  init?: { method?: string; body?: string },
) => {
  requests.push({
    method: init?.method ?? 'GET',
    url,
    body: init?.body ? JSON.parse(init.body) : undefined,
  });
  const { status, body } = answer;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}) as typeof fetch;

// Imported through the SAME specifiers the component uses, so all share one store.
const { useFeatureToggleStore } = await import('../../state/featureToggleStore');
const { useFeatureGateStore } = await import('../../notices/featureGateStore');
const notice = () => useFeatureGateStore.getState().notices.find((n) => n.id === 'settings:patch');
const {
  UserClaudeConfigToggle,
  USER_CLAUDE_CONFIG_ID,
  setUseUserClaudeConfig,
  userClaudeConfigHint,
} = await import('./UserClaudeConfigToggle.tsx');

const current = () => useFeatureToggleStore.getState().settings.assistant?.use_user_claude_config;

// 1. The old mirror rehydrates with the switch filled in (ON), and the user's
//    own choices from it survive.
assert.equal(useFeatureToggleStore.persist.hasHydrated(), true, 'the mirror was read');
assert.equal(current(), true, 'a mirror from the previous build reads as ON');
assert.equal(useFeatureToggleStore.getState().settings.notation.artist, 'SOMEONE');
assert.equal(useFeatureToggleStore.getState().settings.app.launch_mode, 'desktop');

// The markup: a native checkbox, a real label pointing at it, the hint tied in.
const html = renderToStaticMarkup(<UserClaudeConfigToggle />);
assert.ok(html.includes(`id="${USER_CLAUDE_CONFIG_ID}"`), 'checkbox carries its id');
assert.ok(html.includes(`for="${USER_CLAUDE_CONFIG_ID}"`), 'a real label points at it');
assert.ok(html.includes('name="assistantUseUserClaudeConfig"'), 'checkbox carries a form name');
assert.ok(html.includes('type="checkbox"'));
assert.ok(html.includes('Use my Claude settings and MCP servers'), 'the label says what it does');
assert.ok(html.includes(`aria-describedby="${USER_CLAUDE_CONFIG_ID}-hint"`));
assert.ok(html.includes(`id="${USER_CLAUDE_CONFIG_ID}-hint"`));
assert.ok(html.includes('checked=""'), 'ON by default');
assert.ok(!html.includes('aria-label='), 'a native labelled checkbox needs no aria-label');
assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(html), 'no text under 12px');

// 2. The backend is a build without the section: still ON.
answer = { status: 200, body: { ...previousBuildSettings, app: { launch_mode: 'desktop' } } };
await useFeatureToggleStore.getState().refresh();
assert.equal(requests.at(-1)?.method, 'GET');
assert.equal(current(), true, 'a backend without the section reads as ON');

// 3. The user unchecks it: exactly this key goes to the backend, and the
//    backend's confirmation is what the store ends on.
answer = {
  status: 200,
  body: { ...previousBuildSettings, schema_version: 11, assistant: { use_user_claude_config: false } },
};
assert.equal(await setUseUserClaudeConfig(false), true);
assert.deepEqual(requests.at(-1), {
  method: 'PATCH',
  url: '/api/settings',
  body: { assistant: { use_user_claude_config: false } },
});
assert.equal(current(), false);

// 4. A LAN device tries to turn it back on; the backend refuses. The box goes
//    back to what the backend holds, and the reason is kept for the notice.
answer = { status: 403, body: { detail: "This request must come from theDAW's desktop shell." } };
assert.equal(await setUseUserClaudeConfig(true), false);
assert.equal(current(), false, 'a refused save rolls back');
assert.ok(useFeatureToggleStore.getState().error?.includes('desktop shell'));
assert.ok(notice()?.message.includes('The backend refused it.'), notice()?.message);
assert.ok(!notice()?.message.includes('never received'), 'the 403 WAS received');

// 5. The backend is down: the request never arrives, and the notice says so.
const reachable = globalThis.fetch;
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;
assert.equal(await setUseUserClaudeConfig(true), false);
assert.equal(current(), false);
assert.ok(notice()?.message.includes('The backend never received it.'), notice()?.message);
(globalThis as unknown as { fetch: typeof fetch }).fetch = reachable;

// The hint says what each position means, and when it takes effect.
assert.ok(userClaudeConfigHint(true).includes('MCP servers'));
assert.ok(userClaudeConfigHint(true).includes('allow rules'));
assert.ok(userClaudeConfigHint(true).includes('except in Read-only'));
assert.ok(userClaudeConfigHint(true).includes('own code always ask'));
assert.ok(userClaudeConfigHint(false).includes('permission mode decides every action'));
for (const on of [true, false]) {
  assert.ok(userClaudeConfigHint(on).includes('Applies from your next message.'));
}

console.log('UserClaudeConfigToggle regression passed');
