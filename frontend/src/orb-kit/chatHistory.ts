/**
 * Orb chat history — durable, client-side conversation storage.
 *
 * The assistant panel keeps its live transcript in React state, which is lost
 * on reload. This module persists each conversation to localStorage so the
 * user can reload, close/reopen the app, and resume any past chat.
 *
 * Storage is per-browser (the user chose local-only over a backend store).
 * Everything is best-effort and wrapped so a disabled/full localStorage never
 * throws into the panel — it just degrades to "no history".
 */
import type { ChatMessage, ToolCallEntry, TurnMeta } from './stream/types';

const CONV_KEY = 'thedaw:orb:conversations:v1';
const ACTIVE_KEY = 'thedaw:orb:activeId:v1';
/** Hard cap on stored conversations; oldest (by updatedAt) are trimmed. */
const MAX_CONVERSATIONS = 100;

export interface StoredConversation {
    id: string;
    /** Human label — derived from the first user message, or renamed. */
    title: string;
    messages: ChatMessage[];
    provider: string;
    model: string;
    /** Backend conversation id — the key for control-response / interrupt. */
    sessionId: string | null;
    /** The Claude CLI's own resume id, distinct from the conversation id. */
    claudeSessionId?: string | null;
    /** Which Claude mode this chat ran in, so resuming it puts the picker back
     *  where the user left it. Optional: a chat saved by a panel that takes its
     *  mode from the permission store simply has none. */
    claudeMode?: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * Epoch millis from whatever storage holds.
 *
 * The pre-port panel wrote `timestamp` as a Date, which JSON turns into an ISO
 * string; the transcript shape stores a number. Both are accepted, and a value
 * that parses to neither falls back to now — an NaN timestamp poisons every
 * downstream sort and format.
 */
function reviveTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return Date.now();
}

/** What an unfinished tool's result reads as once the turn is gone. */
export const INTERRUPTED_TOOL_RESULT = 'Interrupted before completion';

function reviveToolCalls(value: unknown): ToolCallEntry[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const calls = value
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => {
            // A tool that was still 'executing' when the tab closed will never
            // get its tool_result — nothing is left to deliver one. Restoring
            // the status verbatim leaves a spinner turning forever in a
            // transcript that is not streaming, so it revives as what it
            // actually was: a call that never came back.
            const stranded = t.status === 'executing';
            return {
                toolId: String(t.toolId ?? ''),
                name: String(t.name ?? ''),
                inputJson: typeof t.inputJson === 'string' ? t.inputJson : '{}',
                result: typeof t.result === 'string'
                    ? t.result
                    : stranded
                        ? INTERRUPTED_TOOL_RESULT
                        : undefined,
                isError: t.isError === true || stranded ? true : undefined,
                status: (stranded || t.status === 'error' ? 'error' : 'success') as ToolCallEntry['status'],
                subCalls: reviveToolCalls(t.subCalls),
            };
        });
    return calls.length > 0 ? calls : undefined;
}

/**
 * Rebuild the transcript from storage.
 *
 * `toolCalls` and `meta` are carried because a tool-only turn keeps ALL of its
 * content there — dropping them would reload the chat as a row with nothing in
 * it. `pendingActions` is deliberately NOT carried: a parked T2 tool is tied to
 * an MCP-relay `callId` that the backend has long since timed out, so a Run
 * button restored from disk would answer a call nobody is waiting on.
 */
function reviveMessages(msgs: unknown): ChatMessage[] {
    if (!Array.isArray(msgs)) return [];
    return msgs
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m) => {
            // `content` is the pre-port field name; `text` is the current one.
            const raw = m.text !== undefined ? m.text : m.content;
            const meta = m.meta && typeof m.meta === 'object' ? (m.meta as TurnMeta) : undefined;
            return {
                id: typeof m.id === 'string' && m.id ? m.id : `restored-${Math.random().toString(36).slice(2, 11)}`,
                role: m.role === 'user' ? 'user' : 'assistant',
                text: typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw),
                thinking: typeof m.thinking === 'string' ? m.thinking : undefined,
                toolCalls: reviveToolCalls(m.toolCalls),
                meta,
                attachments: Array.isArray(m.attachments) ? (m.attachments as ChatMessage['attachments']) : undefined,
                isError: m.isError === true ? true : undefined,
                timestamp: reviveTimestamp(m.timestamp),
            };
        });
}

/**
 * Is this snapshot worth a write?
 *
 * The persist effect re-runs on every `messages` change AND on mount for a
 * restored chat, where the snapshot is byte-identical to what is already
 * stored; writing anyway would only bump `updatedAt` and reshuffle the history
 * list under the user. Comparing prose alone is not enough any more: a
 * tool-only turn legitimately has `text: ''` and keeps everything it did in
 * `toolCalls`/`meta`, so two different turns can share the same empty text.
 */
export function conversationNeedsWrite(
    existing: StoredConversation | null,
    snapshot: ChatMessage[],
): boolean {
    if (snapshot.length === 0) return false;
    if (!existing) return true;
    if (existing.messages.length !== snapshot.length) return true;
    const prev = existing.messages[existing.messages.length - 1];
    const last = snapshot[snapshot.length - 1];
    if (!prev || !last) return true;
    return (
        prev.id !== last.id ||
        prev.text !== last.text ||
        !!prev.isError !== !!last.isError ||
        (prev.toolCalls?.length ?? 0) !== (last.toolCalls?.length ?? 0) ||
        !!prev.meta !== !!last.meta
    );
}

/** All stored conversations, newest-updated first. Never throws. */
export function loadConversations(): StoredConversation[] {
    try {
        const raw = localStorage.getItem(CONV_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((c) => c && typeof c.id === 'string')
            .map((c) => ({ ...c, messages: reviveMessages(c.messages) }))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch {
        return [];
    }
}

/** Write the full list (sorted + capped). On quota error, trims oldest and
 *  retries until it fits. Returns the list actually persisted. On total
 *  failure (even a single conversation will not fit) it returns the list
 *  still in storage, so a failed write is never treated as saved. */
function writeAll(list: StoredConversation[]): StoredConversation[] {
    let capped = [...list]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_CONVERSATIONS);
    if (capped.length === 0) {
        // An empty list is a real state (the last conversation was deleted).
        // setItem('[]') would work too, but removing the key is cleaner and —
        // unlike falling through the loop below — it actually persists.
        try {
            localStorage.removeItem(CONV_KEY);
        } catch {
            /* localStorage unavailable — nothing to do */
        }
        return [];
    }
    while (capped.length > 0) {
        try {
            localStorage.setItem(CONV_KEY, JSON.stringify(capped));
            return capped;
        } catch (e) {
            // Only a quota failure is worth retrying with less data; anything
            // else (SecurityError, storage disabled) repeats forever.
            const quota =
                e instanceof DOMException &&
                (e.name === 'QuotaExceededError' ||
                    (e as DOMException & { code?: number }).code === 22);
            if (!quota) {
                console.warn('chatHistory: write failed', e);
                break;
            }
            if (capped.length === 1) break; // one convo still won't fit → give up
            capped = capped.slice(0, capped.length - 1); // drop the oldest, retry
        }
    }
    // Nothing was written — report what storage actually holds, not `capped`.
    return loadConversations();
}

/** First non-empty user line, trimmed to a short title. */
export function deriveTitle(messages: ChatMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user' && m.text.trim());
    const base = (firstUser?.text || '').trim().replace(/\s+/g, ' ') || 'New chat';
    return base.length > 48 ? `${base.slice(0, 47)}…` : base;
}

/** Insert or replace a conversation by id; returns the new list. */
export function upsertConversation(conv: StoredConversation): StoredConversation[] {
    const rest = loadConversations().filter((c) => c.id !== conv.id);
    // Strip the parked T2 actions before they reach disk: their relay callIds
    // die with the turn, so storing them only wastes quota on a Run button that
    // could never be answered. (reviveMessages drops them on read too, for
    // transcripts written before this.)
    const clean: StoredConversation = {
        ...conv,
        messages: conv.messages.map(({ pendingActions: _parked, ...rest2 }) => rest2),
    };
    return writeAll([clean, ...rest]);
}

export function deleteConversation(id: string): StoredConversation[] {
    const rest = loadConversations().filter((c) => c.id !== id);
    const written = writeAll(rest);
    if (getActiveId() === id) setActiveId(null);
    return written;
}

export function renameConversation(id: string, title: string): StoredConversation[] {
    const next = loadConversations().map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c,
    );
    return writeAll(next);
}

export function getConversation(id: string | null): StoredConversation | null {
    if (!id) return null;
    return loadConversations().find((c) => c.id === id) || null;
}

export function getActiveId(): string | null {
    try {
        return localStorage.getItem(ACTIVE_KEY);
    } catch {
        return null;
    }
}

export function setActiveId(id: string | null): void {
    try {
        if (id) localStorage.setItem(ACTIVE_KEY, id);
        else localStorage.removeItem(ACTIVE_KEY);
    } catch {
        /* localStorage unavailable — nothing to do */
    }
}

/** Wipe ALL saved conversations + the active pointer off this machine. Backs
 *  the "Clear all history" affordance so transcripts do not persist forever. */
export function clearAllConversations(): void {
    try {
        localStorage.removeItem(CONV_KEY);
        localStorage.removeItem(ACTIVE_KEY);
    } catch {
        /* localStorage unavailable — nothing to do */
    }
}
