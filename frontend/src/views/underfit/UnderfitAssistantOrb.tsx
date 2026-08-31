import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  MessageSquare,
  History,
  Plus,
  Trash2,
  Square,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Upload,
  X,
  Settings,
  Cpu,
  Send,
  Loader2,
  Mic,
  Wrench,
  HelpCircle,
  Check,
  Pencil,
  ListTodo,
  Bot,
  Copy,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import GantasmoOrb from "../../orb-kit/react/GantasmoOrb";
import "../../orb-kit/styles/gantasmo-orb.css";
import "../../orb-kit/chat/orb-chat.css";
import "./underfit-orb.css";

// Assistant backend base URL. This orb is bundled INTO underfit's dashboard
// (served on :8791). It talks to underfit's OWN assistant backend — a clone of
// the VST Foundry assistant (identical providers/models + Better Claude Code) —
// running on :5473 (cross-origin fetch/SSE). Override at runtime via
// window.__UNDERFIT_ASSISTANT_BASE__.
const ASSISTANT_API_BASE =
  (typeof window !== "undefined" &&
    (window as unknown as { __UNDERFIT_ASSISTANT_BASE__?: string })
      .__UNDERFIT_ASSISTANT_BASE__) ||
  "http://localhost:5473";

// One tool the agent invoked, paired with its result. `inputJson` is the tool
// input as a JSON string (BCC stores it stringified so partial input deltas can
// accumulate before parse); the renderer try/pretty-prints it. `result`/`isError`
// arrive later via the matching tool_result frame (joined on `toolId`).
// `subCalls` holds a sub-agent's tools when this entry is a Task/Agent spawn
// (BCC parity: sub-agent activity nests under its card, off the main transcript).
interface ToolCallEntry {
  toolId: string;
  name: string;
  inputJson: string;
  result?: string;
  isError?: boolean;
  status: "executing" | "success" | "error";
  subCalls?: ToolCallEntry[];
}

// Per-turn accounting from the CLI `result` event (BCC shows this under each
// assistant message). `costUsd` is the per-turn delta of cumulative session cost.
interface TurnMeta {
  costUsd?: number;
  inTokens?: number;
  outTokens?: number;
  durationMs?: number;
  isError?: boolean;
}

// A live CLI control_request the user must answer (AskUserQuestion multiple
// choice, or a can_use_tool permission prompt). Mirrors BCC's PendingPermission.
interface PendingControl {
  requestId: string;
  toolName: string;
  input: any;
  suggestions?: any[];
  reason?: string;
}

// A live `ask_user` multiple-choice question raised by a DIRECT-API provider
// (the ask_user tool). Distinct from PendingControl (which is the Claude CLI's
// native AskUserQuestion / permission control_request). Rendered as the special
// interactive question card and answered via /api/assistant/control-response,
// keyed by the tool-call `id`.
interface PendingAsk {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  allowOther: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  image?: string; // base64
  toolCalls?: ToolCallEntry[];
  meta?: TurnMeta;
  groundingUrls?: Array<{ title: string; url: string }>;
  // True for a bubble that records a user's answer to an ask_user /
  // AskUserQuestion card. Kept in the transcript (cosmetic) but FILTERED from the
  // conversation history sent on later turns — the model already received the
  // answer as the tool result during the asking turn, so re-sending it would
  // duplicate it (and could produce two consecutive user messages).
  askAnswer?: boolean;
  timestamp: number;
}

interface ChatSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  provider?: string;
  model: string;
  effort?: string;
  thinkingLevel?: string; // legacy field, kept for backward-compat reads
  claudeSessionId?: string | null;
  lastUpdated: number;
}

// Provider/model metadata returned by the backend discovery endpoints.
interface ProviderInfo {
  id: string;
  label: string;
  requiresKey: boolean;
  isLocal: boolean;
  defaultModel: string;
}

interface ModelInfo {
  id: string;
  label: string;
  capabilities?: string[];
}


// Effort levels accepted by the Claude Code provider.
const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

// LocalStorage keys
const LS_PROVIDER = "underfit-provider";
const LS_MODEL = "underfit-model";
const LS_PROVIDER_KEYS = "underfit-provider-api-keys";
const LS_EFFORT = "underfit-effort";
const LS_LEGACY_KEY = "underfit-custom-api-key";
const LS_SESSIONS = "underfit-assistant-sessions";

const DEFAULT_PROVIDER = "claude";
// Must be a full model id the backend/CLI accepts (matches better-claude-code).
// CLI aliases like "opus"/"sonnet" are unreliable on this machine, so use the
// full id; the server also normalizes any stale value to a valid full id.
const DEFAULT_MODEL = "claude-opus-4-8";

// Normalize a provider record from the backend into a consistent shape.
// Tolerates both the documented contract (requiresKey/isLocal/defaultModel)
// and the alternate backend field names (has_key/is_local/default_model).
function normalizeProviders(raw: any[]): ProviderInfo[] {
  return (raw || []).map((p) => {
    const isLocal = p.isLocal ?? p.is_local ?? false;
    let requiresKey: boolean;
    if (typeof p.requiresKey === "boolean") {
      requiresKey = p.requiresKey;
    } else if (typeof p.has_key === "boolean") {
      // has_key=true means the server already has a usable key for this provider
      requiresKey = !isLocal && !p.has_key;
    } else {
      requiresKey = false;
    }
    return {
      id: p.id,
      label: p.label ?? p.id,
      requiresKey: p.id === "claude" ? false : requiresKey,
      isLocal,
      defaultModel: p.defaultModel ?? p.default_model ?? "",
    };
  });
}

function normalizeModels(raw: any[]): ModelInfo[] {
  return (raw || []).map((m: any) => ({
    id: m.id,
    label: m.label ?? m.name ?? m.id,
    capabilities: m.capabilities,
  }));
}


// ---------------------------------------------------------------------------
// Lightweight markdown renderer for assistant replies (ported from theDAW's
// orb chat so the Foundry assistant renders identically to the Gantasmo orb).
// ---------------------------------------------------------------------------
function inlineMd(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
      // Security: only allow safe link schemes; block javascript:/data:/etc.,
      // and neutralize any quote that could break out of the href attribute.
      const raw = String(url).trim();
      const safe = /^(https?:|mailto:|#|\/)/i.test(raw) ? raw.replace(/"/g, "%22") : "#";
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
}

function buildTable(rows: string[]): string {
  if (rows.length < 1) return "";
  const parse = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const hdrs = parse(rows[0]);
  const sep = rows.length > 1 && /^[\s|:-]+$/.test(rows[1]);
  const start = sep ? 2 : 1;
  let h = "<table><thead><tr>" + hdrs.map((c) => `<th>${inlineMd(c)}</th>`).join("") + "</tr></thead><tbody>";
  for (let r = start; r < rows.length; r++) {
    if (/^[\s|:-]+$/.test(rows[r])) continue;
    h += "<tr>" + parse(rows[r]).map((c) => `<td>${inlineMd(c)}</td>`).join("") + "</tr>";
  }
  return h + "</tbody></table>";
}

function isBlockStart(line: string): boolean {
  const t = line.trim();
  return /^#{1,4}\s/.test(line) || /^>\s?/.test(line) || /^\s*[-*+]\s/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
    (/^\|.+\|$/.test(t)) || /^\x00P\d+\x00$/.test(line);
}

function simpleMarkdown(text: string): string {
  const ph: string[] = [];
  const src = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    ph.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${esc}</code></pre>`);
    return `\x00P${ph.length - 1}\x00`;
  });
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const pm = line.match(/^\x00P(\d+)\x00$/);
    if (pm) { out.push(ph[parseInt(pm[1])]); i++; continue; }
    if (!trimmed) { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push("<hr/>"); i++; continue; }
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) { out.push(`<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${buf.map((l) => inlineMd(l)).join("<br/>")}</blockquote>`);
      continue;
    }
    if (/^\|.+\|$/.test(trimmed)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) { rows.push(lines[i]); i++; }
      out.push(buildTable(rows));
      continue;
    }
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s/, "")); i++; }
      out.push(`<ul>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s/, "")); i++; }
      out.push(`<ol>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ol>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    if (para.length) out.push(`<p>${para.map((l) => inlineMd(l)).join("<br/>")}</p>`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Voice input via MediaRecorder → backend /api/assistant/transcribe (server-side
// STT through faster-whisper). Ported from better-claude-code's ChatPane
// useSpeechInput (frontend/src/ChatPane.tsx:32-106). `listening` drives the mic
// "recording" indicator and `transcribing` shows a spinner while the recorded
// clip is uploaded. Unsupported browsers (no getUserMedia) hide the button.
// ---------------------------------------------------------------------------
function useSpeechInput(onText: (t: string) => void) {
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  // Stop tracks + recorder without uploading (used on unmount / errors).
  const teardown = useCallback(() => {
    try {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    } catch {
      /* noop */
    }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* noop */
      }
    });
    streamRef.current = null;
  }, []);

  // Release the mic if the host component ever unmounts (StrictMode dev cycles).
  useEffect(() => () => teardown(), [teardown]);

  const stop = useCallback(() => {
    // onstop assembles + uploads the blob; just request the stop here.
    try {
      recRef.current?.stop();
    } catch {
      teardown();
      setListening(false);
    }
  }, [teardown]);

  const start = useCallback(async () => {
    if (!supported || recRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Mic permission denied / no device — surface as a one-shot note in input.
      onText("[microphone unavailable — permission denied]");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType =
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.("audio/webm")
        ? "audio/webm"
        : "";
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      const tracks = streamRef.current;
      streamRef.current = null;
      recRef.current = null;
      tracks?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      setListening(false);
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
      chunksRef.current = [];
      if (blob.size === 0) return;
      setTranscribing(true);
      try {
        const res = await fetch(ASSISTANT_API_BASE + "/api/assistant/transcribe", {
          method: "POST",
          headers: { "Content-Type": blob.type || "audio/webm" },
          body: blob,
        });
        const data = await res.json().catch(() => null);
        if (data?.ok && typeof data.text === "string" && data.text.trim()) {
          onText(data.text.trim());
        } else if (data && !data.ok) {
          onText(`[transcription failed: ${data.error ?? "unknown error"}]`);
        }
      } catch {
        onText("[transcription failed — backend unreachable]");
      } finally {
        setTranscribing(false);
      }
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [supported, onText]);

  return { supported, listening, transcribing, start, stop };
}

export default function UnderfitAssistantOrb() {
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
    fetch(ASSISTANT_API_BASE + "/api/assistant/providers")
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
      ? `${ASSISTANT_API_BASE}/api/assistant/models/${selectedProvider}?apiKey=${encodeURIComponent(apiKey)}`
      : `${ASSISTANT_API_BASE}/api/assistant/models/${selectedProvider}`;

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
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [currentThinking, setCurrentThinking] = useState("");
  const [currentText, setCurrentText] = useState("");
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallEntry[]>([]);
  // A live question/permission the CLI is BLOCKED on until the user answers.
  const [pendingControl, setPendingControl] = useState<PendingControl | null>(null);
  // A live `ask_user` multiple-choice question from a direct-API provider (the
  // agentic loop is BLOCKED server-side until the user picks). See PendingAsk.
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  // Cumulative session cost (total_cost_usd) so we can show each turn's delta.
  const sessionCostRef = useRef(0);
  // The model the CLI actually booted with (from system/init) — may differ from
  // the requested alias. null until the first turn's init frame arrives.
  const [cliModel, setCliModel] = useState<string | null>(null);
  // REAL context-window usage queried from the CLI (get_context_usage). null =
  // not yet fetched / unsupported → fall back to the char-count estimate.
  const [contextUsage, setContextUsage] = useState<{ totalTokens: number; maxTokens: number; percentage: number } | null>(null);
  const [currentGrounding, setCurrentGrounding] = useState<any[]>([]);

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
  const pendingSendsRef = useRef<Array<{ prompt: string; image?: string }>>([]);
  const [queuedSends, setQueuedSends] = useState<string[]>([]);

  // Dragging states
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panelStart = useRef({ x: 0, y: 0 });

  // Resizing states
  const [isResizing, setIsResizing] = useState(false);
  const resizeStart = useRef({ x: 0, y: 0 });
  const sizeStart = useRef({ width: 0, height: 0 });

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
    fetch(ASSISTANT_API_BASE + "/api/assistant/session/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    }).catch(() => {});
  };

  // Start fresh chat session. baseSessions overrides the sessions closure
  // state — needed on mount, where the freshly loaded history hasn't flushed
  // into state yet (building on the stale empty array would wipe history).
  const startNewChat = (forceOpen = true, baseSessions?: ChatSession[]) => {
    // Release the prior backend session before abandoning its id client-side.
    releaseSession(currentSessionId);
    const base = baseSessions ?? sessions;
    const newId = Math.random().toString(36).substring(2, 9);
    const newSession: ChatSession = {
      id: newId,
      name: `Underfit Session ${base.length + 1}`,
      messages: [
        {
          id: "welcome",
          role: "assistant",
          text: "Hi — I'm your Underfit training assistant. I can launch and monitor LoRA finetunes, manage datasets, watch GPU/VRAM, pull demos and loss curves, and manage checkpoints for your Stable Audio 3 models. What do you want to train?",
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
      fetch(ASSISTANT_API_BASE + "/api/assistant/control-response", {
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
    // ask_user needs no deny POST: aborting the fetch closes the SSE, which lets
    // the server's awaitAskUser resolve via its abort listener. Just clear the card.
    setPendingAsk(null);
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
    // Parity with the ask_user card: when the user answers an AskUserQuestion,
    // echo the choice as a user bubble so the transcript records what was picked.
    // Tagged askAnswer so it is not re-sent in later turns' history.
    const answers = (response as any)?.updatedInput?.answers;
    if (answers && typeof answers === "object") {
      const picked = Object.values(answers as Record<string, string>).map((v) => String(v)).filter(Boolean);
      if (picked.length) {
        setMessages((prev) => [
          ...prev,
          {
            id: Math.random().toString(36).substring(2, 9),
            role: "user",
            text: picked.join(", "),
            askAnswer: true,
            timestamp: Date.now(),
          },
        ]);
      }
    }
    try {
      await fetch(ASSISTANT_API_BASE + "/api/assistant/control-response", {
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

  // Answer a live `ask_user` multiple-choice question from a direct-API provider.
  // The agentic loop is BLOCKED server-side (awaitAskUser) until this POST resolves
  // it, keyed by the tool-call `id`; the choice returns to the model as the
  // ask_user tool result. Echo the pick as a user bubble (tagged askAnswer so it is
  // not duplicated in later turns' history) and disable the card.
  const answerAskUser = async (id: string, selected: string[], other: string | null) => {
    const parts = [...selected];
    if (other) parts.push(other);
    const bubbleText = parts.length ? parts.join(", ") : "(no answer)";
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(2, 9),
        role: "user",
        text: bubbleText,
        askAnswer: true,
        timestamp: Date.now(),
      },
    ]);
    setPendingAsk(null);
    try {
      await fetch(ASSISTANT_API_BASE + "/api/assistant/control-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentSessionId || undefined,
          sessionId: toolSessionIdRef.current || undefined,
          requestId: id,
          response: { selected, other },
        }),
      });
    } catch (e) {
      console.error("Failed to POST ask_user answer", e);
    }
  };

  // Query the CLI for its REAL context-window usage (BCC's get_context_usage) and
  // update the meter. No-op / keeps the estimate if the CLI doesn't answer.
  const refreshContextUsage = async () => {
    if (selectedProvider !== "claude") return;
    const sid = claudeSessionIdRef.current;
    if (!sid && !currentSessionId) return;
    try {
      const res = await fetch(ASSISTANT_API_BASE + "/api/assistant/control-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentSessionId || undefined,
          sessionId: sid || undefined,
          request: { subtype: "get_context_usage" },
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      const outer = json?.response; // { subtype:"success", request_id, response: ContextUsage }
      const usage = outer?.response;
      if (outer?.subtype === "success" && usage && typeof usage.percentage === "number") {
        setContextUsage({
          totalTokens: Number(usage.totalTokens ?? usage.total_tokens ?? 0),
          maxTokens: Number(usage.maxTokens ?? usage.max_tokens ?? 0),
          percentage: Number(usage.percentage),
        });
      }
    } catch {
      /* keep the char-count estimate */
    }
  };

  // Desktop notification when the tab is backgrounded (turn done / needs answer).
  const notifyDesktop = (title: string, body: string) => {
    try {
      if (typeof Notification === "undefined" || !document.hidden) return;
      if (Notification.permission === "granted") new Notification(title, { body });
    } catch {
      /* ignore */
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

  // Main stream caller function
  const handleSendMessage = async (customPrompt?: string, optionalImage?: string) => {
    const promptToSend = customPrompt || input;
    if (!promptToSend.trim() && !optionalImage && !attachedImage) return;

    setInput("");
    const imageToSend = optionalImage || attachedImage;
    setAttachedImage(null);

    // BCC parity: if a turn is already streaming, queue this message instead of
    // firing a second, colliding request (which the backend used to reject 409).
    // It is sent automatically when the current turn finishes (see the drain in
    // the stream loop's `finally`). Stop clears the queue.
    if (activeTurnRef.current) {
      pendingSendsRef.current.push({ prompt: promptToSend, image: imageToSend || undefined });
      setQueuedSends(pendingSendsRef.current.map((p) => p.prompt));
      return;
    }
    activeTurnRef.current = true;

    const userMsgId = Math.random().toString(36).substring(2, 9);
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      text: promptToSend,
      image: imageToSend || undefined,
      timestamp: Date.now(),
    };

    // Append user message immediately
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);
    setStatusText("Preparing AI Engine...");

    // Prime desktop-notification permission during this user gesture (so a later
    // background "turn done" / "needs answer" notification can actually show).
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    // Setup streaming chunks accumulation states
    setCurrentThinking("");
    setCurrentText("");
    setCurrentToolCalls([]);
    setCurrentGrounding([]);
    setPendingControl(null);
    setPendingAsk(null);

    const currentHistory = [...messagesRef.current, userMsg];

    // Build abort controller
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    let turnSucceeded = false;

    try {

      // Model-agnostic conversation history: [{role, content}].
      // Drop the seeded welcome greeting so providers that require a
      // user-first message (e.g. Anthropic) are not given an assistant lead.
      const conversationHistory = currentHistory
        .filter((m) => m.id !== "welcome")
        // Drop ask_user/AskUserQuestion answer bubbles — they were already handed
        // to the model as tool results during the asking turn (see ChatMessage.askAnswer).
        .filter((m) => !m.askAnswer)
        .map((m) => ({
          role: m.role,
          content: m.text,
        }));

      const body: Record<string, any> = {
        messages: conversationHistory,
        provider: selectedProvider,
        model: selectedModel,
        apiKey: providerApiKeys[selectedProvider] || undefined,
        conversationId: currentSessionId || undefined,
        assistantProfile: "underfit",
        screenshot: imageToSend || undefined,
      };

      // Claude Code-specific fields only when that provider is active.
      if (selectedProvider === "claude") {
        body.effort = effort;
        if (claudeSessionId) body.claudeSessionId = claudeSessionId;
      }

      const res = await fetch(ASSISTANT_API_BASE + "/api/assistant/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP Error: ${res.status} ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No readable stream received.");

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let currentEvent = ""; // legacy "event:" line support

      let thinkingAccumulated = "";
      let textAccumulated = "";
      let groundedLinksAccumulated: any[] = [];
      let toolCallsAccumulated: ToolCallEntry[] = [];
      let metaAccumulated: TurnMeta | undefined;
      let receivedDone = false;

      while (!receivedDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // SSE comment / keepalive ping (": ping")
          if (trimmed.startsWith(":")) continue;

          // Legacy "event: <name>" lines (kept for backward compatibility).
          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7).trim();
            continue;
          }
          if (!trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6).trim();
          if (!dataStr || dataStr === "[DONE]") {
            currentEvent = "";
            continue;
          }

          let dataObj: any;
          try {
            dataObj = JSON.parse(dataStr);
          } catch (err) {
            console.error("Failed to parse SSE line", dataStr, err);
            currentEvent = "";
            continue;
          }

          // Frame type comes from the JSON "type" field (new contract) or,
          // failing that, the legacy "event:" line.
          const frameType = dataObj.type || currentEvent;
          currentEvent = "";

          // Capture a relay session id from any frame that carries one. The ref
          // is updated synchronously so a tool result fired later in this same
          // stream targets the correct session id. The Claude CLI resume id is
          // only tracked for the Claude provider; non-Claude relay ids must not
          // pollute it (see toolSessionIdRef note above).
          const sid = dataObj.sessionId || dataObj.session_id;
          if (sid) {
            toolSessionIdRef.current = sid;
            if (selectedProvider === "claude") {
              // A NEW CLI session id means fresh cost accounting — rebaseline the
              // cumulative-cost ref so the first turn's cost delta isn't clamped,
              // and drop the stale context-usage reading.
              if (sid !== claudeSessionIdRef.current) {
                sessionCostRef.current = 0;
                setContextUsage(null);
              }
              claudeSessionIdRef.current = sid;
              setClaudeSessionId(sid);
            }
          }

          switch (frameType) {
            case "status":
              if (dataObj.message) setStatusText(dataObj.message);
              break;

            case "thinking":
              thinkingAccumulated += dataObj.text ?? dataObj.delta ?? "";
              setCurrentThinking(thinkingAccumulated);
              break;

            case "text":
            case "text_delta":
              textAccumulated += dataObj.text ?? dataObj.delta ?? "";
              setCurrentText(textAccumulated);
              break;

            case "session_id":
              // Handled above via the generic sid capture.
              break;

            case "grounding": {
              let links: any[] = [];
              if (Array.isArray(dataObj.sources)) {
                links = dataObj.sources
                  .filter((s: any) => s.uri || s.url)
                  .map((s: any) => ({
                    title: s.title || s.uri || s.url,
                    url: s.uri || s.url,
                  }));
              } else if (dataObj.metadata?.groundingChunks) {
                // Legacy Gemini grounding shape.
                links = dataObj.metadata.groundingChunks
                  .filter((c: any) => c.web?.uri)
                  .map((c: any) => ({
                    title: c.web.title || c.web.uri,
                    url: c.web.uri,
                  }));
              }
              if (links.length) {
                groundedLinksAccumulated = [...groundedLinksAccumulated, ...links];
                setCurrentGrounding(groundedLinksAccumulated);
              }
              break;
            }

            // Display-only tool activity (BCC parity). The agent's tool_use and
            // its matching tool_result are surfaced so the user can SEE what the
            // agent is doing (Read/Bash/Edit/Task/… and MCP canvas tools). This
            // is NOT the execution channel — canvas tools still run via the
            // `client_tool_call` relay case below. We only RENDER here.
            case "tool_use": {
              const tid = dataObj.toolId || "";
              const parentId = typeof dataObj.parentToolId === "string" ? dataObj.parentToolId : "";
              const entry: ToolCallEntry = {
                toolId: tid,
                name: dataObj.name || "tool",
                inputJson:
                  typeof dataObj.inputJson === "string"
                    ? dataObj.inputJson
                    : JSON.stringify(dataObj.input ?? {}),
                status: "executing",
              };
              if (parentId && toolCallsAccumulated.some((tc) => tc.toolId === parentId)) {
                // Sub-agent tool — NEST under its Task/Agent card instead of the
                // main list (BCC parity; keeps the main transcript uncorrupted).
                toolCallsAccumulated = toolCallsAccumulated.map((tc) => {
                  if (tc.toolId !== parentId) return tc;
                  const subs = tc.subCalls ?? [];
                  if (tid && subs.some((s) => s.toolId === tid)) return tc;
                  return { ...tc, subCalls: [...subs, entry] };
                });
              } else {
                // Top-level tool. Dedup: the CLI can re-emit the authoritative
                // assistant message, so guard on toolId.
                if (tid && toolCallsAccumulated.some((tc) => tc.toolId === tid)) break;
                toolCallsAccumulated = [...toolCallsAccumulated, entry];
              }
              setCurrentToolCalls(toolCallsAccumulated);
              break;
            }

            case "tool_result": {
              const tid = dataObj.toolId || "";
              const parentId = typeof dataObj.parentToolId === "string" ? dataObj.parentToolId : "";
              const isError = !!dataObj.isError;
              const resultText = typeof dataObj.content === "string" ? dataObj.content : "";
              const applyResult = (tc: ToolCallEntry): ToolCallEntry =>
                tc.toolId && tc.toolId === tid
                  ? { ...tc, result: resultText, isError, status: isError ? "error" : "success" }
                  : tc;
              if (parentId && toolCallsAccumulated.some((tc) => tc.toolId === parentId)) {
                toolCallsAccumulated = toolCallsAccumulated.map((tc) =>
                  tc.toolId === parentId ? { ...tc, subCalls: (tc.subCalls ?? []).map(applyResult) } : tc
                );
              } else {
                toolCallsAccumulated = toolCallsAccumulated.map(applyResult);
              }
              setCurrentToolCalls(toolCallsAccumulated);
              break;
            }

            // The agent is asking the USER something and is BLOCKED until we
            // answer. AskUserQuestion (multiple choice) and can_use_tool
            // (permission) both arrive as control_request/can_use_tool. Render a
            // card; the user's choice POSTs back via answerControlRequest.
            case "control_request": {
              const request = dataObj.request || {};
              if (request.subtype === "can_use_tool") {
                setPendingControl({
                  requestId: String(dataObj.requestId ?? ""),
                  toolName: String(request.tool_name ?? "tool"),
                  input: request.input,
                  suggestions: Array.isArray(request.permission_suggestions)
                    ? request.permission_suggestions
                    : undefined,
                  reason: typeof request.decision_reason === "string" ? request.decision_reason : undefined,
                });
                notifyDesktop("Underfit", "The agent needs your answer");
              }
              break;
            }

            case "control_cancel": {
              const rid = String(dataObj.requestId ?? "");
              setPendingControl((prev) => (prev && prev.requestId === rid ? null : prev));
              break;
            }

            // A DIRECT-API provider called the `ask_user` tool. The agentic loop
            // is BLOCKED server-side until we answer. Render the special
            // multiple-choice question card; the pick POSTs back via answerAskUser
            // (keyed by this tool-call id) and the same turn resumes streaming.
            case "ask_user": {
              const opts = Array.isArray(dataObj.options)
                ? dataObj.options
                    .map((o: any) =>
                      typeof o === "string"
                        ? { label: o }
                        : { label: String(o?.label ?? ""), description: typeof o?.description === "string" ? o.description : undefined },
                    )
                    .filter((o: any) => o.label)
                : [];
              setPendingAsk({
                id: String(dataObj.id ?? ""),
                question: String(dataObj.question ?? ""),
                options: opts,
                multiSelect: !!dataObj.multi_select,
                allowOther: dataObj.allow_other === undefined ? true : !!dataObj.allow_other,
              });
              notifyDesktop("Underfit", "The assistant is asking you something");
              break;
            }

            case "model":
              // The CLI's actual booted model (from system/init).
              if (dataObj.model) setCliModel(String(dataObj.model));
              break;

            case "client_tool_call":
            case "function_call":
              // (underfit) No browser-side tool execution. The underfit MCP
              // tools run inside the Claude CLI and surface via tool_use /
              // tool_result (display-only, above). Nothing to do here.
              break;

            case "function_result":
              // Server-side tool result; no client-side action required.
              break;

            case "done": {
              // Per-turn accounting (BCC parity): tokens incl. cache, this turn's
              // cost delta of cumulative total_cost_usd, duration, error state.
              const u = dataObj.usage || {};
              const inTokens =
                (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
              let costUsd: number | undefined;
              if (typeof dataObj.totalCostUsd === "number") {
                costUsd = Math.max(0, dataObj.totalCostUsd - sessionCostRef.current);
                sessionCostRef.current = dataObj.totalCostUsd;
              }
              metaAccumulated = {
                inTokens,
                outTokens: u.output_tokens || 0,
                costUsd,
                durationMs: typeof dataObj.durationMs === "number" ? dataObj.durationMs : undefined,
                isError: !!dataObj.isError,
              };
              receivedDone = true;
              break;
            }

            case "error":
              throw new Error(dataObj.message || dataObj.error || "Unknown stream error");

            default:
              // Unknown frame type — ignore gracefully.
              break;
          }

          if (receivedDone) break;
        }
      }

      // Finalize message creation
      const assistantMsgId = Math.random().toString(36).substring(2, 9);
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        text: textAccumulated || "I've completed the adjustments on your layout.",
        thinking: thinkingAccumulated || undefined,
        toolCalls: toolCallsAccumulated.length > 0 ? toolCallsAccumulated : undefined,
        meta: metaAccumulated,
        groundingUrls: groundedLinksAccumulated.length > 0 ? groundedLinksAccumulated : undefined,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
      turnSucceeded = true;
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("Stream aborted successfully");
      } else {
        console.error("Stream failed", err);
        const errorMsgId = Math.random().toString(36).substring(2, 9);
        setMessages((prev) => [
          ...prev,
          {
            id: errorMsgId,
            role: "assistant",
            text: `Error during communication: ${err.message || err}`,
            timestamp: Date.now(),
          },
        ]);
      }
    } finally {
      setIsStreaming(false);
      setStatusText(null);
      setCurrentThinking("");
      setCurrentText("");
      setCurrentToolCalls([]);
      setCurrentGrounding([]);
      setPendingControl(null);
      setPendingAsk(null);
      abortControllerRef.current = null;
      activeTurnRef.current = false;
      // BCC parity: this turn is done — send the next queued message (if any).
      const next = pendingSendsRef.current.shift();
      setQueuedSends(pendingSendsRef.current.map((p) => p.prompt));
      if (next) {
        // Defer a tick so the state resets above settle before the next turn opens.
        setTimeout(() => handleSendMessage(next.prompt, next.image), 0);
      } else if (turnSucceeded) {
        // No more queued turns: notify (if backgrounded) and refresh the REAL
        // context meter now that the child is idle.
        notifyDesktop("Underfit", "Response ready");
        refreshContextUsage();
      }
    }
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

  const getScaleClasses = () => {
    switch (textScale) {
      case "xs":
        return "text-[11px] leading-relaxed";
      case "md":
        return "text-[14px] leading-relaxed";
      case "lg":
        return "text-[16px] leading-relaxed";
      default:
        return "text-[12.5px] leading-relaxed";
    }
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
    <div className="gantasmo-orb-theme underfit-orb-white text-slate-200">
      {/* 1. Floating Orb Button — Gantasmo ghost-face orb, white theme for Underfit */}
      <GantasmoOrb
        isActive={isOpen}
        onToggle={() => setIsOpen(!isOpen)}
        ariaLabel="Toggle Underfit assistant"
        persistenceKey="underfit-orb-position"
        defaultPosition={{
          x: typeof window !== "undefined" ? window.innerWidth - 96 : 900,
          y: typeof window !== "undefined" ? window.innerHeight - 150 : 600,
        }}
        className="underfit-orb-white"
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
                background: "linear-gradient(to right, rgba(139,92,246,0.1), rgba(236,72,153,0.1))",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: "linear-gradient(135deg, #8b5cf6, #ec4899)",
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
                  style={{ padding: 6, borderRadius: 8, background: "none", border: "none", cursor: "pointer", color: showHistory ? "#8b5cf6" : "#52525b", display: "flex" }}
                  title="Conversation History"
                >
                  <History className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  style={{ padding: 6, borderRadius: 8, background: "none", border: "none", cursor: "pointer", color: showSettings ? "#8b5cf6" : "#52525b", display: "flex" }}
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
                        className="flex items-center space-x-1 text-xs px-2 py-1 bg-violet-600/30 hover:bg-violet-600 rounded text-violet-200 hover:text-white border border-violet-500/30 cursor-pointer"
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
                              ? "bg-violet-600/20 border border-violet-500/30 text-white"
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
                            borderBottom: settingsTab === tab ? "2px solid #8b5cf6" : "2px solid transparent",
                            color: settingsTab === tab ? "#8b5cf6" : "#52525b",
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
                            style={{ width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 8px", fontSize: 11, fontFamily: "monospace", color: "#8b5cf6", outline: "none", cursor: "pointer" }}
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
                          <span>Active: <span style={{ fontFamily: "monospace", color: "#8b5cf6" }}>{selectedModel || "—"}</span></span>
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
                                <button onClick={() => { if (keyInput.trim()) { setProviderApiKeys((prev) => ({ ...prev, [p.id]: keyInput.trim() })); setEditingKey(null); setKeyInput(""); } }} style={{ fontSize: 9, color: "#8b5cf6", background: "rgba(139,92,246,0.2)", border: "none", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}>Save</button>
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
                                <button onClick={() => { setEditingKey(p.id); setKeyInput(providerApiKeys[p.id] || ""); }} style={{ marginLeft: "auto", fontSize: 9, color: "rgba(139,92,246,0.7)", background: "none", border: "none", cursor: "pointer" }}>{providerApiKeys[p.id] ? "Edit" : "Add"}</button>
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
                {messages.map((m) => (
                  <div key={m.id} style={{ display: "flex", gap: 8, justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                    {m.role === "assistant" && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                        <div style={{
                          width: 24, height: 24, borderRadius: "50%",
                          background: "linear-gradient(135deg, #8b5cf6, #ec4899)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 12, color: "white", boxShadow: "0 2px 8px rgba(139,92,246,0.3)",
                        }}>&#9679;</div>
                        <span style={{ fontSize: 7, color: "#71717a", whiteSpace: "nowrap", letterSpacing: "0.05em" }}>GANTASMO</span>
                      </div>
                    )}
                    <div
                      className={getScaleClasses()}
                      style={{
                        maxWidth: "85%", padding: "8px 12px", borderRadius: 12, lineHeight: 1.5,
                        ...(m.role === "user"
                          ? { background: "#8b5cf6", color: "white", borderBottomRightRadius: 4 }
                          : { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderBottomLeftRadius: 4, color: "#fafafa" }),
                      }}
                    >
                      {/* Attached image if present */}
                      {m.image && (
                        <div style={{ marginBottom: 8, maxHeight: 144, overflow: "hidden", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)" }}>
                          <img src={m.image} alt="Attachment" style={{ width: "100%", objectFit: "cover" }} />
                        </div>
                      )}

                      {/* Reasoning process */}
                      {m.thinking && <CollapsibleReasoning thinking={m.thinking} textScale={textScale} />}

                      {/* Tool activity (what the agent did) */}
                      {m.toolCalls && m.toolCalls.length > 0 && (
                        <ToolCallList toolCalls={m.toolCalls} textScale={textScale} />
                      )}

                      {/* Main message text */}
                      {m.role === "user" ? (
                        <span style={{ whiteSpace: "pre-line" }}>{m.text}</span>
                      ) : (
                        <div className="orb-chat__prose" dangerouslySetInnerHTML={{ __html: simpleMarkdown(m.text) }} />
                      )}

                      {/* Per-turn accounting (tokens · cost · duration · error) */}
                      {m.role === "assistant" && m.meta && <TurnMetaLine meta={m.meta} />}

                      {/* Grounding source citations */}
                      {m.groundingUrls && m.groundingUrls.length > 0 && (
                        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 10 }}>
                          <span style={{ color: "#52525b" }}>Grounded sources:</span>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                            {m.groundingUrls.slice(0, 4).map((link, idx) => (
                              <a
                                key={idx}
                                href={link.url}
                                target="_blank"
                                rel="noreferrer"
                                title={link.title}
                                style={{ color: "#a78bfa", textDecoration: "underline", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              >
                                {link.title}
                              </a>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Message actions — copy (always) + retry (last turn only) */}
                      {m.role === "assistant" && m.id !== "welcome" && (
                        <div style={{ marginTop: 8, display: "flex", gap: 10, opacity: 0.65 }}>
                          <button
                            onClick={() => handleCopyMessage(m.text)}
                            title="Copy"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#71717a", display: "flex", alignItems: "center", gap: 3, fontSize: 10, padding: 0 }}
                          >
                            <Copy className="w-3 h-3" /> Copy
                          </button>
                          {!isStreaming && m.id === messages[messages.length - 1]?.id && (
                            <button
                              onClick={handleRetry}
                              title="Retry this turn"
                              style={{ background: "none", border: "none", cursor: "pointer", color: "#71717a", display: "flex", alignItems: "center", gap: 3, fontSize: 10, padding: 0 }}
                            >
                              <RotateCcw className="w-3 h-3" /> Retry
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {m.role === "user" && (
                      <div style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, background: "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#a1a1aa" }}>&#9679;</div>
                    )}
                  </div>
                ))}

                {/* Real-time streaming response */}
                {isStreaming && (currentThinking || currentText || currentToolCalls.length > 0) && (
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-start" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                      <div style={{ width: 24, height: 24, borderRadius: "50%", background: "linear-gradient(135deg, #8b5cf6, #ec4899)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "white", boxShadow: "0 2px 8px rgba(139,92,246,0.3)" }}>&#9679;</div>
                      <span style={{ fontSize: 7, color: "#71717a", whiteSpace: "nowrap", letterSpacing: "0.05em" }}>GANTASMO</span>
                    </div>
                    <div className={getScaleClasses()} style={{ maxWidth: "85%", padding: "8px 12px", borderRadius: 12, borderBottomLeftRadius: 4, lineHeight: 1.5, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#fafafa" }}>
                      {currentThinking && <CollapsibleReasoning thinking={currentThinking} textScale={textScale} defaultOpen={true} />}
                      {currentToolCalls.length > 0 && <ToolCallList toolCalls={currentToolCalls} textScale={textScale} />}
                      {currentText && <div className="orb-chat__prose" dangerouslySetInnerHTML={{ __html: simpleMarkdown(currentText) }} />}
                      <span className="orb-chat__cursor" />
                    </div>
                  </div>
                )}

                {/* Agent is asking a question / needs permission — answer inline.
                    The CLI is BLOCKED until the user picks; the same turn resumes
                    streaming once answerControlRequest POSTs the choice back. */}
                {pendingControl && (
                  <ControlRequestCard
                    control={pendingControl}
                    textScale={textScale}
                    onAnswer={(response) => answerControlRequest(pendingControl.requestId, response)}
                  />
                )}

                {/* Direct-API provider asked a multiple-choice question via the
                    ask_user tool — answer inline; the server-side agentic loop is
                    blocked until answerAskUser POSTs the pick back. */}
                {pendingAsk && (
                  <AskUserCard
                    ask={pendingAsk}
                    onAnswer={(selected, other) => answerAskUser(pendingAsk.id, selected, other)}
                  />
                )}
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
                    <div style={{ height: "100%", borderRadius: 9999, transition: "width 0.5s", width: `${getContextPercentage()}%`, background: getContextPercentage() > 80 ? "#ef4444" : getContextPercentage() > 50 ? "#f59e0b" : "linear-gradient(to right, #8b5cf6, #ec4899)" }} />
                  </div>
                  <span style={{ color: "#71717a", fontFamily: "monospace" }}>{getContextPercentage()}%</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: "35%", overflow: "hidden" }}>
                  {isStreaming ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" style={{ color: "#8b5cf6" }} />
                      <span style={{ color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{statusText || "Thinking..."}</span>
                    </>
                  ) : statusText ? (
                    <span style={{ color: "#10b981", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{statusText}</span>
                  ) : (
                    <span style={{ color: "#52525b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={cliModel || undefined}>{selectedProvider === "claude" && cliModel ? cliModel : "Ready"}</span>
                  )}
                </div>
              </div>

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
                <div style={{ padding: "6px 16px", background: "rgba(139,92,246,0.08)", borderTop: "1px solid rgba(139,92,246,0.18)", display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 10, color: "#a78bfa", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Queued ({queuedSends.length}) — runs after the current turn
                  </span>
                  {queuedSends.map((q, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#c4b5fd", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q}</span>
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
                  placeholder={isStreaming ? "Type to queue the next message…" : "Ask to launch a finetune, check a run, or manage datasets…"}
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
                  <button onClick={() => handleSendMessage()} disabled={!input.trim() && !attachedImage} title="Send" style={{ width: 36, height: 36, borderRadius: 8, border: "none", cursor: (!input.trim() && !attachedImage) ? "not-allowed" : "pointer", background: "linear-gradient(135deg, #8b5cf6, #ec4899)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 2px 8px rgba(139,92,246,0.3)", opacity: (!input.trim() && !attachedImage) ? 0.5 : 1 }}><Send className="w-3.5 h-3.5" /></button>
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

// Collapsible Reasoning Component to separate AI thought output elegantly
interface CollapsibleReasoningProps {
  thinking: string;
  textScale: "xs" | "sm" | "md" | "lg";
  defaultOpen?: boolean;
}

function CollapsibleReasoning({ thinking, textScale, defaultOpen = false }: CollapsibleReasoningProps) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen);

  return (
    <div className="mb-2 bg-black/30 border border-white/10 rounded-lg overflow-hidden flex flex-col font-mono text-[11px] leading-relaxed">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="px-2.5 py-1.5 bg-white/5 flex items-center justify-between text-[10px] text-zinc-500 hover:text-zinc-300 font-sans cursor-pointer transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-violet-400" />
          {isExpanded ? "Hide Thought Process" : "View Thought Process"}
        </span>
        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {isExpanded && (
        <div className="p-2.5 text-zinc-400 max-h-48 overflow-y-auto whitespace-pre-line border-t border-white/5 bg-black/20 select-all">
          {thinking}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool activity (BCC parity) — the tools the agent ran, each paired with its
// result. Ported from BCC's ToolUseBlock/ToolResultBlock/DiffBlock/AgentCard.
// A `ToolCallRow` dispatches by tool: Task/Agent → nested agent card, Edit/Write
// → +/- diff, TodoWrite → checklist, everything else → collapsible JSON.
// ---------------------------------------------------------------------------
const DIFFABLE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Total tool count + error count across a tree (includes sub-agent subCalls).
function countTools(tools: ToolCallEntry[]): { total: number; errors: number } {
  let total = 0;
  let errors = 0;
  for (const t of tools) {
    total += 1;
    if (t.isError) errors += 1;
    if (t.subCalls?.length) {
      const c = countTools(t.subCalls);
      total += c.total;
      errors += c.errors;
    }
  }
  return { total, errors };
}

// Pull the before/after hunks out of a file-mutating tool's input (BCC's extractHunks).
function extractDiffHunks(name: string, inputJson: string): { file: string; hunks: Array<{ old: string; new: string }> } | null {
  let input: any;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const file = String(input.file_path || input.notebook_path || input.path || "");
  if (name === "Edit") return { file, hunks: [{ old: String(input.old_string ?? ""), new: String(input.new_string ?? "") }] };
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return { file, hunks: edits.map((e: any) => ({ old: String(e.old_string ?? ""), new: String(e.new_string ?? "") })) };
  }
  if (name === "Write") return { file, hunks: [{ old: "", new: String(input.content ?? "") }] };
  if (name === "NotebookEdit") return { file, hunks: [{ old: "", new: String(input.new_source ?? "") }] };
  return null;
}

// Minimal LCS line diff (no external `diff` dep). Falls back to del-all/add-all
// on very large hunks so an oversized Edit can't blow up the O(m·n) table.
function diffLines(oldStr: string, newStr: string): Array<{ type: "add" | "del" | "ctx"; text: string }> {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  const m = a.length;
  const n = b.length;
  if (oldStr.length + newStr.length > 40000 || m * n > 250000) {
    return [
      ...a.map((t) => ({ type: "del" as const, text: t })),
      ...b.map((t) => ({ type: "add" as const, text: t })),
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ type: "add" | "del" | "ctx"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "del", text: a[i++] });
  while (j < n) out.push({ type: "add", text: b[j++] });
  return out;
}

function ToolCallList({
  toolCalls,
  textScale,
}: {
  toolCalls: ToolCallEntry[];
  textScale: "xs" | "sm" | "md" | "lg";
}) {
  const scaleClass = { xs: "text-[10px]", sm: "text-[11px]", md: "text-xs", lg: "text-sm" }[textScale];
  const { total, errors } = countTools(toolCalls);
  const names = Array.from(new Set(toolCalls.map((t) => t.name))).slice(0, 4);
  return (
    <div className={`mb-2 flex flex-col gap-1 ${scaleClass}`}>
      {total > 1 && (
        <div className="flex items-center gap-2 px-1 text-[10px] text-zinc-500">
          <Wrench className="w-3 h-3 text-violet-400 shrink-0" />
          <span className="font-semibold text-zinc-400 shrink-0">
            {total} tool{total === 1 ? "" : "s"}
          </span>
          <span className="truncate">
            {names.join(", ")}
            {toolCalls.length > 4 ? "…" : ""}
          </span>
          {errors > 0 && <span className="text-red-400 shrink-0">{errors} ⚠</span>}
        </div>
      )}
      {toolCalls.map((tc, i) => (
        <ToolCallRow key={tc.toolId || i} tool={tc} />
      ))}
    </div>
  );
}

// Dispatcher: pick the right renderer for this tool.
function ToolCallRow({ tool }: { tool: ToolCallEntry }) {
  if (tool.name === "Task" || tool.name === "Agent" || (tool.subCalls && tool.subCalls.length > 0)) {
    return <AgentToolCard tool={tool} />;
  }
  if (tool.name === "TodoWrite") {
    const todos = <TodoList inputJson={tool.inputJson} />;
    if (todos) return todos;
  }
  if (DIFFABLE_TOOLS.has(tool.name) && extractDiffHunks(tool.name, tool.inputJson)) {
    return <DiffToolRow tool={tool} />;
  }
  return <PlainToolRow tool={tool} />;
}

// Default: wrench + name + collapsible pretty-JSON input + result preview.
function PlainToolRow({ tool }: { tool: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  let prettyInput = tool.inputJson;
  try {
    prettyInput = JSON.stringify(JSON.parse(tool.inputJson), null, 2);
  } catch {
    /* partial/non-JSON input — show raw */
  }
  const resultText = tool.result ?? "";
  const firstLine = resultText.split("\n")[0].slice(0, 100);
  const truncated = resultText.length > 100 || resultText.includes("\n");
  const iconColor =
    tool.status === "error" ? "text-red-400" : tool.status === "success" ? "text-emerald-400" : "text-violet-400";
  return (
    <div className="bg-black/30 border border-white/10 rounded-lg overflow-hidden font-mono text-[11px] leading-relaxed">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2.5 py-1.5 bg-white/5 flex items-center gap-1.5 text-[10px] text-zinc-400 hover:text-zinc-200 font-sans cursor-pointer transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Wrench className={`w-3 h-3 shrink-0 ${iconColor}`} />
        <span className="font-semibold text-zinc-300 shrink-0">{tool.name}</span>
        {tool.status === "executing" && <Loader2 className="w-3 h-3 animate-spin text-violet-400 shrink-0" />}
        {tool.status === "error" && <span className="text-red-400 shrink-0">error</span>}
        {!open && resultText && (
          <span className="text-zinc-500 truncate">
            {tool.isError ? "⚠ " : "→ "}
            {firstLine}
            {truncated ? "…" : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-white/5 bg-black/20">
          <pre className="p-2.5 m-0 text-zinc-400 max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word select-all">
            {prettyInput}
          </pre>
          {resultText && (
            <pre
              className={`p-2.5 m-0 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word select-all border-t border-white/5 ${
                tool.isError ? "text-red-300" : "text-emerald-200/80"
              }`}
            >
              {resultText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Edit/Write/MultiEdit/NotebookEdit rendered as a +/- line diff (BCC's DiffBlock).
function DiffToolRow({ tool }: { tool: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  const d = extractDiffHunks(tool.name, tool.inputJson);
  if (!d) return <PlainToolRow tool={tool} />;
  const rows: Array<{ type: "add" | "del" | "ctx"; text: string }> = [];
  let adds = 0;
  let dels = 0;
  for (const h of d.hunks) {
    for (const r of diffLines(h.old, h.new)) {
      if (r.type === "add") adds++;
      else if (r.type === "del") dels++;
      rows.push(r);
    }
  }
  const shown = rows.slice(0, 400);
  const fileName = d.file ? d.file.split(/[\\/]/).pop() : tool.name;
  return (
    <div className="bg-black/30 border border-white/10 rounded-lg overflow-hidden font-mono text-[11px] leading-relaxed">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2.5 py-1.5 bg-white/5 flex items-center gap-1.5 text-[10px] text-zinc-400 hover:text-zinc-200 font-sans cursor-pointer transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Pencil className={`w-3 h-3 shrink-0 ${tool.isError ? "text-red-400" : "text-violet-400"}`} />
        <span className="font-semibold text-zinc-300 truncate">{fileName}</span>
        <span className="text-emerald-400 shrink-0">+{adds}</span>
        <span className="text-red-400 shrink-0">−{dels}</span>
        {tool.status === "executing" && <Loader2 className="w-3 h-3 animate-spin text-violet-400 shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-white/5 bg-black/20 max-h-64 overflow-auto">
          {d.file && (
            <div className="px-2.5 py-1 text-[10px] text-zinc-500 border-b border-white/5 truncate">{d.file}</div>
          )}
          {shown.map((r, idx) => (
            <div
              key={idx}
              className={`px-2.5 whitespace-pre-wrap wrap-break-word ${
                r.type === "add"
                  ? "bg-emerald-500/10 text-emerald-300"
                  : r.type === "del"
                    ? "bg-red-500/10 text-red-300"
                    : "text-zinc-500"
              }`}
            >
              <span className="select-none opacity-60">{r.type === "add" ? "+ " : r.type === "del" ? "- " : "  "}</span>
              {r.text || " "}
            </div>
          ))}
          {rows.length > 400 && (
            <div className="px-2.5 py-1 text-[10px] text-zinc-600">… {rows.length - 400} more lines</div>
          )}
          {tool.isError && tool.result && (
            <pre className="p-2.5 m-0 text-red-300 max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word border-t border-white/5">
              {tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// TodoWrite → checklist (BCC's tasks panel). Returns null if there are no todos.
function TodoList({ inputJson }: { inputJson: string }): React.ReactElement | null {
  let todos: any[] = [];
  try {
    const p = JSON.parse(inputJson);
    todos = Array.isArray(p?.todos) ? p.todos : [];
  } catch {
    todos = [];
  }
  if (!todos.length) return null;
  const done = todos.filter((t) => t?.status === "completed").length;
  return (
    <div className="bg-black/30 border border-white/10 rounded-lg overflow-hidden font-sans text-[11px]">
      <div className="px-2.5 py-1.5 bg-white/5 flex items-center gap-1.5 text-[10px] text-zinc-400">
        <ListTodo className="w-3 h-3 text-violet-400 shrink-0" />
        <span className="font-semibold text-zinc-300">Tasks</span>
        <span className="text-zinc-500">
          {done}/{todos.length}
        </span>
      </div>
      <div className="p-2 flex flex-col gap-1">
        {todos.map((t, i) => {
          const st = t?.status;
          return (
            <div key={i} className="flex items-start gap-1.5">
              <span
                className={`mt-0.5 shrink-0 ${
                  st === "completed" ? "text-emerald-400" : st === "in_progress" ? "text-violet-400" : "text-zinc-600"
                }`}
              >
                {st === "completed" ? "✓" : st === "in_progress" ? "◐" : "○"}
              </span>
              <span className={st === "completed" ? "text-zinc-500 line-through" : "text-zinc-300"}>
                {t?.content ?? t?.title ?? ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Task/Agent spawn → nested card with the sub-agent's own tool transcript (BCC's AgentCard).
function AgentToolCard({ tool }: { tool: ToolCallEntry }) {
  const [open, setOpen] = useState(true);
  let input: any = {};
  try {
    input = JSON.parse(tool.inputJson);
  } catch {
    input = {};
  }
  const desc = String(input.description ?? input.prompt ?? "sub-agent").slice(0, 80);
  const agentType = input.subagent_type ? String(input.subagent_type) : "";
  const subs = tool.subCalls ?? [];
  const { total, errors } = countTools(subs);
  const statusColor =
    tool.status === "error" ? "text-red-400" : tool.status === "success" ? "text-emerald-400" : "text-violet-400";
  return (
    <div className="bg-violet-500/5 border border-violet-400/20 rounded-lg overflow-hidden text-[11px]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2.5 py-1.5 bg-violet-500/10 flex items-center gap-1.5 text-[10px] text-zinc-300 hover:text-zinc-100 cursor-pointer transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Bot className={`w-3 h-3 shrink-0 ${statusColor}`} />
        <span className="font-semibold shrink-0">{agentType || "Agent"}</span>
        <span className="text-zinc-500 truncate">{desc}</span>
        {tool.status === "executing" && <Loader2 className="w-3 h-3 animate-spin text-violet-400 shrink-0" />}
        {total > 0 && (
          <span className="text-zinc-500 shrink-0">
            {total} tool{total === 1 ? "" : "s"}
          </span>
        )}
        {errors > 0 && <span className="text-red-400 shrink-0">{errors} ⚠</span>}
      </button>
      {open && (
        <div className="border-t border-violet-400/15 bg-black/20 p-1.5 flex flex-col gap-1">
          {subs.length > 0 ? (
            subs.map((s, i) => <ToolCallRow key={s.toolId || i} tool={s} />)
          ) : (
            <div className="px-1.5 py-1 text-[10px] text-zinc-600">running…</div>
          )}
          {tool.result && (
            <div
              className={`px-2 py-1.5 rounded text-[10px] whitespace-pre-wrap wrap-break-word ${
                tool.isError ? "text-red-300 bg-red-500/10" : "text-zinc-400 bg-white/5"
              }`}
            >
              {tool.result.slice(0, 2000)}
              {tool.result.length > 2000 ? "…" : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Compact per-turn accounting line under an assistant message (BCC parity).
function TurnMetaLine({ meta }: { meta: TurnMeta }) {
  const parts: string[] = [];
  if (meta.inTokens) parts.push(`${(meta.inTokens / 1000).toFixed(1)}k in`);
  if (meta.outTokens) parts.push(`${(meta.outTokens / 1000).toFixed(1)}k out`);
  if (typeof meta.costUsd === "number" && meta.costUsd > 0) parts.push(`$${meta.costUsd.toFixed(3)}`);
  if (typeof meta.durationMs === "number") parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  if (!parts.length && !meta.isError) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-600">
      {meta.isError && <span className="text-red-400 font-semibold">⚠ error</span>}
      <span>{parts.join(" · ")}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared "white-glass" visual language for the interactive question cards.
// BOTH the direct-API ask_user card AND the Better Claude Code AskUserQuestion /
// permission card use these classes so the two providers look identical. Frosted
// translucent-white glass on the dark panel, with the orb's violet→pink accent
// for selection and confirm. Tailwind v4 forms only (bg-linear-to-*, opacity
// modifiers, shrink-0). Custom option controls carry real ARIA roles/state.
// ---------------------------------------------------------------------------
const ASK_CARD_SHELL =
  "mt-1 mb-1 self-start w-[92%] flex flex-col gap-3 rounded-2xl border border-white/15 bg-white/8 p-3.5 backdrop-blur-md shadow-lg shadow-black/40 ring-1 ring-inset ring-white/10";
const ASK_HEADER = "flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-white/70";
const ASK_QUESTION = "text-[13px] font-medium leading-snug text-white";
const ASK_OPT_BASE =
  "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left text-[12px] transition-colors cursor-pointer";
const ASK_OPT_IDLE = "border-white/12 bg-white/5 text-zinc-200 hover:border-white/25 hover:bg-white/10";
const ASK_OPT_SEL = "border-violet-300/50 bg-linear-to-r from-violet-500/25 to-pink-500/20 text-white";
const ASK_MARK_BASE = "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors";
const ASK_MARK_SEL = "border-transparent bg-linear-to-br from-violet-400 to-pink-400 text-black";
const ASK_MARK_IDLE = "border-white/30 text-transparent";
const ASK_CONFIRM_ON =
  "self-end rounded-xl bg-linear-to-r from-violet-500 to-pink-500 px-4 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 cursor-pointer";
const ASK_CONFIRM_OFF = "self-end rounded-xl bg-white/5 px-4 py-1.5 text-[11px] font-semibold text-zinc-600 cursor-not-allowed";
const ASK_OTHER_INPUT =
  "min-w-0 flex-1 rounded-lg border border-white/12 bg-black/30 px-2.5 py-1.5 text-[11px] text-white outline-none placeholder:text-zinc-500 focus:border-violet-300/50";

// ---------------------------------------------------------------------------
// Question / permission card (BCC parity) — rendered when the CLI raises a
// control_request. AskUserQuestion → multiple-choice; can_use_tool → allow/deny.
// The chosen answer is handed to onAnswer, which POSTs it back to the blocked
// CLI child. Response shapes mirror BCC's ChatPane cards verbatim.
// ---------------------------------------------------------------------------
function ControlRequestCard({
  control,
  textScale,
  onAnswer,
}: {
  control: PendingControl;
  textScale: "xs" | "sm" | "md" | "lg";
  onAnswer: (response: Record<string, unknown>) => void;
}) {
  if (control.toolName === "AskUserQuestion") {
    return <AskQuestionCard control={control} textScale={textScale} onAnswer={onAnswer} />;
  }
  return (
    <div className={ASK_CARD_SHELL}>
      <div className={ASK_HEADER}>
        <HelpCircle className="w-3.5 h-3.5 text-violet-300" aria-hidden="true" />
        Permission requested
      </div>
      <div className="text-[12px] text-zinc-200">
        The agent wants to use <span className="font-mono text-violet-200">{control.toolName}</span>.
      </div>
      {control.reason && <div className="text-[10px] text-zinc-400">{control.reason}</div>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onAnswer({ behavior: "allow", updatedInput: control.input ?? {} })}
          className="rounded-xl border border-emerald-400/40 bg-emerald-500/20 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/30 cursor-pointer"
        >
          Allow once
        </button>
        {control.suggestions && control.suggestions.length > 0 && (
          <button
            type="button"
            onClick={() =>
              onAnswer({ behavior: "allow", updatedInput: control.input ?? {}, updatedPermissions: control.suggestions })
            }
            className="rounded-xl border border-violet-400/40 bg-violet-500/20 px-3 py-1.5 text-[11px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/30 cursor-pointer"
          >
            Always allow
          </button>
        )}
        <button
          type="button"
          onClick={() => onAnswer({ behavior: "deny", message: "The user denied this action in the web UI." })}
          className="rounded-xl border border-red-400/40 bg-red-500/20 px-3 py-1.5 text-[11px] font-semibold text-red-200 transition-colors hover:bg-red-500/30 cursor-pointer"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function AskQuestionCard({
  control,
  textScale,
  onAnswer,
}: {
  control: PendingControl;
  textScale: "xs" | "sm" | "md" | "lg";
  onAnswer: (response: Record<string, unknown>) => void;
}) {
  void textScale;
  const questions: any[] = Array.isArray(control.input?.questions) ? control.input.questions : [];
  const [selected, setSelected] = useState<Record<number, string[]>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...prev, [qi]: [label] };
    });
  };

  const allAnswered = questions.length > 0 && questions.every((_, qi) => (selected[qi]?.length ?? 0) > 0);

  const submit = () => {
    // BCC answer shape: echo the original questions + an answers map keyed by
    // the question text, each value the joined selected label(s).
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      answers[q.question] = (selected[qi] ?? []).join(", ");
    });
    onAnswer({ behavior: "allow", updatedInput: { questions, answers } });
  };

  if (questions.length === 0) {
    return (
      <div className={ASK_CARD_SHELL}>
        <div className={ASK_HEADER}>
          <Sparkles className="w-3.5 h-3.5 text-violet-300" aria-hidden="true" />
          The agent is asking for input
        </div>
        <button
          type="button"
          onClick={() => onAnswer({ behavior: "allow", updatedInput: control.input ?? {} })}
          className="self-start rounded-xl border border-violet-400/40 bg-violet-500/20 px-3 py-1.5 text-[11px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/30 cursor-pointer"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className={ASK_CARD_SHELL}>
      <div className={ASK_HEADER}>
        <Sparkles className="w-3.5 h-3.5 text-violet-300" aria-hidden="true" />
        The agent is asking{questions.length > 1 ? ` ${questions.length} questions` : " a question"}
      </div>
      {questions.map((q, qi) => {
        const qId = `bcc-ask-q-${qi}`;
        const multi = !!q.multiSelect;
        return (
          <div key={qi} className="flex flex-col gap-1.5">
            <div id={qId} className={ASK_QUESTION}>
              {q.question}
              {multi && <span className="ml-1 text-[10px] text-zinc-400">(choose any)</span>}
            </div>
            <div className="flex flex-col gap-1.5" role={multi ? "group" : "radiogroup"} aria-labelledby={qId}>
              {(Array.isArray(q.options) ? q.options : []).map((opt: any, oi: number) => {
                const isSel = (selected[qi] ?? []).includes(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    role={multi ? "checkbox" : "radio"}
                    aria-checked={isSel}
                    aria-label={opt.label}
                    onClick={() => toggle(qi, opt.label, multi)}
                    className={`${ASK_OPT_BASE} ${isSel ? ASK_OPT_SEL : ASK_OPT_IDLE}`}
                  >
                    <span
                      className={`${ASK_MARK_BASE} ${multi ? "rounded" : "rounded-full"} ${isSel ? ASK_MARK_SEL : ASK_MARK_IDLE}`}
                      aria-hidden="true"
                    >
                      {isSel && <Check className="w-2.5 h-2.5" />}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{opt.label}</span>
                      {opt.description && <span className="text-[10px] text-zinc-400">{opt.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <button type="button" onClick={submit} disabled={!allAnswered} className={allAnswered ? ASK_CONFIRM_ON : ASK_CONFIRM_OFF}>
        Submit
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ask_user card — the direct-API provider counterpart to AskQuestionCard. Same
// white-glass look; renders a SINGLE multiple-choice question. Single-select →
// click an option to answer immediately. multi_select → toggle chips + Confirm.
// allow_other → a free-text field (submitted via Send / Confirm / Enter).
// ---------------------------------------------------------------------------
function AskUserCard({
  ask,
  onAnswer,
}: {
  ask: PendingAsk;
  onAnswer: (selected: string[], other: string | null) => void;
}) {
  const multi = ask.multiSelect;
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const qId = `ask-user-q-${ask.id}`;
  const otherId = `ask-user-other-${ask.id}`;

  const pick = (label: string) => {
    if (!multi) {
      // Single-select: a click IS the answer.
      onAnswer([label], null);
      return;
    }
    setSelected((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]));
  };

  const trimmedOther = other.trim();
  const canConfirm = multi ? selected.length > 0 || !!trimmedOther : !!trimmedOther;

  const confirm = () => {
    if (multi) {
      if (selected.length === 0 && !trimmedOther) return;
      onAnswer(selected, trimmedOther || null);
    } else {
      // Single-select: the only reason to reach Confirm is a custom "other".
      if (!trimmedOther) return;
      onAnswer([], trimmedOther);
    }
  };

  return (
    <div className={ASK_CARD_SHELL} role="group" aria-labelledby={qId}>
      <div className={ASK_HEADER}>
        <Sparkles className="w-3.5 h-3.5 text-violet-300" aria-hidden="true" />
        {multi ? "Choose any that apply" : "Pick one"}
      </div>
      <div id={qId} className={ASK_QUESTION}>
        {ask.question}
      </div>
      <div className="flex flex-col gap-1.5" role={multi ? "group" : "radiogroup"} aria-labelledby={qId}>
        {ask.options.map((opt, oi) => {
          const isSel = selected.includes(opt.label);
          return (
            <button
              key={oi}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={isSel}
              aria-label={opt.label}
              onClick={() => pick(opt.label)}
              className={`${ASK_OPT_BASE} ${isSel ? ASK_OPT_SEL : ASK_OPT_IDLE}`}
            >
              <span
                className={`${ASK_MARK_BASE} ${multi ? "rounded" : "rounded-full"} ${isSel ? ASK_MARK_SEL : ASK_MARK_IDLE}`}
                aria-hidden="true"
              >
                {isSel && <Check className="w-2.5 h-2.5" />}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{opt.label}</span>
                {opt.description && <span className="text-[10px] text-zinc-400">{opt.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {ask.allowOther && (
        <div className="flex items-center gap-2">
          <label htmlFor={otherId} className="shrink-0 text-[10px] text-zinc-400">
            Other
          </label>
          <input
            id={otherId}
            name={otherId}
            type="text"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && trimmedOther) {
                e.preventDefault();
                onAnswer(multi ? selected : [], trimmedOther);
              }
            }}
            placeholder="Type a custom answer…"
            className={ASK_OTHER_INPUT}
            aria-label="Other answer"
          />
        </div>
      )}
      {(multi || ask.allowOther) && (
        <button type="button" onClick={confirm} disabled={!canConfirm} className={canConfirm ? ASK_CONFIRM_ON : ASK_CONFIRM_OFF}>
          {multi ? "Confirm selection" : "Send"}
        </button>
      )}
    </div>
  );
}
