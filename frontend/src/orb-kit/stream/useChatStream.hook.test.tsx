/**
 * Hook-level test for useChatStream: drives the REAL hook through a stubbed
 * `fetch` and counts every POST it makes.
 *
 * No new dependency: jsdom is already a devDependency and react-dom a runtime
 * one. react-dom/client is imported dynamically AFTER the jsdom globals exist,
 * because it decides at module load whether a DOM is available.
 *
 * What it pins down (audit V3-4):
 *   - answerControl dismisses on the turn ref: an answered card does not come
 *     back on a later frame, and is answered exactly once;
 *   - a double Run (and double Skip, and Run-then-Skip) posts the relay result
 *     exactly once;
 *   - the error path and the abort path decline each parked action exactly once
 *     and deny each pending control exactly once (audit V3-3).
 */

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { useChatStream } from './useChatStream.ts';
import type { UseChatStreamApi } from './useChatStream.ts';
import { DECLINED_RESULT, TURN_ENDED_DENIAL } from './pendingActions.ts';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

// ---------------------------------------------------------------------------
// fetch stub: the chat endpoint streams whatever the test pushes; every other
// endpoint is recorded and answered 200.
// ---------------------------------------------------------------------------

interface Post {
    url: string;
    body: Record<string, unknown>;
}

const posts: Post[] = [];
let chatController: ReadableStreamDefaultController<Uint8Array> | null = null;
const encoder = new TextEncoder();

g.fetch = async (input: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const url = String(input);
    if (url === '/api/assistant/chat') {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                chatController = controller;
            },
        });
        // Honour the abort signal the way a real fetch body does.
        init?.signal?.addEventListener('abort', () => {
            chatController?.error(new DOMException('The operation was aborted.', 'AbortError'));
        });
        return new Response(stream, { status: 200 });
    }
    posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response('{}', { status: 200 });
};

function push(frame: Record<string, unknown>) {
    assert.ok(chatController, 'no chat stream is open');
    chatController.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
}

/** Let the read loop, React state and any fire-and-forget POSTs settle. */
async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

function postsTo(path: string): Post[] {
    return posts.filter((p) => p.url === path);
}

function relayPostsFor(callId: string): Post[] {
    return postsTo('/api/mcp-relay/result').filter((p) => p.body.callId === callId);
}

function controlPostsFor(requestId: string): Post[] {
    return postsTo('/api/assistant/control-response').filter((p) => p.body.requestId === requestId);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const executed: string[] = [];
let api: UseChatStreamApi | null = null;

function Harness() {
    api = useChatStream({
        getTurnContext: () => ({ provider: 'claude', model: 'test-model', conversationId: 'conv-1' }),
        executeAction: (action) => {
            executed.push(action.type);
            return `ran ${action.type}`;
        },
    });
    return null;
}

function hook(): UseChatStreamApi {
    assert.ok(api, 'hook not mounted');
    return api;
}

const root = createRoot(dom.window.document.getElementById('root') as unknown as Element);
await act(async () => {
    root.render(<Harness />);
});

/**
 * Open a turn and wait until its stream is live.
 *
 * The turn's promise is returned WRAPPED: an async function that returns a
 * promise adopts it, so returning `send()` directly would make `await
 * openTurn()` wait for the whole turn — which cannot end until the test pushes
 * `done`. Deadlock.
 */
async function openTurn(prompt: string): Promise<{ finished: Promise<void> }> {
    chatController = null;
    let finished: Promise<void> = Promise.resolve();
    await act(async () => {
        finished = hook().send(prompt);
    });
    await settle();
    assert.ok(chatController, 'turn did not open a stream');
    return { finished };
}

// ---------------------------------------------------------------------------
// 1. answerControl dismisses on the turn ref — no resurrection, one answer
// ---------------------------------------------------------------------------

{
    const turn = await openTurn('run ls');
    push({ type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    await settle();
    assert.equal(hook().pendingControls.length, 1);

    await act(async () => {
        await hook().answerControl('r1', { behavior: 'allow', updatedInput: {} }, 'once');
    });
    assert.equal(hook().pendingControls.length, 0);

    // A later frame republishes the turn. The answered card must stay gone.
    push({ type: 'text_delta', text: 'listing…' });
    await settle();
    assert.equal(hook().pendingControls.length, 0, 'answered control resurrected on a later frame');
    assert.equal(hook().liveText, 'listing…');

    push({ type: 'done', usage: {} });
    await act(async () => {
        await turn.finished;
    });
    await settle();

    assert.equal(controlPostsFor('r1').length, 1, 'answered exactly once');
    assert.deepEqual(controlPostsFor('r1')[0].body.response, { behavior: 'allow', updatedInput: {} });
    // A normal `done` must not also send a teardown denial for it.
    assert.equal(
        controlPostsFor('r1').filter((p) => (p.body.response as { behavior?: string }).behavior === 'deny').length,
        0,
    );
}

// ---------------------------------------------------------------------------
// 2. double clicks on a parked T2 action post the relay result exactly once
// ---------------------------------------------------------------------------

{
    const turn = await openTurn('make and stop');
    push({ type: 'client_tool_call', callId: 'run1', name: 'generate', args: {}, sessionId: 'relay-9' });
    push({ type: 'client_tool_call', callId: 'skip1', name: 'abort', args: {}, sessionId: 'relay-9' });
    push({ type: 'client_tool_call', callId: 'mixed1', name: 'editor_remove_track', args: {}, sessionId: 'relay-9' });
    await settle();
    assert.equal(hook().livePendingActions.length, 3, 'all three are parked on the live turn');

    // Double Run: both clicks land before either POST resolves.
    await act(async () => {
        await Promise.all([hook().runPendingAction(null, 'run1'), hook().runPendingAction(null, 'run1')]);
    });
    // Double Skip.
    await act(async () => {
        await Promise.all([hook().skipPendingAction(null, 'skip1'), hook().skipPendingAction(null, 'skip1')]);
    });
    // Run then Skip on the same card.
    await act(async () => {
        await Promise.all([hook().runPendingAction(null, 'mixed1'), hook().skipPendingAction(null, 'mixed1')]);
    });
    await settle();

    assert.equal(relayPostsFor('run1').length, 1, 'double Run posted twice');
    assert.equal(relayPostsFor('run1')[0].body.isError, false);
    assert.equal(relayPostsFor('run1')[0].body.sessionId, 'relay-9');
    assert.deepEqual(executed, ['generate', 'editor_remove_track'], 'each action executed once');

    assert.equal(relayPostsFor('skip1').length, 1, 'double Skip posted twice');
    assert.equal(relayPostsFor('skip1')[0].body.result, DECLINED_RESULT);

    assert.equal(relayPostsFor('mixed1').length, 1, 'Run then Skip answered the relay twice');
    assert.equal(relayPostsFor('mixed1')[0].body.isError, false, 'the first answer (Run) wins');
    assert.equal(hook().livePendingActions.length, 0);

    push({ type: 'done', usage: {} });
    await act(async () => {
        await turn.finished;
    });
    await settle();
    // Nothing answered above may be re-parked onto the finalized message.
    assert.equal(hook().messages.some((m) => (m.pendingActions?.length ?? 0) > 0), false);
}

// ---------------------------------------------------------------------------
// 3. error path — each parked action declined once, each control denied once
// ---------------------------------------------------------------------------

{
    const before = posts.length;
    const turn = await openTurn('this will fail');
    push({ type: 'client_tool_call', callId: 'e1', name: 'generate', args: {}, sessionId: 'relay-e' });
    push({ type: 'client_tool_call', callId: 'e2', name: 'abort', args: {} });
    push({ type: 'control_request', requestId: 'er1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    push({ type: 'control_request', requestId: 'er2', request: { subtype: 'can_use_tool', tool_name: 'Write' } });
    await settle();
    // The hook logs the failure; capture it so the run stays quiet and the log
    // itself is asserted instead of ignored.
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
        logged.push(args);
    };
    try {
        push({ type: 'error', message: 'child exited' });
        await act(async () => {
            await turn.finished;
        });
        await settle();
    } finally {
        console.error = realError;
    }
    assert.equal(logged.length, 1, 'the failure is logged exactly once');
    assert.match(String(logged[0][1]), /child exited/);

    const teardown = posts.slice(before);
    assert.equal(teardown.length, 4, `expected exactly 4 teardown POSTs, got ${teardown.length}`);

    assert.equal(relayPostsFor('e1').length, 1);
    assert.deepEqual(relayPostsFor('e1')[0].body, {
        sessionId: 'relay-e',
        callId: 'e1',
        result: DECLINED_RESULT,
        isError: true,
    });
    assert.equal(relayPostsFor('e2').length, 1);
    assert.equal(relayPostsFor('e2')[0].body.result, DECLINED_RESULT);

    for (const requestId of ['er1', 'er2']) {
        assert.equal(controlPostsFor(requestId).length, 1, `${requestId} denied ${controlPostsFor(requestId).length}×`);
        assert.deepEqual(controlPostsFor(requestId)[0].body, {
            conversationId: 'conv-1',
            requestId,
            response: { behavior: 'deny', message: TURN_ENDED_DENIAL },
            scope: 'once',
        });
    }

    assert.equal(hook().pendingControls.length, 0);
    assert.equal(hook().livePendingActions.length, 0);
    assert.equal(hook().isStreaming, false);
    const last = hook().messages[hook().messages.length - 1];
    assert.equal(last.isError, true);
    assert.equal(last.pendingActions, undefined, 'declined actions are not carried onto the error row');
}

// ---------------------------------------------------------------------------
// 4. abort path (Stop) — same teardown, same exactly-once guarantee
// ---------------------------------------------------------------------------

{
    const before = posts.length;
    const turn = await openTurn('stop me');
    push({ type: 'client_tool_call', callId: 'x1', name: 'generate', args: {} });
    push({ type: 'control_request', requestId: 'xr1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    push({ type: 'text_delta', text: 'half' });
    await settle();

    await act(async () => {
        hook().stop();
        await turn.finished;
    });
    await settle();

    const teardown = posts.slice(before);
    assert.equal(teardown.length, 2, `expected exactly 2 teardown POSTs, got ${teardown.length}`);
    assert.equal(relayPostsFor('x1').length, 1);
    assert.equal(relayPostsFor('x1')[0].body.result, DECLINED_RESULT);
    assert.equal(controlPostsFor('xr1').length, 1);
    assert.deepEqual(controlPostsFor('xr1')[0].body.response, { behavior: 'deny', message: TURN_ENDED_DENIAL });

    const last = hook().messages[hook().messages.length - 1];
    assert.match(last.text, /interrupted/);
    assert.equal(last.pendingActions, undefined, 'a declined action must not offer Run on the interrupted row');
}

// ---------------------------------------------------------------------------
// An approval is answered under the REQUEST's own conversation id
//
// The backend runs a turn on the session it resolved, which is not always keyed
// by the id the host holds (a request can reach a live session through its
// Claude session id). The permission frame carries the session's own key; the
// answer has to go back under it. Before this, an approved `mcp__thedaw__navigate`
// was refused by the route (422 for a null id, 404 for a stale one) and the CLI
// stayed blocked until its auto-deny — "stuck even after I approved it".
// ---------------------------------------------------------------------------

{
    const turn = await openTurn('take me to the edit tab');
    push({ type: 'session_id', sessionId: 'cli-session-9' });
    push({
        type: 'control_request',
        requestId: 'nav1',
        conversationId: 'canonical-conv',
        request: { subtype: 'can_use_tool', tool_name: 'mcp__thedaw__navigate', input: { tab: 'edit' } },
    });
    await settle();
    assert.equal(hook().pendingControls[0]?.conversationId, 'canonical-conv');

    await act(async () => {
        await hook().answerControl('nav1', { behavior: 'allow', updatedInput: { tab: 'edit' } }, 'once');
    });
    const answer = controlPostsFor('nav1')[0];
    assert.equal(answer.body.conversationId, 'canonical-conv', 'answered under the request’s own session key');
    assert.equal(answer.body.claudeSessionId, 'cli-session-9', 'the CLI session id rides along as a fallback key');

    await act(async () => {
        await hook().interrupt();
    });
    const stop = postsTo('/api/assistant/interrupt').at(-1);
    assert.ok(stop, 'Stop reached the backend');
    assert.equal(typeof stop.body.conversationId, 'string', 'Stop never sends a null conversation id');
    assert.equal(stop.body.claudeSessionId, 'cli-session-9');

    push({ type: 'done', usage: {} });
    await act(async () => {
        await turn.finished;
    });
    await settle();
}

await act(async () => {
    root.unmount();
});

console.log('useChatStream hook regression passed');
