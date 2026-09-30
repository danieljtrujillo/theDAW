import assert from 'node:assert/strict';

// Storage budget for the shim below, in characters. `Infinity` = never full.
// Tests lower it to drive the quota-trim path in writeAll().
let BUDGET = Infinity;
// When set, the shim throws this instead of a quota error (non-quota path).
let FORCE_ERROR: Error | null = null;
// Number of setItem calls, so a test can prove there was no retry loop.
let setItemCalls = 0;

// Minimal in-memory localStorage for the node/tsx test env. Runs before any
// chatHistory function is called (module bodies don't touch storage at import).
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
    const store = new Map<string, string>();
    const totalWith = (k: string, v: string) => {
        let total = k.length + v.length;
        for (const [ek, ev] of store) if (ek !== k) total += ek.length + ev.length;
        return total;
    };
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
            setItemCalls += 1;
            if (FORCE_ERROR) throw FORCE_ERROR;
            if (totalWith(k, String(v)) > BUDGET) {
                throw new DOMException('quota', 'QuotaExceededError');
            }
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

import {
    loadConversations,
    upsertConversation,
    deleteConversation,
    renameConversation,
    getConversation,
    getActiveId,
    setActiveId,
    deriveTitle,
    clearAllConversations,
    conversationNeedsWrite,
    type StoredConversation,
} from './chatHistory.ts';
import type { ChatMessage } from './stream/types.ts';

/** Mirrors the (unexported) key in chatHistory.ts — lets a test read raw. */
const CONV_KEY = 'thedaw:orb:conversations:v1';

function msg(id: string, role: 'user' | 'assistant', text: string): ChatMessage {
    return { id, role, text, timestamp: 1_700_000_000_000 };
}

function conv(id: string, firstUser: string, updatedAt: number): StoredConversation {
    return {
        id,
        title: deriveTitle([msg('u', 'user', firstUser)]),
        messages: [msg('u', 'user', firstUser), msg('a', 'assistant', 'ok')],
        provider: 'claude',
        model: 'claude-opus-4-6',
        claudeMode: 'interactive',
        sessionId: `sess-${id}`,
        claudeSessionId: `cli-${id}`,
        createdAt: updatedAt,
        updatedAt,
    };
}

/** What is physically in the store right now, bypassing loadConversations(). */
function rawStored(): unknown {
    const raw = localStorage.getItem(CONV_KEY);
    return raw === null ? [] : JSON.parse(raw);
}

localStorage.clear();

// deriveTitle: first user line, trimmed
assert.equal(deriveTitle([msg('1', 'user', 'Make a beat')]), 'Make a beat');
assert.equal(deriveTitle([]), 'New chat');
assert.ok(deriveTitle([msg('1', 'user', 'x'.repeat(80))]).endsWith('…'));
// A tool-only assistant turn has empty text; it must not become the title.
assert.equal(deriveTitle([msg('1', 'assistant', ''), msg('2', 'user', 'Real prompt')]), 'Real prompt');

// empty to start
assert.deepEqual(loadConversations(), []);

// upsert + load round-trip, newest first
upsertConversation(conv('a', 'first chat', 1000));
upsertConversation(conv('b', 'second chat', 2000));
let all = loadConversations();
assert.equal(all.length, 2);
assert.equal(all[0].id, 'b', 'newest updatedAt sorts first');
assert.equal(all[1].id, 'a');
assert.equal(all[0].sessionId, 'sess-b');
assert.equal(all[0].claudeSessionId, 'cli-b', 'the CLI resume id round-trips alongside the conversation id');
assert.equal(all[0].claudeMode, 'interactive', 'the Claude mode is restored with the chat that ran in it');

// timestamps are epoch millis on the wire and in memory — no Date revival
assert.equal(typeof all[0].messages[0].timestamp, 'number', 'timestamp stays a number');
assert.equal(all[0].messages[0].text, 'second chat');

// replace by id (not duplicate)
upsertConversation(conv('a', 'first chat edited', 3000));
all = loadConversations();
assert.equal(all.length, 2, 'upsert replaces same id, no dupe');
assert.equal(all[0].id, 'a', 'a is now newest');

// rename
renameConversation('a', 'Renamed');
assert.equal(getConversation('a')?.title, 'Renamed');

// active id
setActiveId('a');
assert.equal(getActiveId(), 'a');

// delete clears active if it was active
deleteConversation('a');
assert.equal(getConversation('a'), null);
assert.equal(getActiveId(), null, 'deleting the active convo clears activeId');
assert.equal(loadConversations().length, 1);

// clearAllConversations wipes every stored convo + the active pointer
upsertConversation(conv('c', 'third chat', 4000));
upsertConversation(conv('d', 'fourth chat', 5000));
setActiveId('d');
assert.equal(loadConversations().length, 3, 'b, c, d stored before clear');
clearAllConversations();
assert.deepEqual(loadConversations(), [], 'clear wipes all conversations');
assert.equal(getActiveId(), null, 'clear wipes the active id');

// --- deleting the ONLY conversation actually persists the empty list -------
localStorage.clear();
BUDGET = Infinity;
upsertConversation(conv('solo', 'only chat', 1000));
assert.equal(loadConversations().length, 1, 'one conversation stored');
const afterDelete = deleteConversation('solo');
assert.deepEqual(afterDelete, [], 'deleteConversation returns the empty list');
assert.deepEqual(loadConversations(), [], 'last delete is reflected on reload');
assert.deepEqual(rawStored(), [], 'last delete is persisted, not just returned');

// --- quota: trims oldest until the write fits -----------------------------
const pad = 'y'.repeat(200);
localStorage.clear();
BUDGET = Infinity;
upsertConversation(conv('q1', `one ${pad}`, 1000));
upsertConversation(conv('q2', `two ${pad}`, 2000));
upsertConversation(conv('q3', `thr ${pad}`, 3000));
const len3 = localStorage.getItem(CONV_KEY)!.length;
localStorage.clear();
upsertConversation(conv('q1', `one ${pad}`, 1000));
upsertConversation(conv('q2', `two ${pad}`, 2000));
const len2 = localStorage.getItem(CONV_KEY)!.length;
assert.ok(len3 > len2, 'three conversations serialize larger than two');
// A budget strictly between two and three conversations: the 3-item write
// throws, the trimmed 2-item write fits.
BUDGET = CONV_KEY.length + len2 + Math.floor((len3 - len2) / 2);
const trimmed = upsertConversation(conv('q3', `thr ${pad}`, 3000));
assert.deepEqual(
    trimmed.map((c) => c.id),
    ['q3', 'q2'],
    'quota trims the oldest and keeps the newest two',
);
assert.deepEqual(
    loadConversations().map((c) => c.id),
    ['q3', 'q2'],
    'the trimmed list is what actually persisted',
);

// --- quota: total failure returns the PRE-EXISTING stored list ------------
const huge = 'z'.repeat(50000);
const before = loadConversations().map((c) => c.id);
const failed = upsertConversation(conv('big', huge, 9000));
assert.deepEqual(
    failed.map((c) => c.id),
    before,
    'a write that cannot fit returns what storage holds, never the unsaved list',
);
assert.ok(!failed.some((c) => c.id === 'big'), 'the unsaved conversation is not reported as saved');
assert.deepEqual(
    loadConversations().map((c) => c.id),
    before,
    'storage is unchanged after a total write failure',
);

// --- non-quota error: warn once, no retry loop ----------------------------
BUDGET = Infinity;
FORCE_ERROR = new Error('storage disabled');
const warnings: unknown[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
    warnings.push(args[0]);
};
setItemCalls = 0;
const kept = loadConversations().map((c) => c.id);
const nonQuota = upsertConversation(conv('nq', 'nope', 9999));
console.warn = realWarn;
FORCE_ERROR = null;
assert.equal(setItemCalls, 1, 'a non-quota error is not retried');
assert.equal(warnings.length, 1, 'a non-quota error warns exactly once');
assert.deepEqual(
    nonQuota.map((c) => c.id),
    kept,
    'a non-quota failure returns the stored list, not the unsaved one',
);

// --- MAX_CONVERSATIONS cap keeps the newest -------------------------------
localStorage.clear();
BUDGET = Infinity;
for (let i = 1; i <= 105; i += 1) upsertConversation(conv(`m${i}`, `chat ${i}`, i * 1000));
const capped = loadConversations();
assert.equal(capped.length, 100, 'stored list is capped at MAX_CONVERSATIONS');
assert.equal(capped[0].id, 'm105', 'newest survives the cap');
assert.equal(capped[99].id, 'm6', 'the oldest five were trimmed');
assert.equal(getConversation('m1'), null, 'trimmed conversations are gone');

// --- garbage in the store never throws and never leaks -------------------
for (const garbage of ['not json', '{"a":1}', '[null]']) {
    localStorage.clear();
    localStorage.setItem(CONV_KEY, garbage);
    assert.deepEqual(loadConversations(), [], `garbage ${garbage} yields an empty list`);
}

// --- corrupt message fields revive to usable values ----------------------
localStorage.clear();
localStorage.setItem(
    CONV_KEY,
    JSON.stringify([
        {
            id: 'x',
            title: 'corrupt',
            messages: [
                { id: 'm', role: 'user', text: 42, timestamp: 'not-a-date' },
                null,
                { id: 'n', role: 'assistant', text: 'ok' },
                { id: 'o', role: 'wat', text: 'odd role' },
            ],
            provider: 'claude',
            model: 'claude-opus-4-6',
            claudeMode: 'interactive',
            sessionId: null,
            createdAt: 1,
            updatedAt: 1,
        },
    ]),
);
const revived = loadConversations()[0].messages;
assert.equal(revived.length, 3, 'null messages are dropped');
assert.equal(typeof revived[0].text, 'string', 'non-string text is coerced');
assert.equal(revived[0].text, '42');
assert.equal(typeof revived[0].timestamp, 'number');
assert.ok(Number.isFinite(revived[0].timestamp), 'an unparseable timestamp is not NaN');
assert.ok(Number.isFinite(revived[1].timestamp), 'a missing timestamp is not NaN');
assert.equal(revived[2].role, 'assistant', 'an unknown role falls back to assistant, never renders as the user');

// --- transcripts written by the OLD panel shape still load ---------------
// The pre-port panel stored `content` and an ISO-string Date. Those chats are
// on real machines right now; losing them on upgrade is not acceptable.
localStorage.clear();
localStorage.setItem(
    CONV_KEY,
    JSON.stringify([
        {
            id: 'legacy',
            title: 'legacy chat',
            messages: [
                { id: 'u', role: 'user', content: 'old prompt', timestamp: '2026-01-02T03:04:05.000Z' },
                { id: 'a', role: 'assistant', content: 'old reply', timestamp: '2026-01-02T03:04:06.000Z' },
            ],
            provider: 'claude',
            model: 'claude-opus-4-6',
            claudeMode: 'interactive',
            sessionId: 'sess-legacy',
            createdAt: 1,
            updatedAt: 1,
        },
    ]),
);
const legacy = loadConversations()[0].messages;
assert.equal(legacy.length, 2);
assert.equal(legacy[0].text, 'old prompt', 'legacy `content` migrates to `text`');
assert.equal(legacy[1].text, 'old reply');
assert.equal(legacy[0].timestamp, Date.parse('2026-01-02T03:04:05.000Z'), 'an ISO timestamp becomes epoch millis');

// --- tool calls and turn meta survive a round-trip ------------------------
// A tool-only turn is ALL tools and no prose. If toolCalls/meta were dropped
// on persist, reloading would show a blank row with nothing in it.
localStorage.clear();
BUDGET = Infinity;
const toolTurn: ChatMessage = {
    id: 't',
    role: 'assistant',
    text: '',
    thinking: 'considering',
    toolCalls: [{ toolId: 'tc1', name: 'Read', inputJson: '{"file_path":"a.ts"}', status: 'success', result: 'ok' }],
    meta: { inTokens: 10, outTokens: 3, costUsd: 0.01, durationMs: 1234 },
    pendingActions: [{ type: 'generate', payload: {}, callId: 'dead-call', description: 'Generate audio' }],
    timestamp: 1_700_000_000_000,
};
upsertConversation({ ...conv('tools', 'run a tool', 7000), messages: [msg('u', 'user', 'run a tool'), toolTurn] });
const storedTurn = getConversation('tools')!.messages[1];
assert.equal(storedTurn.text, '');
assert.equal(storedTurn.thinking, 'considering');
assert.equal(storedTurn.toolCalls?.length, 1, 'tool calls persist');
assert.equal(storedTurn.toolCalls?.[0].name, 'Read');
assert.equal(storedTurn.meta?.inTokens, 10, 'turn meta persists');
assert.equal(storedTurn.toolCalls?.[0].status, 'success', 'a finished tool keeps its status');

// --- a tool still 'executing' when the tab closed never finishes -----------
// Nothing will ever deliver its tool_result, so restoring it as 'executing'
// leaves a spinner turning forever in a transcript that is not streaming.
localStorage.clear();
BUDGET = Infinity;
upsertConversation({
    ...conv('interrupted', 'run a tool', 8000),
    messages: [
        msg('u', 'user', 'run a tool'),
        {
            id: 'a',
            role: 'assistant',
            text: '',
            toolCalls: [
                { toolId: 'live', name: 'Bash', inputJson: '{}', status: 'executing' },
                {
                    toolId: 'agent',
                    name: 'Task',
                    inputJson: '{}',
                    status: 'executing',
                    subCalls: [{ toolId: 'sub', name: 'Read', inputJson: '{}', status: 'executing' }],
                },
            ],
            timestamp: 1_700_000_000_000,
        },
    ],
});
const interrupted = getConversation('interrupted')!.messages[1].toolCalls!;
assert.equal(interrupted[0].status, 'error', 'an unfinished tool revives as an error, not a live spinner');
assert.equal(interrupted[0].isError, true);
assert.equal(interrupted[0].result, 'Interrupted before completion');
assert.equal(interrupted[1].status, 'error', 'the same holds for a sub-agent card');
assert.equal(interrupted[1].subCalls?.[0].status, 'error', 'and for its nested calls');
assert.equal(interrupted[1].subCalls?.[0].result, 'Interrupted before completion');
assert.equal(
    storedTurn.pendingActions,
    undefined,
    'a parked T2 action is NOT persisted — its relay callId is dead after a reload',
);

// --- conversationNeedsWrite: the no-op guard -----------------------------
const base = conv('guard', 'hello', 1000);
assert.equal(conversationNeedsWrite(null, []), false, 'an empty transcript is never written');
assert.equal(conversationNeedsWrite(base, []), false);
assert.equal(conversationNeedsWrite(null, base.messages), true, 'a brand new conversation is written');
assert.equal(conversationNeedsWrite(base, base.messages), false, 'an identical snapshot is a no-op');
assert.equal(
    conversationNeedsWrite(base, [...base.messages, msg('c', 'user', 'more')]),
    true,
    'an appended message is written',
);
assert.equal(
    conversationNeedsWrite(base, [base.messages[0], { ...base.messages[1], text: 'changed' }]),
    true,
    'edited text on the last message is written',
);
assert.equal(
    conversationNeedsWrite(base, [base.messages[0], { ...base.messages[1], isError: true }]),
    true,
    'the error flag turning on is written',
);
// Text is not the whole message any more: a tool-only turn holds its content
// in toolCalls/meta, so comparing prose alone would call it unchanged.
assert.equal(
    conversationNeedsWrite(base, [
        base.messages[0],
        { ...base.messages[1], toolCalls: [{ toolId: 'x', name: 'Read', inputJson: '{}', status: 'success' }] },
    ]),
    true,
    'tool activity added to the last turn is written',
);
assert.equal(
    conversationNeedsWrite(base, [base.messages[0], { ...base.messages[1], meta: { inTokens: 1 } }]),
    true,
    'turn meta arriving is written',
);

localStorage.clear();
BUDGET = Infinity;

console.log('chatHistory: all assertions passed');
