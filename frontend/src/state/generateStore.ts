import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';
import { logError, logInfo } from './logStore';
import { useLibraryStore } from './libraryStore';
import { usePlayerStore } from './playerStore';
import { useGenerateParamsStore, type GenerateParamsState } from './generateParamsStore';
import { getOrRenderChimera } from '../lib/chimeraClient';

export interface GenerateParams {
  prompt: string;
  negativePrompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  batch: number;
  initNoise: number;
  initType: string;
  initAudioEnabled?: boolean;
  initAudioFile?: File | null;
  inpaintAudioFile?: File | null;
  inpaintEnabled?: boolean;
  maskStart?: number;
  maskEnd?: number;

  samplerType?: string;
  sigmaMax?: number;
  durationPaddingSec?: number;

  apgScale?: number;
  cfgRescale?: number;
  cfgNormThreshold?: number;
  cfgIntervalMin?: number;
  cfgIntervalMax?: number;

  shiftMode?: string;
  logsnrAnchorLength?: number;
  logsnrAnchorLogsnr?: number;
  logsnrRate?: number;
  logsnrEnd?: number;
  fluxMinLen?: number;
  fluxMaxLen?: number;
  fluxAlphaMin?: number;
  fluxAlphaMax?: number;
  fullBaseShift?: number;
  fullMaxShift?: number;
  fullMinLen?: number;
  fullMaxLen?: number;

  inversionSteps?: number;
  inversionGamma?: number;
  inversionUnconditional?: boolean;

  fileFormat?: string;
  fileNaming?: string;
  outputName?: string;
  cutToDuration?: boolean;

  loras?: Array<{ file: File | null; weight: number }>;

  // Magenta RT2 (text→music) sampling params.
  magTemperature?: number;
  magTopK?: number;
  magCfgMusiccoca?: number;
  magCfgNotes?: number;
  magCfgDrums?: number;
  magDrums?: number;
  magChunkFrames?: number;
  magSeed?: number;
  magExtend?: boolean;
  magNotes?: number[];
}

type JobStatus = 'idle' | 'submitting' | 'queued' | 'running' | 'completed' | 'failed';

interface GenerateStoreState {
  isGenerating: boolean;
  jobStatus: JobStatus;
  statusLabel: string;
  progressPct: number;
  currentJobId: string | null;
  lastAudioUrl: string | null;
  lastAudioBlob: Blob | null;
  lastFilename: string | null;
  lastDurationSec: number | null;
  lastModelName: string | null;
  error: string | null;
  pollRunId: number;
  submitGeneration: (params: GenerateParams) => Promise<void>;
  cancelPolling: () => void;
  clearResult: () => void;
}

const POLL_INTERVAL_MS = 1000;

// ── Whole-run progress pacer ────────────────────────────────────────────────
// progressPct spans the ENTIRE run — weave render + submit + model load +
// sampling — not just sampler steps. It is time-paced from a vague upfront
// estimate (clip count, model size, requested duration) and re-anchored by
// real measurements as they arrive (weave finish time, then the real sampler
// fraction), so accuracy improves the further the run goes. Monotonic.
let _paceTimer: ReturnType<typeof setInterval> | null = null;
let _paceRunId = -1;
let _paceT0 = 0;
let _estPreSec = 12; // weave + submit + model-load estimate
let _estSamplingSec = 40;
let _pBase = 0; // displayed fraction at the moment real sampling anchored
let _samplingFrac = 0; // real sampler fraction 0..1
let _shownPct = 0; // monotonic guard
// sampler-step cadence, for interpolating BETWEEN step reports: an 8-step
// sampler otherwise advances in ~6% jumps with 15-25s freezes in between
let _sampLastT = 0; // performance.now() at the last step increase
let _sampStepInc = 0; // observed per-report fraction increment
let _sampStepDt = 6; // EMA of seconds between step increases
// the SHOWN fraction is a critically damped spring chasing the raw estimate:
// position AND velocity stay continuous, so a re-anchor or step report turns
// into a gradual speed-up of the count — never a jump of any size
let _dispFrac = 0;
let _dispVel = 0;
let _lastTickT = 0;

function _stopPacer(): void {
  if (_paceTimer != null) {
    clearInterval(_paceTimer);
    _paceTimer = null;
  }
}

// continuous whole-run fraction (float, computed at call time): pre-sampling
// creeps across the estimated weave/load share — with an asymptotic tail so an
// estimate overrun slows the creep instead of freezing it — then the REAL
// sampler fraction carries the rest from wherever the display anchored
function _runFraction(): number {
  const el = (performance.now() - _paceT0) / 1000;
  if (_samplingFrac <= 0) {
    const preW = _estPreSec / (_estPreSec + _estSamplingSec);
    const ignition = Math.min(el / 6, 1) * 0.1;
    const x = el / _estPreSec;
    const xe = x < 0.8 ? x : 0.97 - 0.17 * Math.exp(-(x - 0.8) / 0.9);
    return Math.max(preW * xe, ignition);
  }
  const base = _pBase > 0 ? _pBase : _dispFrac;
  // between step reports, creep asymptotically toward (never past) the next
  // step's value at the observed cadence — no freezes, no overshoot
  const sEl = _sampLastT > 0 ? (performance.now() - _sampLastT) / 1000 : 0;
  const creep = _sampStepInc * (1 - Math.exp(-sEl / Math.max(0.5, _sampStepDt)));
  const sf = Math.min(1, _samplingFrac + creep);
  return Math.min(0.995, base + sf * (1 - base));
}

/** The SAME whole-run fraction that paces the displayed progress %, for the
 *  CRISPR choreography — so what the DNA does and what the number says always
 *  agree. This is the spring-smoothed value, identical to the digits. */
export function getRunFraction(): number {
  return _dispFrac;
}

function _markWeaveDone(): void {
  // re-anchor the pre-sampling estimate: weave actually took this long, the
  // remainder is submit + model load
  const el = (performance.now() - _paceT0) / 1000;
  _estPreSec = el + 12;
}

function _reportSamplingFrac(frac: number): void {
  const f = Math.max(0, Math.min(1, frac));
  if (f <= _samplingFrac) return;
  const now = performance.now();
  if (_samplingFrac > 0 && _sampLastT > 0) {
    _sampStepDt = _sampStepDt * 0.5 + ((now - _sampLastT) / 1000) * 0.5;
  } else {
    // first report: seed the cadence from the upfront sampling estimate
    _sampStepDt = Math.max(0.5, _estSamplingSec * (f - _samplingFrac));
  }
  _sampStepInc = f - _samplingFrac;
  _samplingFrac = f;
  _sampLastT = now;
}

function _startPacer(
  runId: number,
  estPreSec: number,
  estSamplingSec: number,
  set: (p: Partial<GenerateStoreState>) => void,
  get: () => GenerateStoreState,
): void {
  _stopPacer();
  _paceRunId = runId;
  _paceT0 = performance.now();
  _estPreSec = Math.max(4, estPreSec);
  _estSamplingSec = Math.max(8, estSamplingSec);
  _pBase = 0;
  _samplingFrac = 0;
  _shownPct = 0;
  _sampLastT = 0;
  _sampStepInc = 0;
  _sampStepDt = 6;
  _dispFrac = 0;
  _dispVel = 0;
  _lastTickT = 0;
  _paceTimer = setInterval(() => {
    const st = get();
    if (st.pollRunId !== _paceRunId || !st.isGenerating) {
      _stopPacer();
      return;
    }
    // anchor continuity: the moment real sampling progress first appears, the
    // remaining range hands over to the sampler fraction from right here
    if (_samplingFrac > 0 && _pBase <= 0) _pBase = _dispFrac;
    const now = performance.now();
    const dt = _lastTickT > 0 ? Math.min(1, (now - _lastTickT) / 1000) : 0.25;
    _lastTickT = now;
    // critically damped spring toward the raw estimate: position AND velocity
    // stay continuous, so estimate corrections change the counting SPEED,
    // never the value. The count never reverses, never snaps.
    const target = Math.min(0.99, Math.max(_dispFrac, _runFraction()));
    const omega = 0.8;
    const ex = Math.exp(-omega * dt);
    const delta = _dispFrac - target;
    const temp = (_dispVel + omega * delta) * dt;
    let next = target + (delta + temp) * ex;
    _dispVel = Math.max(0, (_dispVel - omega * temp) * ex);
    // continuous-motion floor: there is NO pause, ever. When the estimate
    // stalls (weave overrun, model load, a slow sampler step) the fraction
    // keeps gliding forward at a rate proportional to the remaining headroom —
    // asymptotic toward 0.99, so it can never overshoot the bar nor reverse,
    // and the spring takes back over the moment real signal returns.
    const vFloor = Math.max(0.008 * (0.99 - _dispFrac), 0.002);
    if (next < _dispFrac + vFloor * dt) {
      next = _dispFrac + vFloor * dt;
      _dispVel = Math.max(_dispVel, vFloor);
    }
    _dispFrac = Math.min(0.99, next);
    const pct = Math.max(_shownPct, Math.min(99, Math.round(_dispFrac * 100)));
    if (pct !== _shownPct || pct !== st.progressPct) {
      _shownPct = pct;
      set({ progressPct: pct });
    }
  }, 250);
}

const base64ToBlob = (audioBase64: string, mimeType: string): Blob => {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || 'audio/wav' });
};

const decodeAudioToBlobUrl = (audioBase64: string, mimeType: string): string => {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
  return URL.createObjectURL(blob);
};

const getErrorMessage = (payload: unknown, fallback: string): string => {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    const maybe = payload as { error?: unknown; detail?: unknown };
    if (typeof maybe.error === 'string') {
      return maybe.error;
    }
    if (typeof maybe.detail === 'string') {
      return maybe.detail;
    }
  }
  return fallback;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

/** Build the form for the Magenta RT2 sidecar (/api/magenta/generate): text prompt
 *  -> audio. The model takes a prompt + duration + its own sampling knobs (no SA3
 *  fields). An enabled Init clip is forwarded as the audio-style ("clone") source,
 *  which the sidecar embeds in place of the text style. */
export const buildMagentaFormData = (params: GenerateParams, prompt: string): FormData => {
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('duration', String(params.duration));
  formData.append('model_size', params.model.replace('magenta-', '') || 'small');
  if (params.magTemperature !== undefined) formData.append('temperature', String(params.magTemperature));
  if (params.magTopK !== undefined) formData.append('top_k', String(Math.round(params.magTopK)));
  if (params.magCfgMusiccoca !== undefined) formData.append('cfg_musiccoca', String(params.magCfgMusiccoca));
  if (params.magCfgNotes !== undefined) formData.append('cfg_notes', String(params.magCfgNotes));
  if (params.magCfgDrums !== undefined) formData.append('cfg_drums', String(params.magCfgDrums));
  if (params.magDrums !== undefined) formData.append('drums', String(Math.round(params.magDrums)));
  if (params.magChunkFrames !== undefined) formData.append('chunk_frames', String(Math.round(params.magChunkFrames)));
  // Seed: -1 means "fresh each run" → omit so the sidecar randomises.
  if (params.magSeed !== undefined && params.magSeed >= 0) formData.append('seed', String(Math.round(params.magSeed)));
  if (params.magExtend) formData.append('extend', 'true');
  // Notes → full-duration melody events the sidecar encodes into 128-pitch states.
  if (params.magNotes && params.magNotes.length) {
    const events = params.magNotes.map((pitch) => ({ pitch, start: 0, end: params.duration }));
    formData.append('notes', JSON.stringify(events));
  }
  if ((params.initAudioEnabled ?? false) && params.initAudioFile) {
    formData.append('audio_file', params.initAudioFile);
  }
  return formData;
};

export const buildGenerateJobFormData = (params: GenerateParams, prompt: string): FormData => {
  const formData = new FormData();
  formData.append('model_name', params.model);
  formData.append('prompt', prompt);
  formData.append('negative_prompt', params.negativePrompt || '');
  formData.append('duration', String(params.duration));
  formData.append('steps', String(params.steps));
  formData.append('cfg_scale', String(params.cfg));
  formData.append('seed', String(params.seed));
  formData.append('batch_size', String(Math.max(1, params.batch)));
  formData.append('init_noise_level', String(params.initNoise));
  formData.append('init_audio_type', params.initType);
  formData.append('file_format', params.fileFormat || 'wav');
  formData.append('file_naming', params.fileNaming || 'verbose');
  formData.append('custom_name', params.outputName || '');

  if (params.samplerType) formData.append('sampler_type', params.samplerType);
  if (params.sigmaMax !== undefined) formData.append('sigma_max', String(params.sigmaMax));
  if (params.durationPaddingSec !== undefined) formData.append('duration_padding_sec', String(params.durationPaddingSec));

  if (params.apgScale !== undefined) formData.append('apg_scale', String(params.apgScale));
  if (params.cfgRescale !== undefined) formData.append('cfg_rescale', String(params.cfgRescale));
  if (params.cfgNormThreshold !== undefined) formData.append('cfg_norm_threshold', String(params.cfgNormThreshold));
  if (params.cfgIntervalMin !== undefined) formData.append('cfg_interval_min', String(params.cfgIntervalMin));
  if (params.cfgIntervalMax !== undefined) formData.append('cfg_interval_max', String(params.cfgIntervalMax));

  if (params.shiftMode) formData.append('dist_shift_type', params.shiftMode);
  if (params.logsnrAnchorLength !== undefined) formData.append('logsnr_anchor_length', String(params.logsnrAnchorLength));
  if (params.logsnrAnchorLogsnr !== undefined) formData.append('logsnr_anchor_logsnr', String(params.logsnrAnchorLogsnr));
  if (params.logsnrRate !== undefined) formData.append('logsnr_rate', String(params.logsnrRate));
  if (params.logsnrEnd !== undefined) formData.append('logsnr_end', String(params.logsnrEnd));
  if (params.fluxMinLen !== undefined) formData.append('flux_min_len', String(params.fluxMinLen));
  if (params.fluxMaxLen !== undefined) formData.append('flux_max_len', String(params.fluxMaxLen));
  if (params.fluxAlphaMin !== undefined) formData.append('flux_alpha_min', String(params.fluxAlphaMin));
  if (params.fluxAlphaMax !== undefined) formData.append('flux_alpha_max', String(params.fluxAlphaMax));
  if (params.fullBaseShift !== undefined) formData.append('full_base_shift', String(params.fullBaseShift));
  if (params.fullMaxShift !== undefined) formData.append('full_max_shift', String(params.fullMaxShift));
  if (params.fullMinLen !== undefined) formData.append('full_min_len', String(params.fullMinLen));
  if (params.fullMaxLen !== undefined) formData.append('full_max_len', String(params.fullMaxLen));

  if (params.inversionSteps !== undefined) formData.append('inversion_steps', String(params.inversionSteps));
  if (params.inversionGamma !== undefined) formData.append('inversion_gamma', String(params.inversionGamma));
  if (params.inversionUnconditional !== undefined) formData.append('inversion_unconditional', String(params.inversionUnconditional));

  if (params.cutToDuration !== undefined) formData.append('cut_to_duration', String(params.cutToDuration));

  if (params.loras) {
    params.loras.forEach((lora, i) => {
      if (lora.file) {
        formData.append(`lora_file_${i}`, lora.file);
        formData.append(`lora_weight_${i}`, String(lora.weight));
      }
    });
  }

  if ((params.initAudioEnabled ?? true) && params.initAudioFile) {
    formData.append('init_audio', params.initAudioFile);
  }
  if (params.inpaintEnabled && params.inpaintAudioFile) {
    formData.append('inpaint_audio', params.inpaintAudioFile);
    formData.append('mask_start', String(params.maskStart ?? 0));
    formData.append('mask_end', String(params.maskEnd ?? 0));
  }

  return formData;
};

export const buildGenerateParamsFromState = (params: GenerateParamsState): GenerateParams => ({
  prompt: params.prompt,
  negativePrompt: params.negativePrompt,
  model: params.model,
  duration: params.duration,
  steps: params.steps,
  cfg: params.cfg,
  seed: params.seed,
  batch: params.batch,
  initNoise: params.initNoise,
  initType: params.initType,
  initAudioEnabled: params.initAudioEnabled,
  initAudioFile: params.initAudioFile,
  inpaintAudioFile: params.inpaintAudioFile,
  inpaintEnabled: params.inpaintEnabled,
  maskStart: params.maskStart,
  maskEnd: params.maskEnd,
  samplerType: params.samplerType,
  sigmaMax: params.sigmaMax,
  durationPaddingSec: params.durationPaddingSec,
  apgScale: params.apgScale,
  cfgRescale: params.cfgRescale,
  cfgNormThreshold: params.cfgNormThreshold,
  cfgIntervalMin: params.cfgIntervalMin,
  cfgIntervalMax: params.cfgIntervalMax,
  shiftMode: params.shiftMode,
  logsnrAnchorLength: params.logsnrAnchorLength,
  logsnrAnchorLogsnr: params.logsnrAnchorLogsnr,
  logsnrRate: params.logsnrRate,
  logsnrEnd: params.logsnrEnd,
  fluxMinLen: params.fluxMinLen,
  fluxMaxLen: params.fluxMaxLen,
  fluxAlphaMin: params.fluxAlphaMin,
  fluxAlphaMax: params.fluxAlphaMax,
  fullBaseShift: params.fullBaseShift,
  fullMaxShift: params.fullMaxShift,
  fullMinLen: params.fullMinLen,
  fullMaxLen: params.fullMaxLen,
  inversionSteps: params.inversionSteps,
  inversionGamma: params.inversionGamma,
  inversionUnconditional: params.inversionUnconditional,
  fileFormat: params.fileFormat,
  fileNaming: params.fileNaming,
  outputName: params.outputName,
  cutToDuration: params.cutToDuration,
  loras: params.loras.map((lora) => ({ file: lora.file, weight: lora.weight })),
  magTemperature: params.magTemperature,
  magTopK: params.magTopK,
  magCfgMusiccoca: params.magCfgMusiccoca,
  magCfgNotes: params.magCfgNotes,
  magCfgDrums: params.magCfgDrums,
  magDrums: params.magDrums,
  magChunkFrames: params.magChunkFrames,
  magSeed: params.magSeed,
  magExtend: params.magExtend,
  magNotes: params.magNotes,
});

export const useGenerateStore = create<GenerateStoreState>()((set, get) => ({
  isGenerating: false,
  jobStatus: 'idle',
  statusLabel: 'READY',
  progressPct: 0,
  currentJobId: null,
  lastAudioUrl: null,
  lastAudioBlob: null,
  lastFilename: null,
  lastDurationSec: null,
  lastModelName: null,
  error: null,
  pollRunId: 0,

  submitGeneration: async (params) => {
    const prompt = params.prompt.trim();
    if (!prompt) {
      set({ error: 'Prompt is required before generation can start.' });
      return;
    }

    const previousUrl = get().lastAudioUrl;
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }

    const nextRunId = get().pollRunId + 1;
    // Wall-clock anchor for elapsed-time logging across the whole generate flow.
    const t0 = performance.now();
    const elapsed = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`;

    set({
      isGenerating: true,
      jobStatus: 'submitting',
      statusLabel: 'SUBMITTING JOB...',
      progressPct: 0,
      currentJobId: null,
      error: null,
      lastAudioUrl: null,
      lastAudioBlob: null,
      lastFilename: null,
      pollRunId: nextRunId,
    });
    useStatusBarStore.getState().setText('GENERATION STARTED');
    logInfo('generate', `[${elapsed()}] CREATE pressed: model=${params.model} duration=${params.duration}s steps=${params.steps} seed=${params.seed} prompt="${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`);

    // whole-run progress pacing: vague estimate now, re-anchored by real
    // measurements (weave finish, then sampler fraction) as the run proceeds
    {
      const nClips = useGenerateParamsStore.getState().chimera.clips.length;
      const weaveEst = nClips >= 2 ? 8 + 5 * nClips : 0;
      const small = params.model.startsWith('small');
      const samplingEst = (small ? 0.15 : 0.45) * (params.duration ?? 30) + 12;
      _startPacer(nextRunId, weaveEst + 12, samplingEst, set, get);
    }

    let effectiveParams = params;
    let chimeraSourceLabels: string[] | undefined;
    const chimeraStack = useGenerateParamsStore.getState().chimera;
    if (chimeraStack.clips.length >= 2) {
      try {
        const chimeraT0 = performance.now();
        logInfo('generate', `[${elapsed()}] Chimera: starting mashup render (${chimeraStack.clips.length} clips, mode=${chimeraStack.alignMode}, target_bpm=${chimeraStack.targetBpm})`);
        useStatusBarStore.getState().setText(`CHIMERA: rendering ${chimeraStack.clips.length} clips...`);
        const { file, meta } = await getOrRenderChimera(chimeraStack);
        _markWeaveDone();
        chimeraSourceLabels = chimeraStack.clips.map((c) => c.label);
        const chimeraDt = ((performance.now() - chimeraT0) / 1000).toFixed(1);
        logInfo('generate', `[${elapsed()}] Chimera: mashup done in ${chimeraDt}s — ${meta.duration_sec.toFixed(1)}s @ ${meta.target_bpm_used.toFixed(1)} BPM, ${Math.round(file.size / 1024)}KB`);
        useGenerateParamsStore.getState().patch({
          initAudioFile: file,
          initAudioEnabled: true,
          initAudioSourceLabel: `Chimera · ${chimeraStack.clips.length} clips · @${meta.target_bpm_used.toFixed(1)} BPM (${meta.align_mode_used})`,
          initAudioSourceClipLabels: chimeraSourceLabels,
        });
        useGenerateParamsStore.getState().setChimeraField('lastMeta', meta);
        effectiveParams = { ...params, initAudioFile: file, initAudioEnabled: true };
        useStatusBarStore.getState().setText('CHIMERA READY — submitting job');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError('generate', `Chimera mashup failed; aborting generation: ${msg}`);
        useStatusBarStore.getState().setText(`CHIMERA FAILED: ${msg}`);
        set({
          isGenerating: false,
          jobStatus: 'idle',
          statusLabel: 'IDLE',
          error: `Chimera mashup failed: ${msg}`,
        });
        return;
      }
    }

    // Magenta RT2 routes to its own sidecar-backed module; SA3 uses the main job API.
    const isMagenta = effectiveParams.model.startsWith('magenta-');
    const genEndpoint = isMagenta ? '/api/magenta/generate' : '/api/generate-jobs';
    const jobsBase = isMagenta ? '/api/magenta/jobs' : '/api/jobs';
    const formData = isMagenta
      ? buildMagentaFormData(effectiveParams, prompt)
      : buildGenerateJobFormData(effectiveParams, prompt);

    try {
      logInfo('generate', `[${elapsed()}] POST ${genEndpoint} — model=${params.model} duration=${params.duration}s steps=${params.steps} seed=${params.seed}`);
      const response = await fetch(genEndpoint, {
        method: 'POST',
        body: formData,
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const detail = getErrorMessage(payload, `HTTP ${response.status} ${response.statusText}`);
        logError('generate', `POST /api/generate-jobs → ${response.status} ${response.statusText} — ${detail}`);
        throw new Error(detail);
      }

      const jobId = (payload as { job?: { id?: string } })?.job?.id;
      if (!jobId) {
        logError('generate', 'POST /api/generate-jobs → 200 OK but no job_id in response payload');
        throw new Error('Backend did not return a job id for /api/generate-jobs.');
      }

      logInfo('generate', `[${elapsed()}] POST /api/generate-jobs → 200 OK — job_id=${jobId.slice(0, 8)} (server received the job)`);
      set({
        currentJobId: jobId,
        jobStatus: 'queued',
        statusLabel: 'QUEUED...',
      });
      useStatusBarStore.getState().setText(`GENERATION QUEUED: ${jobId.slice(0, 8)}`);
      logInfo('generate', `[${elapsed()}] Job queued: ${jobId.slice(0, 8)} — waiting for backend to start sampling`);

      while (true) {
        const state = get();
        if (state.pollRunId !== nextRunId) {
          return;
        }

        const jobResponse = await fetch(`${jobsBase}/${jobId}`);
        let jobPayload: unknown = null;
        try {
          jobPayload = await jobResponse.json();
        } catch {
          jobPayload = null;
        }

        if (!jobResponse.ok) {
          if (jobResponse.status === 404) {
            logError('generate', `Job ${jobId.slice(0, 8)} not found on server (it may have restarted). Aborting.`);
            set({
              isGenerating: false,
              jobStatus: 'failed',
              statusLabel: 'SERVER RESET',
              error: 'Server restarted or lost job. Please try again.',
            });
            return;
          }
          const detail = getErrorMessage(jobPayload, `HTTP ${jobResponse.status} ${jobResponse.statusText}`);
          logError('generate', `GET /api/jobs/${jobId.slice(0, 8)} → ${jobResponse.status} ${jobResponse.statusText} — ${detail}`);
          throw new Error(`Job polling failed: ${detail}`);
        }

        const job = jobPayload as {
          status?: string;
          progress?: { step?: number; steps?: number };
          result?: {
            batch?: boolean;
            item?: { audio_base64?: string; mime_type?: string; filename?: string };
            items?: Array<{ audio_base64?: string; mime_type?: string; filename?: string }>;
          };
          error?: string;
        };

        const step = job.progress?.step ?? 0;
        const totalSteps = Math.max(1, job.progress?.steps ?? params.steps ?? 1);
        // feed the REAL sampler fraction into the whole-run pacer; the
        // displayed progressPct spans weave + load + sampling, not steps/100
        if (step > 0) _reportSamplingFrac(step / totalSteps);

        if (job.status === 'queued' || job.status === 'running') {
          const previousStatus = get().jobStatus;
          if (previousStatus !== job.status) {
            logInfo('generate', job.status === 'running'
              ? `[${elapsed()}] Job running: ${jobId.slice(0, 8)} — sampler started (${totalSteps} steps requested)`
              : `[${elapsed()}] Job still queued: ${jobId.slice(0, 8)}`);
          }
          set({
            jobStatus: job.status,
            isGenerating: true,
            statusLabel: job.status === 'queued' ? 'QUEUED...' : `SAMPLING ${get().progressPct}%`,
          });
          await wait(POLL_INTERVAL_MS);
          continue;
        }

        if (job.status === 'completed') {
          _stopPacer();
          const items = job.result?.batch ? job.result?.items ?? [] : job.result?.item ? [job.result.item] : [];
          const resultItem = items[0];
          if (!resultItem?.audio_base64) {
            throw new Error('Generation completed but no audio payload was returned.');
          }

          const resultMime = resultItem.mime_type || 'audio/wav';
          const resultBlob = base64ToBlob(resultItem.audio_base64, resultMime);
          const audioUrl = URL.createObjectURL(resultBlob);
          set({
            isGenerating: false,
            jobStatus: 'completed',
            statusLabel: 'COMPLETE',
            progressPct: 100,
            lastAudioUrl: audioUrl,
            lastAudioBlob: resultBlob,
            lastFilename: resultItem.filename || 'output.wav',
            lastDurationSec: params.duration,
            lastModelName: params.model,
            error: null,
          });
          useStatusBarStore.getState().setText('Decoded — registering library entries...');
          logInfo('generate', `[${elapsed()}] Sampler finished — ${resultItem.filename || 'output.wav'} (${params.duration}s, ${Math.round(resultBlob.size / 1024)}KB). Audio was written to disk server-side; pulling the entries.`);

          // The backend already wrote each item to disk via _save_generation_artifacts_sync.
          // Refresh the library to surface the new entries via /api/library/entries.
          const isChimeraRun = !!(chimeraSourceLabels && chimeraSourceLabels.length > 0);
          const library = useLibraryStore.getState();
          await library.refresh();

          // Backend doesn't know the user-facing Chimera source labels, so
          // PATCH them in after refresh. Entry ID format matches what the
          // backend writes: `<job_id>_<index:02d>`.
          if (isChimeraRun && chimeraSourceLabels) {
            const newEntries = useLibraryStore.getState().entries;
            for (let i = 0; i < items.length; i += 1) {
              if (!items[i]?.audio_base64) continue;
              const entryId = `${jobId}_${String(i).padStart(2, '0')}`;
              const exists = newEntries.find((e) => e.id === entryId);
              if (!exists) {
                logError('library', `Chimera-sources PATCH skipped: entry ${entryId} not found in refresh.`);
                continue;
              }
              await useLibraryStore.getState().updateEntry(entryId, {
                tags: Array.from(new Set([...(exists.tags ?? []), 'chimera'])),
                chimeraSources: chimeraSourceLabels,
              });
            }
          }

          // Load the first new entry into the player so playback works
          // immediately. The blob comes from the backend streaming URL.
          const after = useLibraryStore.getState().entries;
          const firstEntry = items[0]?.audio_base64
            ? after.find((e) => e.id === `${jobId}_00`) ?? after.find((e) => e.id === jobId)
            : null;
          if (firstEntry) {
            try {
              const loadT0 = performance.now();
              const blob = await useLibraryStore.getState().fetchAudioBlob(firstEntry);
              await usePlayerStore.getState().load(blob, {
                label: firstEntry.title,
                entryId: firstEntry.id,
              });
              logInfo('generate', `[${elapsed()}] Loaded into player bar (${Math.round(performance.now() - loadT0)}ms).`);
              // "Play" toggle on → route the output straight through the footer transport.
              if (useGenerateParamsStore.getState().autoplay) {
                usePlayerStore.getState().play();
                logInfo('generate', `[${elapsed()}] Auto-play (footer transport) started.`);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logError('generate', `Player load failed: ${msg}`);
            }
          } else {
            logError('generate', `Could not find freshly-saved entry for job ${jobId}; library may need a manual reload.`);
          }

          useStatusBarStore.getState().setText('GENERATION COMPLETE');
          logInfo('generate', `[${elapsed()}] Generation pipeline complete.`);
          return;
        }

        if (job.status === 'failed') {
          throw new Error(job.error || 'Generation job failed.');
        }

        throw new Error(`Unexpected job status: ${job.status ?? 'unknown'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Generation failed unexpectedly.';
      set({
        isGenerating: false,
        jobStatus: 'failed',
        statusLabel: 'FAILED',
        error: message,
      });
      useStatusBarStore.getState().setText(`GENERATION FAILED: ${message}`);
      logError('generate', message);
    }
  },

  cancelPolling: () => {
    const nextRunId = get().pollRunId + 1;
    set({
      pollRunId: nextRunId,
      isGenerating: false,
      jobStatus: 'idle',
      statusLabel: 'STOPPED',
      progressPct: 0,
      currentJobId: null,
    });
    useStatusBarStore.getState().setText('GENERATION STOPPED');
    logInfo('generate', 'Job aborted by user');
  },

  clearResult: () => {
    const currentUrl = get().lastAudioUrl;
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
    }
    set({
      lastAudioUrl: null,
      lastAudioBlob: null,
      lastFilename: null,
      lastDurationSec: null,
      lastModelName: null,
      error: null,
      statusLabel: 'READY',
      progressPct: 0,
    });
    useStatusBarStore.getState().setText('GENERATION OUTPUT CLEARED');
  },
}));

