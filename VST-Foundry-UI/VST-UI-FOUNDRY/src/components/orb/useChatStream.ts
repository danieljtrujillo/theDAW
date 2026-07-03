import type React from "react";
import { useRef } from "react";
import type { UIElement, CanvasState } from "../../types";
import type { ChatMessage, ElementRef, ToolCallEntry, TurnMeta, PendingControl } from "./types";

// ---------------------------------------------------------------------------
// Chat streaming (SSE fetch/read loop) + mid-turn send queue drain.
// Extracted verbatim from AIAssistantOrb so the huge streaming state machine
// lives on its own. Every dependency is passed in via params so the hook builds
// each turn from the SAME live state/refs the component owns.
// ---------------------------------------------------------------------------
export interface UseChatStreamParams {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  attachedImage: string | null;
  setAttachedImage: React.Dispatch<React.SetStateAction<string | null>>;
  referencedElements: ElementRef[];
  setReferencedElements: React.Dispatch<React.SetStateAction<ElementRef[]>>;

  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  messagesRef: React.RefObject<ChatMessage[]>;

  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setStatusText: React.Dispatch<React.SetStateAction<string | null>>;
  setCurrentThinking: React.Dispatch<React.SetStateAction<string>>;
  setCurrentText: React.Dispatch<React.SetStateAction<string>>;
  setCurrentToolCalls: React.Dispatch<React.SetStateAction<ToolCallEntry[]>>;
  setPendingControl: React.Dispatch<React.SetStateAction<PendingControl | null>>;

  activeTurnRef: React.RefObject<boolean>;
  pendingSendsRef: React.RefObject<
    Array<{ prompt: string; image?: string; refs?: ElementRef[] }>
  >;
  setQueuedSends: React.Dispatch<React.SetStateAction<string[]>>;

  abortControllerRef: React.RefObject<AbortController | null>;

  elementsRef: React.RefObject<UIElement[]>;
  canvasStateRef: React.RefObject<CanvasState>;

  selectedProviderRef: React.RefObject<string>;
  selectedModelRef: React.RefObject<string>;
  providerApiKeysRef: React.RefObject<Record<string, string>>;
  currentSessionIdRef: React.RefObject<string>;
  effortRef: React.RefObject<string>;

  claudeSessionIdRef: React.RefObject<string | null>;
  setClaudeSessionId: React.Dispatch<React.SetStateAction<string | null>>;

  // Direct (non-ref) reads used inside the stream loop / context refresh.
  selectedProvider: string;
  currentSessionId: string;

  setContextUsage: React.Dispatch<
    React.SetStateAction<{ totalTokens: number; maxTokens: number; percentage: number } | null>
  >;
  setCliModel: React.Dispatch<React.SetStateAction<string | null>>;

  toolSessionIdRef: React.RefObject<string | null>;

  handleClientToolCall: (toolCall: { id?: string; name: string; args: any }) => Promise<any>;
}

export function useChatStream(params: UseChatStreamParams) {
  const {
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
  } = params;

  // Cumulative session cost (total_cost_usd) so we can show each turn's delta.
  const sessionCostRef = useRef(0);

  // Query the CLI for its REAL context-window usage (BCC's get_context_usage) and
  // update the meter. No-op / keeps the estimate if the CLI doesn't answer.
  const refreshContextUsage = async () => {
    if (selectedProvider !== "claude") return;
    const sid = claudeSessionIdRef.current;
    if (!sid && !currentSessionId) return;
    try {
      const res = await fetch("/api/assistant/control-request", {
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

  // Main stream caller function
  const handleSendMessage = async (
    customPrompt?: string,
    optionalImage?: string,
    optionalRefs?: ElementRef[],
  ) => {
    // ?? not ||: a queued refs-only message legitimately has prompt "" and must
    // not fall back to whatever is in the live input box at drain time.
    const promptToSend = customPrompt ?? input;
    // Referenced canvas elements ("Add to Chat") ride the message like the
    // attached image does: captured here, cleared from the composer, and
    // carried through the mid-turn queue.
    const refsToSend = optionalRefs ?? (referencedElements.length ? referencedElements : undefined);
    if (!promptToSend.trim() && !optionalImage && !attachedImage && !refsToSend) return;

    setInput("");
    const imageToSend = optionalImage || attachedImage;
    setAttachedImage(null);
    setReferencedElements([]);

    // BCC parity: if a turn is already streaming, queue this message instead of
    // firing a second, colliding request (which the backend used to reject 409).
    // It is sent automatically when the current turn finishes (see the drain in
    // the stream loop's `finally`). Stop clears the queue.
    if (activeTurnRef.current) {
      pendingSendsRef.current.push({ prompt: promptToSend, image: imageToSend || undefined, refs: refsToSend });
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
      refs: refsToSend,
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
    setPendingControl(null);

    const currentHistory = [...messagesRef.current, userMsg];

    // Build abort controller
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    let turnSucceeded = false;
    // Hoisted above the try so the AbortError handler can commit the partial
    // reply + any tools that already ran when the user hits Stop mid-turn.
    let thinkingAccumulated = "";
    let textAccumulated = "";
    let toolCallsAccumulated: ToolCallEntry[] = [];

    try {
      const appStatePayload = {
        elements: elementsRef.current,
        canvasState: canvasStateRef.current,
      };

      // Model-agnostic conversation history: [{role, content}].
      // Drop the seeded welcome greeting so providers that require a
      // user-first message (e.g. Anthropic) are not given an assistant lead.
      // Messages with element refs get a context block appended so the model
      // knows exactly which appState.elements entries the user means.
      const conversationHistory = currentHistory
        .filter((m) => m.id !== "welcome")
        .map((m) => ({
          role: m.role,
          content: m.refs?.length
            ? `${m.text}\n\n[Referenced canvas elements — full definitions are in appState.elements]\n${m.refs
                .map((r) => `- "${r.name}" (${r.type}, id: ${r.id})`)
                .join("\n")}`
            : m.text,
        }));

      const activeProvider = selectedProviderRef.current;
      const body: Record<string, any> = {
        messages: conversationHistory,
        provider: activeProvider,
        model: selectedModelRef.current,
        apiKey: providerApiKeysRef.current[activeProvider] || undefined,
        conversationId: currentSessionIdRef.current || undefined,
        appState: appStatePayload,
        screenshot: imageToSend || undefined,
      };

      // Claude Code-specific fields only when that provider is active.
      if (activeProvider === "claude") {
        body.effort = effortRef.current;
        if (claudeSessionIdRef.current) body.claudeSessionId = claudeSessionIdRef.current;
      }

      const res = await fetch("/api/assistant/chat", {
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

      let groundedLinksAccumulated: any[] = [];
      let metaAccumulated: TurnMeta | undefined;
      let receivedDone = false;

      while (!receivedDone) {
        const { done, value } = await reader.read();

        // On the final read (done), flush the decoder to recover any trailing
        // multibyte character and keep the whole buffer so a final SSE frame the
        // stream sent WITHOUT a terminating "\n" is still processed below.
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = done ? "" : lines.pop() || "";

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
                notifyDesktop("Foundry", "The agent needs your answer");
              }
              break;
            }

            case "control_cancel": {
              const rid = String(dataObj.requestId ?? "");
              setPendingControl((prev) => (prev && prev.requestId === rid ? null : prev));
              break;
            }

            case "model":
              // The CLI's actual booted model (from system/init).
              if (dataObj.model) setCliModel(String(dataObj.model));
              break;

            case "client_tool_call":
            case "function_call": {
              const name = dataObj.name;
              const args = dataObj.args ?? dataObj.input ?? {};
              const id = dataObj.id;
              if (name) {
                // Fire-and-forget: handleClientToolCall relays its own result
                // and errors; swallow rejection so the stream loop continues.
                handleClientToolCall({ id, name, args }).catch((err) =>
                  console.error("client tool call failed", err)
                );
              }
              break;
            }

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

        if (done) break;
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
        // Preserve the partial reply + any tools that already ran before the
        // user hit Stop, so the transcript records what happened this turn.
        if (textAccumulated || thinkingAccumulated || toolCallsAccumulated.length > 0) {
          const interruptedMsgId = Math.random().toString(36).substring(2, 9);
          setMessages((prev) => [
            ...prev,
            {
              id: interruptedMsgId,
              role: "assistant",
              text: textAccumulated
                ? `${textAccumulated}\n\n*(interrupted)*`
                : "*(interrupted)*",
              thinking: thinkingAccumulated || undefined,
              toolCalls: toolCallsAccumulated.length > 0 ? toolCallsAccumulated : undefined,
              timestamp: Date.now(),
            },
          ]);
        }
      } else {
        console.error("Stream failed", err);
        const errorMsgId = Math.random().toString(36).substring(2, 9);
        setMessages((prev) => [
          ...prev,
          {
            id: errorMsgId,
            role: "assistant",
            text: `⚠️ Error during communication: ${err.message || err}`,
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
      setPendingControl(null);
      abortControllerRef.current = null;
      activeTurnRef.current = false;
      // BCC parity: this turn is done — send the next queued message (if any).
      const next = pendingSendsRef.current.shift();
      setQueuedSends(pendingSendsRef.current.map((p) => p.prompt));
      if (next) {
        // Defer a tick so the state resets above settle before the next turn opens.
        setTimeout(() => handleSendMessage(next.prompt, next.image, next.refs), 0);
      } else if (turnSucceeded) {
        // No more queued turns: notify (if backgrounded) and refresh the REAL
        // context meter now that the child is idle.
        notifyDesktop("Foundry", "Response ready");
        refreshContextUsage();
      }
    }
  };

  return { handleSendMessage };
}
