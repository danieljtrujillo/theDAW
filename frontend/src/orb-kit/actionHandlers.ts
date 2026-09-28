import { useGenerateParamsStore } from '../state/generateParamsStore';
import { buildGenerateParamsFromState, useGenerateStore } from '../state/generateStore';
import type { GenerateParamsState, WavBitDepth } from '../state/generateParamsStore';
import { FEATURES, featureById } from '../onboarding/featureRegistry';
import { useOnboardingStore } from '../onboarding/onboardingStore';
import { useAppUiStore } from '../state/appUiStore';
import { useEditorStore } from '../state/editorStore';
import { summarizeEditor } from './appContext';
import { isBundledSetId, isPendingBundledRow, useSetlistStore } from '../state/setlistStore';
import { readyActiveSetForAutomix, useDjAutomix } from '../state/djAutomixStore';
import { logInfo } from '../state/logStore';
import * as editorTools from '../state/editorTools';
import type { ToolResult } from '../state/editorTools';
import * as editorToolBridge from './editorToolBridge';
import { composerTool } from './composerTools';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from '../lib/tempoMap';

export interface AssistantActionPayload {
    type: string;
    payload?: Record<string, unknown>;
}

/** What an action actually did. `ok:false` means the app is UNCHANGED and
 *  `message` says why — the panel prints it verbatim instead of the old
 *  "Executed action: X", which was printed for a miss and a hit alike. */
export interface AssistantActionResult {
    ok: boolean;
    message: string;
}

/** Marks a branch that refused to act. See `runtheDAWAction`. */
interface ActionFailure {
    failed: true;
    message: string;
}

/** A branch of `runtheDAWAction` returns a bare string when it DID the thing,
 *  or `fail(...)` when it did not. Keeping success as a plain string means the
 *  honesty of a branch is visible at its own `return` rather than buried in a
 *  wrapper object every line has to spell out. */
type ActionOutcome = string | ActionFailure;

/** What a branch answers with. The editor tools re-render audio or call the
 *  backend, so their outcome only exists once that work is done. So do the DJ
 *  actions that register a bundled set with the backend (`dj_load_set` on a
 *  set nobody has opened, `dj_automix` on), which answer once the register
 *  has landed. Everything else in the switch below answers synchronously and
 *  must keep doing so. */
type ActionBranch = ActionOutcome | Promise<ActionOutcome>;

const fail = (message: string): ActionFailure => ({ failed: true, message });

function stringValue(payload: Record<string, unknown> | undefined, keys: string[], fallback = ''): string {
    for (const key of keys) {
        const value = payload?.[key];
        if (value !== undefined && value !== null) return String(value);
    }
    return fallback;
}

function numberValue(payload: Record<string, unknown> | undefined, keys: string[], fallback: number): number {
    for (const key of keys) {
        const value = payload?.[key];
        if (value !== undefined && value !== null && value !== '') return Number(value);
    }
    return fallback;
}

function booleanValue(payload: Record<string, unknown> | undefined, keys: string[], fallback: boolean): boolean {
    for (const key of keys) {
        const value = payload?.[key];
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.toLowerCase() === 'true';
        if (typeof value === 'number') return value !== 0;
    }
    return fallback;
}

/** Narrow a depth the model wrote freehand onto the three the backend knows.
 *  It is as likely to say 32, "32f" or "32-bit float" as the literal token, and
 *  the backend silently treats anything off-vocabulary as 16 — which would look
 *  like the request was honoured. There is no 32-bit integer option, so any 32
 *  means float. */
function bitDepthValue(payload: Record<string, unknown> | undefined, keys: string[]): WavBitDepth {
    const raw = stringValue(payload, keys, '16').trim().toLowerCase();
    if (raw.startsWith('32')) return '32f';
    if (raw.startsWith('24')) return '24';
    return '16';
}

function buildParamUpdates(payload: Record<string, unknown> | undefined): Partial<GenerateParamsState> {
    const updates: Partial<GenerateParamsState> = {};
    if (!payload) return updates;

    if ('prompt' in payload) updates.prompt = String(payload.prompt ?? '');
    if ('negativePrompt' in payload || 'negative_prompt' in payload) updates.negativePrompt = stringValue(payload, ['negativePrompt', 'negative_prompt']);
    if ('model' in payload) updates.model = String(payload.model ?? 'medium');
    if ('duration' in payload) updates.duration = Number(payload.duration);
    if ('steps' in payload) updates.steps = Number(payload.steps);
    if ('cfg' in payload || 'cfg_scale' in payload) updates.cfg = numberValue(payload, ['cfg', 'cfg_scale'], 1.0);
    if ('seed' in payload) updates.seed = Number(payload.seed);
    if ('batch' in payload || 'batch_size' in payload) updates.batch = numberValue(payload, ['batch', 'batch_size'], 1);
    if ('samplerType' in payload || 'sampler' in payload || 'sampler_type' in payload) updates.samplerType = stringValue(payload, ['samplerType', 'sampler', 'sampler_type'], 'pingpong');
    if ('sigmaMax' in payload || 'sigma_max' in payload) updates.sigmaMax = numberValue(payload, ['sigmaMax', 'sigma_max'], 1.0);
    if ('durationPaddingSec' in payload || 'duration_padding_sec' in payload) updates.durationPaddingSec = numberValue(payload, ['durationPaddingSec', 'duration_padding_sec'], 6.0);
    if ('apgScale' in payload || 'apg_scale' in payload) updates.apgScale = numberValue(payload, ['apgScale', 'apg_scale'], 1.0);
    if ('cfgRescale' in payload || 'cfg_rescale' in payload) updates.cfgRescale = numberValue(payload, ['cfgRescale', 'cfg_rescale'], 0.0);
    if ('cfgNormThreshold' in payload || 'cfg_norm_threshold' in payload) updates.cfgNormThreshold = numberValue(payload, ['cfgNormThreshold', 'cfg_norm_threshold'], 0.0);
    if ('cfgIntervalMin' in payload || 'cfg_interval_min' in payload) updates.cfgIntervalMin = numberValue(payload, ['cfgIntervalMin', 'cfg_interval_min'], 0.0);
    if ('cfgIntervalMax' in payload || 'cfg_interval_max' in payload) updates.cfgIntervalMax = numberValue(payload, ['cfgIntervalMax', 'cfg_interval_max'], 1.0);
    if ('shiftMode' in payload || 'shift_mode' in payload || 'mode' in payload) updates.shiftMode = stringValue(payload, ['shiftMode', 'shift_mode', 'mode'], 'LogSNR');
    if ('logsnrAnchorLength' in payload || 'logsnr_anchor_length' in payload) updates.logsnrAnchorLength = numberValue(payload, ['logsnrAnchorLength', 'logsnr_anchor_length'], 2000);
    if ('logsnrAnchorLogsnr' in payload || 'logsnr_anchor_logsnr' in payload) updates.logsnrAnchorLogsnr = numberValue(payload, ['logsnrAnchorLogsnr', 'logsnr_anchor_logsnr'], -6.2);
    if ('logsnrRate' in payload || 'logsnr_rate' in payload) updates.logsnrRate = numberValue(payload, ['logsnrRate', 'logsnr_rate'], 0.0);
    if ('logsnrEnd' in payload || 'logsnr_end' in payload) updates.logsnrEnd = numberValue(payload, ['logsnrEnd', 'logsnr_end'], 2.0);
    if ('fluxMinLen' in payload || 'flux_min_len' in payload) updates.fluxMinLen = numberValue(payload, ['fluxMinLen', 'flux_min_len'], 256);
    if ('fluxMaxLen' in payload || 'flux_max_len' in payload) updates.fluxMaxLen = numberValue(payload, ['fluxMaxLen', 'flux_max_len'], 4096);
    if ('fluxAlphaMin' in payload || 'flux_alpha_min' in payload) updates.fluxAlphaMin = numberValue(payload, ['fluxAlphaMin', 'flux_alpha_min'], 6.93);
    if ('fluxAlphaMax' in payload || 'flux_alpha_max' in payload) updates.fluxAlphaMax = numberValue(payload, ['fluxAlphaMax', 'flux_alpha_max'], 6.93);
    if ('fullBaseShift' in payload || 'full_base_shift' in payload) updates.fullBaseShift = numberValue(payload, ['fullBaseShift', 'full_base_shift'], 0.5);
    if ('fullMaxShift' in payload || 'full_max_shift' in payload) updates.fullMaxShift = numberValue(payload, ['fullMaxShift', 'full_max_shift'], 1.15);
    if ('fullMinLen' in payload || 'full_min_len' in payload) updates.fullMinLen = numberValue(payload, ['fullMinLen', 'full_min_len'], 256);
    if ('fullMaxLen' in payload || 'full_max_len' in payload) updates.fullMaxLen = numberValue(payload, ['fullMaxLen', 'full_max_len'], 4096);
    if ('initNoise' in payload || 'init_noise' in payload || 'noise' in payload) updates.initNoise = numberValue(payload, ['initNoise', 'init_noise', 'noise'], 0.7);
    if ('inversionSteps' in payload || 'inversion_steps' in payload) updates.inversionSteps = numberValue(payload, ['inversionSteps', 'inversion_steps'], 100);
    if ('inversionGamma' in payload || 'inversion_gamma' in payload) updates.inversionGamma = numberValue(payload, ['inversionGamma', 'inversion_gamma'], 0.0);
    if ('inversionUnconditional' in payload || 'inversion_unconditional' in payload) updates.inversionUnconditional = booleanValue(payload, ['inversionUnconditional', 'inversion_unconditional'], false);
    if ('fileFormat' in payload || 'file_format' in payload) updates.fileFormat = stringValue(payload, ['fileFormat', 'file_format'], 'wav');
    if ('wavBitDepth' in payload || 'wav_bit_depth' in payload || 'bit_depth' in payload) updates.wavBitDepth = bitDepthValue(payload, ['wavBitDepth', 'wav_bit_depth', 'bit_depth']);
    if ('fileNaming' in payload || 'file_naming' in payload) updates.fileNaming = stringValue(payload, ['fileNaming', 'file_naming'], 'verbose');
    if ('cutToDuration' in payload || 'cut_to_duration' in payload) updates.cutToDuration = booleanValue(payload, ['cutToDuration', 'cut_to_duration'], true);
    if ('autoplay' in payload) updates.autoplay = booleanValue(payload, ['autoplay'], true);
    if ('autoDownload' in payload || 'auto_download' in payload) updates.autoDownload = booleanValue(payload, ['autoDownload', 'auto_download'], false);

    return updates;
}

/** The ids a spotlight can actually land on, so a miss tells the model what to
 *  ask for instead of just saying no. Entries without a `locate` are left out:
 *  they have no single on-screen home to ring. */
function locatableFeatureIds(): string {
    return FEATURES.filter((f) => f.locate && !f.devOnly).map((f) => f.id).join(', ');
}

/** Resolve a track by id (exact) or name (case-insensitive) from the payload. */
function findEditorTrack(payload: Record<string, unknown> | undefined) {
    const tracks = useEditorStore.getState().tracks;
    const id = payload?.track_id !== undefined ? String(payload.track_id) : '';
    if (id) {
        const byId = tracks.find((t) => t.id === id);
        if (byId) return byId;
        const byName = tracks.find((t) => t.name.toLowerCase() === id.toLowerCase());
        if (byName) return byName;
    }
    const name = payload?.track_name !== undefined ? String(payload.track_name) : '';
    if (name) return tracks.find((t) => t.name.toLowerCase() === name.toLowerCase());
    return undefined;
}

function editorTrackMiss(payload: Record<string, unknown> | undefined): string {
    const asked = String(payload?.track_id ?? payload?.track_name ?? '?');
    const names = useEditorStore.getState().tracks.map((t) => `${t.name} (${t.id})`).join(', ') || 'none';
    return `No track "${asked}". Tracks: ${names}`;
}

/** Resolve a clip by id (exact) or label (case-insensitive) from the payload. */
function findEditorClip(payload: Record<string, unknown> | undefined) {
    const clips = useEditorStore.getState().clips;
    const id = payload?.clip_id !== undefined ? String(payload.clip_id) : '';
    if (id) {
        const byId = clips.find((c) => c.id === id);
        if (byId) return byId;
        const byLabel = clips.find((c) => c.label.toLowerCase() === id.toLowerCase());
        if (byLabel) return byLabel;
    }
    return undefined;
}

function editorClipMiss(payload: Record<string, unknown> | undefined): string {
    const asked = String(payload?.clip_id ?? '?');
    const labels = useEditorStore.getState().clips.slice(0, 20).map((c) => `${c.label} (${c.id})`).join(', ') || 'none';
    return `No clip "${asked}". Clips: ${labels}`;
}

/* ── the editor tool table ───────────────────────────────────────────────────
 *
 * Everything T09-T12 built is reached from here. A table rather than fifty more
 * `case` labels for three reasons: the keys ARE the contract (a test compares
 * them to `assistantEvents.ts`'s allowlist and, through it, to the Python
 * catalog), one entry per tool makes an undeclared or unhandled name impossible
 * to miss in review, and the uniform shape is what lets the dispatcher await
 * the async half without every branch repeating it.
 *
 * Each entry does exactly two things: narrow the payload to the arguments its
 * tool actually declares, and hand them to the facade. It does NOT validate
 * values — `state/editorTools.ts` owns that, and duplicating its rules here is
 * how the two drift until a tool refuses for one reason and explains another.
 *
 * The narrowing is not cosmetic. `editorTools`' argument types carry test seams
 * (`render`, `ctxFactory`, `sample_rate`) that replace the MIDI synth and the
 * audio context; passing a model's raw payload through would let a tool call
 * set them.
 */
type EditorToolRun = (payload: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

/** The facade's functions, and nothing else from the module. */
type EditorFacade = {
    -readonly [K in keyof typeof editorTools as (typeof editorTools)[K] extends (...args: never[]) => unknown ? K : never]: (typeof editorTools)[K];
};

/**
 * Every table entry calls the facade through this object rather than the
 * module namespace, so a test can stub ONE facade function and observe exactly
 * the arguments an entry's own mapping produced — without rendering audio, and
 * without letting a seam in through a tool payload. Nothing reachable from a
 * payload writes to it; only {@link overrideEditorFacadeForTest} does.
 */
const facade = { ...editorTools } as EditorFacade;

function pick<K extends string>(payload: Record<string, unknown>, keys: readonly K[]): Record<K, unknown> {
    const out = {} as Record<K, unknown>;
    for (const key of keys) {
        if (payload[key] !== undefined) out[key] = payload[key];
    }
    return out;
}

/** Both aliases for "which clip", so a model that speaks in labels works. */
const CLIP = ['clip_id', 'clip'] as const;
const TRACK = ['track_id', 'track'] as const;
const AUTOMATION_TARGET = ['lane_id', 'kind', 'track_id', 'track', 'entry_id', 'param_key'] as const;

/** A clip by id or exact label, with no opinion about whether it exists. */
function lookupClip(ref: unknown) {
    const asked = ref === undefined || ref === null ? '' : String(ref).trim();
    if (!asked) return undefined;
    const clips = useEditorStore.getState().clips;
    return clips.find((c) => c.id === asked) ?? clips.find((c) => c.label.toLowerCase() === asked.toLowerCase());
}

const STRETCH_TARGETS = ['ratio', 'target_bpm', 'target_duration_sec'] as const;

/** Where an `editor_stretch_clip` call goes, and with exactly which arguments. */
export type StretchRoute =
    | { route: 'refuse'; error: string; args?: undefined }
    | { route: 'backend'; args: Record<(typeof CLIP)[number] | (typeof STRETCH_TARGETS)[number], unknown>; error?: undefined }
    | { route: 'facade'; args: Record<(typeof CLIP)[number] | 'target_bpm' | 'target_duration_sec', unknown>; error?: undefined };

/**
 * Stretch routes on what the clip IS.
 *
 * A piano-roll clip is re-rendered from its notes locally — exact, and it keeps
 * the notes and the audio in step. An audio clip needs a pitch-preserving
 * stretch, which only the backend has. An unresolved clip goes to the facade so
 * the "No clip X. Known clips: …" message is written in one place.
 *
 * Pure (reads the store, writes nothing, calls nothing) so the routing and the
 * ratio-to-duration conversion can be asserted without rendering or a network.
 */
export function planStretch(payload: Record<string, unknown>): StretchRoute {
    const targets = STRETCH_TARGETS.filter((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== '');
    if (targets.length !== 1) {
        return {
            route: 'refuse',
            error: `stretch: pass exactly one of ratio, target_bpm or target_duration_sec (got ${targets.length ? targets.join(' and ') : 'none'})`,
        };
    }

    const clip = lookupClip(payload.clip_id ?? payload.clip);
    const isMidi = !!clip && clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll?.length;
    if (clip && !isMidi) return { route: 'backend', args: pick(payload, [...CLIP, ...STRETCH_TARGETS]) };

    const args = pick(payload, [...CLIP, 'target_bpm', 'target_duration_sec']);
    if (targets[0] === 'ratio' && clip) {
        // `stretchPlan` has no ratio target; for a MIDI clip a ratio is simply a
        // duration, and converting here keeps one validator for both paths.
        const ratio = Number(payload.ratio);
        if (!Number.isFinite(ratio) || ratio <= 0) return { route: 'refuse', error: 'stretch: ratio must be a positive number' };
        args.target_duration_sec = clip.durationSec * ratio;
    }
    return { route: 'facade', args };
}

async function stretchClipTool(payload: Record<string, unknown>): Promise<ToolResult> {
    const plan = planStretch(payload);
    if (plan.route === 'refuse') return { ok: false, error: plan.error };
    if (plan.route === 'backend') return editorToolBridge.stretchAudioClip(plan.args);
    return facade.stretchClip(plan.args);
}

const EDITOR_TOOLS: Record<string, EditorToolRun> = {
    // -- notes ---------------------------------------------------------------
    editor_quantize_clip: (p) => facade.quantizeClip(pick(p, [...CLIP, 'grid', 'strength', 'swing', 'quantize_ends', 'groove', 'groove_strength'])),
    editor_get_notes: (p) => facade.getNotes(pick(p, CLIP)),
    editor_set_notes: (p) => facade.setNotes(pick(p, [...CLIP, 'notes'])),
    editor_nudge_notes: (p) => facade.nudgeNotes(pick(p, [...CLIP, 'steps', 'ms', 'ticks', 'bpm'])),
    editor_transpose_clip: (p) => facade.transposeClip(pick(p, [...CLIP, 'semitones'])),
    editor_scale_velocity: (p) => facade.scaleVelocity(pick(p, [...CLIP, 'factor', 'offset', 'min', 'max'])),
    editor_humanize_clip: (p) => facade.humanizeClip(pick(p, [...CLIP, 'timing_steps', 'velocity', 'seed'])),
    editor_fix_overlaps: (p) => facade.fixOverlaps(pick(p, [...CLIP, 'mode'])),
    editor_filter_notes: (p) =>
        facade.filterNotes(
            pick(p, [...CLIP, 'min_length_steps', 'min_velocity', 'min_pitch', 'max_pitch', 'max_gap_steps']),
        ),
    editor_set_clip_instrument: (p) => facade.setClipInstrument(pick(p, [...CLIP, 'program'])),

    // -- roll parts ----------------------------------------------------------
    editor_create_midi_clip: (p) =>
        facade.createMidiClip(pick(p, ['track_id', 'track_name', 'program', 'percussion', 'start_bar', 'start_sec', 'bars', 'label'])),
    editor_list_roll_parts: () => facade.listRollParts(),
    editor_get_roll_part: (p) => facade.getRollPart(pick(p, [...CLIP, 'from_bar', 'to_bar'])),
    editor_set_roll_part: (p) =>
        facade.setRollPart(
            pick(p, [...CLIP, 'notes', 'lanes', 'meter_map', 'pickup_steps', 'bars', 'total_steps', 'program']),
        ),

    // -- tempo and time ------------------------------------------------------
    editor_set_clip_source_bpm: (p) => facade.setClipSourceBpm(pick(p, [...CLIP, 'bpm'])),
    editor_stretch_clip: stretchClipTool,
    editor_detect_tempo: (p) => editorToolBridge.detectTempo(pick(p, CLIP)),
    editor_set_time_signature: (p) => facade.setTimeSignature(pick(p, ['num', 'den', 'time_signature'])),
    editor_set_meter_map: (p) => facade.setMeterMap(pick(p, ['meter_map', 'tempo_map', 'adopt_clip_id'])),
    editor_get_meter_map: (p) => facade.getMeterMap(pick(p, ['from_bar', 'to_bar'])),
    editor_nudge_clip: (p) => facade.nudgeClip(pick(p, [...CLIP, 'delta_sec', 'beats', 'bars'])),

    // -- transport -----------------------------------------------------------
    editor_play: () => facade.play(),
    editor_stop: () => facade.stop(),
    editor_seek_bar: (p) => facade.seekBar(pick(p, ['bar'])),
    editor_loop_selection: (p) => facade.loopSelection(pick(p, ['clip_ids'])),

    // -- clip geometry and audio ---------------------------------------------
    editor_set_clip: (p) =>
        facade.setClip(
            pick(p, [...CLIP, 'gain', 'fade_in_sec', 'fade_out_sec', 'muted', 'duration_sec', 'label', 'instrument_program']),
        ),
    editor_trim_clip: (p) => facade.trimClip(pick(p, [...CLIP, 'in_sec', 'out_sec'])),
    editor_duplicate_clip: (p) => facade.duplicateClip(pick(p, [...CLIP, 'at_sec'])),
    editor_merge_clips: (p) => facade.mergeClips(pick(p, ['clip_ids'])),
    // The catalog says clip_id_a / clip_id_b (symmetric with every other
    // *_id argument); the facade's parameters are clip_a / clip_b.
    editor_crossfade_clips: (p) =>
        facade.crossfadeClips({
            clip_a: p.clip_id_a ?? p.clip_a,
            clip_b: p.clip_id_b ?? p.clip_b,
            overlap_sec: p.overlap_sec,
        }),
    editor_reverse_clip: (p) => facade.reverseClip(pick(p, CLIP)),
    editor_normalize_clip: (p) => facade.normalizeClip(pick(p, [...CLIP, 'peak_db'])),
    editor_bounce_clip: (p) => facade.bounceClip(pick(p, [...CLIP, 'flatten'])),
    // The arrangement's notes as one MIDI file; the save seam and the voice seam stay out of reach of a payload.
    editor_export_midi: (p) => facade.exportMidi(pick(p, ['track_ids', 'clip_ids', 'start_sec', 'end_sec', 'name'])),

    // -- selection and grid --------------------------------------------------
    editor_select_clips: (p) => facade.selectClips(pick(p, ['clip_ids'])),
    editor_select_range: (p) => facade.selectRange(pick(p, ['start_sec', 'end_sec', 'track_ids'])),
    editor_select_notes: (p) =>
        facade.selectNotes(pick(p, [...CLIP, 'note_ids', 'min_pitch', 'max_pitch', 'start_step', 'end_step'])),
    editor_set_snap: (p) => facade.setSnap(pick(p, ['snap', 'grid'])),
    editor_set_tool: (p) => facade.setTool(pick(p, ['tool'])),

    // -- tracks --------------------------------------------------------------
    // Routed to the facade rather than handled inline: it is the only path that
    // takes solo through `toggleSolo` (solo is exclusive in this store, so a
    // plain field write lets two tracks both claim it), and the only one that
    // knows freezing is UI-only.
    editor_set_track: (p) =>
        facade.setTrack(pick(p, [...TRACK, 'name', 'volume', 'pan', 'mute', 'solo', 'armed', 'frozen', 'instrument_program', 'drums'])),
    editor_reorder_tracks: (p) => facade.reorderTracks(pick(p, ['track_ids'])),
    editor_duplicate_track: (p) => facade.duplicateTrack(pick(p, TRACK)),
    editor_freeze_track: (p) => facade.freezeTrack(pick(p, TRACK)),
    // The Symphony orchestra template: sixteen section tracks, their buses and the hall send.
    editor_add_symphony_template: (p) => facade.createSymphonyTemplate(pick(p, ['seating'])),

    // -- analysis (backend DSP) ----------------------------------------------
    editor_analyze_clip: (p) => editorToolBridge.analyzeClip(pick(p, CLIP)),
    editor_compare_timing: (p) =>
        editorToolBridge.compareTiming(pick(p, ['midi_clip_id', 'audio_clip_id', 'max_match_sec'])),
    editor_get_waveform_peaks: (p) => editorToolBridge.getWaveformPeaks(pick(p, [...CLIP, 'buckets'])),

    // -- markers -------------------------------------------------------------
    editor_remove_marker: (p) => facade.removeMarker(pick(p, ['marker_id', 'marker', 'name'])),
    // `name` is the NEW label here; the facade resolves by marker_id/marker and
    // takes the new one as `label`, so passing `name` straight through would
    // rename the marker to itself.
    editor_rename_marker: (p) =>
        facade.renameMarker({ marker_id: p.marker_id ?? p.marker, label: p.name ?? p.label }),

    // -- automation ----------------------------------------------------------
    editor_add_automation_lane: (p) => facade.addAutomationLane(pick(p, AUTOMATION_TARGET)),
    editor_set_automation_points: (p) => facade.setAutomationPoints(pick(p, [...AUTOMATION_TARGET, 'points'])),

    // -- safety net ----------------------------------------------------------
    editor_undo: () => facade.undo(),
    editor_redo: () => facade.redo(),
    editor_snapshot: (p) => facade.snapshot(pick(p, ['name'])),
    editor_restore: (p) => facade.restore(pick(p, ['name'])),
};

/** The tool names this table serves. Read by `actionHandlers.test.ts` to prove
 *  the allowlist, the catalog and the handlers describe one set of tools. */
export const editorToolNames = (): string[] => Object.keys(EDITOR_TOOLS);

/**
 * Test seam: swap one table entry, get back the function that puts it back.
 *
 * Exists because the dispatcher's own guarantee — whatever a tool does, the
 * model gets a sentence back — can only be proved with a tool that misbehaves,
 * and the facade is an ES module namespace that cannot be monkeypatched. Only
 * existing entries can be swapped, so a test cannot smuggle a new tool name
 * past the allowlist/catalog contract.
 */
export function overrideEditorToolForTest(name: string, run: EditorToolRun): () => void {
    const original = EDITOR_TOOLS[name];
    if (!original) throw new Error(`overrideEditorToolForTest: no editor tool "${name}"`);
    EDITOR_TOOLS[name] = run;
    return () => {
        EDITOR_TOOLS[name] = original;
    };
}

/**
 * Test seam: stub ONE facade function, get back the function that puts it back.
 *
 * Unlike {@link overrideEditorToolForTest} this leaves the table entry — and so
 * its argument mapping — in place: the stub receives exactly what the entry
 * produced from a payload. That is how the mapping is asserted without running
 * the real MIDI renderer or audio context, whose behaviour in Node is not the
 * dispatcher's to depend on.
 */
export function overrideEditorFacadeForTest<K extends keyof EditorFacade>(name: K, fn: EditorFacade[K]): () => void {
    const original = facade[name];
    if (typeof original !== 'function') throw new Error(`overrideEditorFacadeForTest: no facade function "${String(name)}"`);
    facade[name] = fn;
    return () => {
        facade[name] = original;
    };
}

/** A facade result as the one thing the model gets back. A refusal comes back
 *  as the error text, never as a throw: the whole point is that the model reads
 *  what went wrong and tries something else in the same turn. It is carried as
 *  a `fail(...)` so the caller still knows the app is UNCHANGED. */
const spoken = (result: ToolResult): ActionOutcome => (result.ok ? result.message : fail(result.error));

const thrownReason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Run one table entry and ALWAYS come back with an outcome.
 *
 * The facade promises not to throw, but that is a promise about code, not a
 * proof: a store action that throws on a bad record or a rejected dynamic
 * import escapes it. A throw out of here would take the whole relay call down,
 * and the model would read a timeout instead of the reason. A throw is a
 * failure by definition — the tool did not do the thing. A synchronous tool
 * still answers synchronously.
 */
function runEditorTool(type: string, run: EditorToolRun, payload: Record<string, unknown>): ActionBranch {
    let result: ToolResult | Promise<ToolResult>;
    try {
        result = run(payload);
    } catch (e) {
        return fail(`${type}: ${thrownReason(e)}`);
    }
    if (!(result instanceof Promise)) return spoken(result);
    // Async tools (anything that re-renders audio or calls the backend) resolve
    // to their message only once the work is actually done, so the model never
    // reads "quantized" before the bounce finished.
    return result.then(spoken).catch((e: unknown) => fail(`${type}: ${thrownReason(e)}`));
}

function runtheDAWAction(action: AssistantActionPayload): ActionBranch {
    const { type, payload } = action;
    const params = useGenerateParamsStore.getState();
    const gen = useGenerateStore.getState();

    logInfo('assistant', `Action: ${type}`);

    switch (type) {
        // --- Navigation ---
        case 'navigate':
        case 'navigate_to': {
            const tab = String(payload?.tab || payload?.view || '');
            // Route through the store directly so the result is HONEST: the
            // old handler dispatched an event and claimed "Navigated to X"
            // even when the target silently no-opped (9 of 12 workspaces).
            const ok = useAppUiStore.getState().navigateTo(tab);
            return ok
                ? `Navigated to ${tab}`
                : fail(`Navigation failed: unknown workspace "${tab}". Valid targets: make, edit, mix, perform, dj, vj, sway, foundry, underfit, nodefi, learn, tour, library.`);
        }

        case 'open_docs':
            window.dispatchEvent(new CustomEvent('thedaw:open-docs'));
            return 'Opened docs';

        case 'close_docs':
            window.dispatchEvent(new CustomEvent('thedaw:close-docs'));
            return 'Closed docs';

        case 'open_left_panel':
            window.dispatchEvent(new CustomEvent('thedaw:set-left-panel', { detail: { open: true } }));
            return 'Opened left panel';

        case 'close_left_panel':
            window.dispatchEvent(new CustomEvent('thedaw:set-left-panel', { detail: { open: false } }));
            return 'Closed left panel';

        case 'locate_feature': {
            // "Where is X?" answered by showing rather than describing: the
            // spotlight switches workspace, opens whatever the control lives
            // in, and rings the control itself.
            const id = stringValue(payload, ['feature_id', 'featureId', 'feature', 'id']).trim();
            const entry = featureById(id);
            if (!entry) return fail(`No feature "${id}". Known ids: ${locatableFeatureIds()}`);
            // Spotlighting one of these would dim the app around a ring that
            // never appears, with no way for the user to dismiss it.
            if (!entry.locate) return fail(`${entry.name} has no one control to point at — it is ${entry.where}. ${entry.what}.`);
            useOnboardingStore.getState().spotlightOne(entry.id);
            return `Spotlighting ${entry.name} (${entry.where})`;
        }

        // --- Generation Parameters ---
        case 'set_prompt':
            params.setField('prompt', String(payload?.prompt || ''));
            return `Prompt set`;

        case 'set_negative_prompt':
            params.setField('negativePrompt', String(payload?.prompt || payload?.negative_prompt || ''));
            return `Negative prompt set`;

        case 'set_model':
            params.setField('model', String(payload?.model || 'medium'));
            return `Model: ${payload?.model}`;

        case 'set_duration':
            params.setField('duration', Number(payload?.duration || 30));
            return `Duration: ${payload?.duration}s`;

        case 'set_steps':
            params.setField('steps', Number(payload?.steps || 8));
            return `Steps: ${payload?.steps}`;

        case 'set_cfg':
        case 'set_cfg_scale':
            params.setField('cfg', Number(payload?.cfg || payload?.cfg_scale || 1.0));
            return `CFG: ${payload?.cfg || payload?.cfg_scale}`;

        case 'set_seed':
            params.setField('seed', Number(payload?.seed ?? -1));
            return `Seed: ${payload?.seed}`;

        case 'set_batch':
        case 'set_batch_size':
            params.setField('batch', Number(payload?.batch || payload?.batch_size || 1));
            return `Batch: ${payload?.batch || payload?.batch_size}`;

        case 'set_sampler':
            params.setField('samplerType', String(payload?.sampler || 'pingpong'));
            return `Sampler: ${payload?.sampler}`;

        case 'set_shift_mode':
            params.setField('shiftMode', String(payload?.mode || payload?.shift_mode || 'LogSNR'));
            return `Shift mode: ${payload?.mode || payload?.shift_mode}`;

        case 'set_init_noise':
            params.setField('initNoise', Number(payload?.noise || payload?.init_noise || 0.7));
            return `Init noise: ${payload?.noise || payload?.init_noise}`;

        case 'append_prompt': {
            const text = String(payload?.text || payload?.prompt || '');
            const separator = params.prompt.trim() ? ', ' : '';
            params.setField('prompt', `${params.prompt}${separator}${text}`);
            return 'Prompt appended';
        }

        case 'improve_prompt': {
            const prompt = String(payload?.prompt || payload?.improved_prompt || '');
            if (prompt) params.setField('prompt', prompt);
            const negative = payload?.negative_prompt || payload?.negativePrompt;
            if (negative !== undefined) params.setField('negativePrompt', String(negative));
            return 'Prompt improved';
        }

        case 'set_params': {
            const updates = buildParamUpdates(payload);
            params.patch(updates);
            return `Updated ${Object.keys(updates).length} parameters`;
        }

        // --- Generation Control ---
        case 'generate':
        case 'start_generation': {
            const p = useGenerateParamsStore.getState();
            gen.submitGeneration(buildGenerateParamsFromState(p));
            return 'Generation started';
        }

        case 'abort':
        case 'abort_generation':
        case 'stop_generation':
            gen.cancelGeneration();
            return 'Generation aborted';

        // --- EDIT arrangement (editor_* vocabulary) ---
        case 'editor_get_state': {
            // Same summarizer as the app context's editorState block, so the
            // action can never disagree with what the model was already shown.
            return JSON.stringify(summarizeEditor(useEditorStore.getState()));
        }

        case 'editor_add_track': {
            const name = payload?.name !== undefined ? String(payload.name) : undefined;
            const id = useEditorStore.getState().addTrack(name ? { name } : undefined);
            return `Added track "${name ?? 'Track'}" (id ${id})`;
        }

        case 'editor_remove_track': {
            const track = findEditorTrack(payload);
            if (!track) return fail(editorTrackMiss(payload));
            useEditorStore.getState().removeTrack(track.id);
            return `Removed track "${track.name}" and its clips`;
        }

        // `editor_set_track` used to live here. It moved into EDITOR_TOOLS when
        // T13 extended it with armed / instrument_program / frozen: this version
        // wrote `solo` as a plain field (solo is exclusive in the store, so two
        // tracks could both hold it) and dropped a rename addressed by track
        // name. The facade does both correctly — and reports a refusal through
        // its own ToolResult, so the honest ok:false is kept on that path too.

        case 'editor_move_clip': {
            const clip = findEditorClip(payload);
            if (!clip) return fail(editorClipMiss(payload));
            const updates: Record<string, unknown> = {};
            if (payload?.start_sec !== undefined) updates.startSec = Math.max(0, Number(payload.start_sec));
            if (payload?.track_id !== undefined) {
                const target = findEditorTrack({ track_id: payload.track_id });
                if (!target) return fail(editorTrackMiss({ track_id: payload.track_id }));
                updates.trackId = target.id;
            }
            if (!Object.keys(updates).length) return fail('editor_move_clip: pass start_sec and/or track_id');
            useEditorStore.getState().updateClip(clip.id, updates);
            return `Moved clip "${clip.label}"${updates.startSec !== undefined ? ` to ${updates.startSec}s` : ''}`;
        }

        case 'editor_remove_clip': {
            const clip = findEditorClip(payload);
            if (!clip) return fail(editorClipMiss(payload));
            useEditorStore.getState().removeClip(clip.id);
            return `Removed clip "${clip.label}"`;
        }

        case 'editor_split_clip': {
            const clip = findEditorClip(payload);
            if (!clip) return fail(editorClipMiss(payload));
            const at = Number(payload?.at_sec);
            if (!Number.isFinite(at)) return fail('editor_split_clip: pass at_sec (timeline seconds)');
            if (at <= clip.startSec || at >= clip.startSec + clip.durationSec) {
                return fail(`editor_split_clip: ${at}s is outside "${clip.label}" (${clip.startSec}–${clip.startSec + clip.durationSec}s)`);
            }
            useEditorStore.getState().splitClipAt(clip.id, at);
            return `Split clip "${clip.label}" at ${at}s`;
        }

        case 'editor_select_clip': {
            const clip = findEditorClip(payload);
            if (!clip) return fail(editorClipMiss(payload));
            useEditorStore.getState().setSelected(clip.id);
            return `Selected clip "${clip.label}"`;
        }

        case 'editor_set_playhead': {
            const sec = Number(payload?.seconds ?? payload?.sec);
            if (!Number.isFinite(sec) || sec < 0) return fail('editor_set_playhead: pass seconds >= 0');
            useEditorStore.getState().setPlayhead(sec);
            return `Playhead at ${sec}s`;
        }

        case 'editor_set_bpm': {
            const bpm = Number(payload?.bpm);
            // The app's tempo range (lib/tempoMap): EDIT's setBpm holds 20-300, so a 350 said "BPM set to 350" and set 300.
            if (!Number.isFinite(bpm) || bpm < TEMPO_BPM_MIN || bpm > TEMPO_BPM_MAX) {
                return fail(`editor_set_bpm: pass bpm in ${TEMPO_BPM_MIN}..${TEMPO_BPM_MAX}`);
            }
            useEditorStore.getState().setBpm(bpm);
            return `BPM set to ${bpm}`;
        }

        case 'editor_set_loop': {
            const ed = useEditorStore.getState();
            const enabled = booleanValue(payload, ['enabled'], true);
            ed.setLoopEnabled(enabled);
            const start = Number(payload?.start_sec);
            const end = Number(payload?.end_sec);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                ed.setLoopRegion(start, end);
                return `Loop ${enabled ? 'on' : 'off'} (${start}s–${end}s)`;
            }
            return `Loop ${enabled ? 'enabled' : 'disabled'}`;
        }

        case 'editor_add_marker': {
            const sec = Number(payload?.seconds ?? payload?.sec);
            if (!Number.isFinite(sec) || sec < 0) return fail('editor_add_marker: pass seconds >= 0');
            const name = payload?.name !== undefined ? String(payload.name) : undefined;
            useEditorStore.getState().addMarker(sec, name);
            return `Marker${name ? ` "${name}"` : ''} added at ${sec}s`;
        }

        // --- Status ---
        // ---- DJ performance control (mid-show assistant steering) ----
        case 'dj_get_state': {
            const sl = useSetlistStore.getState();
            const active = sl.activeId ? sl.setlists[sl.activeId] : null;
            const now = useDjAutomix.getState().nowPlayingEntryId;
            return JSON.stringify({
                activeSet: active ? active.name : null,
                nowPlaying: active?.entries.find((e) => e.entryId === now)?.label ?? null,
                order: active ? active.entries.map((e) => e.label) : [],
                sets: Object.values(sl.setlists).map((s) => s.name),
            });
        }

        case 'dj_load_set': {
            const name = stringValue(action.payload, ['name', 'set']).trim();
            if (!name) return fail('No set name provided. Pass a set name to switch to it.');
            const sl = useSetlistStore.getState();
            const match = Object.values(sl.setlists).find(
                (s) => s.name.toLowerCase() === name.toLowerCase(),
            ) ?? Object.values(sl.setlists).find(
                (s) => s.name.toLowerCase().includes(name.toLowerCase()),
            );
            if (!match) return fail(`No setlist named "${name}". Known sets: ${Object.values(sl.setlists).map((s) => s.name).join(', ') || 'none'}`);
            sl.setActive(match.id);
            useAppUiStore.getState().setCenterTab('dj');
            const loaded = `Active set is now "${match.name}" (${match.entries.length} tracks).`;
            // Loading a set is opening it. A bundled set nobody has opened
            // lists its tracks with no library ids, and nothing registered
            // them on this path, so the next dj_automix found nothing to
            // sequence. Register now, as a click on its row does. The set is
            // active either way, so a failed register is still a change made.
            if (!isBundledSetId(match.id) || !match.entries.some(isPendingBundledRow)) {
                return `${loaded} Say dj_automix on to run it.`;
            }
            return sl.registerBundled(match.id).then((registered) =>
                registered === null
                    ? `${loaded} Its tracks could not be registered (see the log); dj_automix on will try again.`
                    : `${loaded} Say dj_automix on to run it.`,
            );
        }

        case 'dj_automix': {
            const on = booleanValue(action.payload, ['on', 'enabled'], true);
            if (on) {
                // The active set has to be something automix can sequence
                // BEFORE the request goes out: a bundled set registers here.
                // This used to answer "requested" and leave the DJ tab to stop
                // at once on an unregistered set, which the model never heard
                // about. `continue`: a deck that is playing keeps playing.
                return readyActiveSetForAutomix().then((ready) => {
                    // A register that ran wrote library entries and patched
                    // the set's ids, so the app DID change even though automix
                    // did not start; fail() would tell the model otherwise.
                    // dj_load_set answers the same case the same way.
                    if (!ready.ok && ready.registered) {
                        return `Registered the tracks of "${ready.name}", but automix did not start: ${ready.message}`;
                    }
                    if (!ready.ok) return fail(`Automix not started: ${ready.message}`);
                    useAppUiStore.getState().setCenterTab('dj');
                    useDjAutomix.getState().requestStart('continue');
                    return `Automix start requested — the DJ tab will run "${ready.name}" (${ready.playable} playable tracks).`;
                });
            }
            useDjAutomix.getState().requestStop();
            return 'Automix stop requested.';
        }

        case 'dj_transition_now': {
            useDjAutomix.getState().requestTransition();
            return 'Forcing the blend into the next track at the next automix tick.';
        }

        case 'dj_set_next': {
            const label = stringValue(action.payload, ['label', 'track', 'title']).trim();
            if (!label) return fail('No track label provided. Pass a title or track label to queue next.');
            const sl = useSetlistStore.getState();
            const active = sl.activeId ? sl.setlists[sl.activeId] : null;
            if (!active) return fail('No active setlist.');
            const idx = active.entries.findIndex(
                (e) => e.label.toLowerCase().includes(label.toLowerCase()),
            );
            if (idx < 0) return fail(`No track matching "${label}" in "${active.name}".`);
            const now = useDjAutomix.getState().nowPlayingEntryId;
            const nowIdx = now ? active.entries.findIndex((e) => e.entryId === now) : -1;
            if (idx === nowIdx) return fail(`"${active.entries[idx].label}" is already playing.`);
            const entries = [...active.entries];
            const [moved] = entries.splice(idx, 1);
            // After the currently-playing track; to the front when nothing plays.
            const target = nowIdx >= 0 ? (idx < nowIdx ? nowIdx : nowIdx + 1) : 0;
            entries.splice(target, 0, moved);
            sl.setEntries(active.id, entries);
            return `"${moved.label}" plays next in "${active.name}".`;
        }

        case 'get_status':
        case 'status': {
            const g = useGenerateStore.getState();
            const gp = useGenerateParamsStore.getState();
            return JSON.stringify({
                generating: g.isGenerating,
                jobStatus: g.jobStatus,
                model: gp.model,
                prompt: gp.prompt.slice(0, 100),
                duration: gp.duration,
                steps: gp.steps,
                cfg: gp.cfg,
                seed: gp.seed,
                shiftMode: gp.shiftMode,
                sampler: gp.samplerType,
            });
        }

        default: {
            // The editor tool table is consulted last so a name that already has
            // a `case` above keeps it — the two sets are disjoint, and letting
            // the switch win means adding a table entry can never silently
            // change the behaviour of a tool that already shipped.
            // Then the composer and score tools (orb-kit/composerTools), which
            // answer the same way: a sentence, or the reason nothing changed.
            const run = EDITOR_TOOLS[type] ?? composerTool(type);
            if (!run) return fail(`Unknown action: ${type}`);
            return runEditorTool(type, run, payload ?? {});
        }
    }
}

const settle = (outcome: ActionOutcome): AssistantActionResult =>
    typeof outcome === 'string' ? { ok: true, message: outcome } : { ok: false, message: outcome.message };

/**
 * Run one assistant action and say truthfully what happened.
 *
 * Callers MUST surface `message`: it is the only place a miss ("No clip
 * \"kick\"...") is reported, and every caller used to throw it away and print
 * its own "Executed action: X" instead. `ok:false` means the app is UNCHANGED,
 * which is the one thing the message alone cannot be relied on to convey.
 *
 * Answers synchronously for everything in the switch but the DJ actions that
 * register a bundled set with the backend; those and the editor tool table
 * (audio re-renders, backend DSP) hand back a promise.
 */
export function handletheDAWActionResult(
    action: AssistantActionPayload,
): AssistantActionResult | Promise<AssistantActionResult> {
    const branch = runtheDAWAction(action);
    return branch instanceof Promise ? branch.then(settle) : settle(branch);
}

/**
 * The same dispatch, as the one string the model reads.
 *
 * This is what the panel, the host bridge and the MCP relay call: a tool result
 * is a sentence, and a refusal is the sentence that says why. Use
 * {@link handletheDAWActionResult} when the caller has to branch on whether the
 * app actually changed.
 */
export function handletheDAWAction(action: AssistantActionPayload): string | Promise<string> {
    const result = handletheDAWActionResult(action);
    return result instanceof Promise ? result.then((r) => r.message) : result.message;
}

/** The message alone, for callers that only log it (orb-kit/chat/useOrbChat). */
export function handletheDAWActionMessage(action: AssistantActionPayload): string | Promise<string> {
    return handletheDAWAction(action);
}
