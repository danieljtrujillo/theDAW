/**
 * The assistant panel lists the Claude allow rules the session loads, and each
 * one has an "Always allow" toggle.
 *
 * In Ask mode the backend now makes every loaded allow rule ask before it runs
 * (claude_session.permission_rules), except the rules saved in settings
 * `assistant.always_allow_rules`. This panel is where the user marks them.
 *
 * Replays the panel in use: it opens in Ask mode and loads the rules, the user
 * marks one Always allow (PATCH /api/settings carries the new list), a phone on
 * the LAN tries the same and the backend refuses (the toggle rolls back), and
 * the user clears the mark. Plus the words for the other modes.
 *
 * Run: npx tsx src/orb-kit/permission/AllowRulesList.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'navigator', 'localStorage']) {
  Object.defineProperty(g, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const RULES = [
  { rule: 'Bash(git status:*)', source: 'user', path: 'C:/Users/me/.claude/settings.json', always_allow: false },
  { rule: 'Bash(uv run pytest:*)', source: 'project', path: 'G:/theDAW/.claude/settings.json', always_allow: false },
];
const requests: Array<{ method: string; url: string; body: unknown }> = [];
let patchStatus = 200;
let savedRules: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ method, url, body });
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  if (url === '/api/assistant/allow-rules') {
    return json({ use_user_config: true, rules: RULES.map((r) => ({ ...r, always_allow: savedRules.includes(r.rule) })) });
  }
  if (url === '/api/settings' && method === 'PATCH') {
    if (patchStatus !== 200) return json({ detail: 'This request must come from theDAW’s desktop shell.' }, patchStatus);
    savedRules = (body as { assistant: { always_allow_rules: string[] } }).assistant.always_allow_rules;
    return json({ assistant: { use_user_claude_config: true, always_allow_rules: savedRules } });
  }
  return json({ detail: 'Not Found' }, 404);
}) as typeof fetch;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { useFeatureToggleStore } = await import('../../state/featureToggleStore');
const { useAssistantPermissionStore } = await import('./assistantPermissionStore');
const { AllowRulesList, allowRulesHint, toggledAlwaysAllow } = await import('./AllowRulesList.tsx');

assert.deepEqual(toggledAlwaysAllow(['a'], 'b', true), ['a', 'b']);
assert.deepEqual(toggledAlwaysAllow(['a', 'b'], 'a', false), ['b']);
assert.deepEqual(toggledAlwaysAllow(['a'], 'a', true), ['a'], 'no duplicates');
assert.match(allowRulesHint('ask'), /asks before/);
assert.match(allowRulesHint('trusted'), /without asking/);
assert.match(allowRulesHint('readonly'), /refuses/);

useAssistantPermissionStore.getState().setMode('ask');
const host = document.getElementById('root')!;
const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
const root = createRoot(host);
await act(async () => root.render(<AllowRulesList />));
await settle();

const toggle = (rule: string) =>
  host.querySelector(`button[aria-label="Always allow ${rule}"]`) as HTMLButtonElement | null;

// 1. The rules are listed with their sources; nothing is marked yet.
assert.ok(host.textContent?.includes('Bash(git status:*)'));
assert.ok(host.textContent?.includes('Your Claude settings'));
assert.ok(host.textContent?.includes('Project settings'));
assert.ok(host.textContent?.includes(allowRulesHint('ask')));
assert.equal(toggle('Bash(git status:*)')?.getAttribute('aria-pressed'), 'false');
assert.equal(host.querySelector('section')?.getAttribute('aria-labelledby'), 'assistant-allow-rules-heading');
for (const el of Array.from(host.querySelectorAll('*'))) {
  const cls = el.getAttribute('class') ?? '';
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]|font-mono/.test(cls), `no small or mono type: ${cls}`);
}

// 2. The user marks one: the PATCH carries the whole new list, the toggle is on.
await act(async () => toggle('Bash(git status:*)')!.click());
await settle();
const patch = requests.filter((r) => r.method === 'PATCH').at(-1);
assert.deepEqual(patch?.body, { assistant: { always_allow_rules: ['Bash(git status:*)'] } });
assert.equal(toggle('Bash(git status:*)')?.getAttribute('aria-pressed'), 'true');
assert.deepEqual(useFeatureToggleStore.getState().settings.assistant.always_allow_rules, ['Bash(git status:*)']);

// 3. A LAN device is refused: the toggle rolls back to what the backend holds.
patchStatus = 403;
await act(async () => toggle('Bash(uv run pytest:*)')!.click());
await settle();
assert.equal(toggle('Bash(uv run pytest:*)')?.getAttribute('aria-pressed'), 'false', 'rolled back');
assert.deepEqual(useFeatureToggleStore.getState().settings.assistant.always_allow_rules, ['Bash(git status:*)']);

// 4. The user clears the mark.
patchStatus = 200;
await act(async () => toggle('Bash(git status:*)')!.click());
await settle();
assert.equal(toggle('Bash(git status:*)')?.getAttribute('aria-pressed'), 'false');
assert.deepEqual(savedRules, []);

await act(async () => root.unmount());
console.log('AllowRulesList: ok');
