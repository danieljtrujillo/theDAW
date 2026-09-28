export interface AssistantExecutableAction {
    type: string;
    payload?: Record<string, unknown>;
}

/**
 * Every action name the browser will execute.
 *
 * Exported because it is half of a contract that spans two languages: the
 * `editor_*` / `dj_*` members here must match the declarations in
 * `backend/modules/assistant/tool_catalog.py` exactly. A name declared to the
 * model and missing here is a tool that silently refuses; a name here and
 * missing there is a capability no provider is ever told about.
 * `tests/test_assistant_provider_tools.py` reads this literal and fails on
 * either kind of drift.
 */
export const theDAW_ACTION_TYPES = new Set([
    'navigate',
    'navigate_to',
    'open_docs',
    'close_docs',
    'open_left_panel',
    'close_left_panel',
    'locate_feature',
    'set_prompt',
    'append_prompt',
    'improve_prompt',
    'set_negative_prompt',
    'set_model',
    'set_duration',
    'set_steps',
    'set_cfg',
    'set_cfg_scale',
    'set_seed',
    'set_batch',
    'set_batch_size',
    'set_sampler',
    'set_shift_mode',
    'set_init_noise',
    'set_params',
    'generate',
    'start_generation',
    'abort',
    'abort_generation',
    'stop_generation',
    'get_status',
    'status',
    // EDIT arrangement vocabulary (editor_* tools).
    'editor_get_state',
    'editor_add_track',
    'editor_remove_track',
    'editor_set_track',
    'editor_move_clip',
    'editor_remove_clip',
    'editor_split_clip',
    'editor_select_clip',
    'editor_set_playhead',
    'editor_set_bpm',
    'editor_set_loop',
    'editor_add_marker',
    // Notes — piano-roll clips, edited as notes (a clip holding rendered audio re-renders).
    'editor_quantize_clip',
    'editor_get_notes',
    'editor_set_notes',
    'editor_nudge_notes',
    'editor_transpose_clip',
    'editor_scale_velocity',
    'editor_humanize_clip',
    'editor_fix_overlaps',
    'editor_filter_notes',
    'editor_set_clip_instrument',
    // Roll parts: a MIDI clip as one part of a score.
    'editor_create_midi_clip',
    'editor_list_roll_parts',
    'editor_get_roll_part',
    'editor_set_roll_part',
    // Tempo and time.
    'editor_set_clip_source_bpm',
    'editor_stretch_clip',
    'editor_detect_tempo',
    'editor_set_time_signature',
    'editor_set_meter_map',
    'editor_get_meter_map',
    'editor_nudge_clip',
    // Transport.
    'editor_play',
    'editor_stop',
    'editor_seek_bar',
    'editor_loop_selection',
    // Clip geometry and audio.
    'editor_set_clip',
    'editor_trim_clip',
    'editor_duplicate_clip',
    'editor_merge_clips',
    'editor_crossfade_clips',
    'editor_reverse_clip',
    'editor_normalize_clip',
    'editor_bounce_clip',
    // The arrangement's notes as one MIDI file (Save As).
    'editor_export_midi',
    // Selection and grid.
    'editor_select_clips',
    'editor_select_range',
    'editor_select_notes',
    'editor_set_snap',
    'editor_set_tool',
    // Tracks.
    'editor_reorder_tracks',
    'editor_duplicate_track',
    'editor_freeze_track',
    // Analysis (backend DSP).
    'editor_analyze_clip',
    'editor_compare_timing',
    'editor_get_waveform_peaks',
    // Markers.
    'editor_remove_marker',
    'editor_rename_marker',
    // Automation.
    'editor_add_automation_lane',
    'editor_set_automation_points',
    // Safety net.
    'editor_undo',
    'editor_redo',
    'editor_snapshot',
    'editor_restore',
    // DJ performance control (handlers predate the declarations).
    'dj_get_state',
    'dj_load_set',
    'dj_automix',
    'dj_transition_now',
    'dj_set_next',
    // Composer: the piano roll's COMPOSE backends (orb-kit/composerTools).
    'composer_plan',
    'composer_check',
    'composer_form',
    'composer_species',
    'composer_canon',
    'composer_fugue',
    'composer_styles',
    'composer_profile',
    // Scores: import a score file, search and open the music21 corpus.
    'notation_import',
    'notation_corpus_search',
    'notation_corpus_open',
]);

/** Validate an arbitrary parsed object (e.g. from a scraped <action> block)
 *  into an executable action, applying the same allowlist as tool_call frames.
 *  Anything not in the vocabulary is rejected instead of executed blindly. */
export function sanitizeAssistantAction(value: unknown): AssistantExecutableAction | null {
    if (!isRecord(value)) return null;
    const type = typeof value.type === 'string' ? value.type : null;
    if (!type || !theDAW_ACTION_TYPES.has(type)) return null;
    return { type, payload: parsePayload(value.payload ?? value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): Record<string, unknown> {
    if (isRecord(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            if (isRecord(parsed)) return parsed;
        } catch {
            return {};
        }
    }
    return {};
}

function actionNameFromEvent(event: Record<string, unknown>): string | null {
    if (typeof event.action_type === 'string') return event.action_type;
    if (typeof event.name === 'string') return event.name;

    const fn = event.function;
    if (isRecord(fn) && typeof fn.name === 'string') return fn.name;

    return null;
}

function payloadFromEvent(event: Record<string, unknown>): Record<string, unknown> {
    if ('payload' in event) return parsePayload(event.payload);
    if ('input' in event) return parsePayload(event.input);

    const fn = event.function;
    if (isRecord(fn) && 'arguments' in fn) return parsePayload(fn.arguments);

    return {};
}

export function actionFromAssistantEvent(event: unknown): AssistantExecutableAction | null {
    if (!isRecord(event)) return null;
    if (event.type !== 'action' && event.type !== 'tool_call' && event.type !== 'function_call') return null;

    const type = actionNameFromEvent(event);
    if (!type || !theDAW_ACTION_TYPES.has(type)) return null;

    return {
        type,
        payload: payloadFromEvent(event),
    };
}

export function statusFromAssistantEvent(event: unknown): string | null {
    if (!isRecord(event)) return null;

    if (event.type === 'function_result') {
        const name = actionNameFromEvent(event);
        return name ? `Claude Code: ${name} complete` : 'Claude Code: tool complete';
    }

    if (event.type !== 'tool_call' && event.type !== 'function_call') return null;
    const name = actionNameFromEvent(event);
    if (!name || theDAW_ACTION_TYPES.has(name)) return null;

    return `Claude Code: using ${name}`;
}


