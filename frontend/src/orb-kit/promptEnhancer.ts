import { buildtheDAWAppContext } from './appContext';
import { useAssistantPermissionStore } from './permission/assistantPermissionStore';
import { uuid } from './utils';

export type PromptEnhancementTarget = 'positive' | 'negative';

/** sessionStorage slot for the BACKEND conversation id (control-response,
 *  interrupt and permission-mode all address this one). */
export const CONVERSATION_ID_KEY = 'thedaw:conversationId';
/** sessionStorage slot for the Claude CLI's own `--resume` session id. */
export const CLAUDE_SESSION_ID_KEY = 'thedaw:claudeSessionId';

/**
 * The enhancer's OWN conversation, per tab.
 *
 * The Claude provider keeps one persistent CLI child per conversation, and a
 * turn sent to a busy conversation queues behind it. Riding the assistant
 * panel's conversation meant an enhancement could wait on (or interleave with)
 * the user's live chat, and write its CLI session id into the panel's resume
 * slot. The enhancer therefore never reads or writes the two keys above.
 */
export const ENHANCE_CONVERSATION_ID_KEY = 'thedaw:enhanceConversationId';
/** The enhancer's own CLI `--resume` id, for the conversation above. */
export const ENHANCE_CLAUDE_SESSION_ID_KEY = 'thedaw:enhanceClaudeSessionId';

/** The relay result that answers any DAW tool the model tries from here. */
export const ENHANCER_TOOL_DECLINED = 'Prompt enhancer cannot run DAW tools';

/** The deny message that answers any CLI permission prompt from here. */
export const ENHANCER_PERMISSION_DENIED = 'Prompt enhancer cannot use tools — answer from your own knowledge';

interface PromptEnhancementRequest {
    target: PromptEnhancementTarget;
    positivePrompt: string;
    negativePrompt: string;
}

interface ProviderSelection {
    provider: string;
    model: string;
}

function getStoredProviderSelection(): ProviderSelection {
    if (typeof localStorage === 'undefined') {
        return { provider: 'gemini', model: 'gemini-flash-recent' };
    }

    const provider = localStorage.getItem('thedaw:provider') || 'gemini';
    const model = localStorage.getItem('thedaw:model') || 'gemini-flash-recent';
    return { provider, model };
}

function readSession(key: string): string | null {
    try {
        return sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeSession(key: string, value: string): void {
    try {
        sessionStorage.setItem(key, value);
    } catch {
        // Non-fatal: continuity is optional for prompt enhancement.
    }
}

/** This tab's enhancer conversation id, minted on first use. */
function enhanceConversationId(): string {
    const existing = readSession(ENHANCE_CONVERSATION_ID_KEY);
    if (existing) return existing;
    const minted = `enhance-${uuid()}`;
    writeSession(ENHANCE_CONVERSATION_ID_KEY, minted);
    return minted;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * Answer a relay tool call with an error, immediately.
 *
 * The CLI is BLOCKED on a `client_tool_call` until a result is POSTed. The
 * enhancer has no DAW dispatcher and must never run one, so leaving the call
 * unanswered would stall the turn until the backend's relay timeout. Fire and
 * forget: a failed POST only means the backend times the call out itself.
 */
function declineToolCall(frame: Record<string, unknown>, conversationId: string | null): void {
    const callId = str(frame.callId) || str(frame.id);
    if (!callId) return;
    void fetch('/api/mcp-relay/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            // The backend stamps the relay key on the frame; post it back
            // verbatim. Fall back to our conversation id, never to ''.
            sessionId: str(frame.sessionId) || str(frame.session_id) || conversationId || '',
            callId,
            result: ENHANCER_TOOL_DECLINED,
            isError: true,
        }),
    }).catch((err) => {
        console.error('prompt enhancer: tool decline POST failed', err);
    });
}

/**
 * Deny a CLI permission prompt, immediately.
 *
 * A `control_request` BLOCKS the CLI until it is answered. The enhancer has no
 * permission card to show, and an enhancement has no business editing files or
 * running commands, so it answers "deny" itself instead of leaving its session
 * stuck until the backend's 180s auto-deny. Always on the enhancer's OWN
 * conversation — the panel's is never addressed from here. Fire and forget, like
 * the relay decline: a failed POST only means the backend auto-denies later.
 */
function denyControlRequest(frame: Record<string, unknown>, conversationId: string | null): void {
    const requestId = str(frame.requestId);
    if (!requestId || !conversationId) return;
    void fetch('/api/assistant/control-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            conversationId,
            requestId,
            response: { behavior: 'deny', message: ENHANCER_PERMISSION_DENIED },
            scope: 'once',
        }),
    }).catch((err) => {
        console.error('prompt enhancer: permission deny POST failed', err);
    });
}

function stripCodeFence(text: string): string {
    return text
        .replace(/^```(?:\w+)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

export function buildPromptEnhancementRequest({
    target,
    positivePrompt,
    negativePrompt,
}: PromptEnhancementRequest): string {
    const targetLabel = target === 'positive' ? 'positive prompt' : 'negative prompt';
    const otherLabel = target === 'positive' ? 'negative prompt' : 'positive prompt';

    return [
        `Enhance ONLY the ${targetLabel} for Stable Audio 3.`,
        `Use theDAW (by GANTASMO) documentation and prompting rules, especially docs/guides/prompting.md, docs/USER_GUIDE.md, and relevant UI prompt guidance from the backend RAG context.`,
        `Consider BOTH prompts. The ${otherLabel} is context and constraints; do not ignore it.`,
        `Keep the result optimized for Stable Audio 3 audio generation: concise, concrete, richly descriptive, and focused on sound, instrumentation, mood, production, texture, stereo field, and artifacts to avoid where relevant.`,
        `Preserve the user's intent, but make it more precise and generation-ready.`,
        target === 'negative'
            ? `For a negative prompt, return exclusions only: unwanted artifacts, styles, instruments, mix problems, vocals, noise, distortion, or other things to avoid. Do not include desired positive qualities.`
            : `For a positive prompt, return desired audio qualities only. Do not include negative exclusions unless they naturally belong in the negative prompt.`,
        `Positive prompt:\n${positivePrompt || '(empty)'}`,
        `Negative prompt:\n${negativePrompt || '(empty)'}`,
        `Return exactly one block and nothing else:`,
        `<enhanced_prompt>your enhanced ${targetLabel} here</enhanced_prompt>`,
    ].join('\n\n');
}

export function extractEnhancedPrompt(rawText: string): string {
    const tagMatch = rawText.match(/<enhanced_prompt>([\s\S]*?)<\/enhanced_prompt>/i);
    if (tagMatch?.[1]) return tagMatch[1].trim();

    try {
        const parsed = JSON.parse(rawText.trim());
        if (parsed && typeof parsed.enhanced_prompt === 'string') {
            return parsed.enhanced_prompt.trim();
        }
        if (parsed && typeof parsed.prompt === 'string') {
            return parsed.prompt.trim();
        }
    } catch {
        // Fall through to plain text cleanup.
    }

    return stripCodeFence(rawText)
        .replace(/^enhanced\s+(positive|negative)\s+prompt\s*:\s*/i, '')
        .replace(/^prompt\s*:\s*/i, '')
        .trim();
}

export async function enhanceStableAudioPrompt(request: PromptEnhancementRequest): Promise<string> {
    const { provider, model } = getStoredProviderSelection();
    const appContext = buildtheDAWAppContext({
        selectedProvider: provider,
        selectedModel: model,
        attachments: [],
    });
    const promptRequest = buildPromptEnhancementRequest(request);

    const body: Record<string, unknown> = {
        messages: [
            { role: 'system', content: appContext },
            { role: 'user', content: promptRequest },
        ],
        provider,
        model,
    };

    const isClaude = provider === 'claude';
    // The enhancer's own conversation (see ENHANCE_CONVERSATION_ID_KEY) — never
    // the panel's, so it neither queues behind the user's live chat nor
    // resumes its CLI session.
    const conversationId = isClaude ? enhanceConversationId() : null;

    if (isClaude) {
        // No `claudeMode`: there is one persistent mode now and the backend
        // ignores the field (plan contract C2).
        body.conversationId = conversationId;
        const claudeSessionId = readSession(ENHANCE_CLAUDE_SESSION_ID_KEY);
        if (claudeSessionId) body.claudeSessionId = claudeSessionId;
        // The backend applies the mode on every turn. Omitting it would let an
        // enhancement quietly put the session back to the default ("ask").
        body.claude_permission_mode = useAssistantPermissionStore.getState().mode;
    }

    const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`Prompt enhancement failed with HTTP ${response.status}.`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Prompt enhancement returned no response body.');

    const decoder = new TextDecoder();
    let buffer = '';
    let rawText = '';
    let errorText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';

        for (const frame of frames) {
            const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
            if (!dataLine) continue;
            let event: Record<string, unknown>;
            try {
                const parsed: unknown = JSON.parse(dataLine.slice(6));
                if (!parsed || typeof parsed !== 'object') continue;
                event = parsed as Record<string, unknown>;
            } catch {
                continue; // Ignore malformed SSE frames.
            }

            // Both frame shapes are accepted: the C1 contract the Claude
            // backend speaks (`text`, `message`, `sessionId`) and the legacy
            // one the other providers still emit (`delta`, `error`,
            // `session_id`). Reading only the legacy names is what made every
            // Claude enhancement come back as "empty prompt".
            const type = str(event.type);

            if (type === 'client_tool_call' || type === 'function_call') {
                // Its `sessionId` is the MCP relay key, not the CLI session —
                // it must not be captured below.
                declineToolCall(event, conversationId);
                continue;
            }

            if (type === 'control_request') {
                denyControlRequest(event, conversationId);
                continue;
            }

            if (isClaude) {
                const cliSessionId = str(event.sessionId) || str(event.session_id);
                if (cliSessionId) writeSession(ENHANCE_CLAUDE_SESSION_ID_KEY, cliSessionId);
            }

            if (type === 'text_delta' || type === 'text') {
                rawText += str(event.text) || str(event.delta);
            } else if (type === 'error') {
                errorText = str(event.message) || str(event.error) || 'Prompt enhancement failed.';
            }
        }
    }

    if (errorText) throw new Error(errorText);

    const enhanced = extractEnhancedPrompt(rawText);
    if (!enhanced) throw new Error('Prompt enhancer returned an empty prompt.');
    return enhanced;
}


