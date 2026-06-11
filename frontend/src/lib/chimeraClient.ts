import {
  useGenerateParamsStore,
  type ChimeraClip,
  type ChimeraMashupMeta,
  type ChimeraState,
} from '../state/generateParamsStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
// circular with generateStore (it calls getOrRenderChimera); only accessed
// inside deferred callbacks, never at module evaluation, so the cycle is safe
import { useGenerateStore } from '../state/generateStore';
import { logError, logInfo } from '../state/logStore';

export interface BlobAddition {
  blob: Blob;
  mimeType: string;
  label: string;
  /** Library entry id when known — lets analysis reuse the cached library row. */
  entryId?: string;
}

/**
 * Immediate per-clip analysis (BPM + per-beat times + key) so a clip's badges
 * and CRISPR beat rungs are real the moment it lands in the stack. Library
 * clips resolve through the cached `/api/analysis/{id}` row; raw drops go
 * through `/api/chimera/analyze` (same detector either way).
 */
const analyzeClip = async (clipId: string, item: BlobAddition): Promise<void> => {
  const { updateChimeraClip } = useGenerateParamsStore.getState();
  const apply = (p: Partial<Omit<ChimeraClip, 'id'>>): void => {
    // The clip may have been removed while analysis ran; updateChimeraClip
    // no-ops on unknown ids, so this is safe.
    updateChimeraClip(clipId, p);
  };
  try {
    if (item.entryId) {
      await useDjAnalysisStore.getState().ensureAnalyzed(item.entryId);
      const row = useDjAnalysisStore.getState().byId[item.entryId];
      const d = row?.data;
      if (d && (d.bpm != null || d.beats != null || d.key != null)) {
        apply({
          detectedBpm: d.bpm,
          keyNote: d.key,
          keyScale: d.scale,
          beats: d.beats,
          durationSec: d.duration_sec,
        });
        logInfo('chimera', `Analyzed (library) ${item.label}: ${d.bpm ? d.bpm.toFixed(1) : '—'} BPM, key ${d.key ?? '—'} ${d.scale ?? ''}`);
        return;
      }
      // fall through to blob analysis when the library row came back empty
    }
    const form = new FormData();
    const fname = item.label || 'clip.wav';
    form.append('file', new File([item.blob], fname, { type: item.mimeType }));
    const res = await fetch('/api/chimera/analyze', { method: 'POST', body: form });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const body = await res.json() as {
      bpm: number | null;
      beats: number[] | null;
      duration_sec: number | null;
      key: string | null;
      scale: string | null;
    };
    apply({
      detectedBpm: body.bpm,
      keyNote: body.key,
      keyScale: body.scale,
      beats: body.beats,
      durationSec: body.duration_sec,
    });
    logInfo('chimera', `Analyzed ${item.label}: ${body.bpm ? body.bpm.toFixed(1) : '—'} BPM, key ${body.key ?? '—'} ${body.scale ?? ''}`);
  } catch (e) {
    logError('chimera', `Analysis failed for ${item.label}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// ── Background mashup pre-render ────────────────────────────────────────────
// The weave render is the big CREATE wait, but it only depends on the stack's
// params — so render it in the background as soon as the stack settles
// (debounced). CREATE then finds the result warm (or an in-flight render to
// await), and the DNA scene gets the REAL chunk placements before CREATE.
interface CachedRender {
  key: string;
  promise: Promise<ChimeraRenderResult>;
  done: boolean;
}

let _renderCache: CachedRender | null = null;
let _preRenderTimer: number | undefined;

const chimeraParamsKey = (c: ChimeraState): string =>
  JSON.stringify({
    clips: c.clips.map((cl) => [cl.id, cl.noise, cl.isBase]),
    bpm: c.targetBpm,
    mode: c.alignMode,
    wb: c.weaveBars,
    wtb: c.weaveTotalBars,
    wmp: c.weaveMaxPolyphony,
  });

const _cacheRender = (key: string, label: string): Promise<ChimeraRenderResult> => {
  const promise = renderChimeraOnce(useGenerateParamsStore.getState().chimera);
  _renderCache = { key, promise, done: false };
  promise
    .then((r) => {
      if (_renderCache?.key === key) {
        _renderCache.done = true;
        // surface the REAL chunk placements to the CRISPR scene immediately
        useGenerateParamsStore.getState().setChimeraField('lastMeta', r.meta);
        logInfo('chimera', `${label} ready — ${r.meta.duration_sec.toFixed(1)}s @ ${r.meta.target_bpm_used.toFixed(1)} BPM (cached for CREATE)`);
      }
    })
    .catch((e) => {
      if (_renderCache?.key === key) _renderCache = null;
      logError('chimera', `${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  return promise;
};

/** CREATE entry point: reuse the pre-rendered mashup when params match. */
export const getOrRenderChimera = (c: ChimeraState): Promise<ChimeraRenderResult> => {
  const key = chimeraParamsKey(c);
  if (_renderCache && _renderCache.key === key) {
    logInfo('chimera', _renderCache.done
      ? 'Mashup pre-rendered — using cached result (no wait)'
      : 'Mashup already rendering in the background — awaiting it');
    return _renderCache.promise;
  }
  return _cacheRender(key, 'Mashup render');
};

// Debounced watcher: when the stack or its params change, pre-render after
// things settle. Skipped mid-generation (the active run owns the params).
useGenerateParamsStore.subscribe((s, prev) => {
  if (s.chimera === prev.chimera) return;
  if (typeof window === 'undefined') return;
  window.clearTimeout(_preRenderTimer);
  if (s.chimera.clips.length < 2) {
    _renderCache = null;
    return;
  }
  _preRenderTimer = window.setTimeout(() => {
    const c = useGenerateParamsStore.getState().chimera;
    if (c.clips.length < 2) return;
    if (useGenerateStore.getState().isGenerating) return;
    // wait until every clip has its analysis so the mashup can skip detection
    const analyzed = c.clips.every((cl) => cl.detectedBpm != null || (cl.beats && cl.beats.length));
    const key = chimeraParamsKey(c);
    if (_renderCache && _renderCache.key === key) return;
    if (!analyzed) return; // re-fires on the analysis updateChimeraClip
    logInfo('chimera', `Pre-rendering mashup in the background (${c.clips.length} clips)…`);
    _cacheRender(key, 'Background pre-render');
  }, 2500);
});

export const addBlobsToChimera = (items: BlobAddition[]): void => {
  if (items.length === 0) return;
  const { addChimeraClip } = useGenerateParamsStore.getState();
  for (const item of items) {
    addChimeraClip(item);
  }
  // Analyze each new clip immediately (badges + beat rungs). Clips are located
  // by blob identity because addChimeraClip generates ids internally.
  const clips = useGenerateParamsStore.getState().chimera.clips;
  for (const item of items) {
    const clip = clips.find((c) => c.blob === item.blob);
    if (clip && clip.detectedBpm == null && clip.beats == null) {
      void analyzeClip(clip.id, item);
    }
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
  // Reuse the analyze-on-add results so the mashup skips re-detecting BPM and
  // beats for every clip (a noticeable chunk of the CREATE wait).
  const knownAnalysis = chimera.clips.map((c) =>
    c.detectedBpm != null && c.beats && c.beats.length && c.durationSec
      ? { bpm: c.detectedBpm, beats: c.beats, duration_sec: c.durationSec }
      : null,
  );
  if (knownAnalysis.some(Boolean)) {
    form.append('known_analysis', JSON.stringify(knownAnalysis));
  }
  if (chimera.alignMode === 'weave') {
    form.append('weave_bars', String(chimera.weaveBars || 0));
    form.append('weave_total_bars', String(chimera.weaveTotalBars || 0));
    form.append('weave_max_polyphony', String(chimera.weaveMaxPolyphony || 0));
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

