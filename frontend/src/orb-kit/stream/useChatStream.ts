/**
 * Chat streaming hook for theDAW's assistant — SSE fetch/read loop, mid-turn
 * send queue, MCP-relay tool execution, and control-request answering.
 *
 * Ported from VST-Foundry-UI/src/components/orb/useChatStream.ts and adapted:
 *
 *  - the whole frame state machine moved to the pure `frameReducer`, so this
 *    file is only I/O (fetch, POST, timers) plus React glue;
 *  - the Foundry's canvas payload is replaced by theDAW's request body (the
 *    shape AssistantPanel already sends) plus `claude_permission_mode`;
 *  - `client_tool_call` frames execute through theDAW's EXISTING dispatcher
 *    (`handletheDAWAction`, injected as `executeAction`) and the result is
 *    POSTed to `/api/mcp-relay/result`, so tool output finally returns to the
 *    model in-turn instead of being scraped out of prose;
 *  - T2_confirm DAW tools do NOT execute on arrival. They park on the message
 *    and only run — and only then answer the relay — when the user hits Run.
 *
 * The hook owns the transcript so it can be mounted whole; `setMessages` is
 * exposed for hydration from saved history and for persistence.
 */

import { useCallback, useRef, useState } from 'react';
import type React from 'react';

import type { AssistantExecutableAction } from '../assistantEvents';
import {
    clearPendingActions,
    clearPendingControls,
    createTurnState,
    dismissControl,
    dismissPendingAction,
    finalizeTurn,
    reduceFrame,
} from './frameReducer';
import type { StreamEffect, TurnState } from './frameReducer';
import {
    DECLINED_RESULT,
    findPendingAction,
    relayResultBody,
    removePendingActionFromMessages,
    teardownPosts,
} from './pendingActions';
import type {
    ChatMessage,
    ClaudePermissionMode,
    ControlResponse,
    ControlScope,
    PendingControl,
    PendingDawAction,
    ToolCallEntry,
} from './types';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ChatEndpoints {
    chat: string;
    controlResponse: string;
    interrupt: string;
    relayResult: string;
}

export const DEFAULT_CHAT_ENDPOINTS: ChatEndpoints = {
    chat: '/api/assistant/chat',
    controlResponse: '/api/assistant/control-response',
    interrupt: '/api/assistant/interrupt',
    relayResult: '/api/mcp-relay/result',
};

/** Everything that varies per turn, read fresh at send time. */
export interface ChatTurnContext {
    provider: string;
    model: string;
    /** The app-context system block (see appContext.ts). Prepended to history. */
    systemContext?: string;
    effort?: string;
    conversationId?: string | null;
    claudeSessionId?: string | null;
    permissionMode?: ClaudePermissionMode;
    /** Merged into the request body last — escape hatch for provider extras. */
    extraBody?: Record<string, unknown>;
}

export interface SendAttachment {
    name: string;
    mime: string;
    size: number;
    /** base64 payload for the request body. */
    data: string;
}

export interface SendOptions {
    attachments?: SendAttachment[];
}

export interface UseChatStreamOptions {
    /** Read the live provider/model/session for this turn. */
    getTurnContext: () => ChatTurnContext | Promise<ChatTurnContext>;
    /** theDAW's action dispatcher — pass `handletheDAWAction`. */
    executeAction: (action: AssistantExecutableAction) => string | Promise<string>;
    onSessionId?: (sessionId: string) => void;
    onConversationId?: (conversationId: string) => void;
    /** Called when a turn ends or the agent needs an answer (desktop notify). */
    onNotify?: (title: string, body: string) => void;
    endpoints?: Partial<ChatEndpoints>;
}

export interface UseChatStreamApi {
    messages: ChatMessage[];
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    isStreaming: boolean;
    /** Transient status line. Never a message row. */
    statusText: string | null;
    liveText: string;
    liveThinking: string;
    liveToolCalls: ToolCallEntry[];
    /**
     * T2 DAW tools parked by the turn that is STILL STREAMING.
     *
     * These have no message yet and cannot get one: the relay call blocks the
     * CLI for up to 115s waiting for the answer, so `done` only arrives after
     * the user presses Run or Skip. They must be rendered from here.
     */
    livePendingActions: PendingDawAction[];
    pendingControls: PendingControl[];
    /** Prompts waiting for the current turn to finish. */
    queuedSends: string[];
    cliModel: string | null;
    send: (text: string, options?: SendOptions) => Promise<void>;
    /** Abort the HTTP stream and drop the queue. */
    stop: () => void;
    /** Ask the CLI to interrupt the current turn without killing the child. */
    interrupt: () => Promise<void>;
    /** Drop the last assistant turn and re-send the last user prompt. */
    retry: () => Promise<void>;
    clear: () => void;
    answerControl: (requestId: string, response: ControlResponse, scope?: ControlScope) => Promise<void>;
    /** `messageId` is null for an action parked by the live, still-open turn. */
    runPendingAction: (messageId: string | null, callId: string) => Promise<void>;
    skipPendingAction: (messageId: string | null, callId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
    return Math.random().toString(36).slice(2, 11);
}

// Defined in the pure pendingActions module (the teardown helper needs it);
// re-exported here so existing `./useChatStream` imports keep working.
export { DECLINED_RESULT, TURN_ENDED_DENIAL } from './pendingActions';

/**
 * Split an SSE buffer into complete lines. On the final read the whole buffer is
 * kept, so a last frame written without a trailing newline is still processed.
 */
function takeLines(buffer: string, done: boolean): { lines: string[]; rest: string } {
    const lines = buffer.split('\n');
    const rest = done ? '' : (lines.pop() ?? '');
    return { lines, rest };
}

/** Parse one SSE line into a frame object, or null for pings/blank/garbage. */
export function parseSseLine(line: string): unknown | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith(':')) return null; // ": ping <ms>" keepalive
    if (!trimmed.startsWith('data:')) return null; // the space after ":" is optional in SSE
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

/**
 * Flatten the transcript into the model-agnostic `[{role, content}]` history.
 *
 * Turns with no prose are DROPPED. A tool-only turn now legitimately has
 * `text: ''` (that is the empty-bubble fix), and replaying it as an empty
 * assistant message breaks providers that require non-empty alternating
 * content. What the tools did is already back in the model's context through
 * the relay results, so nothing is lost.
 */
export function buildConversationHistory(
    messages: ChatMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
    return messages
        .filter((message) => message.text.trim().length > 0)
        .map((message) => ({ role: message.role, content: message.text }));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatStream(options: UseChatStreamOptions): UseChatStreamApi {
    const { getTurnContext, executeAction, onSessionId, onConversationId, onNotify } = options;
    const endpoints: ChatEndpoints = { ...DEFAULT_CHAT_ENDPOINTS, ...options.endpoints };

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const [statusText, setStatusText] = useState<string | null>(null);
    const [liveText, setLiveText] = useState('');
    const [liveThinking, setLiveThinking] = useState('');
    const [liveToolCalls, setLiveToolCalls] = useState<ToolCallEntry[]>([]);
    const [livePendingActions, setLivePendingActions] = useState<PendingDawAction[]>([]);
    const [pendingControls, setPendingControls] = useState<PendingControl[]>([]);
    const [queuedSends, setQueuedSends] = useState<string[]>([]);
    const [cliModel, setCliModel] = useState<string | null>(null);

    // Refs the stream loop reads/writes synchronously — state would lag a frame.
    const messagesRef = useRef<ChatMessage[]>([]);
    messagesRef.current = messages;
    /**
     * The turn state itself, as a ref.
     *
     * It cannot be a local inside `send`: the user answers permission cards and
     * parked actions from event handlers WHILE the loop runs, and those answers
     * have to land on the same object the next frame reduces from. Keeping the
     * turn in a local is what let an answered card come back — the handler
     * cleared the React copy, the loop re-published the turn's untouched list.
     */
    const turnStateRef = useRef<TurnState | null>(null);
    const activeTurnRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);
    const queueRef = useRef<Array<{ text: string; options?: SendOptions }>>([]);
    /** Cumulative session cost, carried across turns so `done` shows a delta. */
    const sessionCostRef = useRef(0);
    /** The CLI session id, for the relay and for `--resume`. */
    const sessionIdRef = useRef<string | null>(null);
    /** The backend conversation id — the key for control-response / interrupt. */
    const conversationIdRef = useRef<string | null>(null);
    /** Set while a user-initiated interrupt is in flight, to label the turn. */
    const interruptedRef = useRef(false);

    // -- relay / control POSTs ------------------------------------------------

    const postRelayResult = useCallback(
        async (callId: string, result: string, isError: boolean, sessionId?: string) => {
            if (!callId) return;
            try {
                await fetch(endpoints.relayResult, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // The relay key the backend registered, straight off the frame;
                    // the refs are only a fallback (see relayResultBody).
                    body: JSON.stringify(
                        relayResultBody(callId, result, isError, sessionId, {
                            sessionId: sessionIdRef.current,
                            conversationId: conversationIdRef.current,
                        }),
                    ),
                });
            } catch (err) {
                // The relay call will time out on the backend; nothing else to do
                // from here, and throwing would abort the stream loop.
                console.error('mcp-relay result POST failed', err);
            }
        },
        [endpoints.relayResult],
    );

    const runAction = useCallback(
        async (callId: string, action: AssistantExecutableAction, sessionId?: string) => {
            try {
                const result = await executeAction(action);
                await postRelayResult(
                    callId,
                    typeof result === 'string' ? result : String(result ?? ''),
                    false,
                    sessionId,
                );
            } catch (err) {
                await postRelayResult(callId, `Tool "${action.type}" failed: ${String(err)}`, true, sessionId);
            }
        },
        [executeAction, postRelayResult],
    );

    /**
     * Teardown: answer everything the failed/aborted turn left blocked on the
     * backend — decline each parked action (relay call held ≤115s) and deny each
     * open permission card (CLI held until the 180s auto-deny). The bodies come
     * from the pure `teardownPosts`, which is where exactly-once is decided.
     *
     * This replaces the earlier `declineParkedActions`, which answered the
     * parked actions but left every open permission card blocking the CLI.
     */
    const postTeardown = useCallback(
        async (state: TurnState) => {
            const posts = teardownPosts(state, {
                conversationId: conversationIdRef.current,
                sessionId: sessionIdRef.current,
            });
            await Promise.all(
                posts.map(async (post) => {
                    try {
                        await fetch(endpoints[post.endpoint], {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(post.body),
                        });
                    } catch (err) {
                        // Best effort: the backend's own timeouts still apply.
                        console.error(`teardown ${post.endpoint} POST failed`, err);
                    }
                }),
            );
        },
        [endpoints.relayResult, endpoints.controlResponse],
    );

    const applyEffects = useCallback(
        (effects: StreamEffect[]) => {
            for (const effect of effects) {
                switch (effect.kind) {
                    case 'session_id':
                        sessionIdRef.current = effect.sessionId;
                        onSessionId?.(effect.sessionId);
                        break;
                    case 'conversation_id':
                        conversationIdRef.current = effect.conversationId;
                        onConversationId?.(effect.conversationId);
                        break;
                    case 'needs_answer':
                        onNotify?.('theDAW assistant', 'The agent needs your answer');
                        break;
                    case 'run_client_tool':
                        // Fire and forget: the relay result is POSTed inside, and a
                        // rejection must not stall the SSE read loop.
                        void runAction(effect.callId, effect.action, effect.sessionId);
                        break;
                    case 'unknown_client_tool':
                        void postRelayResult(
                            effect.callId,
                            `Unknown tool "${effect.name}" — not in theDAW's action vocabulary.`,
                            true,
                            effect.sessionId,
                        );
                        break;
                }
            }
        },
        [onSessionId, onConversationId, onNotify, runAction, postRelayResult],
    );

    // -- the turn -------------------------------------------------------------

    const send = useCallback(
        async (text: string, sendOptions?: SendOptions) => {
            const attachments = sendOptions?.attachments ?? [];
            const prompt = text.trim() || (attachments.length ? 'Analyze the attached file(s).' : '');
            if (!prompt) return;

            // A turn is already streaming: queue instead of firing a colliding
            // request. The queue drains in `finally`; Stop clears it.
            if (activeTurnRef.current) {
                queueRef.current.push({ text, options: sendOptions });
                setQueuedSends(queueRef.current.map((q) => q.text));
                return;
            }
            activeTurnRef.current = true;
            interruptedRef.current = false;

            const attachmentSummary = attachments.length
                ? `\n\nAttached: ${attachments.map((a) => a.name).join(', ')}`
                : '';
            const userMessage: ChatMessage = {
                id: newId(),
                role: 'user',
                text: `${prompt}${attachmentSummary}`,
                attachments: attachments.length
                    ? attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.size }))
                    : undefined,
                timestamp: Date.now(),
            };
            const history = [...messagesRef.current, userMessage];
            // Sync the ref as well as the state: the queue drain re-enters `send`
            // from a timer and must not rebuild history from a pre-render snapshot.
            messagesRef.current = history;
            setMessages(history);

            setIsStreaming(true);
            setStatusText('Preparing…');
            setLiveText('');
            setLiveThinking('');
            setLiveToolCalls([]);
            setLivePendingActions([]);
            setPendingControls([]);

            const controller = new AbortController();
            abortRef.current = controller;

            turnStateRef.current = createTurnState({
                sessionCostUsd: sessionCostRef.current,
                sessionId: sessionIdRef.current,
                conversationId: conversationIdRef.current,
            });
            /** Always read the ref: event handlers mutate it mid-loop. */
            const turn = (): TurnState => turnStateRef.current ?? createTurnState();
            let turnSucceeded = false;

            try {
                const context = await getTurnContext();
                if (context.conversationId !== undefined && context.conversationId !== null) {
                    conversationIdRef.current = context.conversationId;
                }
                if (context.claudeSessionId !== undefined && context.claudeSessionId !== null) {
                    sessionIdRef.current = context.claudeSessionId;
                }
                turnStateRef.current = {
                    ...turn(),
                    sessionId: sessionIdRef.current,
                    conversationId: conversationIdRef.current,
                };

                const conversation = buildConversationHistory(history);
                const body: Record<string, unknown> = {
                    messages: context.systemContext
                        ? [{ role: 'system', content: context.systemContext }, ...conversation]
                        : conversation,
                    provider: context.provider,
                    model: context.model,
                    ...(attachments.length
                        ? { attachments: attachments.map((a) => ({ name: a.name, mime: a.mime, data: a.data })) }
                        : {}),
                    ...(context.provider === 'claude'
                        ? {
                              effort: context.effort,
                              conversationId: conversationIdRef.current ?? undefined,
                              claudeSessionId: sessionIdRef.current ?? undefined,
                              claude_permission_mode: context.permissionMode ?? 'ask',
                          }
                        : {}),
                    ...(context.extraBody ?? {}),
                };

                const response = await fetch(endpoints.chat, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                    signal: controller.signal,
                    body: JSON.stringify(body),
                });
                if (!response.ok) throw new Error(`Backend error: ${response.status} ${response.statusText}`);
                const reader = response.body?.getReader();
                if (!reader) throw new Error('No readable stream received.');

                const decoder = new TextDecoder('utf-8');
                let buffer = '';

                while (!turn().done) {
                    const { done, value } = await reader.read();
                    // Flush the decoder on the final read to recover a trailing
                    // multibyte character, and keep the whole buffer so a final
                    // frame without a terminating newline is still processed.
                    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                    const { lines, rest } = takeLines(buffer, done);
                    buffer = rest;

                    for (const line of lines) {
                        const frame = parseSseLine(line);
                        if (frame === null) continue;

                        const step = reduceFrame(turn(), frame, { now: Date.now() });
                        turnStateRef.current = step.state;
                        sessionCostRef.current = step.state.sessionCostUsd;
                        applyEffects(step.effects);

                        // Republish from the REF, not from `step.state`: an effect
                        // above, or a click handler that ran between frames, may
                        // already have retired a card.
                        const published = turn();
                        setLiveText(published.text);
                        setLiveThinking(published.thinking);
                        setLiveToolCalls(published.toolCalls);
                        // Parked T2 actions must be answerable NOW. The relay call
                        // blocks the CLI, so `done` cannot arrive until they are.
                        setLivePendingActions(published.pendingActions);
                        setStatusText(published.statusText);
                        setPendingControls(published.pendingControls);
                        if (published.cliModel) setCliModel(published.cliModel);
                        if (published.done) break;
                    }

                    if (done) break;
                }

                if (turn().error) throw new Error(turn().error ?? 'Unknown stream error');

                const assistantMessage = finalizeTurn(turn(), {
                    now: Date.now(),
                    id: newId(),
                    // A user-requested interrupt ends the turn through `done`, not
                    // through abort, so the label has to come from the ref.
                    interrupted: interruptedRef.current,
                });
                if (assistantMessage) setMessages((prev) => [...prev, assistantMessage]);
                turnSucceeded = true;
            } catch (err) {
                // The backend is still blocked on every parked action AND every
                // open permission card; the turn is over, so answer each exactly
                // once. Retire them from the turn FIRST (synchronously, before any
                // await) so a click racing the teardown finds nothing to answer
                // and cannot produce a second POST.
                const failed = turn();
                turnStateRef.current = clearPendingControls(clearPendingActions(failed));
                setLivePendingActions([]);
                setPendingControls([]);
                await postTeardown(failed);

                const aborted = err instanceof DOMException && err.name === 'AbortError';
                if (aborted) {
                    // Keep the partial reply and any tools that already ran, so the
                    // transcript still records what this turn actually did.
                    const partial = finalizeTurn(turn(), { now: Date.now(), id: newId(), interrupted: true });
                    if (partial) setMessages((prev) => [...prev, partial]);
                } else {
                    console.error('Assistant stream failed', err);
                    const detail = err instanceof Error ? err.message : String(err);
                    setMessages((prev) => [
                        ...prev,
                        {
                            id: newId(),
                            role: 'assistant',
                            // Keep whatever prose arrived before the failure — losing
                            // it hides how far the turn actually got.
                            text: failed.text
                                ? `${failed.text}\n\nError during communication: ${detail}`
                                : `Error during communication: ${detail}`,
                            isError: true,
                            thinking: failed.thinking || undefined,
                            toolCalls: failed.toolCalls.length > 0 ? failed.toolCalls : undefined,
                            timestamp: Date.now(),
                        },
                    ]);
                }
            } finally {
                setIsStreaming(false);
                setStatusText(null);
                setLiveText('');
                setLiveThinking('');
                setLiveToolCalls([]);
                // Anything still parked has either moved onto the finalized
                // message or been declined above; nothing stale carries over.
                setLivePendingActions([]);
                setPendingControls([]);
                turnStateRef.current = null;
                abortRef.current = null;
                activeTurnRef.current = false;

                const next = queueRef.current.shift();
                setQueuedSends(queueRef.current.map((q) => q.text));
                if (next) {
                    // Defer a tick so the resets above settle before the next turn.
                    window.setTimeout(() => void send(next.text, next.options), 0);
                } else if (turnSucceeded) {
                    onNotify?.('theDAW assistant', 'Response ready');
                }
            }
        },
        [applyEffects, postTeardown, endpoints.chat, getTurnContext, onNotify],
    );

    // -- controls -------------------------------------------------------------

    const stop = useCallback(() => {
        queueRef.current = [];
        setQueuedSends([]);
        abortRef.current?.abort();
    }, []);

    const interrupt = useCallback(async () => {
        interruptedRef.current = true;
        try {
            await fetch(endpoints.interrupt, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Never `null`: the route rejects it outright (422) and the turn
                // keeps running. The CLI session id lets the backend find the
                // session when the conversation id is missing or stale.
                body: JSON.stringify({
                    conversationId: conversationIdRef.current ?? turnStateRef.current?.conversationId ?? undefined,
                    claudeSessionId: sessionIdRef.current ?? undefined,
                }),
            });
        } catch (err) {
            // The interrupt never reached the backend, so the turn is NOT being
            // interrupted — leaving the flag set would mislabel it.
            interruptedRef.current = false;
            console.error('interrupt failed', err);
        }
    }, [endpoints.interrupt]);

    const answerControl = useCallback(
        async (requestId: string, response: ControlResponse, scope: ControlScope = 'once') => {
            // Drop the card immediately: the CLI is unblocked by this POST and a
            // second answer for the same requestId is a 403.
            //
            // It must come off the TURN as well as off React state. Clearing only
            // the latter left the turn's own list intact, and the very next frame
            // republished the answered card.
            // The request's OWN conversation id (stamped by the backend) wins over
            // the hook's: that is the key its pending entry lives under.
            const ownConversationId = turnStateRef.current?.pendingControls.find(
                (c) => c.requestId === requestId,
            )?.conversationId;
            if (turnStateRef.current) turnStateRef.current = dismissControl(turnStateRef.current, requestId);
            setPendingControls((prev) => prev.filter((c) => c.requestId !== requestId));
            try {
                await fetch(endpoints.controlResponse, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversationId: ownConversationId ?? conversationIdRef.current ?? undefined,
                        claudeSessionId: sessionIdRef.current ?? undefined,
                        requestId,
                        response,
                        scope,
                    }),
                });
            } catch (err) {
                console.error('control-response failed', err);
            }
        },
        [endpoints.controlResponse],
    );

    // -- parked T2 DAW tools --------------------------------------------------

    /**
     * Take a parked action out of BOTH homes, wherever it currently lives.
     *
     * Mid-turn it is only on the live turn (no message exists yet, because the
     * relay call is still blocking `done`); after the turn it is only on the
     * message. Retiring it in one place alone either leaves a dead card on
     * screen or lets `finalizeTurn` re-park an action the user already answered.
     */
    const retirePendingAction = useCallback((messageId: string | null, callId: string) => {
        if (turnStateRef.current) {
            turnStateRef.current = dismissPendingAction(turnStateRef.current, callId);
            setLivePendingActions(turnStateRef.current.pendingActions);
        } else {
            setLivePendingActions((prev) => prev.filter((p) => p.callId !== callId));
        }
        const trimmed = removePendingActionFromMessages(messagesRef.current, messageId, callId);
        messagesRef.current = trimmed;
        setMessages(trimmed);
    }, []);

    const runPendingAction = useCallback(
        async (messageId: string | null, callId: string) => {
            const parked = findPendingAction(
                turnStateRef.current?.pendingActions ?? [],
                messagesRef.current,
                messageId,
                callId,
            );
            if (!parked) return;
            retirePendingAction(messageId, callId);
            await runAction(callId, { type: parked.type, payload: parked.payload }, parked.sessionId);
        },
        [retirePendingAction, runAction],
    );

    const skipPendingAction = useCallback(
        async (messageId: string | null, callId: string) => {
            const parked = findPendingAction(
                turnStateRef.current?.pendingActions ?? [],
                messagesRef.current,
                messageId,
                callId,
            );
            // Already answered (a second Skip, or Skip racing a Run): the relay has
            // its one answer; a second POST would contradict it.
            if (!parked) return;
            retirePendingAction(messageId, callId);
            await postRelayResult(callId, DECLINED_RESULT, true, parked.sessionId);
        },
        [retirePendingAction, postRelayResult],
    );

    // -- transcript helpers ---------------------------------------------------

    const retry = useCallback(async () => {
        const current = messagesRef.current;
        let lastUserIndex = -1;
        for (let i = current.length - 1; i >= 0; i--) {
            if (current[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }
        if (lastUserIndex < 0) return;
        const prompt = current[lastUserIndex].text;
        const trimmed = current.slice(0, lastUserIndex);
        messagesRef.current = trimmed;
        setMessages(trimmed);
        await send(prompt);
    }, [send]);

    const clear = useCallback(() => {
        queueRef.current = [];
        setQueuedSends([]);
        setMessages([]);
        messagesRef.current = [];
        setPendingControls([]);
        setLivePendingActions([]);
        sessionCostRef.current = 0;
        sessionIdRef.current = null;
        // A new chat is a new conversation. Keeping the old id pointed
        // control-response and interrupt at the conversation just abandoned.
        conversationIdRef.current = null;
    }, []);

    return {
        messages,
        setMessages,
        isStreaming,
        statusText,
        liveText,
        liveThinking,
        liveToolCalls,
        livePendingActions,
        pendingControls,
        queuedSends,
        cliModel,
        send,
        stop,
        interrupt,
        retry,
        clear,
        answerControl,
        runPendingAction,
        skipPendingAction,
    };
}
