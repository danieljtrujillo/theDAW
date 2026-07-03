import React, { useState } from "react";
import {
  Cpu,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Wrench,
  Loader2,
  Pencil,
  ListTodo,
  Bot,
  HelpCircle,
  Check,
  Copy,
  RotateCcw,
} from "lucide-react";
import { simpleMarkdown } from "./markdown";
import type { ChatMessage, ToolCallEntry, TurnMeta, PendingControl, TextScale } from "./types";

// Message-bubble scale classes (moved from AIAssistantOrb.getScaleClasses).
function getScaleClasses(textScale: TextScale): string {
  switch (textScale) {
    case "xs":
      return "text-[11px] leading-relaxed";
    case "md":
      return "text-sm leading-relaxed";
    case "lg":
      return "text-base leading-relaxed";
    default:
      return "text-[12.5px] leading-relaxed";
  }
}

// ---------------------------------------------------------------------------
// Transcript — the scrollable message list rendering (messages, live streaming
// bubble, and the inline control-request card). Returns a Fragment so it drops
// straight into the orb's flex scroll container without changing the DOM shape.
// ---------------------------------------------------------------------------
export function Transcript({
  messages,
  textScale,
  isStreaming,
  currentThinking,
  currentText,
  currentToolCalls,
  pendingControl,
  onCopyMessage,
  onRetry,
  onAnswerControl,
}: {
  messages: ChatMessage[];
  textScale: TextScale;
  isStreaming: boolean;
  currentThinking: string;
  currentText: string;
  currentToolCalls: ToolCallEntry[];
  pendingControl: PendingControl | null;
  onCopyMessage: (text: string) => void;
  onRetry: () => void;
  onAnswerControl: (requestId: string, response: Record<string, unknown>) => void;
}) {
  return (
    <>
      {messages.map((m) => (
        <div key={m.id} style={{ display: "flex", gap: 8, justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
          {m.role === "assistant" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
              <div style={{
                width: 24, height: 24, borderRadius: "50%",
                background: "linear-gradient(135deg, #b91c1c, #991b1b)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, color: "white", boxShadow: "0 2px 8px rgba(185,28,28,0.3)",
              }}>&#9679;</div>
              <span style={{ fontSize: 7, color: "#71717a", whiteSpace: "nowrap", letterSpacing: "0.05em" }}>GANTASMO</span>
            </div>
          )}
          <div
            className={getScaleClasses(textScale)}
            style={{
              maxWidth: "85%", padding: "8px 12px", borderRadius: 12, lineHeight: 1.5,
              ...(m.role === "user"
                ? { background: "#b91c1c", color: "white", borderBottomRightRadius: 4 }
                : { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderBottomLeftRadius: 4, color: "#fafafa" }),
            }}
          >
            {/* Attached image if present */}
            {m.image && (
              <div style={{ marginBottom: 8, maxHeight: 144, overflow: "hidden", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)" }}>
                <img src={m.image} alt="Attachment" style={{ width: "100%", objectFit: "cover" }} />
              </div>
            )}

            {/* Referenced canvas elements ("Add to Chat") */}
            {m.refs && m.refs.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: m.text ? 6 : 0 }}>
                {m.refs.map((r) => (
                  <span key={r.id} style={{ fontSize: 10, background: "rgba(0,0,0,0.25)", borderRadius: 9999, padding: "1px 8px", color: "rgba(255,255,255,0.85)" }}>
                    {r.name} · {r.type}
                  </span>
                ))}
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
                      style={{ color: "#f87171", textDecoration: "underline", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
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
                  onClick={() => onCopyMessage(m.text)}
                  title="Copy"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#71717a", display: "flex", alignItems: "center", gap: 3, fontSize: 10, padding: 0 }}
                >
                  <Copy className="w-3 h-3" /> Copy
                </button>
                {!isStreaming && m.id === messages[messages.length - 1]?.id && (
                  <button
                    onClick={onRetry}
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
            <div style={{ width: 24, height: 24, borderRadius: "50%", background: "linear-gradient(135deg, #b91c1c, #991b1b)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "white", boxShadow: "0 2px 8px rgba(185,28,28,0.3)" }}>&#9679;</div>
            <span style={{ fontSize: 7, color: "#71717a", whiteSpace: "nowrap", letterSpacing: "0.05em" }}>GANTASMO</span>
          </div>
          <div className={getScaleClasses(textScale)} style={{ maxWidth: "85%", padding: "8px 12px", borderRadius: 12, borderBottomLeftRadius: 4, lineHeight: 1.5, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#fafafa" }}>
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
          onAnswer={(response) => onAnswerControl(pendingControl.requestId, response)}
        />
      )}
    </>
  );
}

// Collapsible Reasoning Component to separate AI thought output elegantly
interface CollapsibleReasoningProps {
  thinking: string;
  textScale: TextScale;
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
          <Cpu className="w-3.5 h-3.5 text-red-400" />
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
  textScale: TextScale;
}) {
  const scaleClass = { xs: "text-[10px]", sm: "text-[11px]", md: "text-xs", lg: "text-sm" }[textScale];
  const { total, errors } = countTools(toolCalls);
  const names = Array.from(new Set(toolCalls.map((t) => t.name))).slice(0, 4);
  return (
    <div className={`mb-2 flex flex-col gap-1 ${scaleClass}`}>
      {total > 1 && (
        <div className="flex items-center gap-2 px-1 text-[10px] text-zinc-500">
          <Wrench className="w-3 h-3 text-red-400 shrink-0" />
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
    tool.status === "error" ? "text-red-400" : tool.status === "success" ? "text-emerald-400" : "text-red-400";
  return (
    <div className="bg-black/30 border border-white/10 rounded-lg overflow-hidden font-mono text-[11px] leading-relaxed">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2.5 py-1.5 bg-white/5 flex items-center gap-1.5 text-[10px] text-zinc-400 hover:text-zinc-200 font-sans cursor-pointer transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Wrench className={`w-3 h-3 shrink-0 ${iconColor}`} />
        <span className="font-semibold text-zinc-300 shrink-0">{tool.name}</span>
        {tool.status === "executing" && <Loader2 className="w-3 h-3 animate-spin text-red-400 shrink-0" />}
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
          <pre className="p-2.5 m-0 text-zinc-400 max-h-40 overflow-auto whitespace-pre-wrap break-words select-all">
            {prettyInput}
          </pre>
          {resultText && (
            <pre
              className={`p-2.5 m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words select-all border-t border-white/5 ${
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
        <Pencil className={`w-3 h-3 shrink-0 ${tool.isError ? "text-red-400" : "text-red-400"}`} />
        <span className="font-semibold text-zinc-300 truncate">{fileName}</span>
        <span className="text-emerald-400 shrink-0">+{adds}</span>
        <span className="text-red-400 shrink-0">−{dels}</span>
        {tool.status === "executing" && <Loader2 className="w-3 h-3 animate-spin text-red-400 shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-white/5 bg-black/20 max-h-64 overflow-auto">
          {d.file && (
            <div className="px-2.5 py-1 text-[10px] text-zinc-500 border-b border-white/5 truncate">{d.file}</div>
          )}
          {shown.map((r, idx) => (
            <div
              key={idx}
              className={`px-2.5 whitespace-pre-wrap break-words ${
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
            <pre className="p-2.5 m-0 text-red-300 max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-white/5">
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
        <ListTodo className="w-3 h-3 text-red-400 shrink-0" />
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
                  st === "completed" ? "text-emerald-400" : st === "in_progress" ? "text-red-400" : "text-zinc-600"
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
    tool.status === "error" ? "text-red-400" : tool.status === "success" ? "text-emerald-400" : "text-red-400";
  return (
    <div className="bg-red-500/5 border border-red-400/20 rounded-lg overflow-hidden text-[11px]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2.5 py-1.5 bg-red-500/10 flex items-center gap-1.5 text-[10px] text-zinc-300 hover:text-zinc-100 cursor-pointer transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Bot className={`w-3 h-3 shrink-0 ${statusColor}`} />
        <span className="font-semibold shrink-0">{agentType || "Agent"}</span>
        <span className="text-zinc-500 truncate">{desc}</span>
        {tool.status === "executing" && <Loader2 className="w-3 h-3 animate-spin text-red-400 shrink-0" />}
        {total > 0 && (
          <span className="text-zinc-500 shrink-0">
            {total} tool{total === 1 ? "" : "s"}
          </span>
        )}
        {errors > 0 && <span className="text-red-400 shrink-0">{errors} ⚠</span>}
      </button>
      {open && (
        <div className="border-t border-red-400/15 bg-black/20 p-1.5 flex flex-col gap-1">
          {subs.length > 0 ? (
            subs.map((s, i) => <ToolCallRow key={s.toolId || i} tool={s} />)
          ) : (
            <div className="px-1.5 py-1 text-[10px] text-zinc-600">running…</div>
          )}
          {tool.result && (
            <div
              className={`px-2 py-1.5 rounded text-[10px] whitespace-pre-wrap break-words ${
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
  textScale: TextScale;
  onAnswer: (response: Record<string, unknown>) => void;
}) {
  if (control.toolName === "AskUserQuestion") {
    return <AskQuestionCard control={control} textScale={textScale} onAnswer={onAnswer} />;
  }
  return (
    <div className="mt-1 mb-1 self-start w-[90%] bg-red-500/10 border border-red-400/30 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-200">
        <HelpCircle className="w-3.5 h-3.5" />
        Permission requested
      </div>
      <div className="text-[11px] text-zinc-300">
        The agent wants to use <span className="font-mono text-red-200">{control.toolName}</span>.
      </div>
      {control.reason && <div className="text-[10px] text-zinc-500">{control.reason}</div>}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onAnswer({ behavior: "allow", updatedInput: control.input ?? {} })}
          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/30 cursor-pointer transition-colors"
        >
          Allow once
        </button>
        {control.suggestions && control.suggestions.length > 0 && (
          <button
            onClick={() =>
              onAnswer({ behavior: "allow", updatedInput: control.input ?? {}, updatedPermissions: control.suggestions })
            }
            className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-500/20 border border-red-400/40 text-red-200 hover:bg-red-500/30 cursor-pointer transition-colors"
          >
            Always allow
          </button>
        )}
        <button
          onClick={() => onAnswer({ behavior: "deny", message: "The user denied this action in the web UI." })}
          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-500/20 border border-red-400/40 text-red-200 hover:bg-red-500/30 cursor-pointer transition-colors"
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
  textScale: TextScale;
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
      <div className="mt-1 mb-1 self-start w-[90%] bg-red-500/10 border border-red-400/30 rounded-xl p-3 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-200">
          <HelpCircle className="w-3.5 h-3.5" />
          The agent is asking for input
        </div>
        <button
          onClick={() => onAnswer({ behavior: "allow", updatedInput: control.input ?? {} })}
          className="self-start px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-500/20 border border-red-400/40 text-red-200 hover:bg-red-500/30 cursor-pointer transition-colors"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1 mb-1 self-start w-[90%] bg-red-500/10 border border-red-400/30 rounded-xl p-3 flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-200">
        <HelpCircle className="w-3.5 h-3.5" />
        The agent is asking{questions.length > 1 ? ` ${questions.length} questions` : " a question"}
      </div>
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1.5">
          <div className="text-xs text-zinc-100 font-medium">
            {q.question}
            {q.multiSelect && <span className="ml-1 text-[10px] text-zinc-500">(choose any)</span>}
          </div>
          <div className="flex flex-col gap-1">
            {(Array.isArray(q.options) ? q.options : []).map((opt: any, oi: number) => {
              const isSel = (selected[qi] ?? []).includes(opt.label);
              return (
                <button
                  key={oi}
                  onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                  className={`text-left px-2.5 py-1.5 rounded-lg text-[11px] border cursor-pointer transition-colors flex items-start gap-2 ${
                    isSel
                      ? "bg-red-500/30 border-red-400/60 text-red-100"
                      : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
                  }`}
                >
                  <span
                    className={`mt-0.5 w-3.5 h-3.5 shrink-0 border flex items-center justify-center ${
                      q.multiSelect ? "rounded" : "rounded-full"
                    } ${isSel ? "bg-red-400 border-red-300" : "border-zinc-500"}`}
                  >
                    {isSel && <Check className="w-2.5 h-2.5 text-black" />}
                  </span>
                  <span className="flex flex-col">
                    <span className="font-medium">{opt.label}</span>
                    {opt.description && <span className="text-[10px] text-zinc-500">{opt.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <button
        onClick={submit}
        disabled={!allAnswered}
        className={`self-end px-3.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
          allAnswered ? "bg-red-600 text-white hover:bg-red-500 cursor-pointer" : "bg-white/5 text-zinc-600 cursor-not-allowed"
        }`}
      >
        Submit
      </button>
    </div>
  );
}
