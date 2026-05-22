import { useGenerateParamsStore } from '../state/generateParamsStore';
import { buildGenerateParamsFromState, useGenerateStore } from '../state/generateStore';
import type { GenerateParamsState } from '../state/generateParamsStore';
import { logInfo } from '../state/logStore';

export interface AssistantActionPayload {
    type: string;
    payload?: Record<string, unknown>;
}

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
    if ('fileNaming' in payload || 'file_naming' in payload) updates.fileNaming = stringValue(payload, ['fileNaming', 'file_naming'], 'verbose');
    if ('cutToDuration' in payload || 'cut_to_duration' in payload) updates.cutToDuration = booleanValue(payload, ['cutToDuration', 'cut_to_duration'], true);
    if ('autoplay' in payload) updates.autoplay = booleanValue(payload, ['autoplay'], true);
    if ('autoDownload' in payload || 'auto_download' in payload) updates.autoDownload = booleanValue(payload, ['autoDownload', 'auto_download'], false);

    return updates;
}

export function handleStableDAWAction(action: AssistantActionPayload): string {
    const { type, payload } = action;
    const params = useGenerateParamsStore.getState();
    const gen = useGenerateStore.getState();

    logInfo('assistant', `Action: ${type}`);

    switch (type) {
        // --- Navigation ---
        case 'navigate':
        case 'navigate_to': {
            const tab = String(payload?.tab || payload?.view || 'create');
            window.dispatchEvent(new CustomEvent('stabledaw:navigate', { detail: { tab } }));
            return `Navigated to ${tab}`;
        }

        case 'open_docs':
            window.dispatchEvent(new CustomEvent('stabledaw:open-docs'));
            return 'Opened docs';

        case 'close_docs':
            window.dispatchEvent(new CustomEvent('stabledaw:close-docs'));
            return 'Closed docs';

        case 'open_left_panel':
            window.dispatchEvent(new CustomEvent('stabledaw:set-left-panel', { detail: { open: true } }));
            return 'Opened left panel';

        case 'close_left_panel':
            window.dispatchEvent(new CustomEvent('stabledaw:set-left-panel', { detail: { open: false } }));
            return 'Closed left panel';

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
            gen.cancelPolling();
            return 'Generation aborted';

        // --- Status ---
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

        default:
            return `Unknown action: ${type}`;
    }
}
