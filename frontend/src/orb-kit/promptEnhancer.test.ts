import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Storage shims. `enhanceStableAudioPrompt` reads the provider from
// localStorage, keeps its own conversation ids in sessionStorage, and reaches
// the zustand `persist` permission store — which reads localStorage the moment
// it is created. So both exist BEFORE the modules are imported.
// ---------------------------------------------------------------------------
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
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
const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
if (typeof g.localStorage === 'undefined') g.localStorage = memoryStorage();
if (typeof g.sessionStorage === 'undefined') g.sessionStorage = memoryStorage();

const {
  buildPromptEnhancementRequest,
  extractEnhancedPrompt,
  enhanceStableAudioPrompt,
  CONVERSATION_ID_KEY,
  CLAUDE_SESSION_ID_KEY,
  ENHANCE_CONVERSATION_ID_KEY,
  ENHANCE_CLAUDE_SESSION_ID_KEY,
  ENHANCER_TOOL_DECLINED,
  ENHANCER_PERMISSION_DENIED,
} = await import('./promptEnhancer.ts');
// Same specifier promptEnhancer.ts uses, so both share one store instance.
const { useAssistantPermissionStore } = await import('./permission/assistantPermissionStore');

// ---------------------------------------------------------------------------
// Prompt building / extraction (unchanged behaviour)
// ---------------------------------------------------------------------------

const positiveRequest = buildPromptEnhancementRequest({
  target: 'positive',
  positivePrompt: 'dark drums',
  negativePrompt: 'vocals, harsh noise',
});

assert.match(positiveRequest, /Enhance ONLY the positive prompt/);
assert.match(positiveRequest, /dark drums/);
assert.match(positiveRequest, /vocals, harsh noise/);
assert.match(positiveRequest, /docs\/guides\/prompting\.md/);
assert.match(positiveRequest, /<enhanced_prompt>/);

const negativeRequest = buildPromptEnhancementRequest({
  target: 'negative',
  positivePrompt: 'cinematic ambient pad',
  negativePrompt: '',
});

assert.match(negativeRequest, /Enhance ONLY the negative prompt/);
assert.match(negativeRequest, /cinematic ambient pad/);

assert.equal(
  extractEnhancedPrompt('Here you go. <enhanced_prompt>cinematic industrial drums, tight low-end punch</enhanced_prompt>'),
  'cinematic industrial drums, tight low-end punch',
);

assert.equal(
  extractEnhancedPrompt('{"enhanced_prompt":"muddy low end, clipping, harsh cymbals"}'),
  'muddy low end, clipping, harsh cymbals',
);

assert.equal(
  extractEnhancedPrompt('```\nwide analog pad, slow harmonic motion\n```'),
  'wide analog pad, slow harmonic motion',
);

// ---------------------------------------------------------------------------
// The stream. A fake backend: `/api/assistant/chat` answers with the SSE frames
// the test hands it; every request (chat and relay POSTs) is recorded.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}
let calls: RecordedCall[] = [];
let nextFrames: unknown[] = [];

/** Serialize frames as SSE and split them across TWO reads at an awkward
 *  offset, so a frame straddling a chunk boundary is exercised every time. */
function sseResponse(frames: unknown[]): Response {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + ': ping 1\n\n';
  const cut = Math.floor(text.length / 2) + 3;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, cut)));
      controller.enqueue(encoder.encode(text.slice(cut)));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  if (url === '/api/assistant/chat') return sseResponse(nextFrames);
  return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const REQUEST = { target: 'positive' as const, positivePrompt: 'pads', negativePrompt: '' };

function chatCalls(): RecordedCall[] {
  return calls.filter((c) => c.url === '/api/assistant/chat');
}
function relayCalls(): RecordedCall[] {
  return calls.filter((c) => c.url === '/api/mcp-relay/result');
}
function controlCalls(): RecordedCall[] {
  return calls.filter((c) => c.url === '/api/assistant/control-response');
}
function reset(provider: string, model: string): void {
  calls = [];
  nextFrames = [];
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('thedaw:provider', provider);
  localStorage.setItem('thedaw:model', model);
}

// --- V3-1: C1-shaped frames (the Claude backend today) --------------------
// `{type:"text_delta", text}`, `{type:"session_id", sessionId}`. The enhancer
// used to read only `event.delta`, so on the default provider EVERY
// enhancement ended in "empty prompt".
reset('claude', 'claude-opus-4-6');
nextFrames = [
  { type: 'conversationId', conversationId: 'ignored-because-we-sent-one' },
  { type: 'session_id', sessionId: 'cli-c1' },
  { type: 'status', message: 'Thinking' },
  { type: 'text_delta', text: '<enhanced_prompt>warm analog ' },
  { type: 'text_delta', text: 'pads, slow swell</enhanced_prompt>' },
  { type: 'done', usage: { input_tokens: 1, output_tokens: 1 }, isError: false },
];
assert.equal(
  await enhanceStableAudioPrompt(REQUEST),
  'warm analog pads, slow swell',
  'C1 text_delta frames carry `text` — the enhancer must read it',
);
assert.equal(
  sessionStorage.getItem(ENHANCE_CLAUDE_SESSION_ID_KEY),
  'cli-c1',
  'a C1 session_id frame (`sessionId`) is remembered for the enhancer',
);

// C1 error frame: `{type:"error", message}`.
reset('claude', 'claude-opus-4-6');
nextFrames = [{ type: 'error', message: 'CLI exited: rate limited' }];
await assert.rejects(
  enhanceStableAudioPrompt(REQUEST),
  /CLI exited: rate limited/,
  'a C1 error frame surfaces its `message`, not a generic failure',
);

// --- V3-1: legacy frames still work (non-Claude providers) ----------------
reset('gemini', 'gemini-flash-recent');
nextFrames = [
  { type: 'text_delta', delta: '<enhanced_prompt>legacy ' },
  { type: 'text_delta', delta: 'drums</enhanced_prompt>' },
];
assert.equal(await enhanceStableAudioPrompt(REQUEST), 'legacy drums', 'legacy `delta` frames still accumulate');

reset('gemini', 'gemini-flash-recent');
nextFrames = [{ type: 'error', error: 'legacy failure' }];
await assert.rejects(enhanceStableAudioPrompt(REQUEST), /legacy failure/, 'legacy `error` field still surfaces');

// A C1 `text` alias frame (the reducer accepts it too).
reset('gemini', 'gemini-flash-recent');
nextFrames = [{ type: 'text', text: '<enhanced_prompt>alias text</enhanced_prompt>' }];
assert.equal(await enhanceStableAudioPrompt(REQUEST), 'alias text');

// Nothing usable at all is still a clear error, not a blank prompt.
reset('gemini', 'gemini-flash-recent');
nextFrames = [{ type: 'done', usage: {} }];
await assert.rejects(enhanceStableAudioPrompt(REQUEST), /empty prompt/);

// --- V3-2: the request body ------------------------------------------------
reset('claude', 'claude-opus-4-6');
// The panel's live Claude conversation. The enhancer must never ride it.
sessionStorage.setItem(CONVERSATION_ID_KEY, 'panel-conv');
sessionStorage.setItem(CLAUDE_SESSION_ID_KEY, 'panel-cli');
useAssistantPermissionStore.getState().setMode('accept_edits');
nextFrames = [
  { type: 'session_id', sessionId: 'cli-enh-1' },
  { type: 'text_delta', text: '<enhanced_prompt>one</enhanced_prompt>' },
  { type: 'done', usage: {} },
];
await enhanceStableAudioPrompt(REQUEST);
const first = chatCalls()[0].body;
assert.equal(
  first.claude_permission_mode,
  'accept_edits',
  'the enhancement turn carries the user’s mode, so it cannot reset the session to "ask"',
);
assert.equal(typeof first.conversationId, 'string');
assert.notEqual(first.conversationId, 'panel-conv', 'never the panel’s conversation');
assert.match(String(first.conversationId), /^enhance-/, 'a conversation id of its own, recognisably the enhancer’s');
assert.equal(
  sessionStorage.getItem(ENHANCE_CONVERSATION_ID_KEY),
  first.conversationId,
  'the enhancer’s conversation id is kept under its own key',
);
assert.notEqual(first.claudeSessionId, 'panel-cli', 'never resumes the panel’s CLI session');
assert.ok(!('claudeMode' in first), 'the dead `claudeMode` field is no longer sent (the backend ignores it)');
assert.deepEqual(
  Object.keys(first).sort(),
  ['claude_permission_mode', 'conversationId', 'messages', 'model', 'provider'],
  'the Claude request is otherwise exactly the documented body (no CLI id yet on a first turn)',
);
assert.equal(sessionStorage.getItem(CONVERSATION_ID_KEY), 'panel-conv', 'the panel’s conversation key is untouched');
assert.equal(
  sessionStorage.getItem(CLAUDE_SESSION_ID_KEY),
  'panel-cli',
  'the enhancer’s CLI session id does NOT leak into the panel’s resume slot',
);

// Second enhancement in the same tab: same enhancer conversation, and it
// resumes the enhancer's own CLI session.
calls = [];
nextFrames = [{ type: 'text_delta', text: '<enhanced_prompt>two</enhanced_prompt>' }];
await enhanceStableAudioPrompt(REQUEST);
const second = chatCalls()[0].body;
assert.equal(second.conversationId, first.conversationId, 'one enhancer conversation per tab, reused');
assert.equal(second.claudeSessionId, 'cli-enh-1', 'resumes the enhancer’s own CLI session');
useAssistantPermissionStore.getState().setMode('ask');

// Non-Claude providers get none of the Claude-only fields.
reset('gemini', 'gemini-flash-recent');
nextFrames = [{ type: 'text_delta', delta: '<enhanced_prompt>g</enhanced_prompt>' }];
await enhanceStableAudioPrompt(REQUEST);
const gemini = chatCalls()[0].body;
assert.equal(gemini.claude_permission_mode, undefined);
assert.equal(gemini.conversationId, undefined);
assert.equal(gemini.claudeSessionId, undefined);

// --- V3-2: client_tool_call is declined, never left hanging ----------------
// The CLI is BLOCKED on a relay call until a result is POSTed. The enhancer
// has no DAW dispatcher, so it must answer at once with an error.
reset('claude', 'claude-opus-4-6');
nextFrames = [
  { type: 'session_id', sessionId: 'cli-real' },
  { type: 'client_tool_call', callId: 'call-7', name: 'generate', args: { prompt: 'x' }, sessionId: 'relay-9' },
  { type: 'text_delta', text: '<enhanced_prompt>after decline</enhanced_prompt>' },
  { type: 'done', usage: {} },
];
assert.equal(await enhanceStableAudioPrompt(REQUEST), 'after decline', 'the turn still completes');
const declines = relayCalls();
assert.equal(declines.length, 1, 'exactly one relay answer for one tool call');
assert.deepEqual(declines[0].body, {
  sessionId: 'relay-9',
  callId: 'call-7',
  result: ENHANCER_TOOL_DECLINED,
  isError: true,
});
assert.equal(ENHANCER_TOOL_DECLINED, 'Prompt enhancer cannot run DAW tools');
assert.equal(
  sessionStorage.getItem(ENHANCE_CLAUDE_SESSION_ID_KEY),
  'cli-real',
  'the relay key on a client_tool_call is NOT mistaken for the CLI session id',
);

// A relay frame without its own sessionId falls back to the enhancer's
// conversation id rather than posting an empty key.
reset('claude', 'claude-opus-4-6');
nextFrames = [
  { type: 'client_tool_call', callId: 'call-8', name: 'navigate', args: {} },
  { type: 'text_delta', text: '<enhanced_prompt>ok</enhanced_prompt>' },
];
await enhanceStableAudioPrompt(REQUEST);
assert.equal(relayCalls()[0].body.sessionId, sessionStorage.getItem(ENHANCE_CONVERSATION_ID_KEY));
assert.equal(relayCalls()[0].body.callId, 'call-8');

// --- control_request is denied at once, never left for the 180s auto-deny ---
// A permission prompt BLOCKS the CLI until it is answered. The enhancer has
// no permission card to show, so it answers "deny" itself — on ITS OWN
// conversation, never the panel's.
reset('claude', 'claude-opus-4-6');
sessionStorage.setItem(CONVERSATION_ID_KEY, 'panel-conv');
sessionStorage.setItem(CLAUDE_SESSION_ID_KEY, 'panel-cli');
nextFrames = [
  {
    type: 'control_request',
    requestId: 'req-42',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
    policy: { kind: 'shell', selfModify: false, selfModifyPath: null, backendRestart: false, decision: 'ask' },
  },
  { type: 'text_delta', text: '<enhanced_prompt>from memory</enhanced_prompt>' },
  { type: 'done', usage: {} },
];
assert.equal(await enhanceStableAudioPrompt(REQUEST), 'from memory', 'the turn still completes after the deny');
const denies = controlCalls();
assert.equal(denies.length, 1, 'exactly one deny POST per control_request');
const enhancerConversation = sessionStorage.getItem(ENHANCE_CONVERSATION_ID_KEY);
assert.deepEqual(denies[0].body, {
  conversationId: enhancerConversation,
  requestId: 'req-42',
  response: { behavior: 'deny', message: ENHANCER_PERMISSION_DENIED },
  scope: 'once',
});
assert.equal(ENHANCER_PERMISSION_DENIED, 'Prompt enhancer cannot use tools — answer from your own knowledge');
assert.notEqual(denies[0].body.conversationId, 'panel-conv', 'never answers on the panel’s conversation');
assert.ok(
  !JSON.stringify(calls).includes('panel-conv') && !JSON.stringify(calls).includes('panel-cli'),
  'neither of the panel’s ids appears in ANY request the enhancer makes',
);
assert.equal(relayCalls().length, 0, 'a permission prompt is not mistaken for a relay tool call');

// Two prompts in one turn: two denies, each with its own requestId.
reset('claude', 'claude-opus-4-6');
nextFrames = [
  { type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Edit' } },
  { type: 'control_request', requestId: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Write' } },
  { type: 'text_delta', text: '<enhanced_prompt>two denies</enhanced_prompt>' },
];
assert.equal(await enhanceStableAudioPrompt(REQUEST), 'two denies');
assert.deepEqual(controlCalls().map((c) => c.body.requestId), ['r1', 'r2']);

// A control_request with no requestId has nothing to answer — no POST.
reset('claude', 'claude-opus-4-6');
nextFrames = [
  { type: 'control_request', request: { subtype: 'can_use_tool' } },
  { type: 'text_delta', text: '<enhanced_prompt>noop</enhanced_prompt>' },
];
await enhanceStableAudioPrompt(REQUEST);
assert.equal(controlCalls().length, 0);

console.log('promptEnhancer regression passed');
