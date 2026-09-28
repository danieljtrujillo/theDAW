import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
// Prose rendering (ReactMarkdown + remark-gfm) moved to transcript/Markdown.tsx
// with the message rows; the icons left here are the panel's own chrome plus
// the reference-chip set (Clock / Library / Layers / AlertTriangle).
import { X, Send, Sparkles, Loader2, Zap, KeyRound, Trash2, Minimize2, Maximize2, Square, Paperclip, Mic, MicOff, FileText, Image as ImageIcon, Music, Film, History, Plus, Clock, Library, Layers, AlertTriangle } from 'lucide-react';
import { ProviderModelSelector, type ModelInfo } from './ProviderModelSelector';
import { SecretFieldLabel } from '../components/ui/SecretFieldLabel';
import { handletheDAWAction } from './actionHandlers';
import type { AssistantExecutableAction } from './assistantEvents';
import { buildtheDAWAppContext } from './appContext';
import { CLAUDE_SESSION_ID_KEY, CONVERSATION_ID_KEY } from './promptEnhancer';
import { uuid } from './utils';
import { useChatStream } from './stream';
import type { ChatTurnContext, SendAttachment } from './stream';
import type { ChatMessage } from './stream/types';
import { Transcript } from './transcript';
import {
    EFFORT_OPTIONS,
    effortLabel,
    normalizeEffort,
    readStoredEffort,
    writeStoredEffort,
    type AssistantEffort,
} from './assistantEffort';
import { contextPercentage, fetchContextUsage, type ContextUsage } from './contextUsage';
import { PermissionModeSelect } from './permission/PermissionModeSelect';
import { UserClaudeConfigToggle } from './permission/UserClaudeConfigToggle';
import { AllowRulesList } from './permission/AllowRulesList';
import { useAssistantPermissionStore } from './permission/assistantPermissionStore';
import {
    loadConversations,
    upsertConversation,
    deleteConversation,
    getConversation,
    getActiveId,
    setActiveId,
    deriveTitle,
    clearAllConversations,
    conversationNeedsWrite,
    type StoredConversation,
} from './chatHistory';
import { useStatusBarStore } from '../state/statusBarStore';
import { useAssistantActivityStore } from '../state/assistantActivityStore';
import {
    ASSISTANT_FOCUS_EVENT,
    referenceKey,
    resolveAssistantReference,
    useAssistantReferenceStore,
    type AssistantReference,
} from '../state/assistantReferenceStore';
import { logInfo } from '../state/logStore';

// Inline clipboard helper (no external util available in theDAW)
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
    /**
     * Host hook for a DAW action.
     *
     * NOT the execution path for the assistant's own tools any more. An MCP
     * relay tool has to hand its RESULT back to the model in-turn, and this
     * callback returns `void`; calling it *and* `handletheDAWAction` to read a
     * result would run every action twice (`append_prompt` would append twice).
     * The panel therefore dispatches through `handletheDAWAction` directly —
     * the same function the host's handler calls — and keeps this prop for
     * hosts that mount the panel for their own reasons.
     *
     * It is typed `=> void` on purpose: a host handler that returns a result is
     * still assignable, and nothing here reads that return value, so no caller
     * can mistake "dispatched" for "succeeded".
     */
    onExecuteAction: (action: { type: string; payload?: any }) => void;
    orbPosition?: { x: number; y: number };
}

/**
 * The transcript shape this panel stored BEFORE the Claude Code port.
 *
 * The live transcript is `ChatMessage` (orb-kit/stream/types.ts) and the
 * `Transcript` component owns every row; nothing in the panel produces a
 * `Message` any more. It stays exported because saved conversations written in
 * this shape are still on disk — `chatHistory` revives them (`content` → `text`)
 * — and because an external reader of a pre-port localStorage record needs a
 * name for what it is parsing. Do not build anything new on it.
 */
export interface MessageActionResult {
    id: string;
    type: string;
    status: 'running' | 'succeeded' | 'failed';
    message: string;
}

/** @see MessageActionResult — legacy persisted transcript row. */
export interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    action?: { type: string; payload?: any };
    pendingAction?: { type: string; payload?: any };
    data?: any;
    suggestions?: string[];
    isError?: boolean;
    /** The chips the user attached to this (user) message. */
    references?: AssistantReference[];
    /** What every action fired from this (assistant) message actually did. */
    actionResults?: MessageActionResult[];
}

interface AssistantAttachment {
    id: string;
    file: File;
    name: string;
    mime: string;
    size: number;
}


const QUICK_COMMANDS = [
    { label: 'Make Beat', command: 'Make me a chill lo-fi beat' },
    { label: 'Analyze', command: 'Analyze the currently playing song' },
    { label: 'Library', command: 'Go to library' },
    { label: 'Trending', command: 'Show trending songs' },
    { label: 'Full Sync', command: 'Start a full sync' },
    { label: 'Stats', command: 'Show my statistics' },
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
const ASSISTANT_DEFAULTS_VERSION = 'bcc-claude-opus-4-8-effort-max-v2';
const DEFAULT_ASSISTANT_PROVIDER = 'claude';
/** The Foundry's `CLAUDE_DEFAULT_MODEL` (server/claude-bridge.ts), verbatim. */
const DEFAULT_ASSISTANT_MODEL = 'claude-opus-4-8';
/** The provider whose CLI has permission modes. */
const CLAUDE_PROVIDER_ID = 'claude';
/** What the Claude provider is CALLED — the Foundry's label, same product. */
const CLAUDE_PROVIDER_LABEL = 'BCC (Better Claude Code)';

// BCC leads: it is the default provider, the one with the CLI, the permission
// modes and the effort control, so it is the first thing the dropdown offers.
// (The backend sends the same order; this list is the offline fallback.)
const DEFAULT_PROVIDERS: ProviderInfo[] = [
   { id: 'claude', label: CLAUDE_PROVIDER_LABEL, default_model: DEFAULT_ASSISTANT_MODEL, has_key: true, is_local: false },
   { id: 'gemini', label: 'Gemini', default_model: 'gemini-flash-recent', has_key: true, is_local: false },
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
        if (localStorage.getItem('thedaw:assistantDefaultsVersion') !== ASSISTANT_DEFAULTS_VERSION) {
            localStorage.setItem('thedaw:provider', DEFAULT_ASSISTANT_PROVIDER);
            localStorage.setItem('thedaw:model', DEFAULT_ASSISTANT_MODEL);
            localStorage.setItem('thedaw:assistantDefaultsVersion', ASSISTANT_DEFAULTS_VERSION);
        }

        return {
            provider: localStorage.getItem('thedaw:provider') || DEFAULT_ASSISTANT_PROVIDER,
            model: localStorage.getItem('thedaw:model') || DEFAULT_ASSISTANT_MODEL,
        };
    } catch {
        return {
            provider: DEFAULT_ASSISTANT_PROVIDER,
            model: DEFAULT_ASSISTANT_MODEL,
        };
    }
}

/**
 * Does this provider get the permission-mode dropdown?
 *
 * Only the Claude Code provider has permission modes — the others have no CLI
 * to grant or refuse anything, so showing them a dropdown would promise a
 * control that does not exist.
 */
export function shouldShowPermissionSelect(provider: string): boolean {
    return provider === CLAUDE_PROVIDER_ID;
}

/** Everything the composer footer's status line is decided from. */
export interface ComposerStatusState {
    isStreaming: boolean;
    /** Transient backend chatter for the live turn ("Running Bash"). */
    statusText: string | null;
    /** Prompts the hook is holding until this turn ends. */
    queuedCount: number;
    /** Has the live turn produced prose, reasoning or a tool row yet? */
    hasLiveContent: boolean;
    /** The panel's OWN status (attachment preparation, a send that failed). */
    localStatus?: string | null;
}

/**
 * Is the transcript's live row currently rendering its "Thinking…" indicator?
 *
 * It does so exactly while a turn is streaming and has produced nothing yet.
 * That row is an `aria-live` region, so anything the composer shows at the same
 * moment is a SECOND region announcing over it.
 */
function transcriptIndicatorShowing(state: ComposerStatusState): boolean {
    return state.isStreaming && !state.hasLiveContent;
}

/**
 * What the composer footer's status line says, or null for "render nothing".
 *
 * `statusText` used to render as an assistant message row with an avatar, which
 * put a fake turn in the transcript. It belongs in exactly one place — here.
 * While the transcript's own indicator is up it says nothing at all, EXCEPT for
 * the two things nothing else on screen reports: how many prompts are queued,
 * and the panel's own local status (attachment preparation, a failed send).
 */
export function composerStatusLine(state: ComposerStatusState): string | null {
    // A local status is the panel reporting on itself, usually before a turn
    // even exists. It outranks the turn's chatter.
    if (state.localStatus?.trim()) return state.localStatus.trim();
    if (!state.isStreaming) return null;
    if (transcriptIndicatorShowing(state) && state.queuedCount === 0) return null;
    const base = state.statusText?.trim() ? state.statusText.trim() : 'Working…';
    return state.queuedCount > 0 ? `${base} · ${state.queuedCount} queued` : base;
}

/**
 * Should the composer's status line be an `aria-live` region?
 *
 * Only when it is the ONLY one. While the transcript's indicator is up it owns
 * the announcement and the queue depth below is plain text — visible, but not
 * a second voice talking over the first.
 */
export function composerStatusIsLiveRegion(state: ComposerStatusState): boolean {
    return !transcriptIndicatorShowing(state);
}

/** Everything the context meter renders, decided from the reading and the %. */
export interface ContextMeterView {
    /** `Context` for the CLI's real reading, `Memory` for the estimate. */
    label: 'Context' | 'Memory';
    /** The bar's fill class — the panel's primary until the window fills up. */
    barClass: string;
    /** Hover text: the real token counts, or a plain admission that it is a guess. */
    title: string;
    /** What a screen reader hears instead of a bare number. */
    ariaLabel: string;
}

/**
 * How the context meter reads.
 *
 * Ported from the Foundry's status bar (AIAssistantOrb.tsx ~L1075-1090). Two
 * things it gets right and are worth keeping: the label distinguishes the CLI's
 * REAL context-window reading from the character-count estimate — a meter that
 * called a guess "Context" would be lying — and the bar warms from primary
 * through amber to red as the window fills, so a conversation about to be
 * compacted is visible before it happens.
 *
 * Pure, and exported, because it is the whole of the meter's logic; the JSX
 * below is just the shape it is poured into.
 */
export function contextMeterView(usage: ContextUsage | null, percent: number): ContextMeterView {
    const isLive = !!usage;
    return {
        label: isLive ? 'Context' : 'Memory',
        barClass: percent > 80 ? 'bg-red-500' : percent > 50 ? 'bg-amber-500' : 'bg-primary',
        title: isLive
            ? `Context: ${usage!.totalTokens.toLocaleString()} / ${usage!.maxTokens.toLocaleString()} tokens`
            : 'Estimated (no live context reading yet)',
        ariaLabel: isLive
            ? `Context window used: ${percent}%`
            : `Estimated context window used: ${percent}%`,
    };
}

/**
 * The conversation id a freshly mounted panel starts from.
 *
 * The saved conversation wins. `sessionStorage['thedaw:conversationId']` is a
 * single tab-wide slot that the prompt enhancer also touches, so reading it
 * first meant reopening chat B could resume chat A's backend conversation. The
 * slot is only a fallback now, for the case where nothing was saved yet (the
 * very first turn of a brand-new chat, before the debounced write lands).
 */
export function seedConversationId(
    restored: { sessionId: string | null } | null,
    tabSessionId: string | null,
): string | null {
    return restored?.sessionId || tabSessionId || null;
}

/** The two tabs of the panel's settings drawer (Model Info). */
export type AssistantSettingsTab = 'model' | 'keys';

const SETTINGS_TABS: ReadonlyArray<{ id: AssistantSettingsTab; label: string }> = [
    { id: 'model', label: 'Chat' },
    { id: 'keys', label: 'Keys' },
];

export const settingsTabId = (tab: AssistantSettingsTab) => `assistant-settings-tab-${tab}`;
export const settingsPanelId = (tab: AssistantSettingsTab) => `assistant-settings-panel-${tab}`;

/**
 * The settings drawer's tab strip: a tablist whose tabs say which one is
 * selected (aria-selected) and which panel it shows (aria-controls, on the
 * selected tab only, since only that panel is in the DOM). Arrow keys, Home
 * and End move between tabs; only the selected tab is in the Tab order.
 */
export function AssistantSettingsTabs({
    active,
    onSelect,
}: {
    active: AssistantSettingsTab;
    onSelect: (tab: AssistantSettingsTab) => void;
}) {
    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const count = SETTINGS_TABS.length;
        const index = SETTINGS_TABS.findIndex((t) => t.id === active);
        let next: number;
        if (event.key === 'ArrowRight') next = (index + 1) % count;
        else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = count - 1;
        else return;
        event.preventDefault();
        const tab = SETTINGS_TABS[next].id;
        onSelect(tab);
        document.getElementById(settingsTabId(tab))?.focus();
    };
    return (
        <div role="tablist" aria-label="Assistant settings" className="flex border-b border-white/5">
            {SETTINGS_TABS.map((tab) => {
                const selected = tab.id === active;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        id={settingsTabId(tab.id)}
                        aria-selected={selected}
                        aria-controls={selected ? settingsPanelId(tab.id) : undefined}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onSelect(tab.id)}
                        onKeyDown={handleKeyDown}
                        className={`flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-bold transition-colors ${selected ? 'text-primary border-b border-primary' : 'text-muted hover:text-white'}`}
                    >
                        {tab.id === 'keys' && <KeyRound className="w-3 h-3 shrink-0" aria-hidden="true" />}
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
}

function timeAgo(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

export const AssistantPanel: React.FC<AssistantPanelProps> = ({
    isOpen,
    onClose,
    onExecuteAction,
    orbPosition = { x: 20, y: typeof window !== 'undefined' ? window.innerHeight - 140 : 500 },
}) => {
    const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
    const initialAssistantSelection = useMemo(readInitialAssistantSelection, []);
    // Chat history: restore the last-active conversation on mount so a reload
    // or app restart keeps the transcript (persisted to localStorage below).
    const activeConvIdRef = useRef<string>('');
    if (!activeConvIdRef.current) activeConvIdRef.current = getActiveId() || uuid();
    const [conversations, setConversations] = useState<StoredConversation[]>(() => loadConversations());
    const [showHistory, setShowHistory] = useState(false);
    const persistTimerRef = useRef<number | null>(null);
    const [input, setInput] = useState('');
    const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
    // `sendMessage` is a stable callback; without this it would close over the
    // attachment list as it stood when the callback was built.
    const attachmentsRef = useRef<AssistantAttachment[]>(attachments);
    attachmentsRef.current = attachments;
    const [currentHint, setCurrentHint] = useState(0);
    const [showModelInfo, setShowModelInfo] = useState(false);
    const [settingsTab, setSettingsTab] = useState<AssistantSettingsTab>('model');
    const [selectedProvider, setSelectedProvider] = useState<string>(initialAssistantSelection.provider);

    const [selectedModel, setSelectedModel] = useState<string>(initialAssistantSelection.model);

    // How hard the Claude CLI is asked to think. theDAW pinned this to `max`
    // and never showed it; the Foundry's orb has had a dropdown for it since
    // its BCC port. Remembered across reloads under `thedaw:effort`.
    const [effort, setEffort] = useState<AssistantEffort>(readStoredEffort);
    useEffect(() => { writeStoredEffort(effort); }, [effort]);

    // --- conversation identity ------------------------------------------------
    // Two ids, and they are NOT the same thing: `conversationId` is the
    // backend's key (control-response, interrupt, permission-mode all address
    // it), `claudeSessionId` is the CLI's own `--resume` id. State, not just a
    // ref, because the permission dropdown has to re-render when the backend
    // mints a conversation mid-turn; refs alongside so the stream callbacks and
    // the debounced persist read the current value without a re-render race.
    const restoredConversation = useMemo(() => getConversation(activeConvIdRef.current), []);
    const [conversationId, setConversationIdState] = useState<string | null>(() => {
        let tabSessionId: string | null = null;
        try { tabSessionId = sessionStorage.getItem(CONVERSATION_ID_KEY); } catch { /* ignore */ }
        return seedConversationId(restoredConversation, tabSessionId);
    });
    const conversationIdRef = useRef<string | null>(conversationId);
    const claudeSessionIdRef = useRef<string | null>((() => {
        if (restoredConversation?.claudeSessionId) return restoredConversation.claudeSessionId;
        try { return sessionStorage.getItem(CLAUDE_SESSION_ID_KEY); } catch { return null; }
    })());

    const setConversationId = useCallback((id: string | null) => {
        conversationIdRef.current = id;
        setConversationIdState(id);
        try {
            if (id) sessionStorage.setItem(CONVERSATION_ID_KEY, id);
            else sessionStorage.removeItem(CONVERSATION_ID_KEY);
        } catch { /* ignore */ }
    }, []);

    const setClaudeSessionId = useCallback((id: string | null) => {
        claudeSessionIdRef.current = id;
        try {
            if (id) sessionStorage.setItem(CLAUDE_SESSION_ID_KEY, id);
            else sessionStorage.removeItem(CLAUDE_SESSION_ID_KEY);
        } catch { /* ignore */ }
    }, []);

    // --- the stream ------------------------------------------------------------
    // Attachment summaries for the app-context block, captured at submit time:
    // the `attachments` state is cleared the moment a turn starts, and
    // getTurnContext runs after that.
    const contextAttachmentsRef = useRef<Array<{ name: string; mime: string; size: number }>>([]);
    // The reference chips that went out with THIS turn, captured for the same
    // reason: the store is emptied as the turn starts, and the app-context block
    // carries the ids the model must act on (see appContext's REFERENCES rule).
    const contextReferencesRef = useRef<AssistantReference[]>([]);
    // Provider/model read fresh at send time rather than closed over, so a
    // model switched between typing and sending is the one that gets used.
    // Effort for the same reason, and one more: a send made DURING a live turn
    // is queued by the hook and its context is built when the queue drains, so
    // a closed-over value would send the effort the user had chosen minutes
    // earlier.
    const selectionRef = useRef({ provider: selectedProvider, model: selectedModel, effort });
    selectionRef.current = { provider: selectedProvider, model: selectedModel, effort };

    const getTurnContext = useCallback((): ChatTurnContext => {
        const { provider, model, effort: turnEffort } = selectionRef.current;
        const isClaude = shouldShowPermissionSelect(provider);
        return {
            provider,
            model,
            systemContext: buildtheDAWAppContext({
                selectedProvider: provider,
                selectedModel: model,
                attachments: contextAttachmentsRef.current,
                references: contextReferencesRef.current,
            }),
            effort: isClaude ? turnEffort : undefined,
            conversationId: conversationIdRef.current,
            claudeSessionId: claudeSessionIdRef.current,
            permissionMode: useAssistantPermissionStore.getState().mode,
            // The panel owns conversation identity — it restores it from saved
            // history and drops it on "New chat". `extraBody` merges last, so
            // these win over whatever the hook is still carrying from the
            // previous turn; without them a new chat would silently resume the
            // old CLI session.
            extraBody: isClaude
                ? {
                      conversationId: conversationIdRef.current,
                      claudeSessionId: claudeSessionIdRef.current,
                  }
                : undefined,
        };
    }, []);

    // Tool execution. `handletheDAWAction` is the same dispatcher the host's
    // onExecuteAction calls — the difference is that it RETURNS the result
    // string, which is what the MCP relay POSTs back so the model finally sees
    // what its own tool did. Tier gating (T0/T1 run, T2 parks for Run/Skip)
    // happens upstream in the frame reducer.
    //
    // The log line is emitted HERE rather than by calling `onExecuteAction`:
    // that prop executes the action, so using it for logging would run every
    // tool twice. This is the same line App.tsx's handler used to write.
    //
    // `handletheDAWAction` returns `string | Promise<string>` — the editor tools
    // wait for their audio re-render before answering. Awaiting it is what makes
    // the log (and the relay result the model reads) the real outcome instead of
    // "[object Promise]".
    const executeAction = useCallback(async (action: AssistantExecutableAction) => {
        const result = await handletheDAWAction(action);
        logInfo('assistant', `Action: ${action.type} → ${result}`);
        return result;
    }, []);

    const handleSessionId = useCallback((sessionId: string) => {
        setClaudeSessionId(sessionId);
    }, [setClaudeSessionId]);

    const {
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
        clear: clearStream,
        answerControl,
        runPendingAction,
        skipPendingAction,
    } = useChatStream({
        getTurnContext,
        executeAction,
        onConversationId: setConversationId,
        onSessionId: handleSessionId,
    });

    // The panel's own status: attachment preparation, or a send that never got
    // off the ground. Distinct from the turn's `statusText`, which the hook owns.
    const [localStatus, setLocalStatus] = useState<string | null>(null);

    // --- context meter ---------------------------------------------------------
    // The CLI's REAL context-window reading, or null while the meter is running
    // on the character-count estimate. Only the Claude provider has a CLI to ask.
    const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);

    /**
     * Ask the backend for the CLI's context usage.
     *
     * A failed read KEEPS the previous reading (the Foundry does the same): a
     * busy child that skips one answer should not make the meter jump back to
     * the estimate. `provider` is passed explicitly by callers that have just
     * switched it, because `selectionRef` only catches up on the next render.
     */
    const refreshContextUsage = useCallback(async (provider?: string) => {
        if (!shouldShowPermissionSelect(provider ?? selectionRef.current.provider)) return;
        const usage = await fetchContextUsage(conversationIdRef.current);
        if (usage) setContextUsage(usage);
    }, []);

    // A turn just finished (streaming fell): the child is idle, so this is the
    // moment it can answer. The hook has no "turn ended" callback — the falling
    // edge of `isStreaming` IS that event.
    const wasStreamingRef = useRef(false);
    useEffect(() => {
        const wasStreaming = wasStreamingRef.current;
        wasStreamingRef.current = isStreaming;
        if (wasStreaming && !isStreaming) void refreshContextUsage();
    }, [isStreaming, refreshContextUsage]);

    // Leaving Claude leaves the reading behind with it: no other provider has a
    // CLI to report a window, so keeping the number would attribute one
    // provider's usage to another.
    useEffect(() => {
        if (!shouldShowPermissionSelect(selectedProvider)) setContextUsage(null);
    }, [selectedProvider]);

    const composerStatus: ComposerStatusState = {
        isStreaming,
        statusText,
        queuedCount: queuedSends.length,
        // Mirrors Transcript's own `hasLiveContent` exactly — that is the
        // condition under which it renders its indicator, and the whole point
        // here is to never speak at the same time as it.
        hasLiveContent: !!(
            liveText ||
            liveThinking ||
            liveToolCalls.length > 0 ||
            livePendingActions.length > 0
        ),
        localStatus,
    };
    const statusLine = composerStatusLine(composerStatus);
    const statusIsLive = composerStatusIsLiveRegion(composerStatus);
    const contextPercent = contextPercentage(contextUsage, messages);
    const contextMeter = contextMeterView(contextUsage, contextPercent);

    /**
     * Stop.
     *
     * Aborting our own read of the SSE stream does NOT stop the CLI: the Claude
     * provider holds one persistent child per conversation, which would keep
     * working (and keep costing) with nobody listening. Ask it to interrupt
     * first — the child survives, the turn does not — then drop the stream.
     */
    const handleStop = useCallback(() => {
        if (shouldShowPermissionSelect(selectionRef.current.provider)) void interrupt();
        stop();
    }, [interrupt, stop]);

    // Mirror the busy flag into the global activity store so the orb (thinking
    // visuals, drip trail) tracks it.
    useEffect(() => {
        useAssistantActivityStore.getState().setThinking(isStreaming);
        return () => useAssistantActivityStore.getState().setThinking(false);
    }, [isStreaming]);

    // Hydrate the restored transcript once. The hook owns `messages`, so this
    // is a mount effect rather than a useState initialiser.
    const hydratedRef = useRef(false);
    useEffect(() => {
        if (hydratedRef.current) return;
        hydratedRef.current = true;
        if (restoredConversation?.messages.length) setMessages(restoredConversation.messages);
    }, [restoredConversation, setMessages]);

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
                id: uuid(),
                role: 'assistant',
                text: 'Speech recognition is not supported in this browser. Try Chrome or Edge.',
                timestamp: Date.now(),
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

    // Reference chips — the "act on THIS" list built from the EDIT timeline and
    // the Library. Resolved at render so a clip deleted while the composer sits
    // open greys out instead of quietly pointing at nothing.
    const references = useAssistantReferenceStore((s) => s.references);
    const removeReference = useAssistantReferenceStore((s) => s.remove);

    const renderReferenceIcon = (kind: AssistantReference['kind']) => {
        if (kind === 'clip') return <Music size={12} />;
        if (kind === 'time-range') return <Clock size={12} />;
        if (kind === 'track') return <Layers size={12} />;
        return <Library size={12} />;
    };

    // The panel used to dispatch actions itself (`runAction`) and paint a
    // result card under the bubble. Tools now execute in `executeAction` above
    // — the one path whose result also goes back to the model over the MCP
    // relay — and the Transcript renders each call with its real outcome, so a
    // second dispatcher here would run every tool twice.

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

    useEffect(() => { if (isBackendReady) void refreshKeyStatus(); }, [isBackendReady, refreshKeyStatus]);

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
       if (!isBackendReady) return;
       fetch('/api/assistant/providers').then(r => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
       }).then(data => {
          if (data.providers?.length) setProviderCatalog(data.providers);
          else setProviderCatalog(DEFAULT_PROVIDERS);
       }).catch(() => {
          setProviderCatalog(DEFAULT_PROVIDERS);
       });
    }, [isBackendReady]);

    // Fetch models when provider changes — only after backend is reachable
    useEffect(() => {
       if (!isBackendReady || !selectedProvider) return;
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
    }, [isBackendReady, selectedProvider, providerCatalog]);

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
    useEffect(() => { localStorage.setItem('thedaw:provider', selectedProvider); }, [selectedProvider]);
    useEffect(() => { localStorage.setItem('thedaw:model', selectedModel); }, [selectedModel]);

    const [isMinimized, setIsMinimized] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);






    // Calculate panel position based on orb position
    const panelPosition = useMemo(() => {
        const orbCenterX = orbPosition.x + 80; // theDAW's 2x orb: 160px hit box
        const orbCenterY = orbPosition.y + 80;

        // Determine which quadrant the orb is in and position panel accordingly
        const isOnRight = orbCenterX > window.innerWidth / 2;
        const isOnBottom = orbCenterY > window.innerHeight / 2;

        let x: number;
        let y: number;

        if (isOnRight) {
            // Panel to the left of orb
            x = Math.max(PANEL_MARGIN, orbPosition.x - PANEL_WIDTH - PANEL_MARGIN);
        } else {
            // Panel to the right of orb (orb box 160 + a small gap)
            x = Math.min(window.innerWidth - PANEL_WIDTH - PANEL_MARGIN, orbPosition.x + 168);
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

    // Adding a reference must not send anything — `requestAssistantFocus()`
    // only brings the composer forward so the user can type against the chips
    // they just made.
    useEffect(() => {
        const onFocusRequest = () => {
            setIsMinimized(false);
            window.setTimeout(() => inputRef.current?.focus(), 0);
        };
        window.addEventListener(ASSISTANT_FOCUS_EVENT, onFocusRequest);
        return () => window.removeEventListener(ASSISTANT_FOCUS_EVENT, onFocusRequest);
    }, []);



    // Follow the tail of the transcript. Kept apart from the persist effect
    // below so switching provider/model/mode doesn't yank the view to the
    // bottom — only new messages scroll.
    // The live row grows OUTSIDE `messages` now (the hook keeps the in-flight
    // turn in its own state and appends one finished message at the end), so
    // the live fields have to be dependencies too or the view stops following
    // the stream the moment a turn starts.
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, liveText, liveThinking, liveToolCalls.length, livePendingActions.length, pendingControls.length]);

    // The single write path for a conversation record. Shared by the debounced
    // timer below and the synchronous flushes in "New chat" / resume, so the
    // last <500ms of a reply survives an active-id swap.
    const flushConversation = useCallback((
        convId: string,
        sessionId: string | null,
        claudeSessionId: string | null,
        snapshot: ChatMessage[],
    ) => {
        const existing = getConversation(convId);
        // Skip a no-op write (e.g. the mount effect for a restored chat) — it
        // would only rebrand provider/model and bump updatedAt, silently
        // reshuffling the history list under the user. `conversationNeedsWrite`
        // carries the hardening this comparison grew inline: an empty snapshot
        // never writes, and the signature covers content, the error flag and the
        // tool/meta state, so a finished reply is never mistaken for the
        // mid-stream partial already on disk and truncated forever.
        if (!conversationNeedsWrite(existing, snapshot)) return;
        const now = Date.now();
        const record: StoredConversation = {
            id: convId,
            title: existing?.title || deriveTitle(snapshot),
            messages: snapshot,
            provider: selectedProvider,
            model: selectedModel,
            sessionId,
            claudeSessionId,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        setActiveId(convId);
        setConversations(upsertConversation(record));
    }, [selectedProvider, selectedModel]);

    useEffect(() => {
        // Debounced persist of the active conversation. Streaming mutates
        // `messages` per token, so writes are coalesced to ~half a second.
        // Any pending timer is cleared first so a stale write can't fire after
        // "New chat" / resume has swapped the active id out from under it.
        if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
        if (messages.length === 0) return;
        // Snapshot at schedule time: the timer must write to the conversation
        // these messages belong to, not whichever id is active 500ms later.
        const convId = activeConvIdRef.current;
        const sessionId = conversationIdRef.current;
        const claudeSessionId = claudeSessionIdRef.current;
        const snapshot = messages;
        persistTimerRef.current = window.setTimeout(() => {
            flushConversation(convId, sessionId, claudeSessionId, snapshot);
            persistTimerRef.current = null;
        }, 500);
        return () => { if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current); };
    }, [messages, selectedProvider, selectedModel, flushConversation]);

    /**
     * Start a turn.
     *
     * Everything that used to live here — the fetch, the SSE reader, the
     * <action> scraper, the tier gate, the placeholder assistant message — now
     * lives in `useChatStream` + the frame reducer. What is left is this
     * panel's own job: turn the attachment files into base64, remember their
     * summaries for the app-context block, and hand the prompt over.
     *
     * A send during a live turn is QUEUED by the hook rather than colliding
     * with it; the composer footer says how many are waiting.
     */
    const sendMessage = useCallback(async (text: string) => {
        const pendingAttachments = attachmentsRef.current;
        // Snapshot the chips: they go out with THIS message and are then
        // cleared, so a later message never silently inherits them.
        const pendingReferences = useAssistantReferenceStore.getState().references;
        const promptText = text.trim()
            || (pendingAttachments.length ? 'Analyze the attached file(s).' : '')
            || (pendingReferences.length ? 'Work on the referenced items.' : '');
        if (!promptText && pendingAttachments.length === 0) return;

        setInput('');
        setLocalStatus(null);

        let payload: SendAttachment[] | undefined;
        if (pendingAttachments.length > 0) {
            const count = pendingAttachments.length;
            setLocalStatus(`Preparing ${count} attachment${count === 1 ? '' : 's'}…`);
            try {
                payload = await Promise.all(pendingAttachments.map(async item => ({
                    name: item.name,
                    mime: item.mime,
                    size: item.size,
                    data: await fileToBase64(item.file),
                })));
            } catch (err) {
                // A file the browser cannot read must not vanish silently, and
                // must not reject out of an un-awaited event handler either.
                const detail = err instanceof Error ? err.message : String(err);
                setLocalStatus(null);
                setMessages(prev => [...prev, {
                    id: uuid(),
                    role: 'assistant',
                    text: `Could not read the attached file(s): ${detail}`,
                    isError: true,
                    timestamp: Date.now(),
                }]);
                return;
            }
            setLocalStatus(null);
            setAttachments([]);
        }

        // Read by getTurnContext, which runs after the state above is cleared.
        contextAttachmentsRef.current = pendingAttachments.map(item => ({
            name: item.name,
            mime: item.mime,
            size: item.size,
        }));
        // Same reason for the chips: the store is emptied on the next line, and
        // getTurnContext builds the app-context block after that.
        contextReferencesRef.current = pendingReferences;
        // The chips are spent the moment the turn starts.
        if (pendingReferences.length) useAssistantReferenceStore.getState().clear();

        await send(promptText, payload ? { attachments: payload } : undefined);
    }, [send, setMessages]);

    /** Fire a send from an event handler. `sendMessage` handles its own errors;
     *  this is the last net, so a rejection can never escape unhandled. */
    const startSend = useCallback((text: string) => {
        void sendMessage(text).catch((err) => {
            console.error('Assistant send failed', err);
            setLocalStatus(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, [sendMessage]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        startSend(input);
    };

    const handleQuickCommand = (command: string) => {
        startSend(command);
    };

    // "New chat": flush any pending debounced write first — the persist timer
    // is up to 500ms behind the stream, and the id swap below would leave that
    // tail unwritten — then start a fresh conversation id with an empty view.
    const handleClearHistory = () => {
        if (persistTimerRef.current) {
            window.clearTimeout(persistTimerRef.current);
            persistTimerRef.current = null;
            flushConversation(activeConvIdRef.current, conversationIdRef.current, claudeSessionIdRef.current, messages);
        }
        // clearStream drops the transcript, any unanswered permission cards and
        // the session cost carried across turns — a new chat must not inherit a
        // bubble the previous CLI is still blocked on.
        clearStream();
        activeConvIdRef.current = uuid();
        setActiveId(activeConvIdRef.current);
        // Both ids are cleared through their setters, which also clear the
        // sessionStorage slots — a new chat must not resume the old CLI session.
        setConversationId(null);
        setClaudeSessionId(null);
        setLocalStatus(null);
        // The reading belonged to the CLI session we just walked away from.
        setContextUsage(null);
        setShowHistory(false);
    };

    // "Clear all": wipe every saved transcript from localStorage, then start
    // a fresh empty conversation so the panel doesn't show a deleted chat.
    const handleClearAll = () => {
        if (!window.confirm('Delete ALL saved chats from this browser?')) return;
        // Drop the pending persist write before wiping, or the flush in
        // handleClearHistory would write the just-deleted chat straight back.
        if (persistTimerRef.current) {
            window.clearTimeout(persistTimerRef.current);
            persistTimerRef.current = null;
        }
        clearAllConversations();
        setConversations([]);
        handleClearHistory();
    };

    const resumeConversation = (conv: StoredConversation) => {
        // Same tail problem as "New chat": write out whatever the debounce is
        // still holding for the conversation we're leaving, under its own id.
        if (persistTimerRef.current) {
            window.clearTimeout(persistTimerRef.current);
            persistTimerRef.current = null;
            flushConversation(activeConvIdRef.current, conversationIdRef.current, claudeSessionIdRef.current, messages);
        }
        activeConvIdRef.current = conv.id;
        setActiveId(conv.id);
        // Clear BEFORE hydrating: an unanswered permission card belongs to the
        // conversation we are leaving, and answering it from here would POST the
        // wrong conversationId. Both calls are state setters, applied in order,
        // so the transcript below is what survives.
        clearStream();
        setMessages(conv.messages);
        setConversationId(conv.sessionId);
        setClaudeSessionId(conv.claudeSessionId ?? null);
        setLocalStatus(null);
        if (conv.provider) setSelectedProvider(conv.provider);
        if (conv.model) setSelectedModel(conv.model);
        setShowHistory(false);
        // The resumed chat has its own window. Drop the old reading and ask for
        // this one's — `setConversationId` above already moved the ref, and the
        // provider is passed explicitly because the state setter just above has
        // not re-rendered yet.
        setContextUsage(null);
        void refreshContextUsage(conv.provider ?? selectionRef.current.provider);
    };

    const removeConversation = (id: string) => {
        // Deleting the active chat: drop its pending write, otherwise the flush
        // in handleClearHistory below would resurrect it.
        if (id === activeConvIdRef.current && persistTimerRef.current) {
            window.clearTimeout(persistTimerRef.current);
            persistTimerRef.current = null;
        }
        setConversations(deleteConversation(id));
        if (id === activeConvIdRef.current) handleClearHistory();
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
                <div className="flex items-center justify-between px-4 py-3 bg-linear-to-r from-primary/10 via-purple-500/10 to-pink-500/10">
                    <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-linear-to-br from-primary via-purple-500 to-pink-500 flex items-center justify-center relative">
                            <div className="absolute inset-0 rounded-full bg-linear-to-br from-primary via-purple-500 to-pink-500 animate-spin-slow opacity-50 blur-sm"></div>
                            <div className="w-3 h-3 rounded-full bg-white/90 z-10"></div>
                        </div>
                        <span className="font-semibold text-sm">theDAW</span>
                        {messages.length > 0 && (
                            <span className="text-xs font-semibold px-1.5 py-0.5 bg-primary/20 text-primary rounded-full">
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
            {/* Header. `flex-wrap` so the control group drops to a second line
                rather than squeezing the permission dropdown out of a 420px
                panel — the dropdown is the point, it must never be clipped. */}
            <div className="flex flex-wrap items-center justify-between gap-y-2 px-4 py-3 border-b border-border bg-linear-to-r from-primary/10 via-purple-500/10 to-pink-500/10">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-linear-to-br from-primary via-purple-500 to-pink-500 flex items-center justify-center animate-pulse relative shrink-0">
                        <div className="absolute inset-0 rounded-full bg-linear-to-br from-primary via-purple-500 to-pink-500 animate-spin-slow opacity-50 blur-sm"></div>
                        <div className="w-4 h-4 rounded-full bg-white/90 z-10"></div>
                    </div>
                    <div className="min-w-0">
                        <h2 className="font-bold text-sm truncate">
                            GANTASMO-b0t
                        </h2>
                        <p className="text-xs font-semibold text-muted truncate">Stable Audio 3 expert</p>
                    </div>
                </div>
                <div className="flex items-center gap-1 min-w-0">
                    {/* Always visible, not buried in the Model Info popover: the
                        permission mode decides what the agent may do without
                        asking, so it has to be readable at a glance. The compact
                        form keeps its real <label htmlFor> (sr-only). */}
                    {shouldShowPermissionSelect(selectedProvider) && (
                        <PermissionModeSelect conversationId={conversationId} compact />
                    )}
                    <button
                        onClick={() => setShowModelInfo(!showModelInfo)}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-muted hover:text-white shrink-0"
                        title="Model Info"
                        aria-label="Model info and settings"
                        aria-expanded={showModelInfo}
                    >
                        <Zap size={14} aria-hidden="true" />
                    </button>
                    <button
                        onClick={() => setShowHistory((v) => !v)}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-muted hover:text-white"
                        title="Chat history"
                        aria-label="Chat history"
                        aria-expanded={showHistory}
                        aria-haspopup="true"
                    >
                        <History size={14} />
                    </button>
                    <button
                        onClick={handleClearHistory}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-muted hover:text-white"
                        title="New chat"
                        aria-label="New chat"
                    >
                        <Plus size={14} />
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

            {showHistory && (
                <div className="border-b border-border bg-surface/95 max-h-72 overflow-y-auto custom-scrollbar">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                        <span className="text-xs font-semibold text-muted uppercase tracking-wide">History</span>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={handleClearHistory}
                                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-white transition-colors"
                                title="Start a new chat"
                            >
                                <Plus size={12} /> New chat
                            </button>
                            <button
                                type="button"
                                onClick={handleClearAll}
                                title="Delete all saved chats"
                                aria-label="Clear all history"
                                className="inline-flex items-center gap-1 text-xs font-semibold text-rose-400/80 hover:text-rose-300 transition-colors"
                            >
                                Clear all
                            </button>
                        </div>
                    </div>
                    {conversations.length === 0 ? (
                        <div className="px-3 py-3 text-xs font-semibold text-muted italic">No saved conversations yet.</div>
                    ) : (
                        conversations.map((c) => (
                            <div
                                key={c.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => resumeConversation(c)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resumeConversation(c); }
                                }}
                                className={`group flex items-center gap-2 px-3 py-2 border-b border-white/5 last:border-0 cursor-pointer hover:bg-white/5 ${c.id === activeConvIdRef.current ? 'bg-primary/10' : ''}`}
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-xs font-semibold text-white truncate">{c.title}</div>
                                    <div className="text-xs font-semibold text-muted">{timeAgo(c.updatedAt)} · {c.messages.length} msgs</div>
                                </div>
                                <button
                                    onClick={(e) => { e.stopPropagation(); removeConversation(c.id); }}
                                    className="p-1 text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                    title="Delete conversation"
                                    aria-label={`Delete conversation: ${c.title}`}
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))
                    )}
                </div>
            )}

            {showModelInfo && (
                <div className="border-b border-border">
                    <AssistantSettingsTabs active={settingsTab} onSelect={setSettingsTab} />

                    {settingsTab === 'model' && (
                        <div
                            role="tabpanel"
                            id={settingsPanelId('model')}
                            aria-labelledby={settingsTabId('model')}
                            className="px-4 py-2.5 bg-linear-to-r from-blue-500/10 to-purple-500/10 space-y-2"
                        >
                            <ProviderModelSelector
                                providers={providers}
                                selectedProvider={selectedProvider}
                                selectedModel={selectedModel}
                                onProviderChange={handleProviderChange}
                                onModelChange={handleModelChange}
                                loading={!!loadingModels}
                            />
                            {/* The permission dropdown is NOT repeated here. It
                                lives in the always-visible header row above;
                                PermissionModeSelect hardcodes
                                id="assistant-permission-mode", so a second copy
                                would duplicate that id and break the label
                                association for both (HARD RULE 3). */}
                            {/* Effort — only the Claude CLI has one, so only it
                                gets the control (the Foundry gates it the same
                                way). A native <select> like the permission
                                dropdown: five values, no badges, and a real
                                <label htmlFor> for free. */}
                            {shouldShowPermissionSelect(selectedProvider) && (
                                <div>
                                    <label htmlFor="assistant-effort" className="text-xs font-bold text-muted block mb-0.5">Effort</label>
                                    <select
                                        id="assistant-effort"
                                        name="assistant-effort"
                                        value={effort}
                                        onChange={(e) => setEffort(normalizeEffort(e.target.value))}
                                        className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-white cursor-pointer hover:border-white/20 focus:outline-none focus:border-primary/50 transition-colors"
                                    >
                                        {EFFORT_OPTIONS.map((level) => (
                                            <option key={level} value={level} className="bg-black text-white">
                                                {effortLabel(level)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            {/* Whether the Claude CLI loads the user's own
                                ~/.claude settings, CLAUDE.md, skills, agents and
                                MCP servers. An app setting (data/settings.json),
                                read by the backend on every turn; Claude only. */}
                            {shouldShowPermissionSelect(selectedProvider) && <UserClaudeConfigToggle />}
                            {/* The loaded allow rules; in Ask mode each one asks
                                unless marked Always allow. Claude only. */}
                            {shouldShowPermissionSelect(selectedProvider) && <AllowRulesList />}
                            <div className="flex items-center justify-between text-xs pt-0.5">
                                {/* The CLI reports the model it actually loaded,
                                    which can differ from the one requested (a
                                    fallback model, an alias resolved server-side).
                                    Show what is running, not what was asked for. */}
                                <span className="text-muted">
                                    Active: <span className="font-bold text-primary">{cliModel ?? selectedModel}</span>
                                    {cliModel && cliModel !== selectedModel && (
                                        <span className="text-muted/60"> (asked for {selectedModel})</span>
                                    )}
                                </span>
                                <span className="inline-flex items-center gap-1 font-bold text-green-400">
                                    {selectedProvider === CLAUDE_PROVIDER_ID ? (
                                        `effort ${effort}`
                                    ) : (
                                        <>
                                            <KeyRound className="w-3 h-3 shrink-0" aria-hidden="true" />
                                            {`${keyPools[selectedProvider]?.available ?? '?'}/${keyPools[selectedProvider]?.total ?? '?'} keys`}
                                        </>
                                    )}
                                </span>
                            </div>
                            <ModelCapabilityHints
                                model={
                                    activeProvider?.models.find((m) => m.id === selectedModel) ?? null
                                }
                            />
                        </div>
                    )}

                    {settingsTab === 'keys' && (
                        <div
                            role="tabpanel"
                            id={settingsPanelId('keys')}
                            aria-labelledby={settingsTabId('keys')}
                            className="px-4 py-2.5 bg-linear-to-r from-purple-500/10 to-pink-500/10 space-y-1 max-h-56 overflow-y-auto custom-scrollbar"
                        >
                            {providerCatalog.filter(p => p.id !== 'claude' && !p.is_local).map(p => {
                                const pool = keyPools[p.id];
                                const keyCount = pool?.total || 0;
                                const availCount = pool?.available || 0;
                                // One id per provider row: it labels the paste field, and it is what
                                // the Add button points aria-controls at while that field is open.
                                const keyFieldId = `assistant-key-input-${p.id}`;
                                return (
                                <div key={p.id} className="py-1.5 border-b border-white/5 last:border-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-muted w-20 shrink-0 truncate" title={p.label}>{p.label}</span>
                                        <div className="flex-1 flex items-center gap-1.5">
                                            {keyCount > 0 ? (
                                                <span className="text-xs font-bold">
                                                    <span className="text-green-400">{availCount}</span>
                                                    <span className="text-muted">/{keyCount} keys</span>
                                                    {pool && pool.cooldown > 0 && <span className="text-yellow-400 ml-1">({pool.cooldown} cooling)</span>}
                                                </span>
                                            ) : (
                                                <span className="text-xs text-muted/50">{p.has_key ? 'env only' : 'no keys'}</span>
                                            )}
                                            <button
                                                onClick={() => { setEditingKeyProvider(editingKeyProvider === p.id ? null : p.id); setKeyInput(''); }}
                                                aria-expanded={editingKeyProvider === p.id}
                                                aria-controls={editingKeyProvider === p.id ? keyFieldId : undefined}
                                                title={editingKeyProvider === p.id ? `Close the ${p.label} key field` : `Paste ${p.label} API keys`}
                                                className="ml-auto inline-flex items-center gap-1 text-xs font-bold text-primary/70 hover:text-primary"
                                            >
                                                {editingKeyProvider === p.id
                                                    ? <X className="w-3 h-3 shrink-0" aria-hidden="true" />
                                                    : <KeyRound className="w-3 h-3 shrink-0" aria-hidden="true" />}
                                                {editingKeyProvider === p.id ? 'Cancel' : (keyCount > 0 ? 'Add' : 'Add keys')}
                                            </button>
                                            {keyCount > 0 && (
                                                <button
                                                    onClick={() => clearProviderKeys(p.id)}
                                                    aria-label={`Clear every ${p.label} key`}
                                                    title={`Forget every ${p.label} key`}
                                                    className="inline-flex items-center gap-1 text-xs font-bold text-red-400/50 hover:text-red-400"
                                                >
                                                    <Trash2 className="w-3 h-3 shrink-0" aria-hidden="true" />
                                                    Clear
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Key input area — supports pasting multiple keys */}
                                    {editingKeyProvider === p.id && (
                                        <div className="mt-1.5 space-y-1">
                                            {/* A real label, not a placeholder: this field carried a name
                                                and nothing else, so it was anonymous to a screen reader
                                                and unmarked on screen. */}
                                            <SecretFieldLabel
                                                htmlFor={keyFieldId}
                                                className="text-xs font-bold text-muted"
                                                iconClassName="w-3 h-3 shrink-0 text-primary/70"
                                            >
                                                {p.label} API keys
                                            </SecretFieldLabel>
                                            <textarea
                                                id={keyFieldId}
                                                name={keyFieldId}
                                                value={keyInput}
                                                onChange={e => setKeyInput(e.target.value)}
                                                placeholder="Paste keys (one per line, or comma/semicolon separated)..."
                                                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-primary/50 resize-none"
                                                rows={3}
                                                autoFocus
                                                onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey && keyInput.trim()) ingestKeys(p.id, keyInput); }}
                                            />
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs text-muted/40 flex-1">Ctrl+Enter to save. Comma, newline, or semicolon separated.</span>
                                                <button
                                                    onClick={() => ingestKeys(p.id, keyInput)}
                                                    disabled={!keyInput.trim() || ingestingKeys}
                                                    className="px-2.5 py-0.5 bg-primary/20 text-primary text-xs font-bold rounded hover:bg-primary/30 disabled:opacity-50"
                                                >{ingestingKeys ? 'Saving...' : 'Ingest Keys'}</button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Show individual keys in pool */}
                                    {pool?.keys && pool.keys.length > 0 && editingKeyProvider !== p.id && (
                                        <div className="mt-1 space-y-0.5">
                                            {pool.keys.map((k) => (
                                                <div key={k.id} className="flex items-center gap-1.5 pl-2 text-xs">
                                                    <span className={`w-1.5 h-1.5 rounded-full ${k.available ? 'bg-green-400' : 'bg-yellow-400'}`} title={k.available ? 'Available' : 'Cooling down'} />
                                                    <KeyRound className="w-3 h-3 shrink-0 text-muted/60" aria-hidden="true" />
                                                    <span className="tabular-nums font-semibold text-muted">{k.masked}</span>
                                                    <span className="text-muted/40">{k.source}</span>
                                                    {k.fail_count > 0 && <span className="text-red-400/60">{k.fail_count}x fail</span>}
                                                    {k.source !== 'env' && (
                                                        <button
                                                            onClick={() => removeOneKey(p.id, k.id)}
                                                            aria-label={`Remove ${p.label} key ${k.masked}`}
                                                            title="Remove this key"
                                                            className="ml-auto text-red-400/40 hover:text-red-400"
                                                        >
                                                            <X className="w-3 h-3" aria-hidden="true" />
                                                        </button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                );
                            })}
                            <div className="pt-1 text-xs text-muted/40 italic">Keys persisted on backend. Env vars auto-detected.</div>
                        </div>
                    )}
                </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center px-2">
                        <div className="w-14 h-14 rounded-full bg-linear-to-br from-primary/20 via-purple-500/20 to-pink-500/20 flex items-center justify-center mb-3 animate-pulse">
                            <Sparkles size={28} className="text-primary" />
                        </div>
                        <h3 className="text-base font-bold mb-1">How can I help?</h3>
                        <p className="text-xs font-semibold text-muted max-w-xs mb-1">
                            I have <span className="text-primary font-semibold">full access</span> to all app capabilities.
                        </p>
                        <p className="text-xs font-semibold text-muted/70 mb-4 italic">
                            {CAPABILITY_HINTS[currentHint]}
                        </p>

                        {/* Quick Commands - Compact */}
                        <div className="flex flex-wrap gap-1.5 justify-center">
                            {QUICK_COMMANDS.map((cmd, i) => (
                                <button
                                    key={i}
                                    onClick={() => handleQuickCommand(cmd.command)}
                                    className="px-2.5 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-primary/30 rounded-full text-xs font-semibold transition-all hover:scale-105"
                                >
                                    {cmd.label}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    /* The ported transcript owns every message row: tool
                       rows, diff cards, collapsible reasoning, the turn meta
                       line, the permission card and the T2 Run/Skip card. A
                       turn with tools and no prose renders its tools with NO
                       bubble and NO Copy/Retry — the empty "No response."
                       bubble is gone with the loop that produced it.

                       `statusText` is deliberately NOT passed: it renders once,
                       in the composer footer below. The live row keeps its own
                       single "Thinking…" indicator. */
                    <Transcript
                        messages={messages}
                        isStreaming={isStreaming}
                        liveText={liveText}
                        liveThinking={liveThinking}
                        liveToolCalls={liveToolCalls}
                        livePendingActions={livePendingActions}
                        pendingControls={pendingControls}
                        onCopyMessage={copyToClipboard}
                        onRetry={retry}
                        onAnswerControl={answerControl}
                        onRunPendingAction={runPendingAction}
                        onSkipPendingAction={skipPendingAction}
                    />
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} className="p-3 border-t border-border bg-black/20">
                <input
                    ref={fileInputRef}
                    id="assistant-attach-files"
                    type="file"
                    name="assistant-attach-files"
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
                {references.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        {references.map(ref => {
                            const key = referenceKey(ref);
                            const resolved = resolveAssistantReference(ref);
                            const missing = resolved.status === 'missing';
                            return (
                                <div
                                    key={key}
                                    title={resolved.detail}
                                    className={`flex items-center gap-1.5 max-w-full rounded-full border px-2 py-1 text-xs font-semibold ${missing
                                        ? 'border-red-500/40 bg-red-500/10 text-red-300 line-through'
                                        : resolved.status === 'changed'
                                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                                            : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                                        }`}
                                >
                                    {missing ? <AlertTriangle size={12} /> : renderReferenceIcon(ref.kind)}
                                    <span className="max-w-48 truncate">{ref.label}</span>
                                    <button
                                        type="button"
                                        onClick={() => removeReference(key)}
                                        className="ml-0.5 rounded-full opacity-70 hover:opacity-100 hover:text-red-300"
                                        title={`Remove reference ${ref.label}`}
                                        aria-label={`Remove reference ${ref.label}`}
                                    >
                                        <X size={10} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
                {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        {attachments.map(item => (
                            <div key={item.id} className="flex items-center gap-1.5 max-w-full rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
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
                {/* The composer status row: transient status on the left, the
                    context meter on the right. Status is still the ONE place
                    transient chatter shows — it used to render as a fake
                    assistant row in the transcript, complete with avatar — and
                    still takes `role="status"` only when the transcript's
                    live-row indicator is NOT up, so there is never a second
                    region announcing. The meter beside it is not a region at
                    all. */}
                <div className="mb-2 flex items-center gap-2 px-0.5">
                    {statusLine && (
                        <div
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold text-muted"
                            role={statusIsLive ? 'status' : undefined}
                            aria-live={statusIsLive ? 'polite' : undefined}
                        >
                            <Loader2 className="w-3 h-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
                            <span className="truncate" title={statusLine}>{statusLine}</span>
                        </div>
                    )}
                    {/* The context meter, ported from the Foundry's status bar.
                        Deliberately NOT a live region: it sits beside the status
                        line, which already owns the one announcement allowed
                        here, and a percentage ticking over would talk across it.
                        role="meter" is what it is — a reading inside a known
                        range — so it still reads correctly on demand. */}
                    <div
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={contextPercent}
                        aria-label={contextMeter.ariaLabel}
                        title={contextMeter.title}
                        className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-semibold text-muted"
                    >
                        <span>{contextMeter.label}</span>
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-white/6">
                            <div
                                className={`h-full rounded-full transition-all ${contextMeter.barClass}`}
                                style={{ width: `${contextPercent}%` }}
                            />
                        </div>
                        <span className="tabular-nums font-semibold">{contextPercent}%</span>
                    </div>
                </div>
                <div className="flex gap-2">
                    <label htmlFor="assistant-chat-input" className="sr-only">Message the assistant</label>
                    <input
                        ref={inputRef}
                        id="assistant-chat-input"
                        type="text"
                        name="assistant-chat-input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={isStreaming ? 'Send to queue a follow-up…' : 'Ask anything...'}
                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[12px] focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-all"
                    />

                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="px-3 py-2 bg-white/5 border border-white/10 text-muted hover:text-white hover:border-primary/30 rounded-lg transition-all relative"
                        title={`Attach code, logs, images, audio, or video for ${CLAUDE_PROVIDER_LABEL} to inspect`}
                        aria-label="Attach files"
                    >
                        <Paperclip size={14} aria-hidden="true" />
                        {attachments.length > 0 && (
                            <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-xs font-bold text-white">
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
                        aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
                        aria-pressed={isRecording}
                    >
                        {isRecording
                            ? <MicOff size={14} aria-hidden="true" />
                            : <Mic size={14} aria-hidden="true" />}
                    </button>

                    {isStreaming ? (
                        <button
                            type="button"
                            onClick={handleStop}
                            className="px-3 py-2 bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 rounded-lg transition-all"
                            title="Stop generation"
                            aria-label="Stop generation"
                        >
                            <Square size={14} aria-hidden="true" />
                        </button>
                    ) : (
                        <button
                            type="submit"
                            disabled={!input.trim() && attachments.length === 0 && references.length === 0}
                            className="px-3 py-2 bg-linear-to-r from-primary to-pink-500 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-all"
                            title="Send message"
                            aria-label="Send message"
                        >
                            <Send size={14} aria-hidden="true" />
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
};

/** Renders a row of capability badges for the selected model plus a
 *  prominent warning when the user has picked a model whose primary
 *  job isn't chat (embeddings / image_gen / music_gen / video_gen /
 *  tts / robotics — they'll error out if a chat request hits them)
 *  or is marked deprecated. Capabilities come from the backend's
 *  GEMINI_MODELS / OPENAI_CAPS / etc. catalogs, so adding a new flag
 *  there shows up here automatically. */
const NON_CHAT_CAPS = new Set([
    'embeddings',
    'image_gen',
    'music_gen',
    'video_gen',
    'tts',
    'robotics',
]);

const CAP_TINT: Record<string, string> = {
    audio_in: 'border-emerald-500/30 text-emerald-300 bg-emerald-500/8',
    audio_out: 'border-emerald-500/30 text-emerald-300 bg-emerald-500/8',
    live: 'border-emerald-500/40 text-emerald-200 bg-emerald-500/12',
    tts: 'border-emerald-500/30 text-emerald-300 bg-emerald-500/8',
    vision: 'border-amber-500/30 text-amber-300 bg-amber-500/8',
    video_in: 'border-amber-500/30 text-amber-300 bg-amber-500/8',
    video_gen: 'border-amber-500/40 text-amber-200 bg-amber-500/12',
    image_gen: 'border-rose-500/30 text-rose-300 bg-rose-500/8',
    music_gen: 'border-pink-500/30 text-pink-300 bg-pink-500/8',
    embeddings: 'border-cyan-500/30 text-cyan-300 bg-cyan-500/8',
    research: 'border-purple-500/30 text-purple-300 bg-purple-500/8',
    agentic: 'border-purple-500/40 text-purple-200 bg-purple-500/12',
    robotics: 'border-orange-500/30 text-orange-300 bg-orange-500/8',
    reasoning: 'border-blue-500/30 text-blue-300 bg-blue-500/8',
    tools: 'border-zinc-500/30 text-zinc-300 bg-white/3',
    code: 'border-zinc-500/30 text-zinc-300 bg-white/3',
    long_context: 'border-zinc-500/30 text-zinc-300 bg-white/3',
    fast: 'border-zinc-500/30 text-zinc-400 bg-white/3',
    deprecated: 'border-red-500/40 text-red-300 bg-red-500/8',
};

const ModelCapabilityHints: React.FC<{ model: ModelInfo | null }> = ({ model }) => {
    if (!model || !model.capabilities || model.capabilities.length === 0) return null;
    const caps = model.capabilities;
    const nonChat = caps.filter((c) => NON_CHAT_CAPS.has(c));
    const isDeprecated = caps.includes('deprecated');
    return (
        <div className="pt-1.5 flex flex-col gap-1">
            <div className="flex flex-wrap gap-1">
                {caps.map((c) => (
                    <span
                        key={c}
                        className={`text-xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                            CAP_TINT[c] ?? 'border-zinc-500/20 text-zinc-400 bg-white/3'
                        }`}
                    >
                        {c}
                    </span>
                ))}
            </div>
            {nonChat.length > 0 && (
                <div className="text-xs font-semibold text-amber-300 bg-amber-500/8 border border-amber-500/30 rounded px-2 py-1 leading-snug">
                    This model is built for <span className="font-bold">{nonChat.join(' / ')}</span> — chat requests will likely error. Pick a model with <span className="font-bold">tools</span> or <span className="font-bold">reasoning</span> for normal conversation.
                </div>
            )}
            {isDeprecated && (
                <div className="text-xs font-semibold text-red-300 bg-red-500/8 border border-red-500/30 rounded px-2 py-1 leading-snug">
                    Deprecated — Google will shut this model down soon. Migrate to a 3.x model when convenient.
                </div>
            )}
        </div>
    );
};

export default AssistantPanel;

