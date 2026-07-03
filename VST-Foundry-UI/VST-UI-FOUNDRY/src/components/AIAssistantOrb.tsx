import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  MessageSquare,
  History,
  Plus,
  Trash2,
  Square,
  Upload,
  X,
  Settings,
  Camera,
  Send,
  Loader2,
  Mic,
} from "lucide-react";
import { generateCanvasScreenshot } from "../lib/canvasMockup";
import GantasmoOrb from "../orb-kit-skin/GantasmoOrb";
import "../orb-kit-skin/gantasmo-orb.css";
import "../orb-kit-skin/orb-chat.css";

import type {
  ChatMessage,
  ChatSession,
  ElementRef,
  ProviderInfo,
  ModelInfo,
  ToolCallEntry,
  PendingControl,
  AIAssistantOrbProps,
} from "./orb/types";
import {
  EFFORT_OPTIONS,
  LS_PROVIDER,
  LS_MODEL,
  LS_PROVIDER_KEYS,
  LS_EFFORT,
  LS_LEGACY_KEY,
  LS_SESSIONS,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
} from "./orb/constants";
import { normalizeProviders, normalizeModels } from "./orb/providers";
import { useSpeechInput } from "./orb/useSpeechInput";
import { useToolActions } from "./orb/useToolActions";
import { useChatStream } from "./orb/useChatStream";
import { Transcript } from "./orb/Transcript";

// Re-export the markdown link renderer so existing importers (and the
// inlineMd.test.ts regression suite) keep resolving it from this module.
export { inlineMd } from "./orb/markdown";

export default function AIAssistantOrb({
  elements,
  setElements,
  canvasState,
  setCanvasState,
  onRegisterModule,
}: AIAssistantOrbProps) {
  // UI Toggles & Panel State
  const [isOpen, setIsOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ x: window.innerWidth - 450, y: 120 });
  const [panelSize, setPanelSize] = useState({ width: 400, height: 580 });
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // ---------------------------------------------------------------------------
  // Provider / Model configuration (model-agnostic)
  // ---------------------------------------------------------------------------
  const [selectedProvider, setSelectedProvider] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_PROVIDER) || DEFAULT_PROVIDER;
    } catch {
      return DEFAULT_PROVIDER;
    }
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_MODEL) || DEFAULT_MODEL;
    } catch {
      return DEFAULT_MODEL;
    }
  });
  const [providerApiKeys, setProviderApiKeys] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(LS_PROVIDER_KEYS);
      const parsed: Record<string, string> = raw ? JSON.parse(raw) : {};
      // Migrate the legacy single Gemini key into the new keyed structure.
      const legacy = localStorage.getItem(LS_LEGACY_KEY);
      if (legacy && !parsed.gemini) {
        parsed.gemini = legacy;
      }
      return parsed;
    } catch (e) {
      console.warn("Could not read provider API keys from localStorage.", e);
      return {};
    }
  });
  const [effort, setEffort] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_EFFORT) || "max";
    } catch {
      return "max";
    }
  });
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  // Always-current mirror of claudeSessionId so the MCP relay can post tool
  // results to the right session even before a re-render commits new state
  // (the session id arrives mid-stream from the SSE "session_id" frame).
  const claudeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    claudeSessionIdRef.current = claudeSessionId;
  }, [claudeSessionId]);
  // Provider-agnostic relay session id. Every provider that loops over tool
  // calls (Claude CLI AND the direct-API providers) emits a `session_id` frame;
  // relayToolResult posts results keyed by this id. Kept separate from
  // claudeSessionId so a non-Claude relay id never leaks into the Claude CLI
  // resume path (which would resume a non-existent CLI session).
  const toolSessionIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // LIVE-STATE MIRRORS — the MCP read fix.
  // Tool handlers (executeClientTool) can run from an SSE closure captured at
  // mount, so reading the `elements`/`canvasState` props directly returns a
  // FROZEN snapshot (the bug: getElements -> [] while elements are on-canvas,
  // and screenshots stuck on the bare background). useRef objects are stable
  // across renders; we refresh `.current` every render so every tool call
  // resolves against the LIVE canvas, never a stale closure.
  const elementsRef = useRef(elements);
  const canvasStateRef = useRef(canvasState);
  elementsRef.current = elements;
  canvasStateRef.current = canvasState;

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // theDAW-style settings: [Chat | Keys] tabs + per-provider key editing.
  const [settingsTab, setSettingsTab] = useState<"model" | "keys">("model");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKeyText, setShowKeyText] = useState(false);
  const maskKey = (k: string) => (k ? "•".repeat(Math.max(0, k.length - 4)) + k.slice(-4) : "");

  // Persist provider/model configuration
  useEffect(() => {
    try {
      localStorage.setItem(LS_PROVIDER, selectedProvider);
    } catch (e) {
      console.warn("Could not persist provider selection.", e);
    }
  }, [selectedProvider]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_MODEL, selectedModel);
    } catch (e) {
      console.warn("Could not persist model selection.", e);
    }
  }, [selectedModel]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_PROVIDER_KEYS, JSON.stringify(providerApiKeys));
    } catch (e) {
      console.warn("Could not persist provider API keys.", e);
    }
  }, [providerApiKeys]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_EFFORT, effort);
    } catch (e) {
      console.warn("Could not persist effort level.", e);
    }
  }, [effort]);

  // Fetch the provider catalog once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/assistant/providers")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const rawList = Array.isArray(data) ? data : data?.providers || [];
        const normalized = normalizeProviders(rawList);
        setProviders(normalized);
        // If the persisted provider no longer exists, fall back sensibly.
        if (normalized.length && !normalized.find((p) => p.id === selectedProvider)) {
          const fallback = normalized.find((p) => p.id === DEFAULT_PROVIDER) || normalized[0];
          setSelectedProvider(fallback.id);
        }
      })
      .catch((e) => console.warn("Failed to load providers", e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch models whenever the provider (or its API key) changes.
  useEffect(() => {
    if (!selectedProvider) return;
    let cancelled = false;
    const apiKey = providerApiKeys[selectedProvider];
    const url = apiKey
      ? `/api/assistant/models/${selectedProvider}?apiKey=${encodeURIComponent(apiKey)}`
      : `/api/assistant/models/${selectedProvider}`;

    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const rawList = Array.isArray(data) ? data : data?.models || [];
        const normalized = normalizeModels(rawList);
        setModels(normalized);
        if (normalized.length && !normalized.find((m) => m.id === selectedModel)) {
          const provInfo = providers.find((p) => p.id === selectedProvider);
          const preferred =
            (provInfo?.defaultModel &&
              normalized.find((m) => m.id === provInfo.defaultModel)?.id) ||
            normalized[0].id;
          setSelectedModel(preferred);
        }
      })
      .catch((e) => console.warn("Failed to load models for", selectedProvider, e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider, providerApiKeys]);

  // Styling / Scale Modifiers
  const [textScale, setTextScale] = useState<"xs" | "sm" | "md" | "lg">("sm");
  const [fontFamily, setFontFamily] = useState<"sans" | "mono" | "serif">("sans");

  // Message / Streaming States
  const [input, setInput] = useState("");
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  // Canvas elements attached as message context via the canvas context menu's
  // "Add to Chat" (chips in the composer; cleared on send).
  const [referencedElements, setReferencedElements] = useState<ElementRef[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [currentThinking, setCurrentThinking] = useState("");
  const [currentText, setCurrentText] = useState("");
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallEntry[]>([]);
  // A live question/permission the CLI is BLOCKED on until the user answers.
  const [pendingControl, setPendingControl] = useState<PendingControl | null>(null);
  // The model the CLI actually booted with (from system/init) — may differ from
  // the requested alias. null until the first turn's init frame arrives.
  const [cliModel, setCliModel] = useState<string | null>(null);
  // REAL context-window usage queried from the CLI (get_context_usage). null =
  // not yet fetched / unsupported → fall back to the char-count estimate.
  const [contextUsage, setContextUsage] = useState<{ totalTokens: number; maxTokens: number; percentage: number } | null>(null);

  // Voice dictation: append the transcribed text to the chat input the orb
  // already sends as the message (matches BCC's space-separated append).
  const handleSpeechText = useCallback((t: string) => {
    setInput((prev) => (prev && !prev.endsWith(" ") ? prev + " " : prev) + t);
  }, []);
  const speech = useSpeechInput(handleSpeechText);

  // Sessions History
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Live mirror of `messages` so async continuations (notably the mid-turn
  // send-queue drain, which re-invokes handleSendMessage from a setTimeout in the
  // turn's `finally`) build conversation history from CURRENT state, not the
  // frozen render closure that started the queue.
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Live mirrors of the send-path configuration, for the same reason: the
  // mid-turn send-queue drain re-invokes handleSendMessage from a setTimeout in
  // the turn's `finally`, so the request body must be built from CURRENT config,
  // not the frozen render closure that started the queue.
  const selectedProviderRef = useRef(selectedProvider);
  const selectedModelRef = useRef(selectedModel);
  const effortRef = useRef(effort);
  const providerApiKeysRef = useRef(providerApiKeys);
  const currentSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    selectedProviderRef.current = selectedProvider;
    selectedModelRef.current = selectedModel;
    effortRef.current = effort;
    providerApiKeysRef.current = providerApiKeys;
    currentSessionIdRef.current = currentSessionId;
  }, [selectedProvider, selectedModel, effort, providerApiKeys, currentSessionId]);

  // Dragging & Resizing Refs
  const headerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // BCC-style mid-turn send queue. Typing while a turn streams does NOT fire a
  // second, colliding request (that produced the backend's 409 "busy"). Instead
  // the message is parked here and sent automatically once the current turn ends —
  // mirroring BCC, where sending mid-turn just queues the message after the run.
  // `activeTurnRef` is the synchronous guard (state is too stale for back-to-back
  // sends); `pendingSendsRef` is the FIFO queue; `queuedSends` mirrors it for the UI.
  const activeTurnRef = useRef(false);
  const pendingSendsRef = useRef<
    Array<{ prompt: string; image?: string; refs?: ElementRef[] }>
  >([]);
  const [queuedSends, setQueuedSends] = useState<string[]>([]);

  // Dragging states
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panelStart = useRef({ x: 0, y: 0 });

  // Resizing states
  const [isResizing, setIsResizing] = useState(false);
  const resizeStart = useRef({ x: 0, y: 0 });
  const sizeStart = useRef({ width: 0, height: 0 });

  // ---------------------------------------------------------------------------
  // Extracted behavior hooks. useToolActions owns client-tool execution + the
  // MCP relay; useChatStream owns the SSE send/read loop + mid-turn queue drain.
  // Both are handed the SAME live state/refs the component owns, so behavior is
  // identical to the previous inline implementation.
  // ---------------------------------------------------------------------------
  const { handleClientToolCall } = useToolActions({
    elementsRef,
    canvasStateRef,
    toolSessionIdRef,
    setElements,
    setCanvasState,
    setStatusText,
    onRegisterModule,
  });

  const { handleSendMessage } = useChatStream({
    input,
    setInput,
    attachedImage,
    setAttachedImage,
    referencedElements,
    setReferencedElements,
    setMessages,
    messagesRef,
    setIsStreaming,
    setStatusText,
    setCurrentThinking,
    setCurrentText,
    setCurrentToolCalls,
    setPendingControl,
    activeTurnRef,
    pendingSendsRef,
    setQueuedSends,
    abortControllerRef,
    elementsRef,
    canvasStateRef,
    selectedProviderRef,
    selectedModelRef,
    providerApiKeysRef,
    currentSessionIdRef,
    effortRef,
    claudeSessionIdRef,
    setClaudeSessionId,
    selectedProvider,
    currentSessionId,
    setContextUsage,
    setCliModel,
    toolSessionIdRef,
    handleClientToolCall,
  });

  // Canvas context menu "Add to Chat" → attach the elements as referenced
  // items and open the panel. Ids are resolved against the LIVE canvas via
  // elementsRef (stable), so the mount-time listener never reads stale props.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const ids: string[] = Array.isArray(detail.ids) ? detail.ids : [];
      if (!ids.length) return;
      const els = elementsRef.current;
      setReferencedElements((prev) => {
        const next = [...prev];
        ids.forEach((id) => {
          if (next.some((r) => r.id === id)) return;
          const el = els.find((x) => x.id === id);
          if (el) next.push({ id: el.id, name: el.name, type: el.type });
        });
        return next;
      });
      setIsOpen(true);
    };
    window.addEventListener("vst-ai-add-reference", handler as EventListener);
    return () =>
      window.removeEventListener(
        "vst-ai-add-reference",
        handler as EventListener,
      );
  }, []);

  // Apply a stored session's AI configuration without clobbering the active
  // provider/model when loading legacy (pre-multi-provider) sessions.
  const applySessionConfig = (sess: ChatSession) => {
    if (sess.provider) {
      setSelectedProvider(sess.provider);
      if (sess.model) setSelectedModel(sess.model);
      if (sess.effort) setEffort(sess.effort);
    }
    setClaudeSessionId(sess.claudeSessionId ?? null);
  };

  // Load Saved Chat Sessions on Mount. Every new app session starts a FRESH
  // chat — prior chats are kept as history (welcome-only empties are pruned so
  // reloads don't pile up blank entries).
  useEffect(() => {
    let history: ChatSession[] = [];
    try {
      const savedSessions = localStorage.getItem(LS_SESSIONS);
      if (savedSessions) {
        history = (JSON.parse(savedSessions) as ChatSession[]).filter(
          (s) => (s.messages?.length ?? 0) > 1,
        );
      }
    } catch (e) {
      console.error("Failed to load assistant sessions", e);
    }
    startNewChat(false, history);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync session changes to localStorage
  const saveSessionsToStorage = (updatedSessions: ChatSession[]) => {
    setSessions(updatedSessions);
    try {
      // Strip heavy base64 images to prevent exceeding the browser's 5MB localStorage quota
      const lightweightSessions = updatedSessions.map((session) => ({
        ...session,
        messages: session.messages.map((msg) => {
          if (msg.image) {
            return {
              ...msg,
              image: undefined, // Strip the large base64 data
            };
          }
          return msg;
        }),
      }));
      localStorage.setItem(LS_SESSIONS, JSON.stringify(lightweightSessions));
    } catch (e) {
      console.warn("Could not save all assistant sessions to localStorage (quota exceeded or disabled).", e);
      try {
        // Fallback: Store only the last 2 sessions to guarantee successful storage
        const reduced = updatedSessions.slice(0, 2).map((session) => ({
          ...session,
          messages: session.messages.map((msg) => ({ ...msg, image: undefined })),
        }));
        localStorage.setItem(LS_SESSIONS, JSON.stringify(reduced));
      } catch (innerErr) {
        console.error("Critical: Failed to save fallback sessions to localStorage", innerErr);
      }
    }
  };

  // Tell the backend to release the persistent Claude process tied to an
  // abandoned conversation. Fire-and-forget + idempotent: never blocks the UI
  // and silently no-ops if the session was already gone.
  const releaseSession = (id: string | undefined | null) => {
    if (!id) return;
    fetch("/api/assistant/session/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    }).catch(() => {});
  };

  // Start fresh chat session
  // baseSessions overrides the sessions closure state — needed on mount, where
  // the freshly loaded history hasn't flushed into state yet (building on the
  // stale empty array would wipe stored history).
  const startNewChat = (forceOpen = true, baseSessions?: ChatSession[]) => {
    // Release the prior backend session before abandoning its id client-side.
    releaseSession(currentSessionId);
    const base = baseSessions ?? sessions;
    const newId = Math.random().toString(36).substring(2, 9);
    const newSession: ChatSession = {
      id: newId,
      name: `Design Session ${base.length + 1}`,
      messages: [
        {
          id: "welcome",
          role: "assistant",
          text: "Greetings! I am your AI Design Assistant. I can build, style, arrange, and delete skeuomorphic controls and analyze your canvas screenshots visually. How can I help you perfect your audio UI layout today?",
          timestamp: Date.now(),
        },
      ],
      provider: selectedProvider,
      model: selectedModel,
      effort,
      claudeSessionId: null,
      lastUpdated: Date.now(),
    };

    const nextSessions = [newSession, ...base];
    setCurrentSessionId(newId);
    setMessages(newSession.messages);
    // A brand-new conversation must not reuse the prior backend session id.
    setClaudeSessionId(null);
    saveSessionsToStorage(nextSessions);
    if (forceOpen) {
      setIsOpen(true);
      setShowHistory(false);
    }
  };

  // Load an existing session
  const loadSession = (sessionId: string) => {
    const sess = sessions.find((s) => s.id === sessionId);
    if (sess) {
      setCurrentSessionId(sess.id);
      setMessages(sess.messages);
      applySessionConfig(sess);
      setShowHistory(false);
    }
  };

  // Delete a session
  const deleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // The deleted thread's backend session is now orphaned — release it.
    releaseSession(sessionId);
    const updated = sessions.filter((s) => s.id !== sessionId);
    saveSessionsToStorage(updated);
    if (currentSessionId === sessionId) {
      if (updated.length > 0) {
        loadSession(updated[0].id);
      } else {
        startNewChat(false);
      }
    }
  };

  // Save current thread messages + active AI configuration
  useEffect(() => {
    if (!currentSessionId) return;
    const sessionToUpdate = sessions.find((s) => s.id === currentSessionId);
    if (sessionToUpdate) {
      const updatedMessages = [...messages];
      const name =
        updatedMessages.length > 2
          ? updatedMessages[1].text.substring(0, 24) + "..."
          : sessionToUpdate.name;

      const updated = sessions.map((s) => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            name,
            messages: updatedMessages,
            provider: selectedProvider,
            model: selectedModel,
            effort,
            claudeSessionId,
            lastUpdated: Date.now(),
          };
        }
        return s;
      });
      saveSessionsToStorage(updated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, selectedProvider, selectedModel, effort, claudeSessionId]);

  // Keep chat scrolled to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentThinking, currentText, currentToolCalls, isStreaming]);

  // Handle panel dragging
  const handleDragStart = (e: React.MouseEvent) => {
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    panelStart.current = { x: panelPos.x, y: panelPos.y };
    e.preventDefault();
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    setIsResizing(true);
    resizeStart.current = { x: e.clientX, y: e.clientY };
    sizeStart.current = { width: panelSize.width, height: panelSize.height };
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        setPanelPos({
          x: Math.max(10, Math.min(window.innerWidth - panelSize.width - 10, panelStart.current.x + dx)),
          y: Math.max(10, Math.min(window.innerHeight - panelSize.height - 10, panelStart.current.y + dy)),
        });
      }
      if (isResizing) {
        const dx = e.clientX - resizeStart.current.x;
        const dy = e.clientY - resizeStart.current.y;
        setPanelSize({
          width: Math.max(320, Math.min(800, sizeStart.current.width + dx)),
          height: Math.max(400, Math.min(1000, sizeStart.current.height + dy)),
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isResizing, panelSize]);

  // File Upload Handling
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = ""; // reset so selecting the same file re-fires onChange
  };

  // Clipboard Image Paste Handling
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const reader = new FileReader();
            reader.onload = () => {
              setAttachedImage(reader.result as string);
            };
            reader.readAsDataURL(blob);
            e.preventDefault();
          }
        }
      }
    }
  };

  // Quick Manual Visual Capture
  const handleCaptureCanvas = async () => {
    setStatusText("Capturing visual layout map...");
    try {
      const screenshotDataUrl = await generateCanvasScreenshot(
        elements,
        canvasState.width,
        canvasState.height,
        canvasState.backgroundImage,
        canvasState.showAnnotations !== false ? canvasState.annotations : undefined
      );
      setAttachedImage(screenshotDataUrl);
      setStatusText(null);
    } catch (e) {
      console.error("Failed to generate mockup screenshot", e);
      setStatusText("Failed to take screenshot.");
      setTimeout(() => setStatusText(null), 3000);
    }
  };

  // Stop / Abort generation stream mid-way. Also drops any queued mid-turn sends —
  // Stop means stop everything, including messages waiting to run.
  const handleInterruptStream = () => {
    pendingSendsRef.current = [];
    setQueuedSends([]);
    // If the agent is BLOCKED on a question/permission, deny it so the CLI child
    // unblocks and returns to idle for the next turn (the session is persistent —
    // a child left waiting on a control_request would wedge the next turn).
    const blocked = pendingControl;
    if (blocked) {
      fetch("/api/assistant/control-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentSessionId || undefined,
          sessionId: claudeSessionIdRef.current || undefined,
          requestId: blocked.requestId,
          response: { behavior: "deny", message: "The user stopped generation." },
        }),
      }).catch((e) => console.error("Failed to deny pending control on stop", e));
    }
    setPendingControl(null);
    setCurrentToolCalls([]);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStatusText("Generation interrupted by user.");
    setTimeout(() => setStatusText(null), 3000);
  };

  // Answer a live CLI question/permission (AskUserQuestion / can_use_tool). POSTs
  // the choice to /api/assistant/control-response, which writes it back to the
  // blocked CLI child's stdin as a control_response. The SAME SSE stream stays
  // open — the agent unblocks and keeps streaming into the current turn. The
  // `response` shape mirrors BCC exactly:
  //   AskUserQuestion submit → { behavior:"allow", updatedInput:{ questions, answers } }
  //   permission allow/deny  → { behavior:"allow"|"deny", updatedInput?, message? }
  const answerControlRequest = async (requestId: string, response: Record<string, unknown>) => {
    setPendingControl(null);
    try {
      await fetch("/api/assistant/control-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentSessionId || undefined,
          sessionId: claudeSessionIdRef.current || undefined,
          requestId,
          response,
        }),
      });
    } catch (e) {
      console.error("Failed to POST control response", e);
    }
  };


  const handleCopyMessage = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* ignore */
    }
  };

  // Re-run the last user turn (BCC message "retry").
  const handleRetry = () => {
    if (isStreaming || activeTurnRef.current) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) handleSendMessage(lastUser.text, lastUser.image);
  };



  // Compute Context Meter percentage
  const getContextPercentage = () => {
    // Prefer the CLI's REAL context-window usage (get_context_usage) when we have
    // it. `percentage` is 0–100 (accept a 0–1 fraction defensively).
    if (contextUsage && Number.isFinite(contextUsage.percentage)) {
      const p = contextUsage.percentage <= 1 ? contextUsage.percentage * 100 : contextUsage.percentage;
      return Math.min(100, Math.max(0, Math.round(p)));
    }
    // Fallback estimate (no real reading yet / non-Claude provider): ~150k chars.
    const totalChars = messages.reduce((acc, m) => acc + m.text.length + (m.thinking?.length || 0), 0);
    return Math.min(100, Math.floor((totalChars / 150000) * 100));
  };


  const getFontFamilyClass = () => {
    switch (fontFamily) {
      case "mono":
        return "font-mono";
      case "serif":
        return "font-serif";
      default:
        return "font-sans";
    }
  };

  // Derived provider/model helpers for the selector UI
  const selectedProviderInfo = providers.find((p) => p.id === selectedProvider);
  const providerLabel = selectedProviderInfo?.label || selectedProvider;

  return (
    <div className="gantasmo-orb-theme text-slate-200">
      {/* 1. Floating Orb Button — Gantasmo ghost-face orb (visual match to theDAW) */}
      <GantasmoOrb
        isActive={isOpen}
        onToggle={() => setIsOpen(!isOpen)}
        ariaLabel="Toggle AI assistant"
        persistenceKey="vst-foundry-orb-position"
      />

      {/* 2. Interactive Drag-and-Resize Chat Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={containerRef}
            id="ai-assistant-panel"
            initial={{ opacity: 0, scale: 0.9, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 30 }}
            className="fixed flex flex-col overflow-hidden z-9998"
            style={{
              left: panelPos.x,
              top: panelPos.y,
              width: panelSize.width,
              height: panelSize.height,
              background: "rgba(9,9,11,0.95)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 16,
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
            }}
          >
            {/* Header Handle for dragging */}
            <div
              ref={headerRef}
              className="cursor-move select-none"
              onMouseDown={handleDragStart}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)",
                background: "linear-gradient(to right, rgba(185,28,28,0.1), rgba(153,27,27,0.1))",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: "linear-gradient(135deg, #b91c1c, #991b1b)",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <div style={{ width: 16, height: 16, borderRadius: "50%", background: "rgba(255,255,255,0.9)" }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#fafafa" }}>Design Orchestrator</div>
                  <div style={{ fontSize: 10, color: "#52525b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                    {providerLabel} · {selectedModel || "—"}
                  </div>
                </div>
              </div>

              {/* Action Toolbar */}
              <div className="flex items-center" style={{ gap: 4, flexShrink: 0 }} onMouseDown={(e) => e.stopPropagation()}>
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  style={{ padding: 6, borderRadius: 8, background: "none", border: "none", cursor: "pointer", color: showHistory ? "#f87171" : "#52525b", display: "flex" }}
                  title="Conversation History"
                >
                  <History className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  style={{ padding: 6, borderRadius: 8, background: "none", border: "none", cursor: "pointer", color: showSettings ? "#f87171" : "#52525b", display: "flex" }}
                  title="Assistant Settings"
                >
                  <Settings className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  style={{ padding: 6, borderRadius: 8, background: "none", border: "none", cursor: "pointer", color: "#52525b", display: "flex" }}
                  title="Close Assistant"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Inner Panels Overlay */}
            <div className="flex-1 relative overflow-hidden flex flex-col">
              {/* History Overlap */}
              <AnimatePresence>
                {showHistory && (
                  <motion.div
                    initial={{ x: "-100%" }}
                    animate={{ x: 0 }}
                    exit={{ x: "-100%" }}
                    className="absolute inset-y-0 left-0 w-3/4 bg-[#0f0f12] border-r border-white/10 z-50 p-4 flex flex-col"
                  >
                    <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-2">
                      <span className="text-sm font-semibold text-zinc-100">Session Threads</span>
                      <button
                        onClick={() => startNewChat()}
                        className="flex items-center space-x-1 text-xs px-2 py-1 bg-red-700/30 hover:bg-red-600 rounded text-red-100 hover:text-white border border-red-500/30 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>New</span>
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
                      {sessions.map((s) => (
                        <div
                          key={s.id}
                          onClick={() => loadSession(s.id)}
                          className={`flex items-center justify-between p-2.5 rounded-lg text-xs cursor-pointer group transition-all ${
                            currentSessionId === s.id
                              ? "bg-red-700/20 border border-red-500/30 text-white"
                              : "hover:bg-white/5 border border-transparent text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          <div className="flex items-center space-x-2 overflow-hidden flex-1">
                            <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{s.name}</span>
                          </div>
                          <button
                            onClick={(e) => deleteSession(s.id, e)}
                            className="p-1 hover:text-red-400 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity rounded cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Settings Overlap */}
              <AnimatePresence>
                {showSettings && (
                  <motion.div
                    initial={{ y: "-100%" }}
                    animate={{ y: 0 }}
                    exit={{ y: "-100%" }}
                    className="absolute inset-x-0 top-0 bg-[#0f0f12] border-b border-white/10 z-40 p-4 space-y-3.5 max-h-full overflow-y-auto"
                  >
                    {/* Settings tabs — Chat | Keys (matches theDAW orb) */}
                    <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.06)", margin: "-16px -16px 0", padding: "0 4px" }}>
                      {(["model", "keys"] as const).map((tab) => (
                        <button
                          key={tab}
                          onClick={() => setSettingsTab(tab)}
                          style={{
                            flex: 1, padding: "8px 12px", fontSize: 10, fontWeight: 500, cursor: "pointer",
                            background: "none", border: "none", textTransform: "uppercase", letterSpacing: "0.5px",
                            borderBottom: settingsTab === tab ? "2px solid #f87171" : "2px solid transparent",
                            color: settingsTab === tab ? "#f87171" : "#52525b",
                          }}
                        >
                          {tab === "model" ? "Chat" : "Keys"}
                        </button>
                      ))}
                    </div>

                    {settingsTab === "model" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
                        <div>
                          <span style={{ fontSize: 10, color: "#52525b", display: "block", marginBottom: 4 }}>Provider</span>
                          <select
                            value={selectedProvider}
                            onChange={(e) => setSelectedProvider(e.target.value)}
                            style={{ width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 8px", fontSize: 11, color: "#fafafa", outline: "none", cursor: "pointer" }}
                          >
                            {!providers.find((p) => p.id === selectedProvider) && (
                              <option value={selectedProvider}>{selectedProvider}</option>
                            )}
                            {providers.map((p) => (
                              <option key={p.id} value={p.id}>{p.label}{p.isLocal ? " (Local)" : ""}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <span style={{ fontSize: 10, color: "#52525b", display: "block", marginBottom: 4 }}>Model</span>
                          <select
                            value={selectedModel}
                            onChange={(e) => setSelectedModel(e.target.value)}
                            style={{ width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 8px", fontSize: 11, fontFamily: "monospace", color: "#f87171", outline: "none", cursor: "pointer" }}
                          >
                            {selectedModel && !models.find((m) => m.id === selectedModel) && (
                              <option value={selectedModel}>{selectedModel || "Loading..."}</option>
                            )}
                            {models.length === 0 && !selectedModel && (
                              <option value="">Loading models...</option>
                            )}
                            {models.map((m) => (
                              <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                          </select>
                        </div>
                        {selectedProvider === "claude" && (
                          <div>
                            <span style={{ fontSize: 10, color: "#52525b", display: "block", marginBottom: 4 }}>Effort</span>
                            <select
                              value={effort}
                              onChange={(e) => setEffort(e.target.value)}
                              style={{ width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 8px", fontSize: 11, color: "#fafafa", outline: "none", cursor: "pointer" }}
                            >
                              {EFFORT_OPTIONS.map((lvl) => (
                                <option key={lvl} value={lvl}>{lvl.charAt(0).toUpperCase() + lvl.slice(1)}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#52525b" }}>
                          <span>Active: <span style={{ fontFamily: "monospace", color: "#f87171" }}>{selectedModel || "—"}</span></span>
                        </div>
                      </div>
                    )}

                    {settingsTab === "keys" && (
                      <div style={{ maxHeight: 220, overflowY: "auto", paddingTop: 4 }}>
                        {providers.filter((p) => p.id !== "claude" && !p.isLocal).map((p) => (
                          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                            <span style={{ fontSize: 10, color: "#52525b", width: 80, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span>
                            {editingKey === p.id ? (
                              <div style={{ flex: 1, display: "flex", gap: 4 }}>
                                <input
                                  name={`fdy-key-${p.id}`}
                                  type={showKeyText ? "text" : "password"}
                                  value={keyInput}
                                  onChange={(e) => setKeyInput(e.target.value)}
                                  placeholder="Paste API key..."
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && keyInput.trim()) { setProviderApiKeys((prev) => ({ ...prev, [p.id]: keyInput.trim() })); setEditingKey(null); setKeyInput(""); }
                                    if (e.key === "Escape") { setEditingKey(null); setKeyInput(""); }
                                  }}
                                  style={{ flex: 1, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "2px 8px", fontSize: 10, fontFamily: "monospace", color: "#fafafa", outline: "none" }}
                                />
                                <button onClick={() => setShowKeyText(!showKeyText)} style={{ fontSize: 9, color: "#52525b", background: "none", border: "none", cursor: "pointer" }}>{showKeyText ? "Hide" : "Show"}</button>
                                <button onClick={() => { if (keyInput.trim()) { setProviderApiKeys((prev) => ({ ...prev, [p.id]: keyInput.trim() })); setEditingKey(null); setKeyInput(""); } }} style={{ fontSize: 9, color: "#f87171", background: "rgba(185,28,28,0.2)", border: "none", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}>Save</button>
                                <button onClick={() => { setEditingKey(null); setKeyInput(""); }} style={{ fontSize: 9, color: "#52525b", background: "none", border: "none", cursor: "pointer" }}>X</button>
                              </div>
                            ) : (
                              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
                                {providerApiKeys[p.id] ? (
                                  <>
                                    <span style={{ fontFamily: "monospace", fontSize: 9, color: "#10b981" }}>{maskKey(providerApiKeys[p.id])}</span>
                                    <button onClick={() => setProviderApiKeys((prev) => { const n = { ...prev }; delete n[p.id]; return n; })} style={{ fontSize: 9, color: "#ef4444", background: "none", border: "none", cursor: "pointer" }}>Clear</button>
                                  </>
                                ) : (
                                  <span style={{ fontSize: 9, color: "rgba(82,82,91,0.5)" }}>{p.requiresKey === false ? "env" : "not set"}</span>
                                )}
                                <button onClick={() => { setEditingKey(p.id); setKeyInput(providerApiKeys[p.id] || ""); }} style={{ marginLeft: "auto", fontSize: 9, color: "rgba(248,113,113,0.85)", background: "none", border: "none", cursor: "pointer" }}>{providerApiKeys[p.id] ? "Edit" : "Add"}</button>
                              </div>
                            )}
                          </div>
                        ))}
                        <div style={{ paddingTop: 4, fontSize: 9, color: "rgba(82,82,91,0.4)", fontStyle: "italic" }}>Keys stored in browser localStorage.</div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Chat Thread Area */}
              <div
                ref={scrollRef}
                className={getFontFamilyClass()}
                style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
              >
                <Transcript
                  messages={messages}
                  textScale={textScale}
                  isStreaming={isStreaming}
                  currentThinking={currentThinking}
                  currentText={currentText}
                  currentToolCalls={currentToolCalls}
                  pendingControl={pendingControl}
                  onCopyMessage={handleCopyMessage}
                  onRetry={handleRetry}
                  onAnswerControl={answerControlRequest}
                />
              </div>

              {/* Status + memory bar */}
              <div style={{ padding: "6px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.2)", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10 }}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, maxWidth: "65%" }}
                  title={
                    contextUsage
                      ? `Context: ${contextUsage.totalTokens.toLocaleString()} / ${contextUsage.maxTokens.toLocaleString()} tokens`
                      : "Estimated (no live context reading yet)"
                  }
                >
                  <span style={{ color: "#52525b" }}>{contextUsage ? "Context" : "Memory"}</span>
                  <div style={{ flex: 1, height: 4, borderRadius: 9999, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                    <div style={{ height: "100%", borderRadius: 9999, transition: "width 0.5s", width: `${getContextPercentage()}%`, background: getContextPercentage() > 80 ? "#ef4444" : getContextPercentage() > 50 ? "#f59e0b" : "linear-gradient(to right, #b91c1c, #991b1b)" }} />
                  </div>
                  <span style={{ color: "#71717a", fontFamily: "monospace" }}>{getContextPercentage()}%</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: "35%", overflow: "hidden" }}>
                  {isStreaming ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" style={{ color: "#f87171" }} />
                      <span style={{ color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{statusText || "Thinking..."}</span>
                    </>
                  ) : statusText ? (
                    <span style={{ color: "#10b981", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{statusText}</span>
                  ) : (
                    <span style={{ color: "#52525b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={cliModel || undefined}>{selectedProvider === "claude" && cliModel ? cliModel : "Ready"}</span>
                  )}
                </div>
              </div>

              {/* Referenced canvas elements ("Add to Chat" chips) */}
              {referencedElements.length > 0 && (
                <div style={{ padding: "6px 16px", background: "rgba(0,0,0,0.2)", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: "#71717a", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>Referenced</span>
                  {referencedElements.map((r) => (
                    <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#a1a1aa", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 9999, padding: "2px 4px 2px 8px" }}>
                      {r.name}
                      <span style={{ color: "#71717a" }}>· {r.type}</span>
                      <button
                        onClick={() => setReferencedElements((prev) => prev.filter((p) => p.id !== r.id))}
                        title="Remove reference"
                        aria-label={`Remove referenced element ${r.name}`}
                        style={{ padding: 2, background: "none", border: "none", cursor: "pointer", color: "#71717a", display: "flex" }}
                      ><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}

              {/* Attached image preview */}
              {attachedImage && (
                <div style={{ padding: "6px 16px", background: "rgba(0,0,0,0.2)", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <img src={attachedImage} alt="Attachment" style={{ width: 32, height: 32, borderRadius: 4, objectFit: "cover", border: "1px solid rgba(255,255,255,0.1)" }} />
                    <span style={{ fontSize: 11, color: "#a1a1aa" }}>Image attached for reasoning</span>
                  </div>
                  <button onClick={() => setAttachedImage(null)} style={{ padding: 4, background: "none", border: "none", cursor: "pointer", color: "#71717a", display: "flex" }} title="Remove"><X className="w-3.5 h-3.5" /></button>
                </div>
              )}

              {/* Queued mid-turn sends (BCC parity) */}
              {queuedSends.length > 0 && (
                <div style={{ padding: "6px 16px", background: "rgba(185,28,28,0.08)", borderTop: "1px solid rgba(185,28,28,0.18)", display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 10, color: "#fca5a5", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Queued ({queuedSends.length}) — runs after the current turn
                  </span>
                  {queuedSends.map((q, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#fca5a5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q}</span>
                      <button
                        onClick={() => {
                          pendingSendsRef.current.splice(i, 1);
                          setQueuedSends(pendingSendsRef.current.map((p) => p.prompt));
                        }}
                        title="Remove from queue"
                        aria-label="Remove queued message"
                        style={{ padding: 2, background: "none", border: "none", cursor: "pointer", color: "#71717a", display: "flex", flexShrink: 0 }}
                      ><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}

              {/* Input */}
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.2)", padding: 12, display: "flex", alignItems: "flex-end", gap: 8 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                  <button onClick={handleCaptureCanvas} title="See canvas (screenshot)" style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#71717a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><Camera className="w-4 h-4" /></button>
                  <button onClick={() => fileInputRef.current?.click()} title="Upload image" style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#71717a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><Upload className="w-4 h-4" /></button>
                </div>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  onPaste={handlePaste}
                  placeholder={isStreaming ? "Type to queue the next message…" : "Ask AI to design, style, or arrange elements..."}
                  style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#fafafa", outline: "none", resize: "none", minHeight: 56, maxHeight: 120, fontFamily: "inherit" }}
                />
                {speech.supported && (
                  <button
                    onClick={() => (speech.listening ? speech.stop() : speech.start())}
                    disabled={speech.transcribing}
                    aria-label={speech.transcribing ? "Transcribing voice input" : speech.listening ? "Stop recording" : "Start voice input"}
                    title={speech.transcribing ? "Transcribing…" : speech.listening ? "Stop recording" : "Dictate (voice input)"}
                    className={speech.listening ? "animate-pulse" : undefined}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      cursor: speech.transcribing ? "wait" : "pointer",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: speech.listening ? "1px solid rgba(239,68,68,0.5)" : "1px solid rgba(255,255,255,0.1)",
                      background: speech.listening ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.05)",
                      color: speech.listening ? "#fca5a5" : "#71717a",
                    }}
                  >
                    {speech.transcribing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
                  </button>
                )}
                {isStreaming ? (
                  <button onClick={handleInterruptStream} title="Stop" style={{ width: 36, height: 36, borderRadius: 8, cursor: "pointer", background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Square className="w-3.5 h-3.5 fill-current" /></button>
                ) : (
                  <button onClick={() => handleSendMessage()} disabled={!input.trim() && !attachedImage && referencedElements.length === 0} title="Send" style={{ width: 36, height: 36, borderRadius: 8, border: "none", cursor: (!input.trim() && !attachedImage && referencedElements.length === 0) ? "not-allowed" : "pointer", background: "linear-gradient(135deg, #b91c1c, #991b1b)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 2px 8px rgba(185,28,28,0.3)", opacity: (!input.trim() && !attachedImage && referencedElements.length === 0) ? 0.5 : 1 }}><Send className="w-3.5 h-3.5" /></button>
                )}
              </div>
            </div>

            {/* Hidden Input File Trigger */}
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />

            {/* Bottom Resize Handle */}
            <div
              ref={resizeRef}
              className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize z-9999"
              onMouseDown={handleResizeStart}
            >
              <div className="absolute right-0.5 bottom-0.5 w-1.5 h-1.5 bg-slate-500/30 rounded-br border-r border-b border-slate-500/60" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
