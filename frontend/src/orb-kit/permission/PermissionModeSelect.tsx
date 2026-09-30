/**
 * PermissionModeSelect — the assistant's permission mode, as a dropdown.
 *
 * A native <select>, deliberately: the four modes are a one-of-four choice
 * with no icons or badges to render, and a native control comes with keyboard
 * handling, type-ahead and a real <label> association for free (HARD RULE 3).
 * Each option carries its explanation as a `title`, so hovering a mode says
 * what it will and will not do before you pick it.
 *
 * Changing the mode updates the store (persisted, used by the next chat
 * request) and, when a conversation is already running, tells the backend at
 * once so the live CLI session switches mid-conversation. When the backend
 * had to stop a running turn for the switch to cover it (a switch into Ask or
 * Read-only), a notice under the control says so, with a Dismiss key.
 *
 * Only the Claude Code provider has permission modes. This component does not
 * gate itself — whoever renders it decides when it applies.
 */
import { useState, type ChangeEvent } from 'react'

import {
  PERMISSION_MODE_OPTIONS,
  normalizePermissionMode,
  sendPermissionMode,
  useAssistantPermissionStore,
  type PermissionMode,
} from './assistantPermissionStore'

/** The notice shown after a switch stopped the running turn. */
export function interruptedNotice(mode: PermissionMode): string {
  const label = PERMISSION_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode
  return `Stopped the running turn so “${label}” covers its next step. Send your message again to go on.`
}

export interface PermissionModeSelectProps {
  /** The live conversation to switch, if there is one. Without it the mode is
   *  only remembered locally and rides along with the next chat request. */
  conversationId?: string | null
  /** Hide the visible label text (it stays in the DOM for screen readers) and
   *  tighten the control for a crowded header row. */
  compact?: boolean
}

export function PermissionModeSelect({ conversationId, compact = false }: PermissionModeSelectProps) {
  const mode = useAssistantPermissionStore((s) => s.mode)
  const setMode = useAssistantPermissionStore((s) => s.setMode)
  const [notice, setNotice] = useState<string | null>(null)

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = normalizePermissionMode(event.target.value)
    if (!next) return
    setMode(next)
    setNotice(null)
    // sendPermissionMode never rejects, and the dropdown does not wait on the
    // network to show the mode the user just picked.
    void sendPermissionMode(conversationId, next).then((reply) => {
      setNotice(reply.interrupted ? interruptedNotice(next) : null)
    })
  }

  return (
    <div className={compact ? 'relative flex items-center gap-1.5' : 'relative flex flex-col gap-0.5'}>
      <label
        htmlFor="assistant-permission-mode"
        className={
          compact
            ? 'sr-only'
            : 'text-xs font-bold text-muted uppercase tracking-wider'
        }
      >
        Permissions
      </label>
      <select
        id="assistant-permission-mode"
        name="assistantPermissionMode"
        value={mode}
        onChange={handleChange}
        className={`${compact ? 'max-w-40' : 'w-full'} bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-white cursor-pointer hover:border-white/20 focus:outline-none focus:border-primary/50 transition-colors`}
      >
        {PERMISSION_MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value} title={option.description} className="bg-black text-white">
            {option.label}
          </option>
        ))}
      </select>
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`${compact ? 'absolute right-0 top-full z-20 mt-1 w-72' : 'mt-1'} flex items-start gap-2 rounded border border-amber-400/40 bg-zinc-900 px-3 py-2 shadow-lg`}
        >
          <span className="flex-1 text-xs font-semibold text-amber-100">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss the permission mode notice"
            className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-amber-100 hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

export default PermissionModeSelect
