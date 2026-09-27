/**
 * editInpaintForm — the /api/generate-jobs request the EDIT inpaint panel
 * sends. Kept out of WaveformEditor so the field names the backend reads are
 * pinned by a test (editInpaintForm.test.ts): a misspelt one is silently
 * ignored by the endpoint and the feature quietly turns off. The crop's
 * encoding is here for the same reason.
 */
import { encodeWav } from './wavEncode';

/** Encode the clip window the request carries. Float WAV: the backend puts
 *  these samples back outside the selection (composite_original) and answers
 *  in float (wav_bit_depth=32f), so what the model is sent is what the clip
 *  keeps. A 16-bit crop would requantize the whole clip on every inpaint. */
export const encodeEditInpaintCrop = (rendered: AudioBuffer): Blob => encodeWav(rendered, { float32: true });

/** The inpaint seam feather: the backend's default and its accepted range
 *  (mask_feather_sec). Below ~0.09 s the fade sits inside the ~93 ms the
 *  model itself blends across at a region edge. */
export const INPAINT_FEATHER_DEFAULT_SEC = 0.1;
export const INPAINT_FEATHER_MAX_SEC = 0.5;

export interface EditInpaintRequest {
  model: string;
  prompt: string;
  steps: number;
  seed: number;
  /** The clip's visible length: the crop's length and the request's duration. */
  durationSec: number;
  /** The selection, in seconds from the start of the crop. */
  maskStartSec: number;
  maskEndSec: number;
  featherSec: number;
  matchLoudness: boolean;
  /** The crop, a float WAV of the clip's visible window. */
  audio: Blob;
}

export function buildEditInpaintForm(req: EditInpaintRequest): FormData {
  const fd = new FormData();
  // Send the model the user actually selected. Without this the endpoint's
  // own default won, which meant INPAINT REGION always asked for the gated
  // 'medium' checkpoint no matter what MAKE was set to (GH-132).
  fd.append('model_name', req.model);
  fd.append('prompt', req.prompt);
  fd.append('steps', String(req.steps));
  fd.append('seed', String(req.seed));
  fd.append('cfg_scale', '1.0');
  fd.append('duration', String(req.durationSec));
  fd.append('mask_start', String(Math.max(0, req.maskStartSec)));
  fd.append('mask_end', String(Math.min(req.durationSec, req.maskEndSec)));
  // Only the selection changes: the backend restores the clip's own samples
  // outside it and crossfades each edge inside it. The result comes back as
  // float WAV so those samples survive the trip unrequantized.
  fd.append('composite_original', 'true');
  const feather = Math.min(INPAINT_FEATHER_MAX_SEC, Math.max(0, req.featherSec));
  fd.append('mask_feather_sec', feather.toFixed(3));
  fd.append('match_loudness', String(req.matchLoudness));
  fd.append('wav_bit_depth', '32f');
  fd.append('inpaint_audio', new File([req.audio], 'inpaint.wav', { type: 'audio/wav' }));
  return fd;
}
