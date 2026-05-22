import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ModelInfo } from '../ProviderModelSelector';
import { handleStableDAWAction, type AssistantActionPayload } from '../actionHandlers';
import { uuid } from '../utils';

// ---------------------------------------------------------------------------
// Action tag parsing — extracts <action>{...}</action> from LLM text
// ---------------------------------------------------------------------------

const ACTION_TAG_RE = /<action>([\s\S]*?)<\/action>/g;
const TRAILING_PARTIAL_RE = /<a(?:c(?:t(?:i(?:o(?:n)?)?)?)?)?$/;

function extractAndExecuteActions(
    rawText: string,
    executed: Set<string>,
): string {
    let match: RegExpExecArray | null;
    ACTION_TAG_RE.lastIndex = 0;
    while ((match = ACTION_TAG_RE.exec(rawText)) !== null) {
        const json = match[1].trim();
        if (!executed.has(json)) {
            executed.add(json);
            try {
                const action: AssistantActionPayload = JSON.parse(json);
                handleStableDAWAction(action);
            } catch { /* malformed JSON — skip */ }
        }
    }

    // Strip complete action tags
    let display = rawText.replace(ACTION_TAG_RE, '');
    // Hide partial <action> tag still being streamed
    const partialIdx = display.lastIndexOf('<action>');
    if (partialIdx !== -1 && display.indexOf('</action>', partialIdx) === -1) {
        display = display.slice(0, partialIdx);
    }
    // Hide trailing partial tag opener (e.g. "<act")
    display = display.replace(TRAILING_PARTIAL_RE, '');
    // Clean up extra whitespace from stripped tags
    display = display.replace(/\n{3,}/g, '\n\n').trim();
    return display;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrbChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    isError?: boolean;
    isStreaming?: boolean;
}

export interface OrbProvider {
    id: string;
    label: string;
    default_model: string;
    has_key: boolean;
    is_local: boolean;
}

export interface OrbChatConfig {
    apiBaseUrl?: string; // defaults to '/api/assistant'
    defaultProvider?: string;
    defaultModel?: string;
}

export interface OrbAttachment {
    id: string;
    name: string;
    mime: string;
    size: number;
    file: File;
}

export interface OrbChatState {
    messages: OrbChatMessage[];
    isProcessing: boolean;
    statusText: string;

    // Provider/model
    providers: OrbProvider[];
    selectedProvider: string;
    selectedModel: string;
    providerModels: Record<string, ModelInfo[]>;
    loadingModels: boolean;

    // API keys
    apiKeys: Record<string, string>;

    // Attachments
    attachments: OrbAttachment[];
    addAttachments: (files: File[]) => void;
    removeAttachment: (id: string) => void;
    clearAttachments: () => void;

    // Actions
    sendMessage: (content: string) => Promise<void>;
    stop: () => void;
    clearHistory: () => void;
    setProvider: (providerId: string) => void;
    setModel: (model: string) => void;
    saveApiKey: (providerId: string, key: string) => void;
    clearApiKey: (providerId: string) => void;
    getActiveKey: (providerId: string) => string;
    maskKey: (key: string) => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYS_STORAGE_KEY = 'stabledaw_orb_api_keys';
const FALLBACK_PROVIDERS: OrbProvider[] = [
    { id: 'gemini', label: 'Google Gemini', default_model: 'gemini-flash-recent', has_key: false, is_local: false },
    { id: 'openai', label: 'OpenAI', default_model: '', has_key: false, is_local: false },
    { id: 'anthropic', label: 'Anthropic', default_model: '', has_key: false, is_local: false },
    { id: 'grok', label: 'xAI Grok', default_model: '', has_key: false, is_local: false },
    { id: 'groq', label: 'Groq', default_model: '', has_key: false, is_local: false },
    { id: 'openrouter', label: 'OpenRouter', default_model: '', has_key: false, is_local: false },
    { id: 'openrouter-free', label: 'OpenRouter Free', default_model: '', has_key: false, is_local: false },
    { id: 'ollama', label: 'Ollama (Local)', default_model: '', has_key: false, is_local: true },
    { id: 'lmstudio', label: 'LM Studio (Local)', default_model: '', has_key: false, is_local: true },
    { id: 'llamacpp', label: 'llama.cpp (Local)', default_model: '', has_key: false, is_local: true },
    { id: 'vllm', label: 'vLLM (Local)', default_model: '', has_key: false, is_local: true },
    { id: 'claude', label: 'Claude Code', default_model: '', has_key: true, is_local: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            const idx = result.indexOf(',');
            resolve(idx >= 0 ? result.slice(idx + 1) : result);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOrbChat(config: OrbChatConfig = {}): OrbChatState {
    const apiBase = config.apiBaseUrl || '/api/assistant';

    const [messages, setMessages] = useState<OrbChatMessage[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [attachments, setAttachments] = useState<OrbAttachment[]>([]);

    // Ref to avoid stale closure in sendMessage
    const messagesRef = useRef<OrbChatMessage[]>([]);
    messagesRef.current = messages;

    const isProcessingRef = useRef(false);
    isProcessingRef.current = isProcessing;

    // Conversation continuity for providers that support it (e.g. Claude)
    const conversationIdRef = useRef<string | null>(null);

    // Provider state
    const [providers, setProviders] = useState<OrbProvider[]>(FALLBACK_PROVIDERS);
    const [selectedProvider, setSelectedProvider] = useState(config.defaultProvider || 'gemini');
    const [selectedModel, setSelectedModel] = useState(config.defaultModel || 'gemini-flash-recent');
    const [providerModels, setProviderModels] = useState<Record<string, ModelInfo[]>>({});
    const [loadingModels, setLoadingModels] = useState(false);
    const failedFetches = useRef<Set<string>>(new Set());

    const abortRef = useRef<AbortController | null>(null);

    const stop = useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setIsProcessing(false);
        setStatusText('');
    }, []);

    // API keys from localStorage
    const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => {
        try { return JSON.parse(localStorage.getItem(KEYS_STORAGE_KEY) || '{}'); }
        catch { return {}; }
    });

    // Fetch providers on mount
    useEffect(() => {
        fetch(`${apiBase}/providers`).then(r => r.json()).then(data => {
            if (data.providers?.length) setProviders(data.providers);
        }).catch(() => {});
    }, [apiBase]);

    const normalizeModel = (m: any): ModelInfo => {
        if (typeof m === 'string') return { id: m, name: m, capabilities: [] };
        if (m && typeof m === 'object' && (m.id || m.name)) {
            return { id: m.id || m.name || String(m), name: m.name || m.id || String(m), capabilities: Array.isArray(m.capabilities) ? m.capabilities : [] };
        }
        return { id: String(m), name: String(m), capabilities: [] };
    };

    // Fetch models when provider changes
    useEffect(() => {
        if (!selectedProvider || (providerModels[selectedProvider]?.length && !failedFetches.current.has(selectedProvider))) return;
        setLoadingModels(true);
        fetch(`${apiBase}/models/${selectedProvider}`).then(r => r.json()).then(data => {
            const raw: any[] = data.models || [];
            const models = raw.map(normalizeModel);
            failedFetches.current.delete(selectedProvider);
            setProviderModels(prev => ({ ...prev, [selectedProvider]: models }));
            const modelIds = models.map(m => m.id);
            if (modelIds.length > 0 && !modelIds.includes(selectedModel)) {
                setSelectedModel(modelIds[0]);
            }
        }).catch(() => {
            failedFetches.current.add(selectedProvider);
            const prov = providers.find(p => p.id === selectedProvider);
            if (prov?.default_model) {
                setProviderModels(prev => ({ ...prev, [selectedProvider]: [normalizeModel(prov.default_model)] }));
            }
        }).finally(() => setLoadingModels(false));
    }, [selectedProvider, providers]);

    // Key management
    const saveApiKey = useCallback((providerId: string, key: string) => {
        setApiKeys(prev => {
            const updated = { ...prev, [providerId]: key };
            localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(updated));
            return updated;
        });
    }, []);

    const clearApiKey = useCallback((providerId: string) => {
        setApiKeys(prev => {
            const updated = { ...prev };
            delete updated[providerId];
            localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(updated));
            return updated;
        });
    }, []);

    const getActiveKey = useCallback((providerId: string): string => {
        return apiKeys[providerId] || '';
    }, [apiKeys]);

    const maskKey = useCallback((key: string): string => {
        return key ? `${'*'.repeat(Math.max(0, key.length - 4))}${key.slice(-4)}` : '';
    }, []);

    const addAttachments = useCallback((files: File[]) => {
        setAttachments(prev => [
            ...prev,
            ...files.map(f => ({
                id: uuid(),
                name: f.name,
                mime: f.type || 'application/octet-stream',
                size: f.size,
                file: f,
            })),
        ]);
    }, []);

    const removeAttachment = useCallback((id: string) => {
        setAttachments(prev => prev.filter(a => a.id !== id));
    }, []);

    const clearAttachments = useCallback(() => {
        setAttachments([]);
    }, []);

    // Ref so sendMessage closure always sees latest attachments
    const attachmentsRef = useRef<OrbAttachment[]>([]);
    attachmentsRef.current = attachments;

    // Send message via SSE
    const sendMessage = useCallback(async (content: string) => {
        const pendingAttachments = attachmentsRef.current;
        if (!content.trim() && pendingAttachments.length === 0) return;
        if (isProcessingRef.current) {
            if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
        }

        const userMsg: OrbChatMessage = {
            id: uuid(),
            role: 'user',
            content: content.trim(),
            timestamp: new Date(),
        };

        // Build attachments payload before clearing state
        let attachmentsPayload: Array<{ name: string; mime: string; data: string }> | undefined;
        if (pendingAttachments.length > 0) {
            attachmentsPayload = await Promise.all(
                pendingAttachments.map(async (a) => ({
                    name: a.name,
                    mime: a.mime || 'application/octet-stream',
                    data: await fileToBase64(a.file),
                }))
            );
        }
        // Clear attachments immediately so UI resets before the network round-trip
        setAttachments([]);
        const assistantId = uuid();
        const assistantMsg: OrbChatMessage = {
            id: assistantId,
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            isStreaming: true,
        };

        setMessages(prev => [...prev, userMsg, assistantMsg]);
        setIsProcessing(true);
        setStatusText('');

        const rawContent = { value: '' };
        const executedActions = new Set<string>();

        try {
            const history = [...messagesRef.current.filter(m => m.role !== 'assistant' || m.content), userMsg]
                .map(m => ({ role: m.role, content: m.content }));

            const body: Record<string, unknown> = {
                messages: history,
                provider: selectedProvider,
                model: selectedModel,
            };

            // Pass client-side API key if the host app stored one
            if (apiKeys[selectedProvider]) {
                body.apiKey = apiKeys[selectedProvider];
            }

            // Conversation continuity for providers that track sessions
            if (conversationIdRef.current) {
                body.conversationId = conversationIdRef.current;
            }

            // Attach file payloads when present
            if (attachmentsPayload) {
                body.attachments = attachmentsPayload;
            }

            const controller = new AbortController();
            abortRef.current = controller;
            const response = await fetch(`${apiBase}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                signal: controller.signal,
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            // Some providers return plain JSON instead of SSE
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const json = await response.json();
                setMessages(prev => prev.map(m =>
                    m.id === assistantId
                        ? { ...m, content: json.message || json.error || 'No response.', isStreaming: false, isError: !!json.error }
                        : m
                ));
                return;
            }

            // SSE streaming
            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split('\n\n');
                buffer = frames.pop() || '';

                for (const frame of frames) {
                    const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
                    if (!dataLine) continue;
                    try {
                        const event = JSON.parse(dataLine.slice(6));

                        // Track conversation/session ID for continuity
                        if (event.session_id) {
                            conversationIdRef.current = event.session_id;
                        }

                        if (event.type === 'text_delta') {
                            rawContent.value += event.delta;
                            const display = extractAndExecuteActions(rawContent.value, executedActions);
                            setMessages(prev => prev.map(m =>
                                m.id === assistantId ? { ...m, content: display } : m
                            ));
                        } else if (event.type === 'action') {
                            const actionPayload: AssistantActionPayload = {
                                type: event.action_type || event.type,
                                payload: event.payload,
                            };
                            handleStableDAWAction(actionPayload);
                        } else if (event.type === 'tool_call' || event.type === 'function_call') {
                            const name = event.name || event.function?.name || 'tool';
                            setStatusText(`Using ${name}...`);
                        } else if (event.type === 'status') {
                            const raw = event.message || '';
                            const friendly = raw.startsWith('spawned') ? 'Connecting...'
                                : raw.startsWith('thinking') ? 'Thinking...'
                                : raw.startsWith('restarting') ? 'Restarting...'
                                : raw.includes('session initialized') ? 'Ready'
                                : raw.startsWith('Connecting') ? raw.replace(/\s*\(.*\)/, '')
                                : raw.startsWith('Key rate') ? 'Retrying...'
                                : raw;
                            setStatusText(friendly);
                        } else if (event.type === 'error') {
                            setMessages(prev => prev.map(m =>
                                m.id === assistantId ? { ...m, content: event.error, isError: true, isStreaming: false } : m
                            ));
                        } else if (event.type === 'done') {
                            setMessages(prev => prev.map(m =>
                                m.id === assistantId ? { ...m, isStreaming: false } : m
                            ));
                        }
                    } catch { /* skip malformed frames */ }
                }
            }

            // Finalize — do one last action-tag pass on the full text
            if (rawContent.value) {
                const finalDisplay = extractAndExecuteActions(rawContent.value, executedActions);
                setMessages(prev => prev.map(m =>
                    m.id === assistantId ? { ...m, isStreaming: false, content: finalDisplay || 'No response.' } : m
                ));
            } else {
                setMessages(prev => prev.map(m =>
                    m.id === assistantId ? { ...m, isStreaming: false, content: m.content || 'No response.' } : m
                ));
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Unknown error';
            setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: errMsg, isError: true, isStreaming: false } : m
            ));
        } finally {
            setIsProcessing(false);
            setStatusText('');
        }
    }, [apiBase, selectedProvider, selectedModel, apiKeys, attachments]);

    const clearHistory = useCallback(() => {
        setMessages([]);
        conversationIdRef.current = null;
    }, []);

    const setProvider = useCallback((providerId: string) => {
        setSelectedProvider(providerId);
        const prov = providers.find(p => p.id === providerId);
        const models = providerModels[providerId];
        if (models?.length) {
            setSelectedModel(models[0].id);
        } else if (prov?.default_model) {
            setSelectedModel(prov.default_model);
        }
    }, [providers, providerModels]);

    const setModel = useCallback((model: string) => setSelectedModel(model), []);

    return {
        messages, isProcessing, statusText,
        providers, selectedProvider, selectedModel, providerModels, loadingModels,
        apiKeys,
        attachments, addAttachments, removeAttachment, clearAttachments,
        sendMessage, stop, clearHistory, setProvider, setModel,
        saveApiKey, clearApiKey, getActiveKey, maskKey,
    };
}
