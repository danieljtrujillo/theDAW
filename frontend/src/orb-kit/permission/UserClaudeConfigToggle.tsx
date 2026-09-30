/**
 * UserClaudeConfigToggle — "Use my Claude settings and MCP servers".
 *
 * A native checkbox with a real <label htmlFor> (HARD RULE 3), backed by the
 * app settings store (`assistant.use_user_claude_config`, which the backend
 * persists in data/settings.json). On, the default: the Claude Code session
 * loads the user's own ~/.claude settings, CLAUDE.md, skills, agents and MCP
 * servers next to theDAW's relay. Off: only this project's settings and
 * theDAW's own MCP servers load.
 * The backend reads the value on every turn and restarts the session when it
 * changed, so a switch applies from the next message.
 *
 * Only the Claude Code provider has this. The component does not gate itself;
 * whoever renders it decides when it applies.
 */
import { useEffect, type ChangeEvent } from 'react';

import { useFeatureToggleStore } from '../../state/featureToggleStore';

/** The checkbox id, the target of its <label htmlFor>. One per page. */
export const USER_CLAUDE_CONFIG_ID = 'assistant-use-user-claude-config';

/** What the current position of the switch means, in one or two sentences. */
export function userClaudeConfigHint(on: boolean): string {
  return on
    ? 'Your own Claude settings, CLAUDE.md, skills, agents and MCP servers load next to theDAW’s tools. Your own allow rules approve the commands they match without asking in Accept edits and Trusted, except in Read-only mode; in Ask mode they ask first unless you mark them Always allow below. Edits to the assistant’s own code always ask. Applies from your next message.'
    : 'Only this project’s settings and theDAW’s own tools load, so the permission mode decides every action this project’s own allow rules leave open. Applies from your next message.';
}

/**
 * Save the switch. Resolves true when the backend confirmed it. patch() rolls
 * the box back and raises a notice when the backend refuses (a LAN device is
 * refused this switch), so it never looks saved when it is not.
 */
export function setUseUserClaudeConfig(on: boolean): Promise<boolean> {
  return useFeatureToggleStore.getState().patch({ assistant: { use_user_claude_config: on } });
}

export function UserClaudeConfigToggle() {
  // `?? true`: a mirror or backend that predates the switch reads as its default.
  const on = useFeatureToggleStore((s) => s.settings.assistant?.use_user_claude_config ?? true);
  const loaded = useFeatureToggleStore((s) => s.loaded);
  const refresh = useFeatureToggleStore((s) => s.refresh);

  // Show the backend's value, not a stale local mirror, before anyone flips it.
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    void setUseUserClaudeConfig(event.target.checked);
  };

  const hintId = `${USER_CLAUDE_CONFIG_ID}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={USER_CLAUDE_CONFIG_ID}
          name="assistantUseUserClaudeConfig"
          type="checkbox"
          checked={on}
          onChange={handleChange}
          aria-describedby={hintId}
          className="size-4 shrink-0 cursor-pointer accent-primary"
        />
        <label htmlFor={USER_CLAUDE_CONFIG_ID} className="text-xs font-bold text-white cursor-pointer">
          Use my Claude settings and MCP servers
        </label>
      </div>
      <p id={hintId} className="text-xs text-muted">
        {userClaudeConfigHint(on)}
      </p>
    </div>
  );
}

export default UserClaudeConfigToggle;
