import { buildStableDAWAppContext } from './appContext';

export type PromptEnhancementTarget = 'positive' | 'negative';

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

    const provider = localStorage.getItem('stabledaw:provider') || 'gemini';
    const model = localStorage.getItem('stabledaw:model') || 'gemini-flash-recent';
    return { provider, model };
}

function resolveClaudeMode(model: string): string {
    if (model.startsWith('claude-code-')) return model.replace('claude-code-', '');
    return localStorage.getItem('stabledaw:claudeMode') || 'interactive';
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
        `Use the StableDAW documentation and prompting rules, especially docs/guides/prompting.md, docs/USER_GUIDE.md, and relevant UI prompt guidance from the backend RAG context.`,
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
    const appContext = buildStableDAWAppContext({
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

    if (provider === 'claude') {
        body.claudeMode = resolveClaudeMode(model);
        try {
            const sessionId = sessionStorage.getItem('stabledaw:conversationId');
            if (sessionId) {
                body.conversationId = sessionId;
                body.claudeSessionId = sessionId;
            }
        } catch {
            // Non-fatal: session continuity is optional for prompt enhancement.
        }
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
            try {
                const event = JSON.parse(dataLine.slice(6));
                if (event.session_id) {
                    try { sessionStorage.setItem('stabledaw:conversationId', event.session_id); } catch {}
                }
                if (event.type === 'text_delta') rawText += event.delta || '';
                if (event.type === 'error') errorText = event.error || 'Prompt enhancement failed.';
            } catch {
                // Ignore malformed SSE frames.
            }
        }
    }

    if (errorText) throw new Error(errorText);

    const enhanced = extractEnhancedPrompt(rawText);
    if (!enhanced) throw new Error('Prompt enhancer returned an empty prompt.');
    return enhanced;
}
