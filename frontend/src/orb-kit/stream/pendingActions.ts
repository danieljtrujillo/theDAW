/**
 * Locating and retiring parked T2 DAW actions.
 *
 * A parked action lives in one of two places depending on when the user gets to
 * it, and the two are NOT interchangeable:
 *
 *  - the LIVE turn, while the relay call is still blocking the CLI. This is the
 *    normal case: `/api/mcp-relay/call` waits up to 115s for an answer, so the
 *    `done` frame cannot arrive until the user presses Run or Skip. There is no
 *    message to hang the card on yet.
 *  - a finalized `ChatMessage`, once the turn ended some other way (interrupt,
 *    a relay timeout that let the turn finish).
 *
 * `callId` is the real key in both cases — it is what answers the relay — so
 * lookup never depends on having the right `messageId`.
 */

import type { ChatMessage, ControlResponse, PendingDawAction } from './types';
import type { TurnState } from './frameReducer';

/** The result string that answers a declined T2 tool. */
export const DECLINED_RESULT = 'User declined.';

/** The denial sent for a permission card still open when its turn ends. */
export const TURN_ENDED_DENIAL = 'Turn ended before you answered';

/**
 * The `/api/mcp-relay/result` body. One builder for the live POST and the
 * teardown POST, so the relay-key fallback cannot drift between them: the key
 * off the frame wins; the CLI session id, then the conversation id, are only a
 * fallback for a backend that has not started sending it.
 */
export function relayResultBody(
    callId: string,
    result: string,
    isError: boolean,
    sessionId: string | undefined,
    fallback: { sessionId: string | null; conversationId: string | null },
): { sessionId: string; callId: string; result: string; isError: boolean } {
    return {
        sessionId: sessionId ?? fallback.sessionId ?? fallback.conversationId ?? '',
        callId,
        result,
        isError,
    };
}

/** Find a parked action in the live turn first, then in the transcript. */
export function findPendingAction(
    live: PendingDawAction[],
    messages: ChatMessage[],
    messageId: string | null,
    callId: string,
): PendingDawAction | null {
    const fromLive = live.find((action) => action.callId === callId);
    if (fromLive) return fromLive;

    if (messageId) {
        const scoped = messages
            .find((message) => message.id === messageId)
            ?.pendingActions?.find((action) => action.callId === callId);
        if (scoped) return scoped;
    }

    for (const message of messages) {
        const found = message.pendingActions?.find((action) => action.callId === callId);
        if (found) return found;
    }
    return null;
}

/**
 * Drop an answered action from the transcript. An emptied list becomes
 * `undefined` rather than `[]` so the renderer's `pendingActions?.map` does not
 * keep an empty card slot alive.
 */
export function removePendingActionFromMessages(
    messages: ChatMessage[],
    messageId: string | null,
    callId: string,
): ChatMessage[] {
    return messages.map((message) => {
        if (!message.pendingActions) return message;
        if (messageId && message.id !== messageId) return message;
        if (!message.pendingActions.some((action) => action.callId === callId)) return message;
        const rest = message.pendingActions.filter((action) => action.callId !== callId);
        return { ...message, pendingActions: rest.length > 0 ? rest : undefined };
    });
}

/**
 * Everything the teardown path must decline.
 *
 * On error or abort the relay call is dead but the backend is still blocked on
 * it; answering each one keeps the model from waiting out a 115s timeout for a
 * turn that already failed.
 */
export function declineTargets(state: TurnState): Array<{ callId: string; sessionId?: string }> {
    return state.pendingActions.map((action) => ({ callId: action.callId, sessionId: action.sessionId }));
}

export interface TeardownPost {
    endpoint: 'relayResult' | 'controlResponse';
    body: Record<string, unknown>;
}

/**
 * Every POST a failed or aborted turn owes the backend, in order.
 *
 * Both kinds of card leave something on the backend BLOCKED:
 *  - a parked T2 action holds `/api/mcp-relay/call` open for up to 115s;
 *  - an open permission card holds the CLI child until the 180s auto-deny.
 * The turn is over, so neither answer can matter any more — but NOT sending it
 * makes the next turn queue behind a dead one. Each gets exactly one answer.
 *
 * Controls are skipped without a conversation id: control-response is keyed by
 * it and would 404. Relay declines still go out, with the usual key fallback.
 */
export function teardownPosts(
    state: TurnState,
    ids: { conversationId: string | null; sessionId: string | null },
): TeardownPost[] {
    const posts: TeardownPost[] = declineTargets(state).map((target) => ({
        endpoint: 'relayResult',
        body: relayResultBody(target.callId, DECLINED_RESULT, true, target.sessionId, ids),
    }));

    const denial: ControlResponse = { behavior: 'deny', message: TURN_ENDED_DENIAL };
    for (const control of state.pendingControls) {
        // The control's own id (stamped by the backend) first; the hook's as a fallback.
        const conversationId = control.conversationId ?? ids.conversationId;
        if (conversationId) {
            posts.push({
                endpoint: 'controlResponse',
                body: {
                    conversationId,
                    requestId: control.requestId,
                    response: denial,
                    scope: 'once',
                },
            });
        }
    }
    return posts;
}
