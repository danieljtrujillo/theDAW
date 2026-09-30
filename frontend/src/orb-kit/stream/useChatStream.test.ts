import assert from 'node:assert/strict';

import {
    createTurnState,
    reduceFrame,
    finalizeTurn,
    dismissControl,
    dismissPendingAction,
    clearPendingActions,
    clearPendingControls,
    CONTROL_TIMEOUT_MS,
} from './frameReducer.ts';
import type { StreamEffect, TurnState } from './frameReducer.ts';
import {
    declineTargets,
    findPendingAction,
    removePendingActionFromMessages,
    teardownPosts,
    DECLINED_RESULT,
    TURN_ENDED_DENIAL,
} from './pendingActions.ts';
import { buildConversationHistory, parseSseLine } from './useChatStream.ts';
import type { ChatMessage } from './types.ts';

const NOW = 1_700_000_000_000;

/** Fold a list of frames through the reducer, collecting every effect. */
function run(frames: unknown[], seed?: Partial<TurnState>, now = NOW): { state: TurnState; effects: StreamEffect[] } {
    let state = createTurnState(seed);
    const effects: StreamEffect[] = [];
    for (const frame of frames) {
        const next = reduceFrame(state, frame, { now });
        state = next.state;
        effects.push(...next.effects);
    }
    return { state, effects };
}

// ---------------------------------------------------------------------------
// text / thinking accumulation
// ---------------------------------------------------------------------------

{
    const { state } = run([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'thinking', text: 'hmm' },
        { type: 'thinking', text: '...' },
    ]);
    assert.equal(state.text, 'Hello world');
    assert.equal(state.thinking, 'hmm...');
}

// Legacy aliases the backend still emits: {type:"text", delta} must accumulate too.
{
    const { state } = run([{ type: 'text', delta: 'legacy' }]);
    assert.equal(state.text, 'legacy');
}

// ---------------------------------------------------------------------------
// status is transient state ONLY — it must never become a message row
// ---------------------------------------------------------------------------

{
    const { state } = run([
        { type: 'status', message: 'Booting Claude...' },
        { type: 'status', message: 'Thinking' },
    ]);
    assert.equal(state.statusText, 'Thinking');
    assert.equal(state.text, '');
    assert.equal(state.toolCalls.length, 0);
}

// ---------------------------------------------------------------------------
// tool_use / tool_result pairing on toolId
// ---------------------------------------------------------------------------

{
    const { state } = run([
        { type: 'tool_use', toolId: 't1', name: 'Read', inputJson: '{"file_path":"a.ts"}' },
        { type: 'tool_result', toolId: 't1', content: 'file body' },
    ]);
    assert.equal(state.toolCalls.length, 1);
    assert.equal(state.toolCalls[0].name, 'Read');
    assert.equal(state.toolCalls[0].inputJson, '{"file_path":"a.ts"}');
    assert.equal(state.toolCalls[0].result, 'file body');
    assert.equal(state.toolCalls[0].isError, false);
    assert.equal(state.toolCalls[0].status, 'success');
}

{
    const { state } = run([
        { type: 'tool_use', toolId: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', toolId: 't1', content: 'boom', isError: true },
    ]);
    assert.equal(state.toolCalls[0].inputJson, '{"command":"ls"}');
    assert.equal(state.toolCalls[0].status, 'error');
    assert.equal(state.toolCalls[0].isError, true);
}

// An unpaired tool stays "executing" so the row can keep its spinner.
{
    const { state } = run([{ type: 'tool_use', toolId: 't1', name: 'Grep', inputJson: '{}' }]);
    assert.equal(state.toolCalls[0].status, 'executing');
}

// Re-emitted tool_use for the same toolId must not duplicate the row.
{
    const { state } = run([
        { type: 'tool_use', toolId: 't1', name: 'Read', inputJson: '{}' },
        { type: 'tool_use', toolId: 't1', name: 'Read', inputJson: '{}' },
    ]);
    assert.equal(state.toolCalls.length, 1);
}

// ---------------------------------------------------------------------------
// sub-agent nesting via parentToolId
// ---------------------------------------------------------------------------

{
    const { state } = run([
        { type: 'tool_use', toolId: 'task1', name: 'Task', inputJson: '{"subagent_type":"scout"}' },
        { type: 'tool_use', toolId: 'sub1', name: 'Read', inputJson: '{}', parentToolId: 'task1' },
        { type: 'tool_result', toolId: 'sub1', content: 'ok', parentToolId: 'task1' },
        { type: 'tool_result', toolId: 'task1', content: 'done' },
    ]);
    assert.equal(state.toolCalls.length, 1, 'sub-agent tools must not land on the main list');
    assert.equal(state.toolCalls[0].toolId, 'task1');
    assert.equal(state.toolCalls[0].subCalls?.length, 1);
    assert.equal(state.toolCalls[0].subCalls?.[0].toolId, 'sub1');
    assert.equal(state.toolCalls[0].subCalls?.[0].status, 'success');
    assert.equal(state.toolCalls[0].result, 'done');
}

// A parentToolId we never saw falls back to the top level rather than vanishing.
{
    const { state } = run([
        { type: 'tool_use', toolId: 'orphan', name: 'Read', inputJson: '{}', parentToolId: 'nope' },
    ]);
    assert.equal(state.toolCalls.length, 1);
    assert.equal(state.toolCalls[0].toolId, 'orphan');
}

// ---------------------------------------------------------------------------
// control_request / control_cancel
// ---------------------------------------------------------------------------

{
    const { state, effects } = run([
        {
            type: 'control_request',
            requestId: 'r1',
            request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'x.py' } },
            policy: { kind: 'edit', selfModify: true, selfModifyPath: 'backend/rag.py', backendRestart: true },
        },
    ]);
    assert.equal(state.pendingControls.length, 1);
    const control = state.pendingControls[0];
    assert.equal(control.requestId, 'r1');
    assert.equal(control.toolName, 'Write');
    assert.deepEqual(control.input, { file_path: 'x.py' });
    assert.equal(control.policy?.selfModify, true);
    assert.equal(control.policy?.selfModifyPath, 'backend/rag.py');
    assert.equal(control.policy?.backendRestart, true);
    assert.equal(control.createdAt, NOW);
    assert.ok(effects.some((e) => e.kind === 'needs_answer'));
}

{
    const { state } = run([
        { type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
        { type: 'control_request', requestId: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Read' } },
        { type: 'control_cancel', requestId: 'r1' },
    ]);
    assert.deepEqual(state.pendingControls.map((c) => c.requestId), ['r2']);
}

// The same requestId arriving twice must not stack two cards.
{
    const { state } = run([
        { type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
        { type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
    ]);
    assert.equal(state.pendingControls.length, 1);
}

// AskUserQuestion is a control_request too and must raise a card.
{
    const { state } = run([
        {
            type: 'control_request',
            requestId: 'q1',
            request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } },
        },
    ]);
    assert.equal(state.pendingControls[0].toolName, 'AskUserQuestion');
}

assert.equal(CONTROL_TIMEOUT_MS, 180_000);

// ---------------------------------------------------------------------------
// client_tool_call — T0/T1 execute immediately, T2 parks for Run/Skip
// ---------------------------------------------------------------------------

{
    const { state, effects } = run([
        { type: 'client_tool_call', callId: 'c1', name: 'navigate', args: { tab: 'make' } },
    ]);
    assert.equal(state.pendingActions.length, 0, 'T0 tools must not park');
    assert.equal(effects.length, 1);
    const effect = effects[0];
    assert.equal(effect.kind, 'run_client_tool');
    if (effect.kind === 'run_client_tool') {
        assert.equal(effect.callId, 'c1');
        assert.deepEqual(effect.action, { type: 'navigate', payload: { tab: 'make' } });
    }
}

{
    const { state, effects } = run([
        { type: 'client_tool_call', callId: 'c2', name: 'set_duration', args: { duration: 30 } },
    ]);
    assert.equal(state.pendingActions.length, 0, 'T1 tools must not park');
    assert.equal(effects[0].kind, 'run_client_tool');
}

{
    const { state, effects } = run([
        { type: 'client_tool_call', callId: 'c3', name: 'generate', args: { prompt: 'drums' } },
    ]);
    assert.equal(effects.length, 0, 'T2 tools must NOT execute on arrival');
    assert.equal(state.pendingActions.length, 1);
    assert.equal(state.pendingActions[0].callId, 'c3');
    assert.equal(state.pendingActions[0].type, 'generate');
    assert.deepEqual(state.pendingActions[0].payload, { prompt: 'drums' });
    assert.ok(state.pendingActions[0].description.length > 0);
}

// Unknown / non-DAW tool names are never executed blind — they fail the relay.
{
    const { state, effects } = run([
        { type: 'client_tool_call', callId: 'c4', name: 'rm_rf_everything', args: {} },
    ]);
    assert.equal(state.pendingActions.length, 0);
    assert.equal(effects.length, 1);
    const effect = effects[0];
    assert.equal(effect.kind, 'unknown_client_tool');
    if (effect.kind === 'unknown_client_tool') {
        assert.equal(effect.callId, 'c4');
        assert.equal(effect.name, 'rm_rf_everything');
    }
}

// Legacy function_call frames carry {id, name, input} instead of {callId,args}.
{
    const { effects } = run([{ type: 'function_call', id: 'c5', name: 'navigate', input: { tab: 'edit' } }]);
    const effect = effects[0];
    assert.equal(effect.kind, 'run_client_tool');
    if (effect.kind === 'run_client_tool') assert.equal(effect.callId, 'c5');
}

// ---------------------------------------------------------------------------
// session / conversation ids
// ---------------------------------------------------------------------------

{
    const { state, effects } = run([
        { type: 'conversationId', conversationId: 'conv-1' },
        { type: 'session_id', sessionId: 'sess-1' },
        { type: 'model', model: 'claude-opus-4-6' },
    ]);
    assert.equal(state.conversationId, 'conv-1');
    assert.equal(state.sessionId, 'sess-1');
    assert.equal(state.cliModel, 'claude-opus-4-6');
    assert.ok(effects.some((e) => e.kind === 'conversation_id'));
    assert.ok(effects.some((e) => e.kind === 'session_id'));
}

// ---------------------------------------------------------------------------
// done → TurnMeta (cost is the per-turn DELTA of cumulative session cost)
// ---------------------------------------------------------------------------

{
    const { state } = run([
        {
            type: 'done',
            usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_input_tokens: 900,
                cache_creation_input_tokens: 1000,
            },
            totalCostUsd: 0.25,
            durationMs: 4321,
            isError: false,
        },
    ]);
    assert.equal(state.done, true);
    assert.equal(state.meta?.inTokens, 2000);
    assert.equal(state.meta?.outTokens, 50);
    assert.equal(state.meta?.costUsd, 0.25);
    assert.equal(state.meta?.durationMs, 4321);
    assert.equal(state.meta?.isError, false);
    assert.equal(state.sessionCostUsd, 0.25);
}

{
    // Second turn of the same session: 0.40 cumulative − 0.25 already billed.
    const { state } = run([{ type: 'done', usage: {}, totalCostUsd: 0.4 }], { sessionCostUsd: 0.25 });
    assert.ok(Math.abs((state.meta?.costUsd ?? 0) - 0.15) < 1e-9);
    assert.equal(state.sessionCostUsd, 0.4);
}

{
    // A NEW CLI session rebaselines cost accounting; the delta must not clamp to 0.
    const { state } = run(
        [
            { type: 'session_id', sessionId: 'sess-2' },
            { type: 'done', usage: {}, totalCostUsd: 0.05 },
        ],
        { sessionId: 'sess-1', sessionCostUsd: 9.99 },
    );
    assert.ok(Math.abs((state.meta?.costUsd ?? 0) - 0.05) < 1e-9);
}

// ---------------------------------------------------------------------------
// error frame
// ---------------------------------------------------------------------------

{
    const { state } = run([{ type: 'error', message: 'child exited' }]);
    assert.equal(state.error, 'child exited');
    assert.equal(state.done, true);
}

// Unknown frame types are ignored, not fatal.
{
    const { state } = run([{ type: 'some_future_frame', whatever: 1 }, { type: 'text_delta', text: 'ok' }]);
    assert.equal(state.text, 'ok');
    assert.equal(state.error, null);
}

// ---------------------------------------------------------------------------
// finalizeTurn — a tool-only turn becomes a message with NO text (no empty bubble)
// ---------------------------------------------------------------------------

{
    const { state } = run([
        { type: 'tool_use', toolId: 't1', name: 'Read', inputJson: '{}' },
        { type: 'tool_result', toolId: 't1', content: 'ok' },
        { type: 'done', usage: { output_tokens: 3 } },
    ]);
    const message = finalizeTurn(state, { now: NOW, id: 'm1' });
    assert.ok(message);
    assert.equal(message.text, '', 'no filler prose for a tool-only turn');
    assert.equal(message.toolCalls?.length, 1);
    assert.equal(message.meta?.outTokens, 3);
}

{
    const { state } = run([{ type: 'text_delta', text: 'done!' }]);
    const message = finalizeTurn(state, { now: NOW, id: 'm2' });
    assert.equal(message?.text, 'done!');
}

// A turn that produced literally nothing must produce NO row at all.
{
    const { state } = run([{ type: 'status', message: 'thinking' }]);
    assert.equal(finalizeTurn(state, { now: NOW, id: 'm3' }), null);
}

// Parked T2 actions survive onto the finalized message so Run/Skip still works.
{
    const { state } = run([{ type: 'client_tool_call', callId: 'c9', name: 'abort', args: {} }]);
    const message = finalizeTurn(state, { now: NOW, id: 'm4' });
    assert.equal(message?.pendingActions?.length, 1);
    assert.equal(message?.pendingActions?.[0].callId, 'c9');
}

// An interrupted turn keeps its partial text and marks it.
{
    const { state } = run([{ type: 'text_delta', text: 'half a th' }]);
    const message = finalizeTurn(state, { now: NOW, id: 'm5', interrupted: true });
    assert.ok(message);
    assert.match(message.text, /half a th/);
    assert.match(message.text, /interrupted/);
}

// ---------------------------------------------------------------------------
// R1 #3 — the relay session key rides on the client_tool_call frame
// ---------------------------------------------------------------------------

{
    const { effects } = run([
        { type: 'client_tool_call', callId: 'c1', name: 'navigate', args: { tab: 'make' }, sessionId: 'relay-7' },
    ]);
    const effect = effects.find((e) => e.kind === 'run_client_tool');
    assert.ok(effect);
    if (effect.kind === 'run_client_tool') assert.equal(effect.sessionId, 'relay-7');
}

{
    const { state } = run([
        { type: 'client_tool_call', callId: 'c2', name: 'generate', args: {}, sessionId: 'relay-7' },
    ]);
    assert.equal(state.pendingActions[0].sessionId, 'relay-7', 'a parked action remembers its relay key');
}

{
    const { effects } = run([
        { type: 'client_tool_call', callId: 'c3', name: 'nope', args: {}, sessionId: 'relay-7' },
    ]);
    const effect = effects[0];
    assert.equal(effect.kind, 'unknown_client_tool');
    if (effect.kind === 'unknown_client_tool') assert.equal(effect.sessionId, 'relay-7');
}

{
    // The relay key is NOT the CLI session id. Letting the generic sid capture
    // swallow it would repoint --resume and rebaseline cost accounting.
    const { state, effects } = run(
        [{ type: 'client_tool_call', callId: 'c4', name: 'navigate', args: {}, sessionId: 'relay-7' }],
        { sessionId: 'cli-1', sessionCostUsd: 3.5 },
    );
    assert.equal(state.sessionId, 'cli-1');
    assert.equal(state.sessionCostUsd, 3.5);
    assert.equal(effects.filter((e) => e.kind === 'session_id').length, 0);
}

// Absent sessionId leaves the effect without one, so the hook falls back.
{
    const { effects } = run([{ type: 'client_tool_call', callId: 'c5', name: 'navigate', args: {} }]);
    const effect = effects[0];
    if (effect.kind === 'run_client_tool') assert.equal(effect.sessionId, undefined);
}

// ---------------------------------------------------------------------------
// R1 #2 — an answered permission card must not resurrect on the next frame
// ---------------------------------------------------------------------------

{
    let state = createTurnState();
    state = reduceFrame(
        state,
        { type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
        { now: NOW },
    ).state;
    assert.equal(state.pendingControls.length, 1);

    state = dismissControl(state, 'r1');
    assert.equal(state.pendingControls.length, 0);

    state = reduceFrame(state, { type: 'text_delta', text: 'continuing' }, { now: NOW }).state;
    assert.equal(state.pendingControls.length, 0, 'the answered card must stay gone');
    assert.equal(state.text, 'continuing');
}

// Dismissing an unknown id is a no-op, not a crash.
{
    const state = createTurnState();
    assert.equal(dismissControl(state, 'nope').pendingControls.length, 0);
}

// ---------------------------------------------------------------------------
// R1 #1 — a parked T2 action is reachable and answerable BEFORE `done`
// ---------------------------------------------------------------------------

{
    // The relay call blocks the CLI turn, so `done` cannot arrive until the user
    // answers. The action must therefore be resolvable from the LIVE turn state,
    // with no message to hang it on yet.
    const { state } = run([{ type: 'client_tool_call', callId: 'c9', name: 'generate', args: { prompt: 'x' } }]);
    assert.equal(state.done, false, 'the turn is still open');

    const found = findPendingAction(state.pendingActions, [], null, 'c9');
    assert.ok(found, 'a live parked action is reachable with no messageId');
    assert.equal(found.type, 'generate');

    // Answering it must take it out of the turn, or `done` would re-park it on
    // the finalized message and offer Run a second time.
    const answered = dismissPendingAction(state, 'c9');
    assert.equal(answered.pendingActions.length, 0);
    const message = finalizeTurn(
        reduceFrame(answered, { type: 'done', usage: {} }, { now: NOW }).state,
        { now: NOW, id: 'm1' },
    );
    assert.equal(message, null, 'nothing left to show once the only activity was answered');
}

// A finalized message's action is still reachable by messageId.
{
    const messages: ChatMessage[] = [
        {
            id: 'm1',
            role: 'assistant',
            text: '',
            pendingActions: [{ type: 'abort', payload: {}, callId: 'c1', description: 'Abort' }],
            timestamp: 0,
        },
    ];
    assert.equal(findPendingAction([], messages, 'm1', 'c1')?.type, 'abort');
    // callId is the real key — a stale messageId must not lose the action.
    assert.equal(findPendingAction([], messages, null, 'c1')?.type, 'abort');
    assert.equal(findPendingAction([], messages, 'm1', 'missing'), null);

    const stripped = removePendingActionFromMessages(messages, 'm1', 'c1');
    assert.equal(stripped[0].pendingActions, undefined, 'an emptied list becomes undefined, not []');
}

// ---------------------------------------------------------------------------
// R1 #4 — teardown declines every parked action instead of dropping it
// ---------------------------------------------------------------------------

{
    const { state } = run([
        { type: 'client_tool_call', callId: 'a1', name: 'generate', args: {}, sessionId: 'relay-1' },
        { type: 'client_tool_call', callId: 'a2', name: 'abort', args: {} },
    ]);
    assert.deepEqual(declineTargets(state), [
        { callId: 'a1', sessionId: 'relay-1' },
        { callId: 'a2', sessionId: undefined },
    ]);

    const cleared = clearPendingActions(state);
    assert.equal(cleared.pendingActions.length, 0);
    assert.equal(
        finalizeTurn(cleared, { now: NOW, id: 'm1' }),
        null,
        'a declined-on-teardown action leaves nothing stale behind',
    );
}

assert.deepEqual(declineTargets(createTurnState()), []);

// ---------------------------------------------------------------------------
// V3-3 — teardown answers pending CONTROLS too, not just parked actions.
// A control left unanswered keeps the CLI blocked until the 180s auto-deny.
// ---------------------------------------------------------------------------

{
    const { state } = run([
        { type: 'client_tool_call', callId: 'a1', name: 'generate', args: {}, sessionId: 'relay-1' },
        { type: 'client_tool_call', callId: 'a2', name: 'abort', args: {} },
        { type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
        { type: 'control_request', requestId: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Write' } },
    ]);

    assert.equal(TURN_ENDED_DENIAL, 'Turn ended before you answered');
    assert.deepEqual(teardownPosts(state, { conversationId: 'conv-1', sessionId: 'cli-1' }), [
        {
            endpoint: 'relayResult',
            body: { sessionId: 'relay-1', callId: 'a1', result: DECLINED_RESULT, isError: true },
        },
        {
            // No relay key on the frame: fall back to the CLI session id.
            endpoint: 'relayResult',
            body: { sessionId: 'cli-1', callId: 'a2', result: DECLINED_RESULT, isError: true },
        },
        {
            endpoint: 'controlResponse',
            body: {
                conversationId: 'conv-1',
                requestId: 'r1',
                response: { behavior: 'deny', message: TURN_ENDED_DENIAL },
                scope: 'once',
            },
        },
        {
            endpoint: 'controlResponse',
            body: {
                conversationId: 'conv-1',
                requestId: 'r2',
                response: { behavior: 'deny', message: TURN_ENDED_DENIAL },
                scope: 'once',
            },
        },
    ]);

    // Without a conversation id there is nothing to address a control-response
    // to (the endpoint 404s), so controls are skipped — relay declines are not.
    const noConv = teardownPosts(state, { conversationId: null, sessionId: null });
    assert.deepEqual(
        noConv.map((p) => p.endpoint),
        ['relayResult', 'relayResult'],
    );
    assert.equal(noConv[1].body.sessionId, '', 'no key anywhere: empty string, same as a live relay POST');
}

assert.deepEqual(teardownPosts(createTurnState(), { conversationId: 'c', sessionId: 's' }), []);

// After teardown the turn holds no open control, so nothing can be answered or
// republished a second time.
{
    const { state } = run([
        { type: 'control_request', requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
        { type: 'text_delta', text: 'kept' },
    ]);
    const cleared = clearPendingControls(state);
    assert.equal(cleared.pendingControls.length, 0);
    assert.equal(cleared.text, 'kept', 'only the controls are retired');
    assert.deepEqual(teardownPosts(cleared, { conversationId: 'c', sessionId: 's' }), []);
    const untouched = createTurnState();
    assert.equal(clearPendingControls(untouched), untouched, 'no-op returns the same object');
}

// ---------------------------------------------------------------------------
// buildConversationHistory — a tool-only turn must not be replayed as an empty
// assistant message. Providers that require alternating non-empty content (and
// Anthropic in particular) reject that.
// ---------------------------------------------------------------------------

{
    const history: ChatMessage[] = [
        { id: 'u1', role: 'user', text: 'make a beat', timestamp: 0 },
        { id: 'a1', role: 'assistant', text: '', toolCalls: [], timestamp: 0 },
        { id: 'a2', role: 'assistant', text: 'here you go', timestamp: 0 },
        { id: 'u2', role: 'user', text: 'louder', timestamp: 0 },
    ];
    assert.deepEqual(buildConversationHistory(history), [
        { role: 'user', content: 'make a beat' },
        { role: 'assistant', content: 'here you go' },
        { role: 'user', content: 'louder' },
    ]);
}

// An empty USER turn is still dropped rather than sent as blank content.
assert.deepEqual(buildConversationHistory([{ id: 'u', role: 'user', text: '   ', timestamp: 0 }]), []);

// ---------------------------------------------------------------------------
// parseSseLine
// ---------------------------------------------------------------------------

assert.deepEqual(parseSseLine('data: {"type":"text_delta","text":"hi"}'), { type: 'text_delta', text: 'hi' });
// SSE allows the space after the colon to be omitted.
assert.deepEqual(parseSseLine('data:{"type":"done"}'), { type: 'done' });
assert.equal(parseSseLine(': ping 1234'), null, 'keepalive comment');
assert.equal(parseSseLine(''), null);
assert.equal(parseSseLine('   '), null);
assert.equal(parseSseLine('event: message'), null);
assert.equal(parseSseLine('data: [DONE]'), null);
assert.equal(parseSseLine('data: {not json'), null, 'a malformed frame is skipped, never thrown');

console.log('useChatStream frame reducer regression passed');
