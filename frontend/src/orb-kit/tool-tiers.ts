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
// Tier map - theDAW tool declarations
// ---------------------------------------------------------------------------

const TOOL_TIERS: Record<string, ToolTier> = {
  // -- T0_silent: read-only / navigation (no UI card) -------------------------
  get_status:        'T0_silent',
  status:            'T0_silent',
  get_params:        'T0_silent',
  navigate:          'T0_silent',
  navigate_to:       'T0_silent',
  open_docs:         'T0_silent',
  close_docs:        'T0_silent',
  open_left_panel:   'T0_silent',
  close_left_panel:  'T0_silent',
  locate_feature:    'T0_silent',
  editor_get_state:  'T0_silent',
  editor_select_clip:'T0_silent',
  editor_set_playhead:'T0_silent',
  // Reading, selecting and driving the transport change nothing a user would
  // have to undo, so they run without a card. Measuring a clip is read-only
  // even though it costs a backend round trip.
  editor_get_notes:  'T0_silent',
  editor_list_roll_parts:'T0_silent',
  editor_get_roll_part:'T0_silent',
  editor_get_meter_map:'T0_silent',
  editor_select_clips:'T0_silent',
  editor_select_range:'T0_silent',
  editor_select_notes:'T0_silent',
  editor_loop_selection:'T0_silent',
  editor_play:       'T0_silent',
  editor_stop:       'T0_silent',
  editor_seek_bar:   'T0_silent',
  editor_analyze_clip:'T0_silent',
  editor_detect_tempo:'T0_silent',
  editor_compare_timing:'T0_silent',
  editor_get_waveform_peaks:'T0_silent',
  dj_get_state:      'T0_silent',

  // -- T1_inform: parameter mutations (show receipt) --------------------------
  set_prompt:        'T1_inform',
  set_negative_prompt:'T1_inform',
  append_prompt:     'T1_inform',
  improve_prompt:    'T1_inform',
  set_model:         'T1_inform',
  set_duration:      'T1_inform',
  set_steps:         'T1_inform',
  set_cfg:           'T1_inform',
  set_cfg_scale:     'T1_inform',
  set_seed:          'T1_inform',
  set_batch:         'T1_inform',
  set_batch_size:    'T1_inform',
  set_sampler:       'T1_inform',
  set_shift_mode:    'T1_inform',
  set_init_noise:    'T1_inform',
  set_params:        'T1_inform',
  editor_add_track:  'T1_inform',
  editor_set_track:  'T1_inform',
  editor_move_clip:  'T1_inform',
  editor_split_clip: 'T1_inform',
  editor_set_bpm:    'T1_inform',
  editor_set_loop:   'T1_inform',
  editor_add_marker: 'T1_inform',
  // Every edit below writes through the store's own actions, so editor_undo
  // takes it back in one step. That is what makes a receipt enough.
  editor_quantize_clip:'T1_inform',
  editor_set_notes:  'T1_inform',
  editor_create_midi_clip:'T1_inform',
  editor_set_roll_part:'T1_inform',
  editor_nudge_notes:'T1_inform',
  editor_transpose_clip:'T1_inform',
  editor_scale_velocity:'T1_inform',
  editor_humanize_clip:'T1_inform',
  editor_fix_overlaps:'T1_inform',
  editor_filter_notes:'T1_inform',
  editor_set_clip_instrument:'T1_inform',
  editor_set_clip_source_bpm:'T1_inform',
  editor_stretch_clip:'T1_inform',
  editor_set_time_signature:'T1_inform',
  editor_set_meter_map:'T1_inform',
  editor_nudge_clip: 'T1_inform',
  editor_set_clip:   'T1_inform',
  editor_trim_clip:  'T1_inform',
  editor_duplicate_clip:'T1_inform',
  editor_crossfade_clips:'T1_inform',
  editor_reverse_clip:'T1_inform',
  editor_normalize_clip:'T1_inform',
  editor_bounce_clip:'T1_inform',
  editor_set_snap:   'T1_inform',
  editor_set_tool:   'T1_inform',
  editor_duplicate_track:'T1_inform',
  editor_rename_marker:'T1_inform',
  editor_add_automation_lane:'T1_inform',
  editor_set_automation_points:'T1_inform',
  editor_undo:       'T1_inform',
  editor_redo:       'T1_inform',
  editor_snapshot:   'T1_inform',
  // Mid-show steering. Reversible by the opposite call (load another set, turn
  // automix off, reorder again), so a receipt rather than a countdown — a
  // confirmation dialog during a live set is worse than the edit.
  dj_load_set:       'T1_inform',
  dj_automix:        'T1_inform',
  dj_transition_now: 'T1_inform',
  dj_set_next:       'T1_inform',

  // -- T2_confirm: expensive / irreversible (require approval) ----------------
  // The backend emits 'generate' / 'abort'; the long names are kept as aliases.
  generate:          'T2_confirm',
  start_generation:  'T2_confirm',
  abort:             'T2_confirm',
  abort_generation:  'T2_confirm',
  stop_generation:   'T2_confirm',
  editor_remove_track:'T2_confirm',
  editor_remove_clip:'T2_confirm',
  // Destructive, or hard to take back:
  //   merge     — flattens several clips into one and deletes the originals
  //   restore   — replaces the whole arrangement with a snapshot
  //   remove_marker / reorder_tracks — destroy structure the user arranged
  //   freeze_track — cannot be done from here at all; the card is where the
  //                  user is told to use the track header instead
  editor_merge_clips:'T2_confirm',
  editor_restore:    'T2_confirm',
  editor_remove_marker:'T2_confirm',
  editor_reorder_tracks:'T2_confirm',
  editor_freeze_track:'T2_confirm',

  // -- Claude-native tools ----------------------------------------------------
  // The Claude Code provider runs the CLI's own tools alongside theDAW's. Their
  // tiers mirror the backend permission policy's READ_TOOLS / EDIT_TOOLS /
  // SHELL_TOOLS / AGENT_TOOLS sets so the transcript shows the same split the
  // permission bubbles enforce: reading is silent, everything that writes to
  // the machine is confirmed.
  Read:              'T0_silent',
  Grep:              'T0_silent',
  Glob:              'T0_silent',
  LS:                'T0_silent',
  WebFetch:          'T0_silent',
  WebSearch:         'T0_silent',
  TodoWrite:         'T0_silent',
  NotebookRead:      'T0_silent',
  // Listed explicitly rather than left to the unknown-tool fallback, so the
  // classification is a stated decision and survives a change to that default.
  Edit:              'T2_confirm',
  Write:             'T2_confirm',
  MultiEdit:         'T2_confirm',
  NotebookEdit:      'T2_confirm',
  Bash:              'T2_confirm',
  PowerShell:        'T2_confirm',
  Agent:             'T2_confirm',
  Task:              'T2_confirm',
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
    case 'navigate_to':
      // Real navigate payloads carry {tab}; {path} was a route-string design
      // that never shipped.
      return `Navigate to ${formatPath((args.tab as string) ?? (args.view as string) ?? (args.path as string))}`
    case 'locate_feature':
      return `Show where ${args.feature_id ?? args.feature ?? 'a feature'} is`

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

    // -- editor_* -------------------------------------------------------------
    case 'editor_add_track':
      return `Add editor track${args.name ? ` "${args.name}"` : ''}`
    case 'editor_remove_track':
      return `Remove editor track ${args.track_id ?? args.track_name ?? ''} (and its clips)`
    case 'editor_set_track':
      return `Update editor track ${args.track_id ?? args.track_name ?? ''}`
    case 'editor_move_clip':
      return `Move clip ${args.clip_id ?? ''}${args.start_sec != null ? ` to ${args.start_sec}s` : ''}`
    case 'editor_remove_clip':
      return `Remove clip ${args.clip_id ?? ''} from the arrangement`
    case 'editor_split_clip':
      return `Split clip ${args.clip_id ?? ''} at ${args.at_sec}s`
    case 'editor_set_playhead':
      return `Move playhead to ${args.seconds}s`
    case 'editor_set_bpm':
      return `Set arrangement BPM to ${args.bpm}`
    case 'editor_set_loop':
      return 'Set the loop region'
    case 'editor_add_marker':
      return `Add marker at ${args.seconds}s`

    // -- the T2 editor tools --------------------------------------------------
    // These are the ones a user has to approve, so each says what it DESTROYS,
    // not just what it does. The rest of the editor_* / dj_* vocabulary falls
    // through to the generic phrasing below.
    case 'editor_merge_clips': {
      const n = Array.isArray(args.clip_ids) ? args.clip_ids.length : 0
      return `Merge ${n || 'the selected'} clips into one — the originals are removed`
    }
    case 'editor_restore':
      return `Restore snapshot "${args.name ?? ''}" over the current arrangement`
    case 'editor_remove_marker':
      return `Remove marker ${args.marker_id ?? args.name ?? ''}`
    case 'editor_reorder_tracks':
      return `Reorder ${Array.isArray(args.track_ids) ? args.track_ids.length : 0} track(s)`
    case 'editor_freeze_track':
      return `Freeze track ${args.track_id ?? ''} (not available from the assistant)`

    // -- T2_confirm -----------------------------------------------------------
    case 'generate':
    case 'start_generation':
      return 'Start audio generation (spends GPU time)'
    case 'abort':
    case 'abort_generation':
    case 'stop_generation':
      return 'Abort the current generation'

    // -- Fallback -------------------------------------------------------------
    default:
      // theDAW's own vocabulary is verb_object by construction, so it reads as
      // a sentence with the underscores taken out. Native tool names (Bash,
      // Read, an MCP server's) are not, and keep the neutral phrasing.
      return toolName.startsWith('editor_') || toolName.startsWith('dj_')
        ? describeDawTool(toolName, args)
        : `Execute tool: ${toolName}`
  }
}

/** "editor_scale_velocity" + {clip_id} -> "Scale velocity on c1". */
function describeDawTool(toolName: string, args: Record<string, unknown>): string {
  const phrase = toolName.replace(/^editor_/, '').replace(/^dj_/, 'DJ ').replace(/_/g, ' ')
  const subject =
    firstDefined(args, ['clip_id', 'midi_clip_id', 'clip_id_a', 'track_id', 'marker_id', 'lane_id', 'name', 'label']) ??
    countOf(args, ['clip_ids', 'track_ids', 'notes', 'points'])
  const sentence = subject ? `${phrase} ${subject}` : phrase
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

function firstDefined(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (value !== undefined && value !== null && value !== '') return truncateString(String(value), 40)
  }
  return undefined
}

function countOf(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (Array.isArray(args[key])) return `(${(args[key] as unknown[]).length})`
  }
  return undefined
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


