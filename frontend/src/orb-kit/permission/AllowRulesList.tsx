/**
 * AllowRulesList — the Claude allow rules the session loads, each with an
 * "Always allow" toggle.
 *
 * The Claude Code CLI approves a call an allow rule matches before it asks
 * theDAW. In Ask mode the backend now sends every loaded allow rule to
 * theDAW's permission check, so the user is asked first, except the rules
 * marked here (settings `assistant.always_allow_rules`, saved through the
 * settings store; see claude_session.permission_rules). In the other modes the
 * rules behave as the CLI's own settings say.
 *
 * The rules come from GET /api/assistant/allow-rules: the user's
 * ~/.claude/settings.json when "Use my Claude settings" is on, and this
 * project's .claude/settings.json and settings.local.json. The toggles are
 * buttons with aria-pressed (HARD RULE 3: custom controls take aria-label and
 * state, never a wrapping <label>).
 */
import { useCallback, useEffect, useState } from 'react';

import { useFeatureToggleStore } from '../../state/featureToggleStore';
import { useAssistantPermissionStore } from './assistantPermissionStore';

export interface LoadedAllowRule {
  rule: string;
  source: 'user' | 'project' | 'local';
  path: string;
  always_allow: boolean;
}

/** Where a rule came from, in words. */
export const SOURCE_LABEL: Record<LoadedAllowRule['source'], string> = {
  user: 'Your Claude settings',
  project: 'Project settings',
  local: 'Project local settings',
};

/** The saved list after the user flips one rule. Order kept, no duplicates. */
export function toggledAlwaysAllow(current: readonly string[], rule: string, on: boolean): string[] {
  const without = current.filter((r) => r !== rule);
  return on ? [...without, rule] : without;
}

/** What the list means in the current permission mode. */
export function allowRulesHint(mode: string): string {
  if (mode === 'ask') {
    return 'In Ask mode each rule below asks before the command it matches runs. Mark a rule Always allow to let it run without asking.';
  }
  if (mode === 'readonly') {
    return 'Read-only mode refuses every edit and command, whatever these rules say. Always allow applies in Ask mode.';
  }
  return 'In this mode these rules run what they match without asking, as your Claude settings say. Always allow applies in Ask mode.';
}

export const ALLOW_RULES_HEADING_ID = 'assistant-allow-rules-heading';

export function AllowRulesList() {
  const mode = useAssistantPermissionStore((s) => s.mode);
  const saved = useFeatureToggleStore((s) => s.settings.assistant?.always_allow_rules ?? []);
  const useUserConfig = useFeatureToggleStore((s) => s.settings.assistant?.use_user_claude_config ?? true);
  const [rules, setRules] = useState<LoadedAllowRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/allow-rules', { cache: 'no-store' });
      if (!res.ok) {
        setError(`the backend answered HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { rules?: LoadedAllowRule[] };
      setRules(Array.isArray(body.rules) ? body.rules : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Reload when the loaded sources change (the user setup switch).
  useEffect(() => {
    void load();
  }, [load, useUserConfig]);

  const flip = (rule: string, on: boolean) => {
    void useFeatureToggleStore
      .getState()
      .patch({ assistant: { always_allow_rules: toggledAlwaysAllow(saved, rule, on) } });
  };

  const hintId = `${ALLOW_RULES_HEADING_ID}-hint`;
  return (
    <section aria-labelledby={ALLOW_RULES_HEADING_ID} aria-describedby={hintId} className="flex flex-col gap-1.5">
      <h3 id={ALLOW_RULES_HEADING_ID} className="text-xs font-bold uppercase tracking-wider text-white">
        Claude allow rules
      </h3>
      <p id={hintId} className="text-xs font-semibold text-muted">
        {allowRulesHint(mode)}
      </p>
      {error && (
        <p role="alert" className="text-xs font-semibold text-rose-300">
          Could not read the allow rules: {error}
        </p>
      )}
      {rules && rules.length === 0 && !error && (
        <p className="text-xs font-semibold text-muted">No allow rules are loaded.</p>
      )}
      {rules && rules.length > 0 && (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
          {rules.map((r) => {
            const on = saved.includes(r.rule);
            return (
              <li key={r.rule} className="flex items-center gap-2 rounded border border-white/10 bg-black/30 px-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-xs font-bold text-white break-all" title={r.path}>
                    {r.rule}
                  </span>
                  <span className="text-xs font-semibold text-muted">{SOURCE_LABEL[r.source] ?? r.source}</span>
                </div>
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={`Always allow ${r.rule}`}
                  onClick={() => flip(r.rule, !on)}
                  className={`shrink-0 rounded border px-2 py-1 text-xs font-bold transition-colors ${
                    on
                      ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-100'
                      : 'border-white/15 bg-white/5 text-zinc-300 hover:border-white/30 hover:text-white'
                  }`}
                >
                  {on && <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-full bg-emerald-300" />}
                  Always allow
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default AllowRulesList;
