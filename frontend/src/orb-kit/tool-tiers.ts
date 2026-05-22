/**
 * Tool Tier Governance System
 *
 * Three-tier classification for assistant tool calls:
 *   T0_silent  - Auto-execute, no UI card. Read-only / navigation operations.
 *   T1_inform  - Auto-execute, show ActionCard receipt. Parameter mutations.
 *   T2_confirm - Show IntentPreviewCard with Run/Skip + 60s countdown.
 *                Expensive or irreversible operations (generation, abort).
 *
 * Unknown tools default to T2_confirm (fail-safe).
 */

export type ToolTier = 'T0_silent' | 'T1_inform' | 'T2_confirm'

// ---------------------------------------------------------------------------
// Tier map - StableDAW tool declarations
// ---------------------------------------------------------------------------

const TOOL_TIERS: Record<string, ToolTier> = {
  // -- T0_silent: read-only / navigation (no UI card) -------------------------
  get_status:        'T0_silent',
  get_params:        'T0_silent',
  navigate:          'T0_silent',

  // -- T1_inform: parameter mutations (show receipt) --------------------------
  set_prompt:        'T1_inform',
  set_model:         'T1_inform',
  set_duration:      'T1_inform',
  set_steps:         'T1_inform',
  set_cfg:           'T1_inform',
  set_seed:          'T1_inform',
  set_sampler:       'T1_inform',
  set_shift_mode:    'T1_inform',
  set_params:        'T1_inform',

  // -- T2_confirm: expensive / irreversible (require approval) ----------------
  start_generation:  'T2_confirm',
  abort_generation:  'T2_confirm',
}

// ---------------------------------------------------------------------------
// Tier lookup
// ---------------------------------------------------------------------------

/**
 * Get the governance tier for a tool. Unknown tools default to T2_confirm.
 */
export function getToolTier(toolName: string): ToolTier {
  return TOOL_TIERS[toolName] ?? 'T2_confirm'
}

// ---------------------------------------------------------------------------
// Human-readable descriptions for IntentPreviewCard / ActionCard
// ---------------------------------------------------------------------------

/**
 * Return a concise, human-readable description of a tool call
 * suitable for display in the IntentPreviewCard (T2) or ActionCard (T1).
 */
export function describeToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    // -- T0_silent ------------------------------------------------------------
    case 'get_status':
      return 'Check pipeline status'
    case 'get_params':
      return 'Get current generation parameters'
    case 'navigate':
      return `Navigate to ${formatPath(args.path as string)}`

    // -- T1_inform ------------------------------------------------------------
    case 'set_prompt':
      return `Set prompt: "${truncateString(args.prompt as string, 60)}"`
    case 'set_model':
      return `Set model to ${args.model}`
    case 'set_duration':
      return `Set duration to ${args.duration}s`
    case 'set_steps':
      return `Set inference steps to ${args.steps}`
    case 'set_cfg':
      return `Set CFG scale to ${args.cfg_scale}`
    case 'set_seed':
      return args.seed != null ? `Set seed to ${args.seed}` : 'Randomize seed'
    case 'set_sampler':
      return `Set sampler to ${args.sampler}`
    case 'set_shift_mode':
      return `Set shift mode to ${args.shift_mode}`
    case 'set_params': {
      const keys = Object.keys(args)
      return `Set ${keys.length} parameter${keys.length !== 1 ? 's' : ''}: ${keys.join(', ')}`
    }

    // -- T2_confirm -----------------------------------------------------------
    case 'start_generation':
      return 'Start audio generation'
    case 'abort_generation':
      return 'Abort current generation'

    // -- Fallback -------------------------------------------------------------
    default:
      return `Execute tool: ${toolName}`
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a route path for display. "/generate" -> "Generate" */
function formatPath(path: string | undefined): string {
  if (!path) return 'unknown page'
  const clean = path.replace(/^#?\/?/, '')
  if (!clean || clean === '/') return 'Home'
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

/** Truncate a string to maxLen with ellipsis. */
function truncateString(s: string | undefined, maxLen: number): string {
  if (!s) return ''
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s
}
