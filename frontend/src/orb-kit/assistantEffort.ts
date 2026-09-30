/**
 * The Claude effort level.
 *
 * Ported from the Foundry orb, which has had this control since the BCC port:
 * `EFFORT_OPTIONS` / `LS_EFFORT` in
 * `VST-Foundry-UI/VST-UI-FOUNDRY/src/components/orb/constants.ts`, read into
 * state in `AIAssistantOrb.tsx` and sent with every Claude turn. theDAW sent a
 * hard-coded `max` and offered no way to change it; this module is the missing
 * half.
 *
 * The five levels are the backend's contract (`low | medium | high | xhigh |
 * max`; the Foundry server's `resolveClaudeEffort` rejects anything else), so
 * the normalizer is not decoration: a value written by an older build, or edited
 * by hand, must never reach the request body.
 */

/** The effort levels the Claude provider accepts, weakest first. */
export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type AssistantEffort = (typeof EFFORT_OPTIONS)[number];

/** Where the chosen level is remembered between sessions. */
export const ASSISTANT_EFFORT_STORAGE_KEY = 'thedaw:effort';

/** theDAW asks for the most effort unless told otherwise. */
export const DEFAULT_ASSISTANT_EFFORT: AssistantEffort = 'max';

/**
 * Coerce anything at all into one of the five levels.
 *
 * Unknown input is `max` rather than an error: the alternative is a chat
 * request the CLI refuses, for a setting the user cannot see.
 */
export function normalizeEffort(value: unknown): AssistantEffort {
    if (typeof value !== 'string') return DEFAULT_ASSISTANT_EFFORT;
    const candidate = value.trim().toLowerCase();
    return (EFFORT_OPTIONS as readonly string[]).includes(candidate)
        ? (candidate as AssistantEffort)
        : DEFAULT_ASSISTANT_EFFORT;
}

/** The remembered level, or `max`. A storage that throws reads as the default. */
export function readStoredEffort(): AssistantEffort {
    try {
        return normalizeEffort(localStorage.getItem(ASSISTANT_EFFORT_STORAGE_KEY));
    } catch {
        return DEFAULT_ASSISTANT_EFFORT;
    }
}

/** Remember the level. A storage that refuses the write is not an error. */
export function writeStoredEffort(effort: string): void {
    try {
        localStorage.setItem(ASSISTANT_EFFORT_STORAGE_KEY, normalizeEffort(effort));
    } catch {
        /* the level simply stops being remembered */
    }
}

/** What the dropdown shows for a level — the Foundry's capitalisation exactly. */
export function effortLabel(effort: string): string {
    if (!effort) return '';
    return effort.charAt(0).toUpperCase() + effort.slice(1);
}
