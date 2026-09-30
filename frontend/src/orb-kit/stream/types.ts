/**
 * Transcript + stream types for theDAW's Claude Code assistant.
 *
 * Ported from VST-Foundry-UI/src/components/orb/types.ts ("copy, don't
 * reinvent") and adapted to theDAW: the Foundry's canvas-element refs are gone,
 * and two things are added for this app —
 *   - `PendingControl.policy`, the C1 permission-policy extension the backend
 *     attaches to every `control_request` (self-modify banner, restart warning);
 *   - `ChatMessage.pendingActions`, the T2_confirm DAW tools that arrived over
 *     the MCP relay and are parked awaiting Run/Skip.
 */

import type { AssistantExecutableAction } from '../assistantEvents';

// One tool the agent invoked, paired with its result. `inputJson` is the tool
// input as a JSON string (the CLI stores it stringified so partial input deltas
// can accumulate before parse); the renderer try/pretty-prints it.
// `result`/`isError` arrive later via the matching tool_result frame (joined on
// `toolId`). `subCalls` holds a sub-agent's tools when this entry is a
// Task/Agent spawn, so sub-agent activity nests under its card instead of
// corrupting the main transcript.
export interface ToolCallEntry {
    toolId: string;
    name: string;
    inputJson: string;
    result?: string;
    isError?: boolean;
    status: 'executing' | 'success' | 'error';
    subCalls?: ToolCallEntry[];
}

// Per-turn accounting from the `done` frame, shown under each assistant message.
// `costUsd` is the per-turn DELTA of the session's cumulative cost.
export interface TurnMeta {
    costUsd?: number;
    inTokens?: number;
    outTokens?: number;
    durationMs?: number;
    isError?: boolean;
}

/** Which family of tool the CLI asked permission for (plan contract C1/C3). */
export type ControlPolicyKind = 'read' | 'edit' | 'shell' | 'agent' | 'mcp' | 'other';

/**
 * The backend's classification of a permission request. `selfModify` means the
 * agent is about to edit its OWN surface (assistant routes, orb-kit, RAG), which
 * always bubbles and can never be remembered for the session.
 */
export interface ControlPolicy {
    kind: ControlPolicyKind;
    selfModify: boolean;
    selfModifyPath: string | null;
    backendRestart: boolean;
    decision?: string;
}

/**
 * A live CLI `control_request` the user must answer — an AskUserQuestion
 * multiple choice, or a `can_use_tool` permission prompt. The CLI is BLOCKED
 * until the answer is POSTed back.
 */
export interface PendingControl {
    requestId: string;
    /** The backend's own key for the session this request is pending on. The
     *  answer goes back under it, not under whatever id the host holds. */
    conversationId?: string;
    toolName: string;
    input: Record<string, unknown> | undefined;
    suggestions?: unknown[];
    reason?: string;
    policy?: ControlPolicy;
    /** Epoch ms the request landed — drives the 180s display countdown. */
    createdAt: number;
}

/** How the user answered a control request: this call only, or all session. */
export type ControlScope = 'once' | 'session';

/** The answer body POSTed to `/api/assistant/control-response`. */
export type ControlResponse =
    | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
    | { behavior: 'deny'; message: string };

/**
 * A T2_confirm DAW tool that arrived over the MCP relay and is waiting for the
 * user to press Run or Skip. It is an `AssistantExecutableAction` (so it drops
 * straight into the existing dispatcher) plus the relay `callId` the result must
 * be POSTed against and a human description for the card.
 */
export interface PendingDawAction extends AssistantExecutableAction {
    callId: string;
    description: string;
    /**
     * The relay key the backend registered for this call, carried verbatim on
     * the `client_tool_call` frame (contract C1). It is NOT the CLI session id —
     * posting the wrong one leaves the relay call to time out — so it travels
     * with the action rather than being inferred at POST time.
     */
    sessionId?: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    thinking?: string;
    toolCalls?: ToolCallEntry[];
    meta?: TurnMeta;
    /** T2_confirm DAW tools parked on this turn, awaiting Run/Skip. */
    pendingActions?: PendingDawAction[];
    /** Attachment summaries echoed back on the user's own row. */
    attachments?: Array<{ name: string; mime: string; size: number }>;
    isError?: boolean;
    timestamp: number;
}

export interface ChatSession {
    id: string;
    name: string;
    messages: ChatMessage[];
    provider?: string;
    model: string;
    effort?: string;
    /** The CLI's own resume id, distinct from our conversation id. */
    claudeSessionId?: string | null;
    lastUpdated: number;
}

/** Shared text-scale union used by the transcript's presentational components. */
export type TextScale = 'xs' | 'sm' | 'md' | 'lg';

/** Permission modes offered by the Claude provider (plan contract C2/C3). */
export type ClaudePermissionMode = 'ask' | 'accept_edits' | 'readonly' | 'trusted';
