import { magentaFetch } from '../lib/magentaEngineClient';
import { handleEngineElsewhere } from '../lib/magentaElsewhere';
import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';
import { logError, logInfo } from './logStore';
import { useLibraryStore } from './libraryStore';
import { usePlayerStore } from './playerStore';
import {
  useGenerateParamsStore,
  type ChimeraMashupMeta,
  type ChimeraState,
  type GenerateParamsState,
  type WavBitDepth,
} from './generateParamsStore';
import { getOrRenderChimera } from '../lib/chimeraClient';
import { fetchModelStatus, setLocalOnly, type ModelStatusResponse } from '../lib/storageClient';
import { classifyModelGate } from '../lib/modelDownloadClient';
import { requireFeature } from '../notices/featureGateStore';
import { CLOUD_MODELS, isCloudModel, isLyriaCheckedOut } from '../lib/cloudModels';
import { useSunoStore } from '../suno/sunoStore';

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
  /** Extra inpaint spans [[start_sec, end_sec], ...] in OUTPUT seconds of the
   *  inpaint audio (Chimera seam healing). Sent as `inpaint_regions`; the
   *  backend applies them only with inpaint_audio and mask_start == mask_end == 0. */
  inpaintRegions?: [number, number][];

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
  wavBitDepth?: WavBitDepth;
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
  /**
   * The job routes of the live run, set when it starts: `/api/jobs` for Stable
   * Audio, `/api/magenta/jobs` for Magenta. STOP posts `{base}/{id}/cancel`.
   */
  runJobsBase: JobsBase;
  lastAudioUrl: string | null;
  lastFilename: string | null;
  lastDurationSec: number | null;
  lastModelName: string | null;
  /** The seed the backend actually used for the last SUBMITTED job (T01
   *  contract: `seed` on the /api/generate-jobs response, resolved from a
   *  `-1` "fresh" request into a concrete 32-bit value before generating).
   *  Set as soon as the POST answers, not on completion, so "reuse seed" and
   *  the Seed row's readout are correct while the job is still rendering. */
  lastSeedUsed: number | null;
  error: string | null;
  pollRunId: number;
  submitGeneration: (params: GenerateParams) => Promise<void>;
  /**
   * STOP. Ends the live run in the app at once (the key returns to CREATE) and
   * cancels its backend job, Stable Audio or Magenta: the caption reads
   * CANCELLING... until the job reports cancelled, then CANCELLED. A job whose
   * id has not come back yet is cancelled the moment it does. Does nothing
   * when no run is live.
   */
  cancelGeneration: () => void;
  clearResult: () => void;
}

type JobsBase = '/api/jobs' | '/api/magenta/jobs';

const POLL_INTERVAL_MS = 1000;
/** How long STOP waits for a cancelled job to report it, before it gives up watching. */
const CANCEL_CONFIRM_MS = 120_000;

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

/** Stops the pacer only while it still paces run `runId`: a stale run never stops a newer run's count. */
function _stopPacerFor(runId: number): void {
  if (_paceRunId === runId) _stopPacer();
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
    // A structured refusal (the Magenta engine_elsewhere 409) carries its
    // sentence in `message`.
    const message = (maybe.detail as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message) {
      return message;
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
  formData.append('wav_bit_depth', params.wavBitDepth || '16');
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
    if (params.inpaintRegions?.length) {
      // Region list mode: the seconds path (mask_start/mask_end) overrides a
      // prebuilt mask in pipeline.generate, so it MUST be 0/0 here.
      formData.append('inpaint_regions', JSON.stringify(params.inpaintRegions));
      formData.append('mask_start', '0');
      formData.append('mask_end', '0');
    } else {
      formData.append('mask_start', String(params.maskStart ?? 0));
      formData.append('mask_end', String(params.maskEnd ?? 0));
    }
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
  inpaintRegions: params.inpaintRegions ?? [],
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
  wavBitDepth: params.wavBitDepth,
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

// ── Model-status pre-flight (non-blocking) ──────────────────────────────────
// GET /api/storage/model-status fans out to six provider probes (Stable Audio
// catalog, Magenta sidecar health, Suno, Lyria, Demucs, MIDI) and has been
// measured at 10-14 s on a warm backend. CREATE must never wait on it: the
// probe is started at the press, consulted only at the POST gate under a
// short cap, and its last answer is reused for a while.
const MODEL_STATUS_TTL_MS = 30_000;
const MODEL_STATUS_WAIT_MS = 3_000;
let _modelStatusCache: { at: number; status: ModelStatusResponse } | null = null;
let _modelStatusInflight: Promise<ModelStatusResponse | null> | null = null;

const probeModelStatus = (): Promise<ModelStatusResponse | null> => {
  if (_modelStatusCache && performance.now() - _modelStatusCache.at < MODEL_STATUS_TTL_MS) {
    return Promise.resolve(_modelStatusCache.status);
  }
  if (_modelStatusInflight) return _modelStatusInflight;
  _modelStatusInflight = fetchModelStatus()
    .then((status) => {
      _modelStatusCache = { at: performance.now(), status };
      return status;
    })
    .catch(() => null)
    .finally(() => {
      _modelStatusInflight = null;
    });
  return _modelStatusInflight;
};

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const t = window.setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { window.clearTimeout(t); resolve(v); },
      () => { window.clearTimeout(t); resolve(fallback); },
    );
  });

/** The no-model guard: a user-facing block message when nothing usable can
 *  generate the selected model, else null. A missing/unreachable probe never
 *  blocks — the submit path surfaces its own errors. */
const modelGateMessage = (status: ModelStatusResponse | null, model: string): string | null => {
  if (!status) return null;
  const stable = status.providers.find((p) => p.id === 'stable');
  const selected = stable?.models?.find((m) => m.id === model);
  const selectionBlocked =
    !model.startsWith('magenta-') && !CLOUD_MODELS.has(model) && !!selected
    && (selected.source === 'missing' || (selected.source === 'download' && status.local_only));
  if (status.usable_generation && !selectionBlocked) return null;
  return status.usable_generation
    ? `${model} is not on this machine and local-only blocks downloads. Pick an installed model in Settings → Models, or allow the one-time download there.`
    : 'No usable model is configured yet. Pick a local checkpoint, connect Suno, set up Magenta, or allow a one-time Stable Audio download — Settings → Models has all of it.';
};

/** INT-005: whether the Lyria sidecar is checked out, for the cloud panels'
 *  model switchers (cloudModels.panelModelOptions). Reuses probeModelStatus's
 *  cache/TTL so calling this from three different panels costs one fetch, and
 *  fails open on a missing/unreachable probe — same convention as
 *  modelGateMessage above, which never blocks generation on a probe outage. */
export const probeLyriaCheckedOut = async (): Promise<boolean> => {
  const status = await withTimeout(probeModelStatus(), MODEL_STATUS_WAIT_MS, null);
  const lyria = status?.providers.find((p) => p.id === 'lyria');
  return isLyriaCheckedOut(lyria?.state ?? null);
};

/** T01 contract: the /api/generate-jobs response carries the seed the backend
 *  actually resolved (a submitted `-1` becomes a concrete 32-bit value before
 *  generating). Reads either a top-level `seed` or `job.seed` since this
 *  ticket consumes that contract rather than defining it; returns null when
 *  absent (an older backend, or the Magenta path, which resolves no such
 *  field).
 *
 *  This is only the EARLY value: the POST reply's `seed` is the base seed
 *  the run started from, not necessarily the per-take seed a batch item
 *  actually rendered with. The completed job's `result.item.seed` /
 *  `result.items[i].seed` (finiteSeedOf, below) is authoritative and wins
 *  once the run finishes — see the `job.status === 'completed'` branch. */
export function extractResolvedSeed(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const top = finiteSeedOf((payload as { seed?: unknown }).seed);
  if (top !== null) return top;
  return finiteSeedOf((payload as { job?: { seed?: unknown } }).job?.seed);
}

/** A `seed` field off some job-response shape, as a finite number or null. */
function finiteSeedOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** DL: a plain client-side save-as for a finished generation, used when
 *  generateParamsStore.autoDownload is on. No extra dependency — an anchor
 *  with a `download` attribute and a revoked object URL. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const BROWSER_MULTI_DOWNLOAD_NOTICE_KEY = 'thedaw-auto-download-browser-notice-shown-v1';

/** Item 4 (T17 audit): the plain browser build has no main process to tell
 *  "these are automatic" — Chromium's own multi-download permission prompt is
 *  the only gate on a batch of takes there. Told once, ever (localStorage),
 *  and only when a batch is actually more than one file (a single download
 *  never trips that prompt). */
function showBrowserMultiDownloadNoticeOnce(count: number): void {
  if (count <= 1) return;
  try {
    if (window.localStorage?.getItem(BROWSER_MULTI_DOWNLOAD_NOTICE_KEY)) return;
    window.localStorage?.setItem(BROWSER_MULTI_DOWNLOAD_NOTICE_KEY, '1');
  } catch {
    /* localStorage unavailable (private mode, etc.) — show it anyway, this run only. */
  }
  const msg = `Auto-download is saving ${count} takes at once — this browser may ask to allow multiple downloads from this page.`;
  logInfo('generate', msg);
  useStatusBarStore.getState().setText(msg.toUpperCase(), { logged: true });
}

/** Item 4 (T17 audit): tells the desktop shell's main process these EXACT
 *  filenames are about to be automatic downloads (electron-ui's
 *  AutoDownloadClaims, matched by name with a short TTL — not a bare count,
 *  which could mis-claim an unrelated later user download or leak a slot
 *  forever), so watchDownloads saves a matching one straight into the
 *  Downloads folder instead of opening a native Save dialog. Call once,
 *  right before the click(s) it covers. A no-op outside Electron (no
 *  `window.electronAPI`) — the plain browser build gets its own one-time
 *  notice instead. */
async function markAutomaticDownloads(filenames: readonly string[]): Promise<void> {
  const api = (window as unknown as {
    electronAPI?: { markAutomaticDownloads?: (names: string[]) => Promise<void> };
  }).electronAPI;
  if (api?.markAutomaticDownloads) {
    await api.markAutomaticDownloads([...filenames]);
    return;
  }
  showBrowserMultiDownloadNoticeOnce(filenames.length);
}

// ── Chimera prompt derivation ───────────────────────────────────────────────
// A Chimera stack is a complete brief on its own: the clips carry BPM, key and
// (for library takes) the analysis module's semantic tags. When the textarea
// is empty, CREATE builds a prompt from that instead of refusing to start.
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const medianOf = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stripExt = (label: string): string => label.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_+/g, ' ').trim();
const keyPhrase = (note: string | null | undefined, scale: string | null | undefined): string | null =>
  note ? `${note} ${scale && /min/i.test(scale) ? 'minor' : 'major'}` : null;

export const deriveChimeraPrompt = async (chimera: ChimeraState): Promise<string> => {
  const clips = chimera.clips;
  const base = clips.find((c) => c.isBase) ?? null;
  const bpm = [
    chimera.lastMeta?.target_bpm_used,
    base?.detectedBpm,
    typeof chimera.targetBpm === 'number' ? chimera.targetBpm : null,
    medianOf(clips.map((c) => c.detectedBpm).filter(isPositive)),
  ].find(isPositive) ?? null;
  // the mashup's solved target key (every tonal clip is shifted to it) beats
  // any single clip's key; then the base clip, then the first keyed clip
  const keyed = base?.keyNote ? base : clips.find((c) => c.keyNote) ?? null;
  const keyNote = chimera.lastMeta?.target_key ?? keyed?.keyNote ?? null;
  const keyScale = chimera.lastMeta?.target_key
    ? chimera.lastMeta.target_scale ?? null
    : keyed?.keyScale ?? null;

  // Library takes: the analysis module's descriptors (mood / energy / timbre).
  const tags: string[] = [];
  await Promise.all(clips.filter((c) => c.entryId).map(async (c) => {
    try {
      const r = await fetch(`/api/analysis/${encodeURIComponent(c.entryId as string)}/prompt`);
      if (!r.ok) return;
      const body = await r.json() as { semantic_tags?: unknown };
      if (Array.isArray(body.semantic_tags)) {
        for (const t of body.semantic_tags) if (typeof t === 'string') tags.push(t);
      }
    } catch { /* optional enrichment */ }
  }));
  const seen = new Set<string>();
  const descriptors = tags
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && !/\bbpm\b/.test(t) && !/\b(major|minor)\b/.test(t) && !seen.has(t) && (seen.add(t), true))
    .slice(0, 8);

  const names = clips.slice(0, 4).map((c) => stripExt(c.label)).filter(Boolean);
  const more = clips.length > 4 ? ` and ${clips.length - 4} more` : '';
  const parts = [`Seamless, cohesive mashup blending ${names.join(', ')}${more}`];
  if (descriptors.length) parts.push(descriptors.join(', '));
  if (bpm) parts.push(`${Math.round(bpm)} BPM`);
  const kp = keyPhrase(keyNote, keyScale);
  if (kp) parts.push(`in ${kp}`);
  parts.push('one continuous arrangement with smooth musical transitions');
  return `${parts.join(', ')}.`;
};

// ── Chimera seam healing ────────────────────────────────────────────────────
// The v2 mashup response lists its seams with a heal window each (OUTPUT
// seconds of the mashup file). 'preserve' sends the mashup as init_audio AND
// as inpaint_audio with those windows as inpaint_regions, so one pass keeps
// the phrase bodies and composes only the joins. 'polish' runs a second job on
// the first result instead (see runHealPass). initNoise is never touched.

/** Seam heal windows from a mashup meta, as [start, end] OUTPUT seconds —
 *  finite, ordered, clamped to the mashup length. Empty when there are none. */
const seamHealRegions = (meta: ChimeraMashupMeta): [number, number][] => {
  const total = Number.isFinite(meta.duration_sec) && meta.duration_sec > 0 ? meta.duration_sec : Infinity;
  const out: [number, number][] = [];
  for (const s of meta.seams ?? []) {
    const a = Math.max(0, Number(s.heal_start_sec));
    const b = Math.min(total, Number(s.heal_end_sec));
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push([a, b]);
  }
  return out;
};

/** What the params store held before Chimera heal patched the inpaint fields,
 *  restored once the run ends — success, failure or abort — so a later plain
 *  CREATE never inherits a mashup as its inpaint source. */
let _healPrev: {
  inpaintAudioFile: File | null;
  inpaintEnabled: boolean;
  maskStart: number;
  maskEnd: number;
} | null = null;

const armHealParams = (file: File, regions: [number, number][]): void => {
  const st = useGenerateParamsStore.getState();
  if (!_healPrev) {
    _healPrev = {
      inpaintAudioFile: st.inpaintAudioFile,
      inpaintEnabled: st.inpaintEnabled,
      maskStart: st.maskStart,
      maskEnd: st.maskEnd,
    };
  }
  st.patch({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0, inpaintRegions: regions });
};

const clearHealParams = (): void => {
  const prev = _healPrev;
  _healPrev = null;
  const st = useGenerateParamsStore.getState();
  if (prev) {
    st.patch({ ...prev, inpaintRegions: [] });
  } else if ((st.inpaintRegions ?? []).length) {
    st.patch({ inpaintRegions: [] });
  }
};

interface JobResultItem { audio_base64?: string; mime_type?: string; filename?: string; seed?: number }
interface FirstResult { blob: Blob; filename: string }

/** HEAL = 'polish': a second /api/generate-jobs run on the first result —
 *  init_audio = inpaint_audio = the generated output, inpaint_regions = the
 *  same seam windows, init_noise 0.35, identical prompt/seed/steps/duration.
 *  The seams are recomposed in the re-textured domain with the generated audio
 *  as context. Returns null on any failure or an abort, in which case the first
 *  result stands. Isolated on purpose: nothing else depends on it. */
const runHealPass = async (
  firstResult: FirstResult,
  effectiveParams: GenerateParams,
  prompt: string,
): Promise<{ jobId: string; items: JobResultItem[] } | null> => {
  const store = useGenerateStore;
  const runId = store.getState().pollRunId;
  const alive = () => store.getState().pollRunId === runId;
  const regions = effectiveParams.inpaintRegions ?? [];
  if (!regions.length) return null;
  const t0 = performance.now();
  const elapsed = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`;
  const healFile = new File([firstResult.blob], firstResult.filename || 'chimera_pass1.wav', {
    type: firstResult.blob.type || 'audio/wav',
  });
  const healParams: GenerateParams = {
    ...effectiveParams,
    batch: 1,
    initNoise: 0.35,
    initAudioFile: healFile,
    initAudioEnabled: true,
    inpaintAudioFile: healFile,
    inpaintEnabled: true,
    maskStart: 0,
    maskEnd: 0,
    inpaintRegions: regions,
  };
  store.setState({ jobStatus: 'submitting', statusLabel: 'HEALING SEAMS...' });
  useStatusBarStore.getState().setText(`HEALING ${regions.length} SEAMS — second pass`);
  logInfo('generate', `Heal pass (polish): second job on the first result — ${regions.length} seam regions, init_noise=0.35, seed=${healParams.seed}`);
  {
    const small = healParams.model.startsWith('small');
    const samplingEst = (small ? 0.15 : 0.45) * (healParams.duration ?? 30) + 12;
    _startPacer(runId, 4, samplingEst, (p) => store.setState(p), () => store.getState());
  }
  try {
    const response = await fetch('/api/generate-jobs', { method: 'POST', body: buildGenerateJobFormData(healParams, prompt) });
    let payload: unknown = null;
    try { payload = await response.json(); } catch { payload = null; }
    const jobId = response.ok ? (payload as { job?: { id?: string } })?.job?.id : undefined;
    // STOP landed while the POST was in flight: cancel the heal job if one was
    // made, and leave the stopped run's state alone.
    if (!alive()) {
      if (jobId) void confirmCancel(jobId, store.getState().isGenerating ? -1 : store.getState().pollRunId, '/api/jobs');
      return null;
    }
    if (!response.ok) {
      handleEngineElsewhere(payload, 'Stable Audio cannot load beside it.');
      throw new Error(getErrorMessage(payload, `HTTP ${response.status} ${response.statusText}`));
    }
    if (!jobId) throw new Error('Backend did not return a job id for the heal pass.');
    store.setState({ currentJobId: jobId, jobStatus: 'queued', statusLabel: 'HEALING SEAMS...' });
    logInfo('generate', `[${elapsed()}] Heal pass queued: ${jobId.slice(0, 8)}`);

    while (alive()) {
      const jobResponse = await fetch(`/api/jobs/${jobId}`);
      let jobPayload: unknown = null;
      try { jobPayload = await jobResponse.json(); } catch { jobPayload = null; }
      // STOP landed while this poll was out; cancelGeneration already sent the
      // heal job's cancel, so nothing here may touch the stopped run.
      if (!alive()) return null;
      if (!jobResponse.ok) {
        throw new Error(getErrorMessage(jobPayload, `HTTP ${jobResponse.status} ${jobResponse.statusText}`));
      }
      const job = jobPayload as {
        status?: string;
        progress?: { step?: number; steps?: number };
        result?: { batch?: boolean; item?: JobResultItem; items?: JobResultItem[] };
        error?: string;
      };
      const step = job.progress?.step ?? 0;
      const totalSteps = Math.max(1, job.progress?.steps ?? healParams.steps ?? 1);
      if (step > 0) _reportSamplingFrac(step / totalSteps);
      if (job.status === 'queued' || job.status === 'running') {
        store.setState({ jobStatus: job.status, statusLabel: 'HEALING SEAMS...' });
        await wait(POLL_INTERVAL_MS);
        continue;
      }
      if (job.status === 'completed') {
        const items = job.result?.batch ? job.result?.items ?? [] : job.result?.item ? [job.result.item] : [];
        if (!items[0]?.audio_base64) throw new Error('Heal pass completed but returned no audio.');
        logInfo('generate', `[${elapsed()}] Heal pass finished: ${jobId.slice(0, 8)} — ${items[0].filename || 'output.wav'}`);
        return { jobId, items };
      }
      throw new Error(job.error || `Heal pass ended with status ${job.status ?? 'unknown'}.`);
    }
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!alive()) {
      logInfo('generate', `Heal pass request ended after STOP: ${msg}`);
      return null;
    }
    logError('generate', `Heal pass failed — keeping the first result: ${msg}`);
    useStatusBarStore.getState().setText('HEAL PASS FAILED — first result kept', { logged: true });
    return null;
  } finally {
    _stopPacerFor(runId);
  }
};

/**
 * STOP's backend half: ask the job to cancel, then watch it until it settles.
 * `jobsBase` is the run's job routes (Stable Audio or Magenta). `runId` is the
 * pollRunId STOP left behind; the caption is written only while no newer run
 * has started since (pass -1 when one already has). A Stable Audio job ends at
 * its next sampler step and a Magenta take at its next rendered chunk, so
 * CANCELLING... is on screen for about that long. Re-POSTing the cancel is how
 * it watches: the route is idempotent and answers with the summary, never the
 * audio payload.
 */
const confirmCancel = async (jobId: string, runId: number, jobsBase: JobsBase): Promise<void> => {
  const store = useGenerateStore;
  const short = jobId.slice(0, 8);
  const still = () => store.getState().pollRunId === runId && !store.getState().isGenerating;
  const settle = (statusLabel: string, bar: string) => {
    if (!still()) return;
    store.setState({ statusLabel });
    useStatusBarStore.getState().setText(bar);
  };
  settle('CANCELLING...', `CANCELLING JOB ${short}`);
  try {
    const started = Date.now();
    let job: { status?: string; saved_takes?: number } = {};
    for (;;) {
      const r = await fetch(`${jobsBase}/${jobId}/cancel`, { method: 'POST' });
      if (r.status === 404) {
        // The route's own 404 names the job; any other 404 is a backend that
        // predates the route, whose job is still running.
        const detail = ((await r.json().catch(() => null)) as { detail?: unknown } | null)?.detail;
        if (detail === 'Job not found') {
          logInfo('generate', `Job ${short} is no longer on the server (it restarted), so nothing is running.`);
          settle('STOPPED', 'GENERATION STOPPED');
          return;
        }
        throw new Error('the backend has no cancel route; restart the backend to get it');
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      job = (await r.json()) as { status?: string; saved_takes?: number };
      if (job.status !== 'queued' && job.status !== 'running') break;
      if (Date.now() - started > CANCEL_CONFIRM_MS) {
        logError('generate', `Job ${short} did not report cancelled within ${CANCEL_CONFIRM_MS / 1000}s and may still be running.`);
        settle('STOPPED', 'GENERATION STOPPED');
        return;
      }
      await wait(POLL_INTERVAL_MS);
    }
    if (job.status === 'cancelled') {
      const saved = job.saved_takes ?? 0;
      logInfo('generate', `Job ${short} cancelled on the server${saved > 0 ? `; ${saved} take(s) finished before the cancel and stay in the library` : ''}.`);
      if (saved > 0) void useLibraryStore.getState().refresh();
      settle('CANCELLED', 'GENERATION CANCELLED');
    } else if (job.status === 'completed') {
      logInfo('generate', `Job ${short} finished before the cancel reached it; its take is in the library.`);
      void useLibraryStore.getState().refresh();
      settle('STOPPED', 'GENERATION STOPPED: the take finished first and is in the library');
    } else {
      logInfo('generate', `Job ${short} ended as ${job.status ?? 'unknown'} before the cancel reached it.`);
      settle('STOPPED', 'GENERATION STOPPED');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('generate', `Cancel request for job ${short} failed (${msg}); the job may still be running.`);
    settle('STOPPED', 'GENERATION STOPPED: the cancel request failed');
  }
};

export const useGenerateStore = create<GenerateStoreState>()((set, get) => ({
  isGenerating: false,
  jobStatus: 'idle',
  statusLabel: 'READY',
  progressPct: 0,
  currentJobId: null,
  runJobsBase: '/api/jobs',
  lastAudioUrl: null,
  lastFilename: null,
  lastDurationSec: null,
  lastModelName: null,
  lastSeedUsed: null,
  error: null,
  pollRunId: 0,

  submitGeneration: async (params) => {
    // Re-entry claim — the FIRST check in the function, before even the cloud
    // branch below. Without it, a caller pressing again during the pre-flight
    // (desktop CREATE double-click, XR trigger bounce, or the assistant's
    // generate action) — including one that switched `model` to suno/lyria
    // mid-run — fell into the cloud branch first: it cleared statusLabel/error
    // on a LIVE local run's caption and, for Suno, fired a second
    // sunoStore.submit while the first was still in flight, since the cloud
    // branch never touches (and so never checked) generateStore.isGenerating.
    // Placed ahead of everything so no path — local or cloud — can start or
    // reset anything while a run is already live.
    if (get().isGenerating) {
      logInfo('generate', 'CREATE ignored: a run is already in progress (press again to abort it)');
      return;
    }

    // P0: Suno and Lyria are cloud providers with their own generate paths —
    // Suno's own form/submit in sunoStore, Lyria's own transport inside its
    // embedded iframe (LyriaPanel). Neither takes a Stable Audio job, so
    // routing them through the rest of this function used to POST straight to
    // /api/generate-jobs with model=suno|lyria, which the SA3 pipeline cannot
    // serve. This has to run before the prompt guard below: Lyria takes no
    // prompt at all, and Suno validates its own form fields in sunoStore.submit.
    if (isCloudModel(params.model)) {
      // A stale FAILED/PROMPT REQUIRED caption from a previous local run
      // (or a previous Suno failure) must not linger under this key just
      // because neither cloud branch below runs the code that normally
      // clears it before a submit.
      set({ error: null, statusLabel: 'READY' });
      if (params.model === 'suno') {
        logInfo('generate', 'CREATE pressed with Suno selected: routing to the Suno panel’s own Generate (sunoStore.submit), not /api/generate-jobs.');
        try {
          await useSunoStore.getState().submit();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logError('generate', `Suno submit failed: ${msg}`);
          set({ error: msg, statusLabel: 'FAILED' });
          useStatusBarStore.getState().setText(`SUNO GENERATE FAILED: ${msg}`, { logged: true });
        }
        return;
      }
      // lyria: fully embedded, unmodified sibling app (its own transport, its
      // own Generate) — there is no host-callable generate path to route to.
      const msg = 'Lyria generates from its own panel — use the controls inside the Lyria tab.';
      logInfo('generate', `CREATE pressed with Lyria selected: ${msg}`);
      useStatusBarStore.getState().setText(msg.toUpperCase());
      return;
    }

    const typedPrompt = params.prompt.trim();
    const chimeraStack = useGenerateParamsStore.getState().chimera;
    const chimeraArmed = chimeraStack.clips.length >= 2;

    // Prompt guard — VISIBLE. This used to `set({ error })` and return, but no
    // component renders that error, so an empty prompt turned CREATE into a
    // silent no-op ("the CREATE button does nothing"). A Chimera stack needs
    // no typed prompt (one is derived from the clips below); everything else
    // gets a LOG line, a caption under CREATE, and the prompt box focused.
    if (!typedPrompt && !chimeraArmed) {
      const msg = 'Prompt required — describe the sound (or stack 2+ clips in Chimera), then press CREATE.';
      logError('generate', msg);
      set({ error: msg, statusLabel: 'PROMPT REQUIRED', jobStatus: 'idle' });
      useStatusBarStore.getState().setText('PROMPT REQUIRED');
      window.dispatchEvent(new CustomEvent('thedaw:focus-prompt'));
      return;
    }

    // The re-entry claim itself already ran, first thing in this function
    // (above the cloud branch). What's still needed here, now that a fresh
    // submission is definitely proceeding: revoke the previous run's object
    // URL and bump pollRunId so the pollRunId checks after each pre-flight
    // await below can tell this submission apart from a stale one.
    const nextRunId = get().pollRunId + 1;
    const previousUrl = get().lastAudioUrl;
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }
    set({
      isGenerating: true,
      jobStatus: 'submitting',
      statusLabel: chimeraArmed ? 'RENDERING CHIMERA...' : 'SUBMITTING JOB...',
      progressPct: 0,
      currentJobId: null,
      runJobsBase: params.model.startsWith('magenta-') ? '/api/magenta/jobs' : '/api/jobs',
      error: null,
      lastAudioUrl: null,
      lastFilename: null,
      lastSeedUsed: null,
      pollRunId: nextRunId,
    });

    // Wall-clock anchor for elapsed-time logging across the whole generate flow.
    const t0 = performance.now();
    const elapsed = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`;
    useStatusBarStore.getState().setText('GENERATION STARTED');
    logInfo('generate', `[${elapsed()}] CREATE pressed: model=${params.model} duration=${params.duration}s steps=${params.steps} seed=${params.seed} prompt="${typedPrompt.slice(0, 60)}${typedPrompt.length > 60 ? '...' : ''}"${chimeraArmed ? ` chimera=${chimeraStack.clips.length} clips` : ''}`);

    // whole-run progress pacing: starts NOW, before any pre-flight await, so
    // the button never sits on a frozen 'ABORT 0%'; re-anchored by real
    // measurements (weave finish, then sampler fraction) as the run proceeds
    {
      const nClips = chimeraStack.clips.length;
      const weaveEst = nClips >= 2 ? 8 + 5 * nClips : 0;
      const small = params.model.startsWith('small');
      const samplingEst = (small ? 0.15 : 0.45) * (params.duration ?? 30) + 12;
      _startPacer(nextRunId, weaveEst + 12, samplingEst, set, get);
    }

    // No-model guard, NON-blocking: the model-status probe (10-14 s on a warm
    // backend) starts here, overlaps the Chimera render, and is consulted at
    // the POST gate under a short cap. Awaiting it up front was the other
    // half of the "CREATE does nothing" report: the button read 'ABORT 0%'
    // for the whole wait and a second press silently cancelled the run.
    const modelGate = probeModelStatus();

    // Chimera with an empty prompt box: a prompt is derived from the stack
    // right after the mashup renders (below), so its BPM and key describe the
    // mashup that is actually sent. The guard above means an empty prompt
    // here always has an armed stack.
    let prompt = typedPrompt;

    let effectiveParams = params;
    let chimeraSourceLabels: string[] | undefined;
    // Seam heal windows for HEAL = 'polish' (second pass on the result); for
    // 'preserve' they ride along in effectiveParams.inpaintRegions instead.
    let polishRegions: [number, number][] = [];
    if (chimeraArmed) {
      try {
        const chimeraT0 = performance.now();
        logInfo('generate', `[${elapsed()}] Chimera: starting mashup render (${chimeraStack.clips.length} clips, mode=${chimeraStack.alignMode}, target_bpm=${chimeraStack.targetBpm})`);
        useStatusBarStore.getState().setText(`CHIMERA: rendering ${chimeraStack.clips.length} clips...`);
        const { file, meta } = await getOrRenderChimera(chimeraStack);
        _markWeaveDone();
        chimeraSourceLabels = chimeraStack.clips.map((c) => c.label);
        const chimeraDt = ((performance.now() - chimeraT0) / 1000).toFixed(1);
        logInfo('generate', `[${elapsed()}] Chimera: mashup done in ${chimeraDt}s — ${meta.duration_sec.toFixed(1)}s @ ${meta.target_bpm_used.toFixed(1)} BPM, ${Math.round(file.size / 1024)}KB`);
        const keyLabel = keyPhrase(meta.target_key, meta.target_scale);
        const sourceLabel = [
          `Chimera · ${chimeraStack.clips.length} clips · @${meta.target_bpm_used.toFixed(1)} BPM (${meta.align_mode_used})`,
          keyLabel,
          meta.arc_used,
        ].filter(Boolean).join(' · ');
        useGenerateParamsStore.getState().patch({
          initAudioFile: file,
          initAudioEnabled: true,
          initAudioSourceLabel: sourceLabel,
          initAudioSourceClipLabels: chimeraSourceLabels,
        });
        useGenerateParamsStore.getState().setChimeraField('lastMeta', meta);
        effectiveParams = { ...params, initAudioFile: file, initAudioEnabled: true };

        // Empty prompt box: derive one from the stack + this mashup's meta and
        // write it back so the user sees (and can edit) exactly what was sent.
        if (!prompt) {
          prompt = await deriveChimeraPrompt({ ...chimeraStack, lastMeta: meta });
          if (get().pollRunId !== nextRunId) return;
          useGenerateParamsStore.getState().patch({ prompt });
          logInfo('generate', `[${elapsed()}] Prompt auto-derived from the Chimera stack: "${prompt.slice(0, 140)}${prompt.length > 140 ? '...' : ''}"`);
        }

        // 'use hint' pill: append '124 BPM, key of A minor' to the SENT prompt
        // (the textarea is left as the user wrote it).
        if ((chimeraStack.usePromptHint ?? false) && meta.prompt_hint) {
          prompt = prompt.trim() ? `${prompt}, ${meta.prompt_hint}` : meta.prompt_hint;
          logInfo('generate', `[${elapsed()}] Chimera: prompt hint appended — "${meta.prompt_hint}"`);
        }

        // Heal wiring (off by default). initNoise is deliberately untouched.
        const heal = chimeraStack.heal ?? 'off';
        const regions = heal === 'off' ? [] : seamHealRegions(meta);
        if (heal !== 'off' && !regions.length) {
          logInfo('generate', `[${elapsed()}] Chimera: heal=${heal} requested but the mashup lists no seams — running init-only`);
        } else if (heal === 'preserve') {
          const masked = regions.reduce((acc, [a, b]) => acc + (b - a), 0);
          effectiveParams = {
            ...effectiveParams,
            inpaintAudioFile: file,
            inpaintEnabled: true,
            maskStart: 0,
            maskEnd: 0,
            inpaintRegions: regions,
          };
          armHealParams(file, regions);
          logInfo('generate', `[${elapsed()}] Chimera: heal=preserve — ${regions.length} seam regions (${masked.toFixed(1)}s of ${meta.duration_sec.toFixed(1)}s) sent as inpaint_regions`);
        } else if (heal === 'polish') {
          polishRegions = regions;
          logInfo('generate', `[${elapsed()}] Chimera: heal=polish — ${regions.length} seam regions queued for a second pass on the result`);
        }
        useStatusBarStore.getState().setText('CHIMERA READY — submitting job');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // STOP (and maybe a new run) came first: this run owns nothing any more.
        if (get().pollRunId !== nextRunId) {
          logInfo('generate', `Chimera mashup ended after STOP: ${msg}`);
          return;
        }
        logError('generate', `Chimera mashup failed; aborting generation: ${msg}`);
        useStatusBarStore.getState().setText(`CHIMERA FAILED: ${msg}`);
        set({
          isGenerating: false,
          jobStatus: 'idle',
          statusLabel: 'CHIMERA FAILED',
          error: `Chimera mashup failed: ${msg}`,
        });
        return;
      }
    }

    // Cancelled during the chimera render: abort before the job is POSTed.
    if (get().pollRunId !== nextRunId) return;

    // POST gate: consult the model-status probe, capped so a slow backend can
    // never hold CREATE hostage (an unreachable probe lets the submit surface
    // its own errors). Blocked → route to Settings → Models, as before.
    set({ statusLabel: 'CHECKING MODELS...' });
    const modelStatus = await withTimeout(modelGate, MODEL_STATUS_WAIT_MS, null);
    if (get().pollRunId !== nextRunId) return;
    const gateMsg = modelGateMessage(modelStatus, params.model);
    if (gateMsg) {
      logError('generate', gateMsg);
      clearHealParams();
      useStatusBarStore.getState().setText('NO USABLE MODEL — see Settings → Models');
      set({ error: gateMsg, isGenerating: false, jobStatus: 'idle', statusLabel: 'NO USABLE MODEL' });
      window.dispatchEvent(new CustomEvent('thedaw:open-settings', { detail: { section: 'models' } }));
      return;
    }
    if (modelStatus === null) {
      logInfo('generate', `[${elapsed()}] Model-status probe slow or unreachable — submitting without the pre-flight gate`);
    }
    set({ statusLabel: 'SUBMITTING JOB...' });

    // Magenta RT2 routes to its own sidecar-backed module; SA3 uses the main job API.
    const isMagenta = effectiveParams.model.startsWith('magenta-');
    const genEndpoint = isMagenta ? '/api/magenta/generate' : '/api/generate-jobs';
    const jobsBase = isMagenta ? '/api/magenta/jobs' : '/api/jobs';
    const formData = isMagenta
      ? buildMagentaFormData(effectiveParams, prompt)
      : buildGenerateJobFormData(effectiveParams, prompt);

    try {
      logInfo('generate', `[${elapsed()}] POST ${genEndpoint} — model=${params.model} duration=${params.duration}s steps=${params.steps} seed=${params.seed}`);
      // Magenta: magentaFetch starts an installed-but-idle engine on demand (live
      // progress card) and re-sends once it is up; SA3 posts straight through.
      const response = isMagenta
        ? await magentaFetch(genEndpoint, { method: 'POST', body: formData })
        : await fetch(genEndpoint, { method: 'POST', body: formData });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      const jobId = response.ok ? (payload as { job?: { id?: string } })?.job?.id : undefined;
      const resolvedSeed = response.ok ? extractResolvedSeed(payload) : null;

      // STOP landed while the POST was in flight: cancel the job if one was
      // made, and leave the stopped run's state alone; a run started since
      // then keeps its caption (-1).
      if (get().pollRunId !== nextRunId) {
        if (jobId) {
          logInfo('generate', `Job ${jobId.slice(0, 8)} was submitted before STOP reached it; cancelling it now.`);
          void confirmCancel(jobId, get().isGenerating ? -1 : get().pollRunId, jobsBase);
        }
        return;
      }

      if (!response.ok) {
        const detail = getErrorMessage(payload, `HTTP ${response.status} ${response.statusText}`);
        logError('generate', `POST ${genEndpoint} → ${response.status} ${response.statusText} — ${detail}`);
        // Another copy's Magenta engine holds the GPU: its card names the
        // engine and offers to stop it.
        if (!isMagenta) handleEngineElsewhere(payload, 'Stable Audio cannot load beside it.');
        throw new Error(detail);
      }

      if (!jobId) {
        logError('generate', `POST ${genEndpoint} → 200 OK but no job_id in response payload`);
        throw new Error(`Backend did not return a job id for ${genEndpoint}.`);
      }

      logInfo('generate', `[${elapsed()}] POST /api/generate-jobs → 200 OK — job_id=${jobId.slice(0, 8)} (server received the job)`);
      if (resolvedSeed !== null) {
        logInfo('generate', `[${elapsed()}] Resolved seed: ${resolvedSeed}${params.seed === -1 ? ' (was -1 / fresh)' : ''}`);
      }
      set({
        currentJobId: jobId,
        jobStatus: 'queued',
        statusLabel: 'QUEUED...',
        lastSeedUsed: resolvedSeed,
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
        // STOP landed while this poll was out. cancelGeneration already sent
        // the job's cancel and wrote the stopped run's caption; whatever the
        // poll says (running, completed, an error), it must not revive the run.
        if (get().pollRunId !== nextRunId) return;

        if (!jobResponse.ok) {
          if (jobResponse.status === 404) {
            logError('generate', `Job ${jobId.slice(0, 8)} not found on server (it may have restarted). Aborting.`);
            clearHealParams();
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
          /** Magenta jobs: 'starting' while the sidecar boots the engine for this job. */
          engine_state?: string;
          progress?: { step?: number; steps?: number; stage?: string };
          result?: {
            batch?: boolean;
            item?: { audio_base64?: string; mime_type?: string; filename?: string; seed?: number };
            items?: Array<{ audio_base64?: string; mime_type?: string; filename?: string; seed?: number }>;
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
            statusLabel: job.engine_state === 'starting'
              ? 'STARTING MAGENTA ENGINE...'
              : job.status === 'queued' ? 'QUEUED...' : `SAMPLING ${get().progressPct}%`,
          });
          await wait(POLL_INTERVAL_MS);
          continue;
        }

        if (job.status === 'completed') {
          _stopPacer();
          let items = job.result?.batch ? job.result?.items ?? [] : job.result?.item ? [job.result.item] : [];
          let resultItem = items[0];
          if (!resultItem?.audio_base64) {
            throw new Error('Generation completed but no audio payload was returned.');
          }
          // The take's own seed, read BEFORE a HEAL = 'polish' pass replaces
          // `items` below — a heal job's seed is not the take's seed. Falls
          // back to whatever the POST reply resolved (extractResolvedSeed)
          // when this backend predates the completed-result seed field.
          const takeSeed = finiteSeedOf(resultItem.seed) ?? get().lastSeedUsed;
          let resultMime = resultItem.mime_type || 'audio/wav';
          let resultBlob = base64ToBlob(resultItem.audio_base64, resultMime);

          // HEAL = 'polish': a second job recomposes the seams on top of this
          // result. Its output becomes the run's result; the first output stays
          // in the library as the parent. On failure the first result stands.
          let resultJobId = jobId;
          let healedJobId: string | null = null;
          if (polishRegions.length && !isMagenta) {
            logInfo('generate', `[${elapsed()}] First pass done (${resultItem.filename || 'output.wav'}); starting the seam heal pass`);
            // The first job is finished, so a STOP from here on has nothing of
            // it to cancel; the heal job becomes currentJobId once its id is back.
            set({ currentJobId: null });
            const healed = await runHealPass(
              { blob: resultBlob, filename: resultItem.filename || 'chimera_pass1.wav' },
              { ...effectiveParams, inpaintRegions: polishRegions },
              prompt,
            );
            if (get().pollRunId !== nextRunId) return;
            if (healed?.items[0]?.audio_base64) {
              items = healed.items;
              resultItem = healed.items[0];
              resultMime = resultItem.mime_type || 'audio/wav';
              resultBlob = base64ToBlob(resultItem.audio_base64 as string, resultMime);
              resultJobId = healed.jobId;
              healedJobId = healed.jobId;
            }
          }
          clearHealParams();

          const audioUrl = URL.createObjectURL(resultBlob);
          set({
            isGenerating: false,
            jobStatus: 'completed',
            statusLabel: 'COMPLETE',
            progressPct: 100,
            lastAudioUrl: audioUrl,
            lastFilename: resultItem.filename || 'output.wav',
            lastDurationSec: params.duration,
            lastModelName: params.model,
            lastSeedUsed: takeSeed,
            error: null,
          });
          useStatusBarStore.getState().setText('Decoded — registering library entries...');
          logInfo('generate', `[${elapsed()}] Sampler finished — ${resultItem.filename || 'output.wav'} (${params.duration}s, ${Math.round(resultBlob.size / 1024)}KB). Audio was written to disk server-side; pulling the entries.`);
          // DL: the auto-download toggle had no consumer — fires once per
          // completed run, but for EVERY take that has audio (Batch > 1 makes
          // `items` more than one entry; a heal pass replaces `items` with its
          // own single healed take, which is what a user with HEAL on wants
          // downloaded, not the pre-heal batch). Distinct filenames per take
          // fall back to the job/batch index when the backend sent none.
          // Item 4 (T17 audit): marks the exact filenames as automatic with
          // the desktop shell BEFORE clicking, so its will-download handler
          // can save straight to disk instead of opening one Save dialog per
          // take — a best-effort hint, wrapped so a missing/rejecting IPC
          // handler (a newer renderer against an older packaged shell) can
          // never fail an otherwise-finished run: everything below this run
          // still has to happen (library refresh, the Chimera PATCH, the
          // player load, autoplay) whether or not the download succeeded.
          if (useGenerateParamsStore.getState().autoDownload) {
            try {
              const toDownload = items
                .map((it, i) => ({ it, i }))
                .filter(({ it }) => !!it.audio_base64)
                .map(({ it, i }) => ({
                  it,
                  filename: it.filename || `${resultJobId}_${String(i).padStart(2, '0')}.wav`,
                }));
              if (toDownload.length) {
                await markAutomaticDownloads(toDownload.map((d) => d.filename));
                toDownload.forEach(({ it, filename }) => {
                  const blob = it === resultItem ? resultBlob : base64ToBlob(it.audio_base64 as string, it.mime_type || 'audio/wav');
                  downloadBlob(blob, filename);
                });
                logInfo('generate', `[${elapsed()}] Auto-download: saved ${toDownload.length} take(s).`);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logError('generate', `Auto-download failed (the run itself still completed): ${msg}`);
            }
          }

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
            // With a heal pass both jobs wrote entries: the first pass is the
            // parent ('chimera'), the healed output adds 'chimera-heal'.
            const tagJobs: Array<{ id: string; count: number; extra: string[] }> = healedJobId
              ? [{ id: jobId, count: 1, extra: [] }, { id: healedJobId, count: items.length, extra: ['chimera-heal'] }]
              : [{ id: jobId, count: items.length, extra: [] }];
            for (const tj of tagJobs) {
              for (let i = 0; i < tj.count; i += 1) {
                if (tj.id === resultJobId && !items[i]?.audio_base64) continue;
                const entryId = `${tj.id}_${String(i).padStart(2, '0')}`;
                const exists = newEntries.find((e) => e.id === entryId);
                if (!exists) {
                  logError('library', `Chimera-sources PATCH skipped: entry ${entryId} not found in refresh.`);
                  continue;
                }
                await useLibraryStore.getState().updateEntry(entryId, {
                  tags: Array.from(new Set([...(exists.tags ?? []), 'chimera', ...tj.extra])),
                  chimeraSources: chimeraSourceLabels,
                });
              }
            }
          }

          // Load the first new entry into the player so playback works
          // immediately. The blob comes from the backend streaming URL.
          //
          // The backend writes artifacts synchronously before reporting
          // 'completed', but the library list index can lag that write by a
          // beat — when it does, the entry isn't in the just-refreshed list
          // and the track silently fails to appear ("manual reload"). Re-
          // refresh a few times until the expected id shows up so generated
          // tracks reliably land in the library.
          const findFirst = () => {
            const after = useLibraryStore.getState().entries;
            return items[0]?.audio_base64
              ? after.find((e) => e.id === `${resultJobId}_00`) ?? after.find((e) => e.id === resultJobId) ?? null
              : null;
          };
          let firstEntry = findFirst();
          for (let attempt = 0; !firstEntry && items[0]?.audio_base64 && attempt < 5; attempt += 1) {
            await wait(400);
            await useLibraryStore.getState().refresh();
            firstEntry = findFirst();
          }
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
            // Retries exhausted: surface it instead of leaving the user to
            // wonder why a track they just generated is missing.
            logError('generate', `Could not find freshly-saved entry for job ${resultJobId} after retries — try reloading the library panel.`);
            useStatusBarStore.getState().setText('Saved to disk, but the library list did not refresh — reload the Library panel.', { logged: true });
          }

          useStatusBarStore.getState().setText('GENERATION COMPLETE');
          logInfo('generate', `[${elapsed()}] Generation pipeline complete.`);
          return;
        }

        // Cancelled on the server by another caller of POST /api/jobs/{id}/cancel
        // (this key's own STOP has already left this loop).
        if (job.status === 'cancelled') {
          _stopPacer();
          clearHealParams();
          set({ isGenerating: false, jobStatus: 'idle', statusLabel: 'CANCELLED', progressPct: 0, currentJobId: null });
          useStatusBarStore.getState().setText('GENERATION CANCELLED');
          logInfo('generate', `[${elapsed()}] Job ${jobId.slice(0, 8)} was cancelled on the server.`);
          return;
        }

        if (job.status === 'failed') {
          throw new Error(job.error || 'Generation job failed.');
        }

        throw new Error(`Unexpected job status: ${job.status ?? 'unknown'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Generation failed unexpectedly.';
      // A request that failed after STOP (and maybe after a new run started)
      // belongs to no live run: log it and leave the store to whoever owns it.
      if (get().pollRunId !== nextRunId) {
        logInfo('generate', `A request of the stopped run ended with: ${message}`);
        return;
      }
      clearHealParams();
      set({
        isGenerating: false,
        jobStatus: 'failed',
        statusLabel: 'FAILED',
        error: message,
      });
      useStatusBarStore.getState().setText(`GENERATION FAILED: ${message}`);
      logError('generate', message);
      // A Hugging Face gate is fixable without leaving the app, so raise the
      // card that carries the fix rather than leaving a raw traceback in the
      // status bar. Which fix depends on which gate: a missing token gets the
      // token field, an account that is not on the allow list gets the model
      // page, because no token will ever open that one.
      const gate = classifyModelGate(message);
      if (gate?.kind === 'local-only') {
        requireFeature({
          id: 'model:local-only',
          kind: 'model',
          title: 'Downloads are turned off',
          message:
            'This model is not on the machine, and local-only mode blocks fetching it. Allowing downloads gets it now.',
          action: {
            label: 'Allow downloads & retry',
            run: async () => {
              await setLocalOnly(false);
              void get().submitGeneration(params);
            },
          },
        });
      } else if (gate?.kind === 'sign-in') {
        requireFeature({
          id: 'hf:generate',
          kind: 'hf',
          title: 'Hugging Face sign-in needed',
          message: 'This model is gated — paste a token and it runs again.',
          action: {
            label: 'Retry generation',
            // Deliberately not awaited: the retry has its own status bar and
            // progress, and the card should clear rather than hang on it.
            run: () => {
              void get().submitGeneration(params);
            },
          },
        });
      } else if (gate?.kind === 'no-access') {
        const repoUrl = gate.repoUrl;
        requireFeature({
          id: 'hf:no-access',
          kind: 'model',
          title: 'Access not granted',
          message:
            'Your token works — this Hugging Face account is not on the model\'s allow list. Open the model page, click "Agree and access", then generate again.',
          action: repoUrl
            ? {
                label: 'Open model page',
                run: () => {
                  window.open(repoUrl, '_blank', 'noopener');
                },
              }
            : undefined,
        });
      }
    }
  },

  cancelGeneration: () => {
    const { isGenerating, currentJobId, runJobsBase } = get();
    if (!isGenerating) return;
    const nextRunId = get().pollRunId + 1;
    // every pollRunId-mismatch exit in submitGeneration/runHealPass routes
    // through here, so this is where an aborted heal run gives back the
    // inpaint fields it borrowed
    clearHealParams();
    set({
      pollRunId: nextRunId,
      isGenerating: false,
      jobStatus: 'idle',
      statusLabel: 'STOPPED',
      progressPct: 0,
      currentJobId: null,
    });
    if (currentJobId) {
      logInfo('generate', `STOP pressed: cancelling job ${currentJobId.slice(0, 8)} on the server`);
      void confirmCancel(currentJobId, nextRunId, runJobsBase);
      return;
    }
    useStatusBarStore.getState().setText('GENERATION STOPPED', { logged: true });
    logInfo('generate', 'STOP pressed before the backend returned a job id: a job already submitted is cancelled when its id comes back');
  },

  clearResult: () => {
    const currentUrl = get().lastAudioUrl;
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
    }
    set({
      lastAudioUrl: null,
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

