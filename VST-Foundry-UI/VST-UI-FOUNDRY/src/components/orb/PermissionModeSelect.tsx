// PermissionModeSelect — the assistant's permission mode, as a dropdown.
//
// A native <select>, deliberately: the four modes are a one-of-four choice with
// no icons or badges to render, and a native control comes with keyboard
// handling, type-ahead and a real <label htmlFor> association for free. Each
// option carries its explanation as a `title`, so hovering a mode says what it
// will and will not do before you pick it.
//
// Changing the mode persists it (localStorage; the next chat request carries
// it) and, when a conversation is already running, tells the server at once so
// the live CLI session switches mid-conversation.
//
// Only the Claude Code provider has permission modes. This component does not
// gate itself — whoever renders it decides when it applies.
import { useEffect, useId, useState } from "react";
import { LS_PERMISSION_MODE } from "./constants";

/** The four permission modes. These strings are the wire contract shared with
 *  the server policy in `server/permissions.ts` — never rename one alone. */
export type PermissionMode = "ask" | "accept_edits" | "readonly" | "trusted";

export interface PermissionModeOption {
  value: PermissionMode;
  /** Short name shown in the dropdown. */
  label: string;
  /** One line explaining the mode; rendered as the option's `title`. */
  description: string;
}

/** Dropdown contents, in display order. 'ask' is listed first (the most
 *  cautious mode), but 'trusted' — last in this list — is the DEFAULT; see
 *  DEFAULT_PERMISSION_MODE below. */
export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: "ask",
    label: "Ask before acting",
    description: "Reading is free; every edit, command or sub-agent asks you first.",
  },
  {
    value: "accept_edits",
    label: "Accept edits, ask for shell",
    description: "File edits inside the project apply on their own; shell commands and sub-agents still ask.",
  },
  {
    value: "readonly",
    label: "Read-only",
    description: "The assistant may only read. Every edit or command is refused outright.",
  },
  {
    value: "trusted",
    label: "Trusted",
    description: "No prompts - except changes to the assistant's own code, which always ask. The default.",
  },
];

const VALID_MODES: readonly PermissionMode[] = PERMISSION_MODE_OPTIONS.map((o) => o.value);

// The Foundry orb has always run with prompts effectively off (the CLI spawn
// carried --dangerously-skip-permissions until the policy layer went live),
// and nobody asked to change that day-to-day experience — only to make the
// enforcement real. So "trusted" is the Foundry's OWN default: every read,
// edit, command and sub-agent auto-allows, and only a self-modify request
// still asks. Mirrors server/permissions.ts's DEFAULT_PERMISSION_MODE — keep
// both in sync if this ever changes. theDAW's separate Python assistant
// keeps its own default of "ask", untouched by this constant.
export const DEFAULT_PERMISSION_MODE: PermissionMode = "trusted";

/** Coerce an unknown value (localStorage, an API reply, a DOM event) into a
 *  mode, or null when it is not one of the four. */
export function normalizePermissionMode(value: unknown): PermissionMode | null {
  return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}

/** The persisted mode, for callers that need it outside React (the chat hook
 *  sends it with every Claude turn). Falls back to the default. */
export function readStoredPermissionMode(): PermissionMode {
  try {
    return normalizePermissionMode(localStorage.getItem(LS_PERMISSION_MODE)) ?? DEFAULT_PERMISSION_MODE;
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

/** Persist the mode. Values that are not one of the four are ignored. */
export function writeStoredPermissionMode(mode: unknown): PermissionMode | null {
  const normalized = normalizePermissionMode(mode);
  if (!normalized) return null;
  try {
    localStorage.setItem(LS_PERMISSION_MODE, normalized);
  } catch {
    /* private mode / quota — the in-memory value still applies to this turn */
  }
  return normalized;
}

/**
 * Tell a live conversation about a mode change. Resolves true when the server
 * accepted it. Never throws and never rejects: the dropdown has already moved
 * by the time this runs, and a server that is down must not strand the UI.
 * Returns false — without calling the API — when there is no conversation yet,
 * in which case the mode simply rides along with the next chat request.
 */
export async function postPermissionMode(
  conversationId: string | null | undefined,
  mode: PermissionMode,
  claudeSessionId?: string | null,
): Promise<boolean> {
  if (!conversationId && !claudeSessionId) return false;
  try {
    const res = await fetch("/api/assistant/permission-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, claudeSessionId, mode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface PermissionModeSelectProps {
  /** The live conversation to switch, if there is one. Without it the mode is
   *  only remembered locally and rides along with the next chat request. */
  conversationId: string | null;
  /** Fallback identity for the live CLI session when the conversation id is lost. */
  claudeSessionId?: string | null;
  /** Hide the visible label text (it stays in the DOM for screen readers) and
   *  tighten the control for a crowded header row. */
  compact?: boolean;
}

export function PermissionModeSelect({ conversationId, claudeSessionId, compact = false }: PermissionModeSelectProps) {
  // A fixed id would collide if more than one PermissionModeSelect is ever
  // mounted at once (a second orb, a second browser tab's tree, a
  // compact+full pair) — two elements sharing one id breaks the
  // label/htmlFor association for BOTH. useId() gives each instance its own
  // stable, unique id.
  const selectId = useId();
  const [mode, setMode] = useState<PermissionMode>(() => readStoredPermissionMode());

  // Adopt a mode another surface stored (a second orb, another tab).
  useEffect(() => {
    const stored = readStoredPermissionMode();
    if (stored !== mode) setMode(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = writeStoredPermissionMode(e.target.value);
    if (!next) return;
    setMode(next);
    // Fire-and-forget: postPermissionMode never rejects, and the dropdown must
    // not wait on the network to show the mode the user just picked.
    void postPermissionMode(conversationId, next, claudeSessionId);
  };

  return (
    <div>
      <label
        htmlFor={selectId}
        style={
          compact
            ? { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }
            : { fontSize: 10, color: "#52525b", display: "block", marginBottom: 4 }
        }
      >
        Permissions
      </label>
      <select
        id={selectId}
        name="assistantPermissionMode"
        value={mode}
        onChange={handleChange}
        title={PERMISSION_MODE_OPTIONS.find((o) => o.value === mode)?.description}
        style={{
          width: "100%",
          background: "rgba(0,0,0,0.3)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6,
          padding: compact ? "4px 6px" : "6px 8px",
          fontSize: 11,
          color: "#fafafa",
          outline: "none",
          cursor: "pointer",
        }}
      >
        {PERMISSION_MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={o.description}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default PermissionModeSelect;
