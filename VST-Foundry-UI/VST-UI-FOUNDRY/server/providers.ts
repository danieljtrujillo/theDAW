import { Response as ExpressResponse } from "express";
import { PORT } from "./config";
import { appendLog } from "./logging";
import { scrapeUrl } from "./net";
import { activeSessions, ActiveSession, RELAY_TIMEOUT_MS } from "./relay";
import {
  Frame,
  ChatMessage,
  OPENAI_TOOLS,
  ANTHROPIC_TOOLS,
  openAIToolName,
  providerSupportsImageInput,
  shouldSendOpenAICompatTools,
  openAICompatToolsForProvider,
  isToolCapabilityError,
  isImageInputCapabilityError,
  isGeminiGenericInvalidArgument,
  messagesHaveImageContent,
  stripImageContent,
  openAICompatRequestSummary,
  buildSystemInstruction,
  buildOpenAIMessages,
  buildAnthropicMessages,
  normalizeUsage,
} from "./tools";

// ===========================================================================
// Provider registry — model-agnostic multi-provider dispatch
// ===========================================================================
//
// 🚨 DO NOT downgrade or delete model ids you don't recognize. The user has
// working keys for Gemini 3.x, Claude 4.x/5.x, GPT-5 variants, etc. The live
// /models fetch is the source of truth; the hard-coded fallbacks below are
// safety nets only. Add speculative models freely; never remove real ones.

export interface ProviderConfig {
  label: string;
  baseUrl: string;
  envKey: string | null;
  modelsPath: string | null;
  defaultModel: string;
  requiresKey: boolean;
  isLocal: boolean;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    modelsPath: null, // uses google-specific /v1beta/models endpoint
    defaultModel: "gemini-2.5-flash",
    requiresKey: true,
    isLocal: false,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    envKey: "OPENAI_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4.1-mini",
    requiresKey: true,
    isLocal: false,
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "claude-sonnet-5",
    requiresKey: true,
    isLocal: false,
  },
  grok: {
    label: "xAI Grok",
    baseUrl: "https://api.x.ai",
    envKey: "XAI_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "grok-3-mini-fast",
    requiresKey: true,
    isLocal: false,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai",
    envKey: "GROQ_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "llama-3.3-70b-versatile",
    requiresKey: true,
    isLocal: false,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    envKey: "OPENROUTER_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "google/gemma-3-1b-it:free",
    requiresKey: true,
    isLocal: false,
  },
  "openrouter-free": {
    label: "OpenRouter (Free)",
    baseUrl: "https://openrouter.ai/api",
    envKey: "OPENROUTER_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "google/gemma-3-1b-it:free",
    requiresKey: false,
    isLocal: false,
  },
  ollama: {
    label: "Ollama (Local)",
    baseUrl: "http://localhost:11434",
    envKey: null,
    modelsPath: null, // uses /api/tags
    defaultModel: "",
    requiresKey: false,
    isLocal: true,
  },
  lmstudio: {
    label: "LM Studio (Local)",
    baseUrl: "http://localhost:1234",
    envKey: null,
    modelsPath: "/v1/models",
    defaultModel: "",
    requiresKey: false,
    isLocal: true,
  },
};
// NOTE: `claude` (Claude Code CLI) is intentionally NOT in PROVIDERS — it is
// special-cased in the routes because it spawns a local CLI process.

export const GEMINI_FALLBACK_MODELS = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", capabilities: ["chat", "tools", "vision"] },
];

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini 3.1 pro": "gemini-3.1-pro-preview",
  "gemini pro 3.1": "gemini-3.1-pro-preview",
  "gemini 3.1 pro preview": "gemini-3.1-pro-preview",
  "gemini 3.1 pro (preview)": "gemini-3.1-pro-preview",
};

export function normalizeModelIdForProvider(provider: string, model: string): string {
  const trimmed = model.trim().replace(/^models\//, "");
  if (provider !== "gemini") return trimmed;
  const aliasKey = trimmed.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
  return GEMINI_MODEL_ALIASES[aliasKey] || trimmed;
}

// ===========================================================================
// Helpers — provider key / URL resolution
// ===========================================================================

export function getApiKey(providerId: string, requestKey?: string): string {
  if (requestKey) return requestKey;
  const cfg = PROVIDERS[providerId];
  if (cfg?.envKey) return process.env[cfg.envKey] || "";
  return "";
}

export function getChatUrl(providerId: string): string {
  const cfg = PROVIDERS[providerId];
  if (!cfg) return "";
  const base = cfg.baseUrl.replace(/\/$/, "");
  // Gemini's base already ends with /v1beta/openai — append /chat/completions.
  if (providerId === "gemini") return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function capabilitiesFromOpenRouterModel(model: any): string[] {
  const caps = new Set<string>(["chat"]);
  const supported = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
  const input = [
    ...(Array.isArray(model?.input_modalities) ? model.input_modalities : []),
    ...(Array.isArray(model?.architecture?.input_modalities) ? model.architecture.input_modalities : []),
  ];
  if (supported.includes("tools")) caps.add("tools");
  if (supported.includes("tool_choice")) caps.add("tool_choice");
  if (supported.includes("reasoning") || supported.includes("include_reasoning")) caps.add("reasoning");
  if (supported.includes("structured_outputs") || supported.includes("response_format")) caps.add("structured_output");
  if (input.includes("image")) caps.add("vision");
  return Array.from(caps);
}

// ===========================================================================
// Frame protocol / stream args
// ===========================================================================

export interface StreamArgs {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  apiKey?: string;
  claudeSessionId?: string;
  effort?: string;
  claudeMode?: string;
  appState?: any;
  screenshot?: string;
  signal?: AbortSignal;
  // Live SSE response — only supplied for the Claude Code path so streamClaude
  // can register the session for MCP tool relay.
  sseRes?: ExpressResponse;
  // Relay session id for the direct-API agentic loop (OpenAI-compat + Anthropic).
  // The chat route registers this id in `activeSessions` and emits it as a
  // `session_id` frame so the browser can POST tool results back to
  // /api/mcp-relay/result, which resolves the matching pending promise and lets
  // the stream loop continue with the tool output.
  toolSessionId?: string;
}

// ===========================================================================
// Tool-call dispatch — server-side tools run here, client-side tools stream out
// ===========================================================================

async function* dispatchToolCall(id: string, name: string, args: any): AsyncGenerator<Frame> {
  if (name === "fetchWebPage") {
    const content = await scrapeUrl(args?.url || "");
    yield { type: "tool_result", id, result: { content } };
    return;
  }

  // ----------------- Server-side texture / Stable Diffusion tools -----------
  if (name === "generateTexture") {
    const resp = await fetch(`http://localhost:${PORT}/api/textures/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    });
    const data = await resp.json();
    yield { type: "tool_result", id, result: { content: JSON.stringify(data) } };
    return;
  }
  if (name === "deleteTexture") {
    await fetch(`http://localhost:${PORT}/api/textures/${args?.textureId}`, { method: "DELETE" });
    yield { type: "tool_result", id, result: { content: JSON.stringify({ ok: true }) } };
    return;
  }
  if (name === "uploadTexture") {
    const resp = await fetch(`http://localhost:${PORT}/api/textures/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: args?.dataUrl, name: args?.name }),
    });
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "getSDStatus") {
    const resp = await fetch(`http://localhost:${PORT}/api/sd/status`);
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "getSDResources") {
    const resp = await fetch(`http://localhost:${PORT}/api/sd/resources?type=${args?.sdType}`);
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "startSDProcess") {
    const resp = await fetch(`http://localhost:${PORT}/api/sd/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdType: args?.sdType }),
    });
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "stopSDProcess") {
    await fetch(`http://localhost:${PORT}/api/sd/stop`, { method: "POST" });
    yield { type: "tool_result", id, result: { content: JSON.stringify({ ok: true }) } };
    return;
  }
  if (name === "editTexture") {
    const resp = await fetch(`http://localhost:${PORT}/api/textures/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    });
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "upscaleTexture") {
    const resp = await fetch(`http://localhost:${PORT}/api/textures/upscale`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    });
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "generateTextureVariations") {
    const resp = await fetch(`http://localhost:${PORT}/api/textures/variations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    });
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "batchGenerateTextures") {
    const resp = await fetch(`http://localhost:${PORT}/api/textures/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    });
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "controlNetGenerate") {
    const resp = await fetch(`http://localhost:${PORT}/api/textures/controlnet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    });
    yield { type: "tool_result", id, result: { content: JSON.stringify(await resp.json()) } };
    return;
  }
  if (name === "getLogs") {
    const n = args?.lines ?? 200;
    const resp = await fetch(`http://localhost:${PORT}/api/logs?lines=${n}`);
    const data = await resp.json();
    yield { type: "tool_result", id, result: { content: JSON.stringify(data) } };
    return;
  }

  // Client-side tools — relay to the browser over SSE.
  yield { type: "client_tool_call", id, name, args: args || {} };
}

// ===========================================================================
// Agentic tool loop — shared by the direct-API streamers
// ===========================================================================
//
// "Claude Code" (the CLI provider) loops natively: the MCP relay feeds tool
// results back to the running agent. The direct-API providers (OpenAI-compat
// and the Anthropic Messages API) historically emitted a single response and
// stopped — any tool call was fire-and-forget with no result channel. These
// helpers give them the SAME loop: emit `client_tool_call`, await the browser's
// result over the relay, feed it back to the provider API, and repeat until the
// model returns a final answer with no tool calls (capped below).

// High ceiling, not a functional cap: multi-step tool tasks on the direct-API
// providers (Gemini/OpenRouter/Anthropic) must not be cut short. Each iteration
// is a full LLM round-trip and every browser tool call is bounded by
// RELAY_TIMEOUT_MS, so this only guards against a pathological infinite loop.
const MAX_AGENT_ITERATIONS = 100;

type BrowserToolResult = { result?: any; error?: string; imageData?: string };

// Register a pending browser tool call on a relay session and return a promise
// that resolves when the browser POSTs the result to /api/mcp-relay/result (the
// same endpoint the Claude MCP relay uses). Mirrors that relay's pending-map
// contract: the result handler calls resolve({result|imageData}) or
// reject(Error). Resolves (never rejects) so the loop can always continue.
function awaitBrowserToolResult(
  session: ActiveSession,
  toolCallId: string,
  signal?: AbortSignal,
  timeoutMs = RELAY_TIMEOUT_MS,
): Promise<BrowserToolResult> {
  return new Promise<BrowserToolResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (v: BrowserToolResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      session.pending.delete(toolCallId);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ error: "Tool call timed out" }), timeoutMs);
    const onAbort = () => finish({ error: "aborted" });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    session.pending.set(toolCallId, {
      resolve: (r: any) => finish((r as BrowserToolResult) || {}),
      reject: (err: Error) => finish({ error: err.message }),
      timer,
    });
  });
}

// Collapse a browser/server tool result into a plain text payload suitable for a
// provider tool message (image results are surfaced separately by the caller).
function toolResultToText(r: BrowserToolResult): string {
  if (r.error) return JSON.stringify({ error: r.error });
  if (r.imageData) return "[Canvas screenshot captured and provided to you as an image.]";
  const v = r.result;
  if (v == null) return JSON.stringify({ ok: true });
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Run one tool call inside the loop. Server-side tools execute here (their
// `tool_result` frame is surfaced and its content captured); client-side tools
// are relayed to the browser as a `client_tool_call` frame and the result is
// awaited via the pending map. Returns the resolved result for the API turn.
async function* runLoopToolCall(
  session: ActiveSession | null,
  id: string,
  name: string,
  args: any,
  signal?: AbortSignal,
): AsyncGenerator<Frame, BrowserToolResult> {
  let resolved: BrowserToolResult | null = null;
  for await (const frame of dispatchToolCall(id, name, args)) {
    if (frame.type === "client_tool_call") {
      if (session) {
        // Register the pending promise BEFORE emitting so a fast browser result
        // cannot race ahead of the listener.
        const pending = awaitBrowserToolResult(session, id, signal);
        yield frame;
        resolved = await pending;
      } else {
        // No relay channel available — emit and treat as fire-and-forget.
        yield frame;
        resolved = { result: { ok: true } };
      }
    } else if (frame.type === "tool_result") {
      const content = (frame as any).result?.content;
      resolved = { result: content !== undefined ? content : (frame as any).result };
      yield frame;
    } else {
      yield frame;
    }
  }
  return resolved ?? { result: { ok: true } };
}

// ===========================================================================
// Streamer 1 — OpenAI-compatible (gemini, openai, grok, groq, openrouter,
//                                  ollama, lmstudio)
// ===========================================================================

export async function* streamOpenAICompat(args: StreamArgs): AsyncGenerator<Frame> {
  const { messages, provider, model, apiKey, appState, screenshot, signal, toolSessionId } = args;
  const cfg = PROVIDERS[provider!];
  if (!cfg) {
    yield { type: "error", message: `Unknown provider: ${provider}` };
    return;
  }

  const useModel = normalizeModelIdForProvider(provider!, model || cfg.defaultModel);
  if (!useModel) {
    yield { type: "error", message: `No model specified for ${provider}. Local providers require an explicit model id.` };
    return;
  }

  const key = getApiKey(provider!, apiKey);
  if (!cfg.isLocal && !key) {
    yield { type: "error", message: `${cfg.envKey} not set. Provide an API key in the assistant settings.` };
    return;
  }

  const url = getChatUrl(provider!);
  let requestTools = openAICompatToolsForProvider(provider!, useModel);
  let toolsSupported = requestTools.length > 0;
  let imageInputSupported = providerSupportsImageInput(provider!, useModel);
  if (!imageInputSupported && screenshot) {
    appendLog(`[chat] dropped screenshot for ${provider}/${useModel}: model/provider does not advertise image input`);
  }
  const payloadMessages = buildOpenAIMessages(
    buildSystemInstruction(appState, toolsSupported, imageInputSupported),
    messages,
    imageInputSupported ? screenshot : undefined,
  );

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (provider === "openrouter" || provider === "openrouter-free") {
    headers["HTTP-Referer"] = "https://vst-foundry.local";
    headers["X-Title"] = "VST Foundry Assistant";
  }

  yield { type: "status", message: `Connecting to ${cfg.label} (${useModel})...` };
  if (!toolsSupported) {
    const reason = shouldSendOpenAICompatTools(provider!, useModel).reason || "No compatible tool schema is available for this provider/model.";
    yield { type: "status", message: `${reason} Continuing without live app tools.` };
    appendLog(`[chat] tools disabled provider=${provider} model=${useModel}: ${reason}`);
  } else if (!imageInputSupported) {
    appendLog(`[chat] image tool disabled provider=${provider} model=${useModel}`);
  }

  const session = toolSessionId ? activeSessions.get(toolSessionId) ?? null : null;
  let lastUsage: any = null;

  // Agentic loop: call the API, run any tool calls, feed results back, repeat
  // until the model returns a final answer with no tool calls (or the cap).
  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    if (signal?.aborted) return;

    const body: any = {
      model: useModel,
      messages: payloadMessages,
      stream: true,
      ...(toolsSupported ? { tools: requestTools } : {}),
    };
    if (provider === "gemini" && toolsSupported) {
      body.tool_choice = "auto";
    }
    if ((provider === "openrouter" || provider === "openrouter-free") && toolsSupported) {
      body.provider = {
        ...(body.provider || {}),
        require_parameters: true,
      };
    }

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      if (cfg.isLocal) {
        yield { type: "error", message: `${cfg.label} is not running at ${cfg.baseUrl}` };
      } else {
        yield { type: "error", message: `Cannot connect to ${cfg.label}: ${e?.message || e}` };
      }
      yield { type: "done" };
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      if (provider === "gemini" && isGeminiGenericInvalidArgument(resp.status, errText) && imageInputSupported && messagesHaveImageContent(payloadMessages)) {
        imageInputSupported = false;
        requestTools = requestTools.filter((tool) => openAIToolName(tool) !== "captureCanvasScreenshot");
        payloadMessages[0] = {
          role: "system",
          content: buildSystemInstruction(appState, toolsSupported, false),
        };
        stripImageContent(payloadMessages);
        yield { type: "status", message: `${cfg.label} rejected the image payload; retrying with tools but without screenshots.` };
        appendLog(
          `[chat] gemini retry without images provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 300)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1200)}`,
        );
        iter--;
        continue;
      }
      if (toolsSupported && isToolCapabilityError(resp.status, errText)) {
        // Provider doesn't support tools — retry this turn without them. Don't
        // consume a loop iteration on the capability downgrade.
        toolsSupported = false;
        requestTools = [];
        payloadMessages[0] = {
          role: "system",
          content: buildSystemInstruction(appState, false, false),
        };
        yield { type: "status", message: `${cfg.label} rejected tool schemas; retrying without live app tools.` };
        appendLog(
          `[chat] provider rejected tools provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 300)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1200)}`,
        );
        iter--;
        continue;
      }
      if (imageInputSupported && isImageInputCapabilityError(resp.status, errText)) {
        imageInputSupported = false;
        requestTools = requestTools.filter((tool) => openAIToolName(tool) !== "captureCanvasScreenshot");
        payloadMessages[0] = {
          role: "system",
          content: buildSystemInstruction(appState, toolsSupported, false),
        };
        stripImageContent(payloadMessages);
        yield { type: "status", message: `${cfg.label} rejected image input; retrying without screenshots.` };
        appendLog(
          `[chat] provider rejected image input provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 300)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1200)}`,
        );
        iter--;
        continue;
      }
      appendLog(
        `[chat] provider rejected request provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 500)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1600)}`,
      );
      yield { type: "error", message: `${cfg.label} ${resp.status}: ${errText.slice(0, 500)}` };
      yield { type: "done" };
      return;
    }

    const collected = yield* parseOpenAIStreamCollect(resp, signal);
    if (collected.usage) lastUsage = collected.usage;

    const toolCalls = collected.toolCalls;
    if (!toolCalls.length) {
      // Final answer — preserves single-turn behavior when no tools are called.
      yield { type: "done", ...(normalizeUsage(lastUsage) ? { usage: normalizeUsage(lastUsage) } : {}) };
      return;
    }

    // Record the assistant turn (text + tool_calls) in the running transcript.
    payloadMessages.push({
      role: "assistant",
      content: collected.text || null,
      tool_calls: toolCalls.map((tc) => {
        const toolCall: any = {
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        };
        if (provider === "gemini" && tc.thoughtSignature) {
          toolCall.extra_content = { google: { thought_signature: tc.thoughtSignature } };
        }
        return toolCall;
      }),
    });

    // Execute each tool call, emit frames, and append the results as tool
    // messages so the next API turn can consume them.
    const imageFollowUps: any[] = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) return;
      if (tc.parseError) {
        yield { type: "status", message: `Tool ${tc.name} skipped: ${tc.parseError}` };
        payloadMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: tc.parseError }) });
        continue;
      }
      const r = yield* runLoopToolCall(session, tc.id, tc.name, tc.parsed, signal);
      payloadMessages.push({ role: "tool", tool_call_id: tc.id, content: toolResultToText(r) });
      if (r.imageData) {
        imageFollowUps.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${r.imageData}` },
        });
      }
    }
    // OpenAI tool messages can't carry images, so surface any captured
    // screenshot as a follow-up user turn (mirrors the legacy resubmit).
    if (imageFollowUps.length && imageInputSupported) {
      payloadMessages.push({
        role: "user",
        content: [{ type: "text", text: "Here is the requested canvas screenshot." }, ...imageFollowUps],
      });
    }
  }

  // Iteration cap reached without a tool-free final answer.
  yield { type: "done", ...(normalizeUsage(lastUsage) ? { usage: normalizeUsage(lastUsage) } : {}) };
}

// Parse an OpenAI-compatible SSE stream, yielding text/thinking frames and
// returning the accumulated tool calls + final text + usage for the agentic
// loop (tool dispatch is handled by the caller, not here).
async function* parseOpenAIStreamCollect(
  resp: Response,
  signal?: AbortSignal,
): AsyncGenerator<
  Frame,
  { toolCalls: Array<{ id: string; name: string; arguments: string; parsed: any; thoughtSignature?: string; parseError?: string }>; text: string; usage: any }
> {
  if (!resp.body) return { toolCalls: [], text: "", usage: null };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolAcc: Record<number, { id: string; name: string; arguments: string; thoughtSignature?: string }> = {};
  let usage: any = null;
  let text = "";

  const assemble = () => ({
    toolCalls: Object.keys(toolAcc)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => toolAcc[Number(k)])
      .filter((tc) => tc.name)
      .map((tc) => {
        let parsed: any = {};
        let parseError: string | undefined;
        try {
          parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch (e: any) {
          parseError = `Invalid tool arguments JSON: ${e?.message || String(e)}`;
        }
          return {
            id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            name: tc.name,
            arguments: tc.arguments,
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
            parsed,
            ...(parseError ? { parseError } : {}),
          };
      }),
    text,
    usage,
  });

  try {
    while (true) {
      if (signal?.aborted) return assemble();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line === "data: [DONE]") continue;
        if (!line.startsWith("data:")) continue;

        let data: any;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (data.usage) usage = data.usage;
        const choice = data.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};
        if (delta.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolAcc[i]) toolAcc[i] = { id: tc.id || "", name: "", arguments: "" };
            if (tc.id) toolAcc[i].id = tc.id;
            const fn = tc.function || {};
            if (fn.name) toolAcc[i].name = fn.name;
            if (fn.arguments) toolAcc[i].arguments += fn.arguments;
            const thoughtSignature =
              tc.extra_content?.google?.thought_signature ||
              tc.extra_content?.google?.thoughtSignature ||
              tc.thought_signature ||
              tc.thoughtSignature ||
              fn.thought_signature ||
              fn.thoughtSignature;
            if (thoughtSignature) toolAcc[i].thoughtSignature = thoughtSignature;
          }
        }
        // Keep reading past finish_reason so trailing usage chunks are captured;
        // the stream closes (done) immediately after for compliant providers.
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return assemble();
    yield { type: "error", message: e?.message || String(e) };
  }

  return assemble();
}

// ===========================================================================
// Streamer 2 — Anthropic Messages API
// ===========================================================================

export async function* streamAnthropic(args: StreamArgs): AsyncGenerator<Frame> {
  const { messages, model, apiKey, appState, screenshot, signal, toolSessionId } = args;
  const cfg = PROVIDERS["anthropic"];

  const key = getApiKey("anthropic", apiKey);
  if (!key) {
    yield { type: "error", message: "ANTHROPIC_API_KEY not set. Provide an API key in the assistant settings." };
    return;
  }

  const useModel = normalizeModelIdForProvider("anthropic", model || cfg.defaultModel);
  const systemText = buildSystemInstruction(appState);
  const anthMessages = buildAnthropicMessages(messages, screenshot);
  if (!anthMessages.length) {
    yield { type: "error", message: "No user/assistant messages provided" };
    return;
  }

  const url = `${cfg.baseUrl}/v1/messages`;
  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  yield { type: "status", message: `Connecting to Anthropic (${useModel})...` };

  const session = toolSessionId ? activeSessions.get(toolSessionId) ?? null : null;
  const usageTotal = { input_tokens: 0, output_tokens: 0 };

  // Agentic loop: call the API, run any tool_use blocks, feed the results back
  // as tool_result blocks, repeat until a tool-free final answer (or the cap).
  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    if (signal?.aborted) return;

    const body: any = {
      model: useModel,
      system: systemText,
      messages: anthMessages,
      max_tokens: 32000,
      stream: true,
      tools: ANTHROPIC_TOOLS,
    };

    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      yield { type: "error", message: `Cannot connect to Anthropic: ${e?.message || e}` };
      yield { type: "done" };
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      yield { type: "error", message: `Anthropic ${resp.status}: ${errText.slice(0, 500)}` };
      yield { type: "done" };
      return;
    }

    const collected = yield* parseAnthropicStreamCollect(resp, signal);
    usageTotal.input_tokens += collected.usage.input_tokens || 0;
    usageTotal.output_tokens += collected.usage.output_tokens || 0;

    if (!collected.toolCalls.length) {
      // Final answer — preserves single-turn behavior when no tools are called.
      yield { type: "done", usage: usageTotal };
      return;
    }

    // Record the assistant turn (text + tool_use blocks) verbatim.
    const assistantContent: any[] = [];
    if (collected.text) assistantContent.push({ type: "text", text: collected.text });
    for (const tc of collected.toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    anthMessages.push({ role: "assistant", content: assistantContent });

    // Execute tools and feed every result back in a single user turn.
    const toolResultBlocks: any[] = [];
    for (const tc of collected.toolCalls) {
      if (signal?.aborted) return;
      if (tc.parseError) {
        yield { type: "status", message: `Tool ${tc.name} skipped: ${tc.parseError}` };
        toolResultBlocks.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify({ error: tc.parseError }), is_error: true });
        continue;
      }
      const r = yield* runLoopToolCall(session, tc.id, tc.name, tc.input, signal);
      const block: any = { type: "tool_result", tool_use_id: tc.id };
      if (r.error) {
        block.content = JSON.stringify({ error: r.error });
        block.is_error = true;
      } else if (r.imageData) {
        block.content = [
          { type: "text", text: "Canvas screenshot:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: r.imageData } },
        ];
      } else {
        block.content = toolResultToText({ result: r.result });
      }
      toolResultBlocks.push(block);
    }
    anthMessages.push({ role: "user", content: toolResultBlocks });
  }

  // Iteration cap reached without a tool-free final answer.
  yield { type: "done", usage: usageTotal };
}

// Parse an Anthropic Messages SSE stream, yielding text/thinking frames and
// returning the accumulated tool_use blocks + final text + usage for the
// agentic loop (tool dispatch is handled by the caller, not here).
async function* parseAnthropicStreamCollect(
  resp: Response,
  signal?: AbortSignal,
): AsyncGenerator<
  Frame,
  {
    toolCalls: Array<{ id: string; name: string; input: any; parseError?: string }>;
    text: string;
    usage: { input_tokens: number; output_tokens: number };
    stopReason: string | null;
  }
> {
  const usage = { input_tokens: 0, output_tokens: 0 };
  let text = "";
  let stopReason: string | null = null;
  // Track every content block by index so multiple parallel tool_use blocks are
  // captured (the previous single-toolAcc only handled one tool per turn).
  const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};

  const assemble = () => ({
    toolCalls: Object.keys(blocks)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => blocks[Number(k)])
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b) => {
        let input: any = {};
        let parseError: string | undefined;
        try {
          input = b.json ? JSON.parse(b.json) : {};
        } catch (e: any) {
          parseError = `Invalid tool arguments JSON: ${e?.message || String(e)}`;
        }
        return { id: b.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: b.name as string, input, ...(parseError ? { parseError } : {}) };
      }),
    text,
    usage,
    stopReason,
  });

  if (!resp.body) return assemble();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return assemble();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith("event:")) continue;
        if (!line.startsWith("data:")) continue;

        let data: any;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        const t = data.type;
        if (t === "content_block_start") {
          const idx = data.index ?? 0;
          const cb = data.content_block || {};
          if (cb.type === "tool_use") {
            blocks[idx] = { type: "tool_use", id: cb.id || "", name: cb.name || "", json: "" };
          } else {
            blocks[idx] = { type: cb.type || "text", json: "" };
          }
        } else if (t === "content_block_delta") {
          const idx = data.index ?? 0;
          const d = data.delta || {};
          if (d.type === "text_delta" && d.text) {
            text += d.text;
            yield { type: "text_delta", text: d.text };
          } else if (d.type === "thinking_delta" && d.thinking) {
            yield { type: "thinking", text: d.thinking };
          } else if (d.type === "input_json_delta") {
            if (blocks[idx]) blocks[idx].json += d.partial_json || "";
          }
        } else if (t === "message_start") {
          const u = data.message?.usage;
          if (u?.input_tokens) usage.input_tokens = u.input_tokens;
        } else if (t === "message_delta") {
          const u = data.usage;
          if (u?.output_tokens) usage.output_tokens = u.output_tokens;
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        } else if (t === "message_stop") {
          return assemble();
        } else if (t === "error") {
          yield { type: "error", message: data.error?.message || "Anthropic stream error" };
        }
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return assemble();
    yield { type: "error", message: e?.message || String(e) };
  }

  return assemble();
}

// ===========================================================================
// Model discovery — provider /models fetch + fallbacks
// ===========================================================================

export function fallbackModels(provider: string, cfg: ProviderConfig): { id: string; label: string }[] {
  if (provider === "gemini") return GEMINI_FALLBACK_MODELS;
  return cfg.defaultModel ? [{ id: cfg.defaultModel, label: cfg.defaultModel }] : [];
}

export async function fetchProviderModels(
  provider: string,
  cfg: ProviderConfig,
  apiKey?: string,
): Promise<{ id: string; label: string; capabilities?: string[] }[]> {
  const key = getApiKey(provider, apiKey);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    // Gemini: native models endpoint (OpenAI-compat base has no /models list).
    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      return (data.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m: any) => ({
          id: String(m.name || "").replace(/^models\//, ""),
          label: m.displayName || String(m.name || "").replace(/^models\//, ""),
          capabilities: ["chat", "tools"],
        }));
    }

    // Ollama: /api/tags rather than an OpenAI-style /models list.
    if (provider === "ollama") {
      const resp = await fetch(`${cfg.baseUrl}/api/tags`, { signal: controller.signal });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      return (data.models || []).map((m: any) => ({
        id: m.name,
        label: m.name,
        capabilities: ["chat", "tools"],
      }));
    }

    // OpenRouter Free: fetch full catalog unauthenticated, filter to zero-cost models.
    // Free detection per OPENROUTER-ROUTER: pricing.prompt === "0" && pricing.completion === "0"
    // OR model id ends with ":free".
    if (provider === "openrouter-free") {
      const resp = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      const rows: any[] = data.data || [];
      return rows
        .filter(
          (m: any) =>
            (m.pricing?.prompt === "0" && m.pricing?.completion === "0") ||
            String(m.id || "").endsWith(":free"),
        )
        .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))
        .map((m: any) => ({
          id: m.id,
          label: m.name || m.id,
          capabilities: capabilitiesFromOpenRouterModel(m),
        }));
    }

    // Generic OpenAI-compatible /v1/models discovery.
    if (cfg.modelsPath) {
      const headers: Record<string, string> = {};
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const resp = await fetch(`${cfg.baseUrl}${cfg.modelsPath}`, {
        headers,
        signal: controller.signal,
      });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      const rows = data.data || data.models || [];
      return rows.map((m: any) => ({
        id: m.id || m.name,
        label: m.name || m.id,
        capabilities: provider === "openrouter" ? capabilitiesFromOpenRouterModel(m) : ["chat"],
      }));
    }

    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}
