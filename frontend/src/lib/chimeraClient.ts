import {
  useGenerateParamsStore,
  type ChimeraMashupMeta,
  type ChimeraState,
} from '../state/generateParamsStore';
import { logError, logInfo } from '../state/logStore';

export interface BlobAddition {
  blob: Blob;
  mimeType: string;
  label: string;
}

export const addBlobsToChimera = (items: BlobAddition[]): void => {
  if (items.length === 0) return;
  const { addChimeraClip } = useGenerateParamsStore.getState();
  for (const item of items) {
    addChimeraClip(item);
  }
  logInfo('chimera', `Added ${items.length} clip${items.length === 1 ? '' : 's'} to Chimera stack`);
};

interface MashupResponse {
  mix_base64: string;
  mime: string;
  sample_rate: number;
  duration_sec: number;
  target_bpm_used: number;
  target_bpm_source: 'user' | 'base_clip' | 'median' | 'fallback';
  align_mode_used: 'start' | 'downbeat' | 'weave';
  per_clip: ChimeraMashupMeta['per_clip'];
  warnings: string[];
}

const base64ToBlob = (b64: string, mime: string): Blob => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
};

export interface ChimeraRenderResult {
  file: File;
  meta: ChimeraMashupMeta;
}

export const renderChimeraOnce = async (chimera: ChimeraState): Promise<ChimeraRenderResult> => {
  if (chimera.clips.length === 0) {
    throw new Error('Chimera stack is empty');
  }

  const form = new FormData();
  const weights: number[] = [];
  let baseIndex: number | null = null;
  chimera.clips.forEach((clip, i) => {
    form.append('files', clip.blob, clip.label);
    weights.push(Math.max(0, Math.min(1, 1 - clip.noise)));
    if (clip.isBase) baseIndex = i;
  });
  form.append(
    'target_bpm',
    chimera.targetBpm === 'auto' ? 'auto' : String(chimera.targetBpm),
  );
  if (baseIndex !== null) {
    form.append('base_index', String(baseIndex));
  }
  form.append('weights', JSON.stringify(weights));
  form.append('align_mode', chimera.alignMode);
  form.append('out_sr', '44100');
  if (chimera.alignMode === 'weave') {
    form.append('weave_bars', String(chimera.weaveBars || 0));
    form.append('weave_total_bars', String(chimera.weaveTotalBars || 0));
  }

  logInfo('chimera', `POST /api/chimera/mashup — ${chimera.clips.length} clips, mode=${chimera.alignMode}, target_bpm=${chimera.targetBpm}`);

  let response: Response;
  try {
    response = await fetch('/api/chimera/mashup', { method: 'POST', body: form });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('chimera', `Mashup network error: ${msg}`);
    throw new Error(`Chimera mashup failed (network): ${msg}`);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = (() => {
      if (payload && typeof payload === 'object') {
        const body = payload as { detail?: unknown; error?: unknown };
        if (typeof body.detail === 'string') return body.detail;
        if (body.detail && typeof body.detail === 'object') {
          return JSON.stringify(body.detail);
        }
        if (typeof body.error === 'string') return body.error;
      }
      return `HTTP ${response.status} ${response.statusText}`;
    })();
    logError('chimera', `Mashup failed: ${detail}`);
    throw new Error(`Chimera mashup failed: ${detail}`);
  }

  const body = payload as MashupResponse;
  const blob = base64ToBlob(body.mix_base64, body.mime || 'audio/wav');
  const fileName = `chimera-${chimera.clips.length}clips-${Date.now()}.wav`;
  const file = new File([blob], fileName, { type: body.mime || 'audio/wav' });

  const meta: ChimeraMashupMeta = {
    sample_rate: body.sample_rate,
    duration_sec: body.duration_sec,
    target_bpm_used: body.target_bpm_used,
    target_bpm_source: body.target_bpm_source,
    align_mode_used: body.align_mode_used,
    per_clip: body.per_clip,
    warnings: body.warnings,
  };

  logInfo(
    'chimera',
    `Mashup done: ${meta.duration_sec.toFixed(2)}s @ ${meta.target_bpm_used.toFixed(1)} BPM (${meta.target_bpm_source}), mode=${meta.align_mode_used}`,
  );
  body.warnings.forEach((w) => logInfo('chimera', `warning: ${w}`));

  return { file, meta };
};
