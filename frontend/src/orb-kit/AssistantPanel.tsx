import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { X, Send, Sparkles, Bot, User, Loader2, Command, Play, Zap, RefreshCw, Trash2, Minimize2, Maximize2, Copy, Square, Paperclip, Mic, MicOff, FileText, Image as ImageIcon, Music, Film } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ProviderModelSelector, type ModelInfo } from './ProviderModelSelector';
import { actionFromAssistantEvent, statusFromAssistantEvent } from './assistantEvents';
import { buildStableDAWAppContext } from './appContext';
import { uuid } from './utils';

// Inline clipboard helper (no external util available in StableDAW)
const copyToClipboard = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
        const result = String(reader.result || '');
        const commaIdx = result.indexOf(',');
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
});

interface AssistantPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onExecuteAction: (action: { type: string; payload?: any }) => void;
    orbPosition?: { x: number; y: number };
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    action?: { type: string; payload?: any };
    pendingAction?: { type: string; payload?: any };
    data?: any;
    suggestions?: string[];
    isError?: boolean;
}

interface AssistantAttachment {
    id: string;
    file: File;
    name: string;
    mime: string;
    size: number;
}


const QUICK_COMMANDS = [
    { label: '🎵 Make Beat', command: 'Make me a chill lo-fi beat' },
    { label: '🔬 Analyze', command: 'Analyze the currently playing song' },
    { label: '📚 Library', command: 'Go to library' },
    { label: '🔥 Trending', command: 'Show trending songs' },
    { label: '⚡ Full Sync', command: 'Start a full sync' },
    { label: '📊 Stats', command: 'Show my statistics' },
];

const CAPABILITY_HINTS = [
    "Try: 'Download song [id]' or 'Download all trending'",
    "Try: 'Build family tree for [song id]'",
    "Try: 'Create a playlist called My Favorites'",
    "Try: 'Search for electronic music'",
    "Try: 'Generate a prompt for chill lo-fi beats'",
    "Try: 'What's in my download queue?'",
    "Try: 'Start discovery radio'",
    "Try: 'Enrich metadata for all songs'",
];

// Panel dimensions
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 550;
const PANEL_MARGIN = 16;

// Provider info type and defaults (shared between useState init and fetch fallback)
type ProviderInfo = { id: string; label: string; default_model: string; has_key: boolean; is_local: boolean };
const ASSISTANT_DEFAULTS_VERSION = 'claude-opus-4-6-effort-max-v1';
const DEFAULT_ASSISTANT_PROVIDER = 'claude';
const DEFAULT_ASSISTANT_MODEL = 'claude-opus-4-6';
const DEFAULT_CLAUDE_MODE = 'interactive';
const DEFAULT_ASSISTANT_EFFORT = 'max';

const DEFAULT_PROVIDERS: ProviderInfo[] = [
   { id: 'gemini', label: 'Gemini', default_model: 'gemini-flash-recent', has_key: true, is_local: false },
    { id: 'claude', label: 'Claude Code', default_model: DEFAULT_ASSISTANT_MODEL, has_key: true, is_local: false },
   { id: 'openai', label: 'OpenAI', default_model: 'gpt-4.1-mini', has_key: false, is_local: false },
   { id: 'anthropic', label: 'Anthropic', default_model: 'claude-sonnet-4-20250514', has_key: false, is_local: false },
   { id: 'grok', label: 'xAI Grok', default_model: 'grok-3-mini-fast', has_key: false, is_local: false },
   { id: 'groq', label: 'Groq', default_model: 'llama-3.3-70b-versatile', has_key: false, is_local: false },
   { id: 'openrouter-free', label: 'OpenRouter Free', default_model: 'google/gemma-3-1b-it:free', has_key: false, is_local: false },
   { id: 'openrouter', label: 'OpenRouter', default_model: 'google/gemma-3-1b-it:free', has_key: false, is_local: false },
   { id: 'ollama', label: 'Ollama (Local)', default_model: '', has_key: true, is_local: true },
   { id: 'lmstudio', label: 'LM Studio (Local)', default_model: '', has_key: true, is_local: true },
];

function readInitialAssistantSelection() {
    try {
        if (localStorage.getItem('stabledaw:assistantDefaultsVersion') !== ASSISTANT_DEFAULTS_VERSION) {
            localStorage.setItem('stabledaw:provider', DEFAULT_ASSISTANT_PROVIDER);
            localStorage.setItem('stabledaw:model', DEFAULT_ASSISTANT_MODEL);
            localStorage.setItem('stabledaw:claudeMode', DEFAULT_CLAUDE_MODE);
            localStorage.setItem('stabledaw:assistantDefaultsVersion', ASSISTANT_DEFAULTS_VERSION);
        }

        return {
            provider: localStorage.getItem('stabledaw:provider') || DEFAULT_ASSISTANT_PROVIDER,
            model: localStorage.getItem('stabledaw:model') || DEFAULT_ASSISTANT_MODEL,
            claudeMode: localStorage.getItem('stabledaw:claudeMode') || DEFAULT_CLAUDE_MODE,
        };
    } catch {
        return {
            provider: DEFAULT_ASSISTANT_PROVIDER,
            model: DEFAULT_ASSISTANT_MODEL,
            claudeMode: DEFAULT_CLAUDE_MODE,
        };
    }
}

export const AssistantPanel: React.FC<AssistantPanelProps> = ({
    isOpen,
    onClose,
    onExecuteAction,
    orbPosition = { x: 20, y: typeof window !== 'undefined' ? window.innerHeight - 140 : 500 },
}) => {
    const initialAssistantSelection = useMemo(readInitialAssistantSelection, []);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [statusText, setStatusText] = useState<string>('');
    const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
    const [currentHint, setCurrentHint] = useState(0);
    const [showModelInfo, setShowModelInfo] = useState(false);
    const [settingsTab, setSettingsTab] = useState<'model' | 'keys'>('model');
    const [selectedProvider, setSelectedProvider] = useState<string>(initialAssistantSelection.provider);

    const [selectedModel, setSelectedModel] = useState<string>(initialAssistantSelection.model);
    const [claudeMode, setClaudeMode] = useState<string>(initialAssistantSelection.claudeMode);
    const conversationIdRef = useRef<string | null>(
        (() => { try { return sessionStorage.getItem('stabledaw:conversationId'); } catch { return null; } })()
    );
    const abortRef = useRef<AbortController | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const recognitionRef = useRef<any>(null);

    const toggleSTT = useCallback(() => {
        if (isRecording) {
            recognitionRef.current?.stop();
            return;
        }

        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'assistant',
                content: 'Speech recognition is not supported in this browser. Try Chrome or Edge.',
                timestamp: new Date(),
                isError: true,
            }]);
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognitionRef.current = recognition;

        recognition.onstart = () => setIsRecording(true);

        recognition.onresult = (event: any) => {
            const transcript = Array.from(event.results)
                .map((r: any) => r[0].transcript)
                .join('');
            setInput(transcript);
        };

        recognition.onend = () => {
            setIsRecording(false);
            recognitionRef.current = null;
        };

        recognition.onerror = (event: any) => {
            setIsRecording(false);
            recognitionRef.current = null;
            if (event.error !== 'aborted') {
                console.error('STT error:', event.error);
            }
        };

        recognition.start();
    }, [isRecording]);

    useEffect(() => {
        return () => { recognitionRef.current?.stop(); };
    }, []);

    const addAttachments = (files: File[]) => {
        if (!files.length) return;
        setAttachments(prev => [
            ...prev,
            ...files.map(file => ({
                id: uuid(),
                file,
                name: file.name,
                mime: file.type || 'application/octet-stream',
                size: file.size,
            })),
        ]);
    };

    const removeAttachment = (id: string) => {
        setAttachments(prev => prev.filter(item => item.id !== id));
    };

    const renderAttachmentIcon = (mime: string) => {
        if (mime.startsWith('audio/')) return <Music size={12} />;
        if (mime.startsWith('image/')) return <ImageIcon size={12} />;
        if (mime.startsWith('video/')) return <Film size={12} />;
        return <FileText size={12} />;
    };

    const stopGeneration = () => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setIsProcessing(false);
        setStatusText('');
    };

    // API key pools — multiple keys per provider with rotation
    const [keyPools, setKeyPools] = useState<Record<string, {
       total: number; available: number; cooldown: number;
       keys: Array<{ id: string; masked: string; source: string; available: boolean; fail_count: number }>;
    }>>({});
    const [keyInput, setKeyInput] = useState('');
    const [editingKeyProvider, setEditingKeyProvider] = useState<string | null>(null);
    const [ingestingKeys, setIngestingKeys] = useState(false);

    // Load key pool status on mount and when provider changes
    const refreshKeyStatus = useCallback(async () => {
       try {
          const resp = await fetch('/api/assistant/keys');
          if (resp.ok) {
             const data = await resp.json();
             if (data.pools) {
                const detailed: typeof keyPools = {};
                for (const [pid, info] of Object.entries(data.pools) as any) {
                   // Fetch detailed status for providers that have keys
                   try {
                      const dr = await fetch(`/api/assistant/keys/${pid}`);
                      if (dr.ok) detailed[pid] = await dr.json();
                   } catch {}
                }
                setKeyPools(detailed);
             }
          }
       } catch {}
    }, []);

    useEffect(() => { refreshKeyStatus(); }, []);

    const ingestKeys = async (providerId: string, raw: string) => {
       if (!raw.trim()) return;
       setIngestingKeys(true);
       try {
          const resp = await fetch(`/api/assistant/keys/${providerId}/ingest`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ keys: raw }),
          });
          if (resp.ok) {
             const data = await resp.json();
             setKeyPools(prev => ({ ...prev, [providerId]: data.status }));
          }
       } catch {}
       setIngestingKeys(false);
       setKeyInput('');
       setEditingKeyProvider(null);
    };

    const clearProviderKeys = async (providerId: string) => {
       try {
          const resp = await fetch(`/api/assistant/keys/${providerId}`, { method: 'DELETE' });
          if (resp.ok) {
             const data = await resp.json();
             setKeyPools(prev => ({ ...prev, [providerId]: data.status }));
          }
       } catch {}
    };

    const removeOneKey = async (providerId: string, keyHash: string) => {
       try {
          const resp = await fetch(`/api/assistant/keys/${providerId}/${keyHash}`, { method: 'DELETE' });
          if (resp.ok) {
             const data = await resp.json();
             setKeyPools(prev => ({ ...prev, [providerId]: data.status }));
          }
       } catch {}
    };

    // Dynamic provider + model loading from backend
    const [providerCatalog, setProviderCatalog] = useState<ProviderInfo[]>(DEFAULT_PROVIDERS);
    const [providerModels, setProviderModels] = useState<Record<string, Array<string | ModelInfo>>>({});
    const failedFetches = useRef<Set<string>>(new Set());
    const [loadingModels, setLoadingModels] = useState<string | null>(null);

    useEffect(() => {
       fetch('/api/assistant/providers').then(r => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
       }).then(data => {
          if (data.providers?.length) setProviderCatalog(data.providers);
          else setProviderCatalog(DEFAULT_PROVIDERS);
       }).catch(() => {
          setProviderCatalog(DEFAULT_PROVIDERS);
       });
    }, []);

     const resolveClaudeMode = (model: string) => {
         if (model.startsWith('claude-code-')) return model.replace('claude-code-', '');
         return claudeMode || DEFAULT_CLAUDE_MODE;
     };

    // Fetch models when provider changes
    useEffect(() => {
       if (!selectedProvider) return;
       if (providerModels[selectedProvider]?.length && !failedFetches.current.has(selectedProvider)) return;

       setLoadingModels(selectedProvider);
       fetch(`/api/assistant/models/${selectedProvider}`).then(r => r.json()).then(data => {
          const raw: any[] = data.models || [];
          // Preserve full ModelInfo objects when the API returns them; keep strings for backward compat
          const models: Array<string | ModelInfo> = raw.map((m: any) => {
             if (typeof m === 'string') return m;
             if (m && typeof m === 'object' && (m.id || m.name)) {
                return {
                   id: m.id || m.name || String(m),
                   name: m.name || m.id || String(m),
                   capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
                } as ModelInfo;
             }
             return String(m);
          });
          failedFetches.current.delete(selectedProvider);
          setProviderModels(prev => ({ ...prev, [selectedProvider]: models }));
          const modelIds = models.map(m => typeof m === 'string' ? m : m.id);
          if (modelIds.length > 0 && !modelIds.includes(selectedModel)) {
             setSelectedModel(modelIds[0]);
          }
       }).catch(() => {
          failedFetches.current.add(selectedProvider);
          const prov = providerCatalog.find(p => p.id === selectedProvider);
          if (prov?.default_model) {
             setProviderModels(prev => ({ ...prev, [selectedProvider]: [prov.default_model] }));
          }
       }).finally(() => setLoadingModels(null));
    }, [selectedProvider, providerCatalog]);

    // Normalize a raw model entry (string | ModelInfo) into a ModelInfo object
    const normalizeModel = (m: string | ModelInfo): ModelInfo =>
       typeof m === 'string' ? { id: m, name: m, capabilities: [] } : m;

    // Build providers list for the dropdown — all models normalized to ModelInfo
    const providers = providerCatalog.map(p => {
       const raw = providerModels[p.id] || (p.default_model ? [p.default_model] : []);
       return {
          id: p.id,
          label: p.label + (p.is_local ? ' (local)' : ''),
          models: raw.map(normalizeModel),
       };
    });
    const activeProvider = providers.find(p => p.id === selectedProvider) || providers[0];

    const handleModelChange = (model: string) => {
       setSelectedModel(model);
           };
    const handleProviderChange = (providerId: string) => {
       setSelectedProvider(providerId);
       const prov = providers.find(p => p.id === providerId);
       if (prov && prov.models.length > 0) {
          const firstModelId = prov.models[0].id;
          setSelectedModel(firstModelId);
                 }
    };
    useEffect(() => { localStorage.setItem('stabledaw:provider', selectedProvider); }, [selectedProvider]);
    useEffect(() => { localStorage.setItem('stabledaw:model', selectedModel); }, [selectedModel]);
    useEffect(() => { localStorage.setItem('stabledaw:claudeMode', claudeMode); }, [claudeMode]);
     useEffect(() => {
         if (selectedProvider === 'claude') setClaudeMode(resolveClaudeMode(selectedModel));
     }, [selectedProvider, selectedModel]);

    const [isMinimized, setIsMinimized] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);






    // Calculate panel position based on orb position
    const panelPosition = useMemo(() => {
        const orbCenterX = orbPosition.x + 32; // Orb is ~64px wide
        const orbCenterY = orbPosition.y + 32;

        // Determine which quadrant the orb is in and position panel accordingly
        const isOnRight = orbCenterX > window.innerWidth / 2;
        const isOnBottom = orbCenterY > window.innerHeight / 2;

        let x: number;
        let y: number;

        if (isOnRight) {
            // Panel to the left of orb
            x = Math.max(PANEL_MARGIN, orbPosition.x - PANEL_WIDTH - PANEL_MARGIN);
        } else {
            // Panel to the right of orb
            x = Math.min(window.innerWidth - PANEL_WIDTH - PANEL_MARGIN, orbPosition.x + 80);
        }

        if (isOnBottom) {
            // Panel above orb
            y = Math.max(PANEL_MARGIN, orbPosition.y - PANEL_HEIGHT - PANEL_MARGIN);
        } else {
            // Panel below orb (or aligned with it)
            y = Math.min(window.innerHeight - PANEL_HEIGHT - PANEL_MARGIN - 80, orbPosition.y);
        }

        // Ensure panel stays within viewport
        x = Math.max(PANEL_MARGIN, Math.min(x, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN));
        y = Math.max(PANEL_MARGIN, Math.min(y, window.innerHeight - PANEL_HEIGHT - PANEL_MARGIN - 80));

        return { x, y };
    }, [orbPosition]);

    // Rotate hints
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentHint(prev => (prev + 1) % CAPABILITY_HINTS.length);
        }, 5000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (isOpen && inputRef.current && !isMinimized) {
            inputRef.current.focus();
        }
    }, [isOpen, isMinimized]);




    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const sendMessage = async (text: string) => {
        const pendingAttachments = attachments;
        const promptText = text.trim() || (pendingAttachments.length ? 'Analyze the attached file(s).' : '');
        if (!promptText && pendingAttachments.length === 0) return;

        // If currently generating, stop it first
        if (isProcessing) stopGeneration();


        setStatusText('');
        setInput('');

        let attachmentsPayload: Array<{ name: string; mime: string; data: string }> | undefined;
        if (pendingAttachments.length > 0) {
            setStatusText(`Preparing ${pendingAttachments.length} attachment${pendingAttachments.length === 1 ? '' : 's'}...`);
            attachmentsPayload = await Promise.all(pendingAttachments.map(async item => ({
                name: item.name,
                mime: item.mime,
                data: await fileToBase64(item.file),
            })));
            setAttachments([]);
        }

        const attachmentSummary = pendingAttachments.length
            ? `\n\nAttached: ${pendingAttachments.map(item => `${item.name} (${formatBytes(item.size)})`).join(', ')}`
            : '';
        const appContext = buildStableDAWAppContext({
            selectedProvider,
            selectedModel,
            attachments: pendingAttachments.map(item => ({
                name: item.name,
                mime: item.mime,
                size: item.size,
            })),
        });

        const userMessage: Message = {
            id: uuid(),
            role: 'user',
            content: `${promptText}${attachmentSummary}`,
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMessage]);
        setIsProcessing(true);

        // Create placeholder assistant message for streaming
        const assistantId = uuid();
        const assistantMessage: Message = {
            id: assistantId,
            role: 'assistant',
            content: '',
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, assistantMessage]);

        try {
            // SSE stream from backend for all providers
            const controller = new AbortController();
                abortRef.current = controller;
                const response = await fetch('/api/assistant/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                    signal: controller.signal,
                    body: JSON.stringify({
                        messages: [
                            { role: 'system', content: appContext },
                            ...messages.filter(m => m.role !== 'assistant' || m.content).map(m => ({ role: m.role, content: m.content })),
                            { role: 'user', content: promptText },
                        ],
                        provider: selectedProvider,
                        model: selectedModel,
                        ...(attachmentsPayload ? { attachments: attachmentsPayload } : {}),
                        ...(selectedProvider === 'claude' ? {
                            effort: DEFAULT_ASSISTANT_EFFORT,
                            claudeMode: resolveClaudeMode(selectedModel),
                            conversationId: conversationIdRef.current,
                            claudeSessionId: conversationIdRef.current,
                        } : {}),

                    }),
                });

                if (!response.ok) {
                    throw new Error(`Backend error: ${response.status}`);
                }

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
                            if (event.session_id) {
                                conversationIdRef.current = event.session_id;
                                try { sessionStorage.setItem('stabledaw:conversationId', event.session_id); } catch {}
                            }

                            const executableAction = actionFromAssistantEvent(event);
                            if (executableAction) {
                                onExecuteAction(executableAction);
                                setMessages(prev => prev.map(msg =>
                                    msg.id === assistantId
                                        ? {
                                            ...msg,
                                            action: executableAction,
                                            content: msg.content || `Executed action: ${executableAction.type}`,
                                        }
                                        : msg
                                ));
                                continue;
                            }

                            const toolStatus = statusFromAssistantEvent(event);
                            if (toolStatus) {
                                setStatusText(toolStatus);
                                continue;
                            }

                            if (event.type === 'text_delta') {
                                setMessages(prev => prev.map(msg => {
                                    if (msg.id !== assistantId) return msg;
                                    let updated = msg.content + event.delta;
                                    const actionRx = /<action>([\s\S]*?)<\/action>/g;
                                    let match: RegExpExecArray | null;
                                    while ((match = actionRx.exec(updated)) !== null) {
                                        try {
                                            const parsed = JSON.parse(match[1]);
                                            onExecuteAction(parsed);
                                        } catch {}
                                    }
                                    updated = updated.replace(actionRx, '').trim();
                                    return { ...msg, content: updated };
                                }));
                            } else if (event.type === 'status') {
                                setStatusText(event.message);
                            } else if (event.type === 'error') {
                                setMessages(prev => prev.map(msg =>
                                    msg.id === assistantId
                                        ? { ...msg, content: event.error, isError: true }
                                        : msg
                                ));
                            }
                        } catch { /* skip malformed frames */ }
                    }
                }

                // Finalize — set final content from accumulated message
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantId
                        ? { ...msg, content: msg.content || 'No response.' }
                        : msg
                ));
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantId
                        ? { ...msg, content: msg.content || '[Cancelled]' }
                        : msg
                ));
            } else {
                console.error('Message processing error:', error);
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantId
                        ? {
                            ...msg,
                            content: "I encountered an error processing your request. Please try again.",
                            isError: true,
                            suggestions: ['Try again', 'Check settings']
                        }
                        : msg
                ));
            }
        } finally {
            abortRef.current = null;
            setStatusText('');
            setIsProcessing(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        sendMessage(input);
    };

    const handleQuickCommand = (command: string) => {
        sendMessage(command);
    };

    const handleSuggestionClick = (suggestion: string) => {
        handleQuickCommand(suggestion);
    };

    const handleClearHistory = () => {
        setMessages([]);
    };

    if (!isOpen) return null;

    // Minimized state - just show a small bar
    if (isMinimized) {
        return (
            <div
                className="fixed z-50 bg-surface/95 backdrop-blur-sm border border-border rounded-xl shadow-2xl overflow-hidden"
                style={{
                    left: `${panelPosition.x}px`,
                    top: `${panelPosition.y}px`,
                    width: '280px',
                }}
            >
                <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-primary/10 via-purple-500/10 to-pink-500/10">
                    <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary via-purple-500 to-pink-500 flex items-center justify-center relative">
                            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-primary via-purple-500 to-pink-500 animate-spin-slow opacity-50 blur-sm"></div>
                            <div className="w-3 h-3 rounded-full bg-white/90 z-10"></div>
                        </div>
                        <span className="font-semibold text-sm">StableDAW</span>
                        {messages.length > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-primary/20 text-primary rounded-full">
                                {messages.length}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setIsMinimized(false)}
                            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
                            title="Expand"
                        >
                            <Maximize2 size={14} />
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
                            title="Close"
                            aria-label="Close assistant"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="fixed z-50 bg-surface/95 backdrop-blur-sm border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200"
            style={{
                left: `${panelPosition.x}px`,
                top: `${panelPosition.y}px`,
                width: `${PANEL_WIDTH}px`,
                height: `${PANEL_HEIGHT}px`,
            }}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-gradient-to-r from-primary/10 via-purple-500/10 to-pink-500/10">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary via-purple-500 to-pink-500 flex items-center justify-center animate-pulse relative">
                        <div className="absolute inset-0 rounded-full bg-gradient-to-br from-primary via-purple-500 to-pink-500 animate-spin-slow opacity-50 blur-sm"></div>
                        <div className="w-4 h-4 rounded-full bg-white/90 z-10"></div>
                    </div>
                    <div>
                        <h2 className="font-bold text-sm">
                            GANTASMO-b0t
                        </h2>
                        <p className="text-[10px] text-muted">Stable Audio 3 expert</p>
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setShowModelInfo(!showModelInfo)}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-muted hover:text-white"
                        title="Model Info"
                    >
                        <Zap size={14} />
                    </button>
                    <button
                        onClick={handleClearHistory}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-muted hover:text-white"
                        title="Clear History"
                    >
                        <Trash2 size={14} />
                    </button>
                    <button
                        onClick={() => setIsMinimized(true)}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-muted hover:text-white"
                        title="Minimize"
                    >
                        <Minimize2 size={14} />
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
                        title="Close"
                        aria-label="Close assistant"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {showModelInfo && (
                <div className="border-b border-border">
                    <div className="flex border-b border-white/5">
                        <button onClick={() => setSettingsTab('model')} className={`flex-1 px-3 py-1.5 text-[10px] font-medium transition-colors ${settingsTab === 'model' ? 'text-primary border-b border-primary' : 'text-muted hover:text-white'}`}>Chat</button>
                        <button onClick={() => setSettingsTab('keys')} className={`flex-1 px-3 py-1.5 text-[10px] font-medium transition-colors ${settingsTab === 'keys' ? 'text-primary border-b border-primary' : 'text-muted hover:text-white'}`}>Keys</button>
                    </div>

                    {settingsTab === 'model' && (
                        <div className="px-4 py-2.5 bg-gradient-to-r from-blue-500/10 to-purple-500/10 space-y-2">
                            <ProviderModelSelector
                                providers={providers}
                                selectedProvider={selectedProvider}
                                selectedModel={selectedModel}
                                onProviderChange={handleProviderChange}
                                onModelChange={handleModelChange}
                                loading={!!loadingModels}
                            />
                            <div className="flex items-center justify-between text-[10px] pt-0.5">
                                <span className="text-muted">Active: <span className="font-mono text-primary">{selectedModel}</span></span>
                                <span className="font-mono text-green-400">
                                    {selectedProvider === 'claude'
                                        ? `effort ${DEFAULT_ASSISTANT_EFFORT}`
                                        : `${keyPools[selectedProvider]?.available ?? '?'}/${keyPools[selectedProvider]?.total ?? '?'} keys`}
                                </span>
                            </div>
                        </div>
                    )}

                    {settingsTab === 'keys' && (
                        <div className="px-4 py-2.5 bg-gradient-to-r from-purple-500/10 to-pink-500/10 space-y-1 max-h-56 overflow-y-auto custom-scrollbar">
                            {providerCatalog.filter(p => p.id !== 'claude' && !p.is_local).map(p => {
                                const pool = keyPools[p.id];
                                const keyCount = pool?.total || 0;
                                const availCount = pool?.available || 0;
                                return (
                                <div key={p.id} className="py-1.5 border-b border-white/5 last:border-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-muted w-20 shrink-0 truncate" title={p.label}>{p.label}</span>
                                        <div className="flex-1 flex items-center gap-1.5">
                                            {keyCount > 0 ? (
                                                <span className="text-[9px] font-mono">
                                                    <span className="text-green-400">{availCount}</span>
                                                    <span className="text-muted">/{keyCount} keys</span>
                                                    {pool && pool.cooldown > 0 && <span className="text-yellow-400 ml-1">({pool.cooldown} cooling)</span>}
                                                </span>
                                            ) : (
                                                <span className="text-[9px] text-muted/50">{p.has_key ? 'env only' : 'no keys'}</span>
                                            )}
                                            <button
                                                onClick={() => { setEditingKeyProvider(editingKeyProvider === p.id ? null : p.id); setKeyInput(''); }}
                                                className="ml-auto text-[9px] text-primary/70 hover:text-primary"
                                            >{editingKeyProvider === p.id ? 'Cancel' : (keyCount > 0 ? '+ Add' : 'Add keys')}</button>
                                            {keyCount > 0 && (
                                                <button onClick={() => clearProviderKeys(p.id)} className="text-[9px] text-red-400/50 hover:text-red-400">Clear</button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Key input area — supports pasting multiple keys */}
                                    {editingKeyProvider === p.id && (
                                        <div className="mt-1.5 space-y-1">
                                            <textarea
                                                value={keyInput}
                                                onChange={e => setKeyInput(e.target.value)}
                                                placeholder="Paste keys (one per line, or comma/semicolon separated)..."
                                                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-white focus:outline-none focus:border-primary/50 resize-none"
                                                rows={3}
                                                autoFocus
                                                onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey && keyInput.trim()) ingestKeys(p.id, keyInput); }}
                                            />
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[9px] text-muted/40 flex-1">Ctrl+Enter to save. Comma, newline, or semicolon separated.</span>
                                                <button
                                                    onClick={() => ingestKeys(p.id, keyInput)}
                                                    disabled={!keyInput.trim() || ingestingKeys}
                                                    className="px-2.5 py-0.5 bg-primary/20 text-primary text-[9px] rounded hover:bg-primary/30 disabled:opacity-50"
                                                >{ingestingKeys ? 'Saving...' : 'Ingest Keys'}</button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Show individual keys in pool */}
                                    {pool?.keys && pool.keys.length > 0 && editingKeyProvider !== p.id && (
                                        <div className="mt-1 space-y-0.5">
                                            {pool.keys.map((k, i) => (
                                                <div key={k.id} className="flex items-center gap-1.5 pl-2 text-[9px]">
                                                    <span className={`w-1.5 h-1.5 rounded-full ${k.available ? 'bg-green-400' : 'bg-yellow-400'}`} />
                                                    <span className="font-mono text-muted">{k.masked}</span>
                                                    <span className="text-muted/40">{k.source}</span>
                                                    {k.fail_count > 0 && <span className="text-red-400/60">{k.fail_count}x fail</span>}
                                                    {k.source !== 'env' && (
                                                        <button onClick={() => removeOneKey(p.id, k.id)} className="ml-auto text-red-400/40 hover:text-red-400">x</button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                );
                            })}
                            <div className="pt-1 text-[9px] text-muted/40 italic">Keys persisted on backend. Env vars auto-detected.</div>
                        </div>
                    )}
                </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center px-2">
                        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/20 via-purple-500/20 to-pink-500/20 flex items-center justify-center mb-3 animate-pulse">
                            <Sparkles size={28} className="text-primary" />
                        </div>
                        <h3 className="text-base font-bold mb-1">How can I help?</h3>
                        <p className="text-[11px] text-muted max-w-xs mb-1">
                            I have <span className="text-primary font-semibold">full access</span> to all app capabilities.
                        </p>
                        <p className="text-[10px] text-muted/70 mb-4 italic">
                            {CAPABILITY_HINTS[currentHint]}
                        </p>

                        {/* Quick Commands - Compact */}
                        <div className="flex flex-wrap gap-1.5 justify-center">
                            {QUICK_COMMANDS.map((cmd, i) => (
                                <button
                                    key={i}
                                    onClick={() => handleQuickCommand(cmd.command)}
                                    className="px-2.5 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-primary/30 rounded-full text-[11px] font-medium transition-all hover:scale-105"
                                >
                                    {cmd.label}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    messages.map((msg) => (
                        <div
                            key={msg.id}
                            className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            {msg.role === 'assistant' && (
                                <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${msg.isError ? 'bg-red-500/20' : 'bg-gradient-to-br from-primary to-pink-500'}`}>
                                    <Bot size={12} className={msg.isError ? 'text-red-400' : 'text-white'} />
                                </div>
                            )}
                            <div className="flex flex-col gap-1.5 max-w-[85%]">
                                <div
                                    className={`px-3 py-2 rounded-xl text-[12px] ${msg.role === 'user'
                                        ? 'bg-primary text-white rounded-br-sm'
                                        : msg.isError
                                            ? 'bg-red-500/10 border border-red-500/30 rounded-bl-sm'
                                            : 'bg-white/5 border border-white/10 rounded-bl-sm'
                                        }`}
                                >
                                    {msg.role === 'user' ? (
                                        <p className="whitespace-pre-wrap">{msg.content}</p>
                                    ) : (
                                        <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-li:my-0 prose-pre:bg-black/50 prose-pre:border prose-pre:border-white/10 prose-pre:p-2 prose-pre:my-2 prose-a:text-primary hover:prose-a:text-primary/80 text-[12px]">
                                            <ReactMarkdown
                                                remarkPlugins={[remarkGfm]}
                                                components={{
                                                    img({ src, alt, ...props }: any) {
                                                        return (
                                                            <img
                                                                src={src}
                                                                alt={alt}
                                                                className="max-w-full h-auto rounded-lg border border-white/10 my-2"
                                                                {...props}
                                                            />
                                                        );
                                                    },
                                                    code({ inline, className, children, ...props }: any) {
                                                        const match = /language-(\w+)/.exec(className || '')
                                                        const text = String(children).replace(/\n$/, '')
                                                        return !inline ? (
                                                            <div className="relative group">
                                                                <button
                                                                    onClick={() => copyToClipboard(text)}
                                                                    className="absolute right-2 top-2 p-1.5 bg-white/10 hover:bg-white/20 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                                                    title="Copy code"
                                                                >
                                                                    <Copy size={12} />
                                                                </button>
                                                                <code className={className} {...props}>
                                                                    {children}
                                                                </code>
                                                            </div>
                                                        ) : (
                                                            <code
                                                                className={`${className} cursor-pointer hover:bg-white/20 transition-colors px-1 rounded`}
                                                                onClick={() => copyToClipboard(text)}
                                                                title="Click to copy"
                                                                {...props}
                                                            >
                                                                {children}
                                                            </code>
                                                        )
                                                    }
                                                }}
                                            >
                                                {msg.content}
                                            </ReactMarkdown>
                                        </div>
                                    )}
                                    {msg.action && (
                                        <div className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center gap-1.5 text-[10px] opacity-70">
                                            <Command size={10} />
                                            <span className="font-mono">{msg.action.type}</span>
                                        </div>
                                    )}
                                    {msg.pendingAction && msg.role === 'assistant' && (
                                        <div className="mt-2 pt-2 border-t border-yellow-500/30 flex flex-col gap-2">
                                            <div className="flex items-center gap-1.5 text-[11px] text-yellow-400 font-medium">
                                                <Zap size={12} />
                                                <span>Requires Confirmation: <span className="font-mono">{msg.pendingAction.type}</span></span>
                                            </div>

                                            <div className="flex gap-2 mt-1">
                                                <button
                                                    onClick={() => {
                                                        onExecuteAction(msg.pendingAction!);
                                                        setMessages(prev => {
                                                            const updated = prev.map(m =>
                                                                m.id === msg.id ? { ...m, pendingAction: undefined } : m
                                                            );
                                                            return [...updated, {
                                                                id: uuid(),
                                                                role: 'assistant' as const,
                                                                content: 'Action "' + msg.pendingAction!.type + '" has been executed.',
                                                                timestamp: new Date(),
                                                            }];
                                                        });
                                                    }}
                                                    className="flex-1 bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/30 rounded py-1.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
                                                    disabled={isProcessing}
                                                >
                                                    <Play size={12} />
                                                    YES, DO IT
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setMessages(prev => prev.map(m =>
                                                            m.id === msg.id ? { ...m, pendingAction: undefined } : m
                                                        ));

                                                        // Just send a message back saying NO
                                                        handleQuickCommand("No, cancel that action. Do not run it.");
                                                    }}
                                                    className="flex-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded py-1.5 text-xs font-semibold transition-colors"
                                                    disabled={isProcessing}
                                                >
                                                    NO, CANCEL
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                    {msg.role === 'assistant' && !msg.pendingAction && (
                                        <div className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center justify-end gap-2 text-[10px] opacity-50 hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => copyToClipboard(msg.content)}
                                                className="flex items-center gap-1 hover:text-primary transition-colors"
                                                title="Copy message"
                                            >
                                                <Copy size={10} />
                                                <span>Copy</span>
                                            </button>
                                            {/* Only show retry for the last message if it's an assistant message */}
                                            {messages[messages.length - 1].id === msg.id && (
                                                <button
                                                    onClick={() => {
                                                        // Find the last user message
                                                        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                                                        if (lastUserMsg) {
                                                            // Remove the last user message and this assistant message from UI
                                                            setMessages(prev => prev.filter(m => m.id !== msg.id && m.id !== lastUserMsg.id));
                                                            // Retry the command
                                                            handleQuickCommand(lastUserMsg.content);
                                                        }
                                                    }}
                                                    className="flex items-center gap-1 hover:text-primary transition-colors"
                                                    title="Retry response"
                                                >
                                                    <RefreshCw size={10} />
                                                    <span>Retry</span>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>



                                {/* Suggestions */}
                                {msg.suggestions && msg.suggestions.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        {msg.suggestions.map((suggestion, i) => (
                                            <button
                                                key={i}
                                                onClick={() => handleSuggestionClick(suggestion)}
                                                className="px-2 py-0.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-[10px] font-medium transition-colors"
                                            >
                                                {suggestion}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {msg.role === 'user' && (
                                <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                                    <User size={12} />
                                </div>
                            )}
                        </div>
                    ))
                )}

                {isProcessing && (
                    <div className="flex gap-2">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary to-pink-500 flex items-center justify-center">
                            <Loader2 size={12} className="text-white animate-spin" />
                        </div>
                        <div className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl rounded-bl-sm">
                            <div className="flex items-center gap-2">
                                <div className="flex gap-1">
                                    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <span className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <span className="w-1.5 h-1.5 bg-pink-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                </div>
                                <span className="text-[10px] text-muted">{statusText || 'Thinking...'}</span>
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} className="p-3 border-t border-border bg-black/20">
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    accept="audio/*,image/*,video/*,.txt,.md,.json,.py,.ts,.tsx,.js,.jsx,.css,.html,.log,.yaml,.yml,.toml"
                    title="Attach files for assistant analysis"
                    aria-label="Attach files for assistant analysis"
                    onChange={(event) => {
                        addAttachments(Array.from(event.target.files || []));
                        event.target.value = '';
                    }}
                />
                {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        {attachments.map(item => (
                            <div key={item.id} className="flex items-center gap-1.5 max-w-full rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-[10px] text-primary">
                                {renderAttachmentIcon(item.mime)}
                                <span className="max-w-48 truncate" title={item.name}>{item.name}</span>
                                <span className="text-primary/60">{formatBytes(item.size)}</span>
                                <button
                                    type="button"
                                    onClick={() => removeAttachment(item.id)}
                                    className="ml-0.5 rounded-full text-primary/60 hover:text-red-300"
                                    title={`Remove ${item.name}`}
                                    aria-label={`Remove ${item.name}`}
                                >
                                    <X size={10} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="flex gap-2">
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={isProcessing ? 'Type to interrupt...' : 'Ask anything...'}
                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-all"
                    />

                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="px-3 py-2 bg-white/5 border border-white/10 text-muted hover:text-white hover:border-primary/30 rounded-lg transition-all relative"
                        title="Attach code, logs, images, audio, or video for Claude Code to inspect"
                        aria-label="Attach files"
                    >
                        <Paperclip size={14} />
                        {attachments.length > 0 && (
                            <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-[9px] font-bold text-white">
                                {attachments.length}
                            </span>
                        )}
                    </button>

                    <button
                        type="button"
                        onClick={toggleSTT}
                        className={`px-3 py-2 rounded-lg transition-all border ${
                            isRecording
                                ? 'bg-red-500/20 border-red-500/40 text-red-300 animate-pulse'
                                : 'bg-white/5 border-white/10 text-muted hover:text-white hover:border-white/20'
                        }`}
                        title={isRecording ? 'Stop recording' : 'Voice input'}
                    >
                        {isRecording ? <MicOff size={14} /> : <Mic size={14} />}
                    </button>

                    {isProcessing ? (
                        <button
                            type="button"
                            onClick={stopGeneration}
                            className="px-3 py-2 bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 rounded-lg transition-all"
                            title="Stop generation"
                        >
                            <Square size={14} />
                        </button>
                    ) : (
                        <button
                            type="submit"
                            disabled={!input.trim() && attachments.length === 0}
                            className="px-3 py-2 bg-gradient-to-r from-primary to-pink-500 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-all"
                            title="Send message"
                        >
                            <Send size={14} />
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
};

export default AssistantPanel;
