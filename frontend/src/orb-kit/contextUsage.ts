/**
 * The context meter's data.
 *
 * Ported from the Foundry orb: `refreshContextUsage` in
 * `VST-Foundry-UI/VST-UI-FOUNDRY/src/components/orb/useChatStream.ts` (which
 * asks the CLI for `get_context_usage` and keeps the estimate when it does not
 * answer) and `getContextPercentage` in `AIAssistantOrb.tsx` (the percentage the
 * bar is drawn from).
 *
 * theDAW asks the backend instead of hand-rolling the control request: the
 * cross-ticket contract is `POST /api/assistant/context-usage` with
 * `{"conversationId": id}` answering `{"ok": true, "usage": {...}}`, 404 for an
 * unknown conversation and 504 when the CLI stays silent.
 *
 * Every failure resolves to `null`. This is called from an effect after a turn
 * ends, where a rejection would be an unhandled one, and the meter has a
 * perfectly good fallback — the character-count estimate — for exactly this
 * case.
 */

/** The CLI's real context-window reading. `percentage` is 0-100. */
export interface ContextUsage {
    totalTokens: number;
    maxTokens: number;
    percentage: number;
}

/** The part of a transcript row the estimate counts. */
export interface ContextEstimateMessage {
    text?: string;
    thinking?: string;
}

/** The contract endpoint. */
const CONTEXT_USAGE_URL = '/api/assistant/context-usage';

/**
 * Characters of transcript the estimate treats as a full window.
 *
 * The Foundry's number, kept identical so both orbs read the same at the same
 * transcript length. It is a rough stand-in for a token count, which is why the
 * label says "Memory" rather than "Context" while it is in use.
 */
const ESTIMATE_CHARS_PER_WINDOW = 150_000;

/** `Number(x)` but never NaN — a missing token count shows as 0, not "NaN". */
function finiteNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Ask the backend what the CLI's context window looks like.
 *
 * Returns `null` — never throws, never rejects — for: no conversation to ask
 * about, a non-200, `ok:false`, a body that is not JSON, and a body with no
 * usable `percentage`. The caller keeps whatever reading it already had.
 *
 * `fetchImpl` exists so a test can answer without a network; production passes
 * nothing.
 */
export async function fetchContextUsage(
    conversationId: string | null | undefined,
    fetchImpl: typeof fetch = fetch,
): Promise<ContextUsage | null> {
    if (!conversationId) return null;
    try {
        const response = await fetchImpl(CONTEXT_USAGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId }),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as
            | { ok?: unknown; usage?: Record<string, unknown> | null }
            | null
            | undefined;
        if (!body || typeof body !== 'object' || body.ok !== true) return null;
        const usage = body.usage;
        if (!usage || typeof usage !== 'object') return null;
        const percentage = Number(usage.percentage);
        if (!Number.isFinite(percentage)) return null;
        return {
            totalTokens: finiteNumber(usage.totalTokens ?? usage.total_tokens),
            maxTokens: finiteNumber(usage.maxTokens ?? usage.max_tokens),
            percentage,
        };
    } catch {
        // A dead backend, an aborted fetch, a non-JSON body — all of them mean
        // "no reading", and the estimate covers it.
        return null;
    }
}

/**
 * The number the meter draws, 0-100.
 *
 * The CLI's real reading wins whenever there is one. `percentage` is documented
 * as 0-100 but a 0-1 fraction is accepted defensively (the Foundry does the
 * same) — 0.25 is a quarter of the window, not a quarter of a percent.
 *
 * Without a reading it is an estimate over the transcript's own characters,
 * reasoning included: reasoning is part of what the window is holding.
 */
export function contextPercentage(
    usage: ContextUsage | null | undefined,
    messages: readonly ContextEstimateMessage[],
): number {
    if (usage && Number.isFinite(usage.percentage)) {
        const percent = usage.percentage <= 1 ? usage.percentage * 100 : usage.percentage;
        return Math.min(100, Math.max(0, Math.round(percent)));
    }
    const totalChars = messages.reduce(
        (acc, message) => acc + (message?.text?.length || 0) + (message?.thinking?.length || 0),
        0,
    );
    return Math.min(100, Math.max(0, Math.floor((totalChars / ESTIMATE_CHARS_PER_WINDOW) * 100)));
}
