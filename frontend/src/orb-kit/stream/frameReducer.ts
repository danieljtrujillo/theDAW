/**
 * Pure SSE-frame reducer for the assistant turn.
 *
 * The Foundry kept this whole state machine inline in `useChatStream`, which
 * made every rule (tool pairing, sub-agent nesting, cost deltas) reachable only
 * through a live fetch. It is factored out here so the rules are testable
 * without a DOM or a network: `reduceFrame` is a pure `(state, frame) -> {state,
 * effects}` step, and the hook does nothing but feed it frames and carry out the
 * effects it returns.
 *
 * Frame vocabulary is plan contract C1. Legacy aliases the existing backend
 * still emits (`text`, `function_call`, `function_result`) are accepted too, so
 * this reducer can drive the transcript before and after the backend swap.
 */

import { sanitizeAssistantAction } from '../assistantEvents';
import type { AssistantExecutableAction } from '../assistantEvents';
import { getToolTier, describeToolCall } from '../tool-tiers';
import type {
    ChatMessage,
    ControlPolicy,
    PendingControl,
    PendingDawAction,
    ToolCallEntry,
    TurnMeta,
} from './types';

/** How long the backend waits before auto-denying a control request. */
export const CONTROL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TurnState {
    /** Accumulated assistant prose for this turn. */
    text: string;
    /** Accumulated extended-thinking text for this turn. */
    thinking: string;
    toolCalls: ToolCallEntry[];
    pendingControls: PendingControl[];
    /** T2_confirm DAW tools parked awaiting Run/Skip. */
    pendingActions: PendingDawAction[];
    /** Transient status line. NEVER promoted to a message row. */
    statusText: string | null;
    meta: TurnMeta | null;
    sessionId: string | null;
    conversationId: string | null;
    cliModel: string | null;
    /** Cumulative session cost carried across turns so `done` can show a delta. */
    sessionCostUsd: number;
    done: boolean;
    error: string | null;
}

export function createTurnState(seed?: Partial<TurnState>): TurnState {
    return {
        text: '',
        thinking: '',
        toolCalls: [],
        pendingControls: [],
        pendingActions: [],
        statusText: null,
        meta: null,
        sessionId: null,
        conversationId: null,
        cliModel: null,
        sessionCostUsd: 0,
        done: false,
        error: null,
        ...seed,
    };
}

// ---------------------------------------------------------------------------
// Effects — everything the reducer cannot do itself
// ---------------------------------------------------------------------------

export type StreamEffect =
    /** Run this DAW tool now and POST its result to the relay. */
    | { kind: 'run_client_tool'; callId: string; action: AssistantExecutableAction; sessionId?: string }
    /** The relay asked for a tool outside theDAW vocabulary — fail it, never guess. */
    | { kind: 'unknown_client_tool'; callId: string; name: string; sessionId?: string }
    | { kind: 'session_id'; sessionId: string }
    | { kind: 'conversation_id'; conversationId: string }
    | { kind: 'needs_answer'; requestId: string; toolName: string };

export interface ReduceContext {
    /** Injected clock so control timestamps are testable. */
    now: number;
}

export interface ReduceResult {
    state: TurnState;
    effects: StreamEffect[];
}

// ---------------------------------------------------------------------------
// Small readers — every frame field is untrusted JSON off the wire
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readPolicy(value: unknown): ControlPolicy | undefined {
    if (!isRecord(value)) return undefined;
    const kind = str(value.kind);
    return {
        kind:
            kind === 'read' || kind === 'edit' || kind === 'shell' || kind === 'agent' || kind === 'mcp'
                ? kind
                : 'other',
        selfModify: value.selfModify === true,
        selfModifyPath: typeof value.selfModifyPath === 'string' ? value.selfModifyPath : null,
        backendRestart: value.backendRestart === true,
        decision: typeof value.decision === 'string' ? value.decision : undefined,
    };
}

/** Tool input arrives either pre-stringified (`inputJson`) or as an object. */
function readInputJson(frame: Record<string, unknown>): string {
    if (typeof frame.inputJson === 'string') return frame.inputJson;
    try {
        return JSON.stringify(frame.input ?? {});
    } catch {
        return '{}';
    }
}

// ---------------------------------------------------------------------------
// Tool tree helpers
// ---------------------------------------------------------------------------

function hasTool(tools: ToolCallEntry[], toolId: string): boolean {
    return !!toolId && tools.some((t) => t.toolId === toolId);
}

function addTool(tools: ToolCallEntry[], parentId: string, entry: ToolCallEntry): ToolCallEntry[] {
    // A sub-agent tool nests under its Task/Agent card. An unknown parent falls
    // through to the top level rather than disappearing from the transcript.
    if (parentId && hasTool(tools, parentId)) {
        return tools.map((t) => {
            if (t.toolId !== parentId) return t;
            const subs = t.subCalls ?? [];
            if (hasTool(subs, entry.toolId)) return t;
            return { ...t, subCalls: [...subs, entry] };
        });
    }
    if (hasTool(tools, entry.toolId)) return tools;
    return [...tools, entry];
}

function applyResult(
    tools: ToolCallEntry[],
    parentId: string,
    toolId: string,
    result: string,
    isError: boolean,
): ToolCallEntry[] {
    const patch = (t: ToolCallEntry): ToolCallEntry =>
        t.toolId && t.toolId === toolId
            ? { ...t, result, isError, status: isError ? 'error' : 'success' }
            : t;
    if (parentId && hasTool(tools, parentId)) {
        return tools.map((t) =>
            t.toolId === parentId ? { ...t, subCalls: (t.subCalls ?? []).map(patch) } : t,
        );
    }
    return tools.map(patch);
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function reduceFrame(state: TurnState, frame: unknown, ctx: ReduceContext): ReduceResult {
    if (!isRecord(frame)) return { state, effects: [] };

    const effects: StreamEffect[] = [];
    let next = state;
    const frameType = str(frame.type);

    // Any frame may carry the CLI session id. Capture it generically so a tool
    // result fired later in the same stream targets the right session. A NEW id
    // means fresh cost accounting, so rebaseline the cumulative total.
    //
    // EXCEPT on relay frames: `client_tool_call` carries the MCP relay key, a
    // different id entirely. Swallowing it here would repoint `--resume` at a
    // relay id and wipe the cost baseline mid-turn.
    const isRelayFrame = frameType === 'client_tool_call' || frameType === 'function_call';
    const sid = isRelayFrame ? '' : str(frame.sessionId) || str(frame.session_id);
    if (sid && sid !== next.sessionId) {
        next = { ...next, sessionId: sid, sessionCostUsd: 0 };
        effects.push({ kind: 'session_id', sessionId: sid });
    }
    const convId = str(frame.conversationId);
    if (convId && convId !== next.conversationId) {
        next = { ...next, conversationId: convId };
        effects.push({ kind: 'conversation_id', conversationId: convId });
    }

    switch (frameType) {
        case 'status':
            if (typeof frame.message === 'string') next = { ...next, statusText: frame.message };
            return { state: next, effects };

        case 'thinking':
            return { state: { ...next, thinking: next.thinking + (str(frame.text) || str(frame.delta)) }, effects };

        case 'text':
        case 'text_delta':
            return { state: { ...next, text: next.text + (str(frame.text) || str(frame.delta)) }, effects };

        case 'model':
            return { state: { ...next, cliModel: str(frame.model) || next.cliModel }, effects };

        case 'conversationId':
        case 'session_id':
            // Captured generically above.
            return { state: next, effects };

        case 'tool_use': {
            const entry: ToolCallEntry = {
                toolId: str(frame.toolId),
                name: str(frame.name) || 'tool',
                inputJson: readInputJson(frame),
                status: 'executing',
            };
            return {
                state: { ...next, toolCalls: addTool(next.toolCalls, str(frame.parentToolId), entry) },
                effects,
            };
        }

        case 'tool_result': {
            const tools = applyResult(
                next.toolCalls,
                str(frame.parentToolId),
                str(frame.toolId),
                typeof frame.content === 'string' ? frame.content : '',
                frame.isError === true,
            );
            return { state: { ...next, toolCalls: tools }, effects };
        }

        case 'control_request': {
            const request = isRecord(frame.request) ? frame.request : {};
            if (str(request.subtype) !== 'can_use_tool') return { state: next, effects };
            const requestId = str(frame.requestId) || str(request.request_id);
            if (next.pendingControls.some((c) => c.requestId === requestId)) {
                return { state: next, effects };
            }
            const control: PendingControl = {
                requestId,
                conversationId: str(frame.conversationId) || next.conversationId || undefined,
                toolName: str(request.tool_name) || 'tool',
                input: isRecord(request.input) ? request.input : undefined,
                suggestions: Array.isArray(request.permission_suggestions)
                    ? request.permission_suggestions
                    : undefined,
                reason: typeof request.decision_reason === 'string' ? request.decision_reason : undefined,
                policy: readPolicy(frame.policy),
                createdAt: ctx.now,
            };
            effects.push({ kind: 'needs_answer', requestId: control.requestId, toolName: control.toolName });
            return { state: { ...next, pendingControls: [...next.pendingControls, control] }, effects };
        }

        case 'control_cancel': {
            const requestId = str(frame.requestId);
            return {
                state: { ...next, pendingControls: next.pendingControls.filter((c) => c.requestId !== requestId) },
                effects,
            };
        }

        case 'client_tool_call':
        case 'function_call': {
            const callId = str(frame.callId) || str(frame.id);
            const name = str(frame.name);
            const args = isRecord(frame.args) ? frame.args : isRecord(frame.input) ? frame.input : {};
            // The relay key this call must be answered against, verbatim.
            const relaySessionId = str(frame.sessionId) || str(frame.session_id) || undefined;
            if (!name) return { state: next, effects };

            // Validate through the SAME allowlist the scraped-<action> path uses:
            // a tool name outside theDAW's vocabulary is failed back to the relay,
            // never executed on a guess.
            const action = sanitizeAssistantAction({ type: name, payload: args });
            if (!action) {
                effects.push({ kind: 'unknown_client_tool', callId, name, sessionId: relaySessionId });
                return { state: next, effects };
            }

            // Tier gate: expensive / irreversible tools park on the message and
            // only execute (and only then POST a result) when the user hits Run.
            if (getToolTier(action.type) === 'T2_confirm') {
                if (next.pendingActions.some((p) => p.callId === callId)) return { state: next, effects };
                const parked: PendingDawAction = {
                    ...action,
                    callId,
                    description: describeToolCall(action.type, action.payload ?? {}),
                    sessionId: relaySessionId,
                };
                return { state: { ...next, pendingActions: [...next.pendingActions, parked] }, effects };
            }

            effects.push({ kind: 'run_client_tool', callId, action, sessionId: relaySessionId });
            return { state: next, effects };
        }

        case 'function_result':
            // Server-side tool result; nothing for the browser to do.
            return { state: next, effects };

        case 'done': {
            const usage = isRecord(frame.usage) ? frame.usage : {};
            const inTokens =
                num(usage.input_tokens) +
                num(usage.cache_read_input_tokens) +
                num(usage.cache_creation_input_tokens);
            let costUsd: number | undefined;
            let sessionCostUsd = next.sessionCostUsd;
            if (typeof frame.totalCostUsd === 'number') {
                costUsd = Math.max(0, frame.totalCostUsd - sessionCostUsd);
                sessionCostUsd = frame.totalCostUsd;
            }
            const meta: TurnMeta = {
                inTokens,
                outTokens: num(usage.output_tokens),
                costUsd,
                durationMs: typeof frame.durationMs === 'number' ? frame.durationMs : undefined,
                isError: frame.isError === true,
            };
            return { state: { ...next, meta, sessionCostUsd, done: true, statusText: null }, effects };
        }

        case 'error':
            return {
                state: {
                    ...next,
                    error: str(frame.message) || str(frame.error) || 'Unknown stream error',
                    done: true,
                },
                effects,
            };

        default:
            // Unknown frame type — ignore gracefully, never throw mid-stream.
            return { state: next, effects };
    }
}

// ---------------------------------------------------------------------------
// Out-of-band turn transitions
//
// The user answers cards WHILE the stream is running, so these are state
// changes the turn must absorb that no frame carries. They belong here, beside
// the frame rules, because forgetting one resurrects the card: clearing only
// the React copy leaves the turn's own list intact, and the next frame pushes
// it straight back into the UI.
// ---------------------------------------------------------------------------

/** The user answered a permission request; it must never be re-offered. */
export function dismissControl(state: TurnState, requestId: string): TurnState {
    if (!state.pendingControls.some((c) => c.requestId === requestId)) return state;
    return { ...state, pendingControls: state.pendingControls.filter((c) => c.requestId !== requestId) };
}

/**
 * The user ran or skipped a parked T2 action. Removing it from the turn is what
 * stops `finalizeTurn` re-parking an already-answered action onto the message
 * and offering Run a second time.
 */
export function dismissPendingAction(state: TurnState, callId: string): TurnState {
    if (!state.pendingActions.some((p) => p.callId === callId)) return state;
    return { ...state, pendingActions: state.pendingActions.filter((p) => p.callId !== callId) };
}

/** Teardown: every open permission card has been denied to the CLI. */
export function clearPendingControls(state: TurnState): TurnState {
    if (state.pendingControls.length === 0) return state;
    return { ...state, pendingControls: [] };
}

/** Teardown: every parked action has been declined to the relay. */
export function clearPendingActions(state: TurnState): TurnState {
    if (state.pendingActions.length === 0) return state;
    return { ...state, pendingActions: [] };
}

// ---------------------------------------------------------------------------
// Turn -> message
// ---------------------------------------------------------------------------

export interface FinalizeContext {
    now: number;
    id: string;
    interrupted?: boolean;
}

/**
 * Build the assistant row for a finished turn, or `null` when the turn produced
 * nothing at all.
 *
 * This is where theDAW's empty-bubble bug dies: a turn that only ran tools gets
 * `text: ''` instead of the old `content || 'No response.'` filler, and the
 * transcript then renders the tool list and the meta line with no bubble body
 * and no Copy/Retry.
 */
export function finalizeTurn(state: TurnState, ctx: FinalizeContext): ChatMessage | null {
    const hasContent =
        state.text.trim().length > 0 ||
        state.thinking.trim().length > 0 ||
        state.toolCalls.length > 0 ||
        state.pendingActions.length > 0;
    if (!hasContent) return null;

    let text = state.text;
    if (ctx.interrupted) text = text ? `${text}\n\n*(interrupted)*` : '*(interrupted)*';

    return {
        id: ctx.id,
        role: 'assistant',
        text,
        thinking: state.thinking || undefined,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        meta: state.meta ?? undefined,
        pendingActions: state.pendingActions.length > 0 ? state.pendingActions : undefined,
        timestamp: ctx.now,
    };
}
