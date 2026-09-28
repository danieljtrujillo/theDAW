/**
 * assistantPermissionStore — the assistant's permission MODE.
 *
 * One setting, four values, shared by the header dropdown and by every chat
 * request that goes to the Claude Code provider. The mode decides what the
 * assistant may do on its own and what has to come back as a permission
 * bubble; the backend policy in `backend/modules/assistant/permissions.py`
 * is the enforcer — this store only carries the user's choice.
 *
 * The chosen mode is remembered across sessions under
 * 'thedaw:assistant-permission-mode'. A live conversation is told about a
 * change immediately via POST /api/assistant/permission-mode, so the running
 * CLI session switches without waiting for the next turn.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from '../../state/persistStorage';

/** The four permission modes. These strings are the wire contract shared with
 *  the backend policy — never rename one without changing it there too. */
export type PermissionMode = 'ask' | 'accept_edits' | 'readonly' | 'trusted';

/** localStorage key holding the persisted mode. */
export const ASSISTANT_PERMISSION_MODE_STORAGE_KEY = 'thedaw:assistant-permission-mode';

export interface PermissionModeOption {
  value: PermissionMode;
  /** Short name shown in the dropdown. */
  label: string;
  /** One line explaining the mode; rendered as the option's `title`. */
  description: string;
}

/** Dropdown contents, in display order. 'ask' is first and is the default. */
export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: 'ask',
    label: 'Ask before acting',
    description:
      'Reading is free; every edit, command or sub-agent asks you first, including what your Claude allow rules cover unless you mark a rule Always allow. The default.',
  },
  {
    value: 'accept_edits',
    label: 'Accept edits, ask for shell',
    description:
      'File edits inside the project apply on their own; shell commands and sub-agents still ask.',
  },
  {
    value: 'readonly',
    label: 'Read-only',
    description: 'The assistant may only read. Every edit or command is refused outright.',
  },
  {
    value: 'trusted',
    label: 'Trusted',
    description:
      'No prompts — except changes to the assistant’s own code, which always ask.',
  },
];

const VALID_MODES: readonly PermissionMode[] = PERMISSION_MODE_OPTIONS.map((o) => o.value);

/** The default mode for a user who has never chosen one. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

/** Coerce an unknown value (persisted state, an API reply, a DOM event) into a
 *  mode, or null when it is not one of the four. */
export function normalizePermissionMode(value: unknown): PermissionMode | null {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}

interface AssistantPermissionState {
  mode: PermissionMode;
  /** Set the mode. Values that are not one of the four are ignored. */
  setMode: (mode: unknown) => void;
}

export const useAssistantPermissionStore = create<AssistantPermissionState>()(
  persist(
    (set) => ({
      mode: DEFAULT_PERMISSION_MODE,
      setMode: (mode) => {
        const normalized = normalizePermissionMode(mode);
        if (!normalized) return;
        set({ mode: normalized });
      },
    }),
    {
      name: ASSISTANT_PERMISSION_MODE_STORAGE_KEY,
      storage: persistStorage(),
      partialize: (s) => ({ mode: s.mode }),
      merge: (persisted, current) => ({
        ...current,
        mode:
          normalizePermissionMode((persisted as { mode?: unknown } | undefined)?.mode) ??
          current.mode,
      }),
    },
  ),
);

/** What POST /api/assistant/permission-mode answered. */
export interface PermissionModeReply {
  /** The backend accepted the switch. */
  ok: boolean;
  /** A running turn was stopped so the new mode covers its next step: the
   *  CLI's child keeps the rules it was started with until it is respawned,
   *  and a switch into Ask or Read-only needs rules it lacks. */
  interrupted: boolean;
}

/**
 * Tell a live conversation about a mode change (contract C2). Never throws
 * and never rejects: the dropdown has already moved by the time this runs,
 * and a backend that is down must not strand the UI. Answers `ok: false` —
 * without calling the API — when there is no conversation yet, in which case
 * the mode simply rides along with the next chat request.
 */
export async function sendPermissionMode(
  conversationId: string | null | undefined,
  mode: PermissionMode,
): Promise<PermissionModeReply> {
  if (!conversationId) return { ok: false, interrupted: false };
  try {
    const response = await fetch('/api/assistant/permission-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, mode }),
    });
    if (!response.ok) return { ok: false, interrupted: false };
    let interrupted = false;
    try {
      const body = (await response.json()) as { interrupted?: unknown } | null;
      interrupted = body?.interrupted === true;
    } catch {
      interrupted = false;
    }
    return { ok: true, interrupted };
  } catch {
    return { ok: false, interrupted: false };
  }
}

/** `sendPermissionMode`, answering only whether the backend accepted it. */
export async function postPermissionMode(
  conversationId: string | null | undefined,
  mode: PermissionMode,
): Promise<boolean> {
  return (await sendPermissionMode(conversationId, mode)).ok;
}
