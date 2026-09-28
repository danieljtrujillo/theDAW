/**
 * The panel's pure render decisions.
 *
 * AssistantPanel no longer decides how a MESSAGE looks — the ported
 * `Transcript` owns that, and `shouldShowMessageActions` in
 * transcript/display.ts is the rule that killed the empty bubble with a
 * Copy/Retry row under it. What is left in the panel are two decisions about
 * its own chrome, and they are exported so a test can pin them instead of
 * leaving them buried in JSX:
 *
 *   - which provider gets the permission-mode dropdown, and
 *   - what the composer footer's status line says.
 *
 * The second one exists because status used to render as a fake assistant
 * message row ("Thinking..." with an avatar) in the transcript. There is now
 * exactly ONE live indicator — the Transcript's — and `statusText` appears
 * only here, in the composer footer.
 *
 * Plus the settings drawer (Model Info): its tab strip is a real tablist, and
 * nothing in the drawer is drawn under 12px or as a small mono label.
 *
 *   cd frontend && npx tsx src/orb-kit/AssistantPanel.render.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The panel's module graph reaches zustand `persist` stores, which read
// localStorage as soon as they are created. Give them one before importing.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
    const store = new Map<string, string>();
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
    shouldShowPermissionSelect,
    composerStatusLine,
    composerStatusIsLiveRegion,
    contextMeterView,
    seedConversationId,
    AssistantSettingsTabs,
    settingsTabId,
    settingsPanelId,
} = await import('./AssistantPanel.tsx');

/** Defaults for the composer-status helpers; each case overrides what it tests. */
const idle = {
    isStreaming: false,
    statusText: null as string | null,
    queuedCount: 0,
    hasLiveContent: false,
    localStatus: null as string | null,
};

// ---------------------------------------------------------------------------
// shouldShowPermissionSelect — permission modes are a Claude Code feature
// ---------------------------------------------------------------------------

assert.equal(shouldShowPermissionSelect('claude'), true, 'the Claude Code provider gets the dropdown');

for (const provider of ['gemini', 'openai', 'anthropic', 'grok', 'groq', 'ollama', 'lmstudio', '']) {
    assert.equal(
        shouldShowPermissionSelect(provider),
        false,
        `${provider || '(none)'} has no permission modes — the dropdown must not render`,
    );
}

// ---------------------------------------------------------------------------
// composerStatusLine — the ONLY place statusText is allowed to show
// ---------------------------------------------------------------------------

// Idle: nothing. A status line that lingers after the turn is a lie.
assert.equal(composerStatusLine(idle), null);
assert.equal(
    composerStatusLine({ ...idle, statusText: 'Running Bash', queuedCount: 2 }),
    null,
    'a stale status from the finished turn is not shown',
);

// Turn start, nothing streamed yet: the transcript's live row already renders a
// "Thinking…" indicator. A second one here would be a SECOND aria-live region
// announcing at the same moment.
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: null, hasLiveContent: false }),
    null,
    'no composer line while the transcript indicator is the only thing on screen',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: 'Running Bash', hasLiveContent: false }),
    null,
    'even a real status waits until the live row has content of its own',
);

// Once the turn has produced something, the transcript stops rendering its
// indicator and the composer line takes over.
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: 'Running Bash', hasLiveContent: true }),
    'Running Bash',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: null, hasLiveContent: true }),
    'Working…',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: '   ', hasLiveContent: true }),
    'Working…',
);

// Queued follow-ups are the user's own pending prompts, and nothing else on
// screen says how many — so they show even before the live row has content.
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: 'Running Bash', hasLiveContent: true, queuedCount: 1 }),
    'Running Bash · 1 queued',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, statusText: null, hasLiveContent: false, queuedCount: 3 }),
    'Working… · 3 queued',
);

// Attachment preparation happens BEFORE the turn exists, so nothing else is on
// screen to report it.
assert.equal(
    composerStatusLine({ ...idle, localStatus: 'Preparing 2 attachments…' }),
    'Preparing 2 attachments…',
);
assert.equal(
    composerStatusLine({ ...idle, isStreaming: true, hasLiveContent: false, localStatus: 'Attachment failed' }),
    'Attachment failed',
    'a local status outranks the turn — it is the panel reporting its own failure',
);

// ---------------------------------------------------------------------------
// composerStatusIsLiveRegion — exactly ONE aria-live region at any moment
// ---------------------------------------------------------------------------

// While the transcript's "Thinking…" row is up, it owns the announcement; the
// composer line (queue depth) renders as plain text.
assert.equal(
    composerStatusIsLiveRegion({ ...idle, isStreaming: true, hasLiveContent: false, queuedCount: 2 }),
    false,
);
// Once the live row has content it drops its indicator, so the composer line
// becomes the only region and must announce.
assert.equal(composerStatusIsLiveRegion({ ...idle, isStreaming: true, hasLiveContent: true }), true);
assert.equal(composerStatusIsLiveRegion({ ...idle, localStatus: 'Preparing 2 attachments…' }), true);

// ---------------------------------------------------------------------------
// seedConversationId — saved conversation first, sessionStorage as fallback
// ---------------------------------------------------------------------------
// sessionStorage is a single tab-wide slot; the saved conversation is the one
// the user actually reopened. Reading the slot first made reopening chat B
// resume chat A's backend conversation.

assert.equal(seedConversationId({ sessionId: 'conv-from-history' }, 'conv-in-tab'), 'conv-from-history');
assert.equal(seedConversationId({ sessionId: null }, 'conv-in-tab'), 'conv-in-tab', 'a saved chat with no id falls back');
assert.equal(seedConversationId(null, 'conv-in-tab'), 'conv-in-tab', 'no saved chat at all falls back');
assert.equal(seedConversationId(null, null), null);
assert.equal(seedConversationId({ sessionId: '' }, 'conv-in-tab'), 'conv-in-tab', 'an empty id is not an id');
assert.equal(seedConversationId({ sessionId: 'only-history' }, null), 'only-history');

// ---------------------------------------------------------------------------
// contextMeterView — a guess is never labelled as a reading
// ---------------------------------------------------------------------------
// The meter draws two different things through one bar: the CLI's real
// context-window usage, and a character-count estimate. Calling the estimate
// "Context" would present a guess as a measurement, so the label is the tell.

{
    const estimate = contextMeterView(null, 12);
    assert.equal(estimate.label, 'Memory', 'no reading means the estimate, and it says so');
    assert.equal(estimate.title, 'Estimated (no live context reading yet)');
    assert.match(estimate.ariaLabel, /^Estimated context window used: 12%$/);
}
{
    const live = contextMeterView({ totalTokens: 42000, maxTokens: 200000, percentage: 21 }, 21);
    assert.equal(live.label, 'Context', 'a real reading is labelled as one');
    assert.equal(live.title, `Context: ${(42000).toLocaleString()} / ${(200000).toLocaleString()} tokens`);
    assert.equal(live.ariaLabel, 'Context window used: 21%');
}

// The bar warms as the window fills: primary → amber over half → red over 80%.
// The boundaries are exclusive, exactly as the Foundry draws them.
const usage = { totalTokens: 1, maxTokens: 2, percentage: 0 };
assert.equal(contextMeterView(usage, 0).barClass, 'bg-primary');
assert.equal(contextMeterView(usage, 50).barClass, 'bg-primary', '50 is not yet amber');
assert.equal(contextMeterView(usage, 51).barClass, 'bg-amber-500');
assert.equal(contextMeterView(usage, 80).barClass, 'bg-amber-500', '80 is not yet red');
assert.equal(contextMeterView(usage, 81).barClass, 'bg-red-500');
assert.equal(contextMeterView(usage, 100).barClass, 'bg-red-500');
// The colour is the percentage's business, not the reading's: an estimate that
// says the window is nearly full is just as urgent.
assert.equal(contextMeterView(null, 95).barClass, 'bg-red-500');

// ---------------------------------------------------------------------------
// The settings drawer — a real tablist, 12px and up
// ---------------------------------------------------------------------------

/** Text-size classes under 12px (text-[8px] .. text-[11.5px]). */
const SMALL_TEXT = /text-\[(?:[0-9]|1[01])(?:\.[0-9]+)?px\]/;

for (const active of ['model', 'keys'] as const) {
    const other = active === 'model' ? 'keys' : 'model';
    const html = renderToStaticMarkup(createElement(AssistantSettingsTabs, { active, onSelect: () => {} }));
    assert.ok(html.includes('role="tablist"'), 'the strip is a tablist');
    assert.ok(html.includes('aria-label="Assistant settings"'), 'the tablist is named');
    assert.equal(html.split('role="tab"').length - 1, 2, 'two tabs');
    const tabTag = (tab: string) => html.match(new RegExp(`<button[^>]*id="${settingsTabId(tab as 'model')}"[^>]*>`))?.[0] ?? '';
    assert.match(tabTag(active), /aria-selected="true"/, `${active} says it is selected`);
    assert.match(tabTag(other), /aria-selected="false"/, `${other} says it is not`);
    assert.ok(tabTag(active).includes(`aria-controls="${settingsPanelId(active)}"`), 'the selected tab names its panel');
    assert.ok(!tabTag(other).includes('aria-controls'), 'a tab whose panel is not rendered names none');
    assert.match(tabTag(active), /tabindex="0"/);
    assert.match(tabTag(other), /tabindex="-1"/);
    assert.ok(html.includes('Chat') && html.includes('Keys'));
    assert.ok(!SMALL_TEXT.test(html), 'no tab text under 12px');
    assert.ok(tabTag(active).includes('text-xs font-bold'), 'tabs are bold 12px sans');
}

// The drawer's own markup, read from the source: the block between the
// Model Info switch and the transcript. Every class there is 12px or more,
// and no label is small uppercase mono.
{
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AssistantPanel.tsx'), 'utf8');
    const start = source.indexOf('{showModelInfo && (');
    const end = source.indexOf('{/* Messages */}', start);
    assert.ok(start > 0 && end > start, 'found the settings drawer');
    const drawer = source.slice(start, end);
    const small = drawer.match(new RegExp(SMALL_TEXT.source, 'g')) ?? [];
    assert.deepEqual(small, [], 'no text under 12px in the settings drawer');
    assert.ok(!/font-mono uppercase/.test(drawer), 'no small uppercase mono labels in the settings drawer');
    assert.ok(drawer.includes('role="tabpanel"'), 'the panels are tabpanels');
    assert.ok(drawer.includes("aria-labelledby={settingsTabId('model')}"));
    assert.ok(drawer.includes("aria-labelledby={settingsTabId('keys')}"));
}

console.log('AssistantPanel render decisions: all assertions passed');
