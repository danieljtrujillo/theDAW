import React, { useEffect, useRef, useState } from "react";
import { Terminal, X, RefreshCw, Trash2, ArrowDownToLine } from "lucide-react";

// ---------------------------------------------------------------------------
// EventLog — in-app event/error console for the Foundry app.
//
// Surfaces errors that the browser's F12 console cannot show: the foundry
// SERVER (server.ts) logs to an in-memory ring exposed at GET /api/logs
// (generation failures, Claude CLI spawn errors, MCP relay, config, etc.).
// This panel polls that endpoint AND captures client-side errors
// (window.onerror / unhandledrejection / console.error) into one merged,
// timestamp-sorted stream so nothing is invisible.
// ---------------------------------------------------------------------------

type Level = "error" | "warn" | "info";

function classify(line: string): Level {
  const l = line.toLowerCase();
  if (
    l.includes("[error]") || l.includes("error:") || l.includes(" failed") ||
    l.includes("failed ") || l.includes("exception") || l.includes("[client] ") && /error|fail|reject|exception/i.test(l)
  ) return "error";
  if (l.includes("[warn]") || l.includes("warning")) return "warn";
  return "info";
}

const LEVEL_COLOR: Record<Level, string> = {
  error: "#fca5a5",
  warn: "#fcd34d",
  info: "#a1a1aa",
};

const MAX_CLIENT = 400;

export default function EventLog() {
  const [open, setOpen] = useState(false);
  const [serverLines, setServerLines] = useState<string[]>([]);
  const [clientLines, setClientLines] = useState<string[]>([]);
  const [unseenErrors, setUnseenErrors] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<string[]>([]);
  const openRef = useRef(false);
  openRef.current = open;

  // Capture client-side errors at all times (even before the panel is opened),
  // so a crash that happens before you look is still recorded.
  useEffect(() => {
    const push = (msg: string) => {
      const entry = `[${new Date().toISOString()}] [CLIENT] ${msg}`;
      clientRef.current = [...clientRef.current.slice(-MAX_CLIENT), entry];
      setClientLines(clientRef.current);
      if (!openRef.current && /error|fail|reject|exception/i.test(msg)) {
        setUnseenErrors((c) => c + 1);
      }
    };
    const onError = (e: ErrorEvent) =>
      push(`${e.message}${e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : ""}`);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r: any = e.reason;
      push(`Unhandled rejection: ${(r && (r.message || r.stack)) || (typeof r === "object" ? JSON.stringify(r) : String(r))}`);
    };
    const origError = console.error;
    console.error = (...args: any[]) => {
      try {
        push(args.map((a) => (typeof a === "string" ? a : a?.message || JSON.stringify(a))).join(" "));
      } catch { /* never let logging break the app */ }
      origError.apply(console, args);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = origError;
    };
  }, []);

  // Poll the foundry server log while the panel is open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/logs?lines=400");
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && Array.isArray(j.lines)) setServerLines(j.lines as string[]);
      } catch { /* server unreachable — client errors still show */ }
    };
    void load();
    const t = window.setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [open]);

  // Merge server + client streams. Both lines start with an ISO timestamp in
  // brackets, so a plain lexicographic sort orders them chronologically.
  const merged = [...serverLines, ...clientLines].sort();
  const newestLine = merged[merged.length - 1];

  useEffect(() => {
    if (open && autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [merged.length, newestLine, open, autoScroll]);

  const errorTotal = merged.filter((l) => classify(l) === "error").length;

  return (
    <>
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setUnseenErrors(0); }}
        title="Event log — server + client errors/events"
        aria-label="Toggle event log"
        style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 9990,
          width: 44, height: 44, borderRadius: "50%",
          background: open ? "rgba(139,92,246,0.25)" : "rgba(9,9,11,0.92)",
          border: `1px solid ${open ? "rgba(139,92,246,0.6)" : "rgba(255,255,255,0.12)"}`,
          color: open ? "#c4b5fd" : "#a1a1aa", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)", backdropFilter: "blur(8px)",
        }}
      >
        <Terminal className="w-5 h-5" />
        {unseenErrors > 0 && (
          <span
            style={{
              position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, padding: "0 5px",
              borderRadius: 9, background: "#ef4444", color: "white", fontSize: 10, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid #09090b",
            }}
          >
            {unseenErrors > 99 ? "99+" : unseenErrors}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          style={{
            position: "fixed", bottom: 80, right: 24, zIndex: 9991,
            width: 560, maxWidth: "calc(100vw - 48px)", height: 360, maxHeight: "60vh",
            display: "flex", flexDirection: "column",
            background: "rgba(9,9,11,0.96)", border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 12, overflow: "hidden", backdropFilter: "blur(20px)",
            boxShadow: "0 25px 50px rgba(0,0,0,0.6)",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)",
              background: "linear-gradient(to right, rgba(139,92,246,0.1), rgba(236,72,153,0.1))",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Terminal className="w-4 h-4" style={{ color: "#c4b5fd" }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "#fafafa" }}>Event Log</span>
              <span style={{ fontSize: 10, color: errorTotal ? "#fca5a5" : "#52525b", fontFamily: "monospace" }}>
                {merged.length} lines{errorTotal ? ` · ${errorTotal} errors` : ""}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button
                type="button"
                onClick={() => setAutoScroll((v) => !v)}
                title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
                style={{ padding: 6, borderRadius: 6, background: "none", border: "none", cursor: "pointer", color: autoScroll ? "#8b5cf6" : "#52525b", display: "flex" }}
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => { clientRef.current = []; setClientLines([]); setServerLines([]); setUnseenErrors(0); }}
                title="Clear (view only — server keeps its own ring)"
                style={{ padding: 6, borderRadius: 6, background: "none", border: "none", cursor: "pointer", color: "#52525b", display: "flex" }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => { void fetch("/api/logs?lines=400").then((r) => r.json()).then((j) => Array.isArray(j.lines) && setServerLines(j.lines)).catch(() => {}); }}
                title="Refresh now"
                style={{ padding: 6, borderRadius: 6, background: "none", border: "none", cursor: "pointer", color: "#52525b", display: "flex" }}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                style={{ padding: 6, borderRadius: 6, background: "none", border: "none", cursor: "pointer", color: "#52525b", display: "flex" }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              if (atBottom !== autoScroll) setAutoScroll(atBottom);
            }}
            style={{
              flex: 1, overflowY: "auto", padding: "8px 12px",
              fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
              fontSize: 11, lineHeight: 1.55, background: "rgba(0,0,0,0.25)",
            }}
          >
            {merged.length === 0 ? (
              <div style={{ color: "#52525b", textAlign: "center", padding: "32px 0" }}>
                No events yet. Server + client errors will appear here in real time.
              </div>
            ) : (
              merged.map((line) => {
                const level = classify(line);
                return (
                  <div
                    key={line}
                    style={{
                      color: LEVEL_COLOR[level],
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      padding: "1px 0",
                      borderLeft: level === "error" ? "2px solid #ef4444" : level === "warn" ? "2px solid #f59e0b" : "2px solid transparent",
                      paddingLeft: 8,
                    }}
                  >
                    {line}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </>
  );
}
