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
import { logDebug, logError, logInfo } from '../state/logStore';

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
interface AnalyzeResponse {
  bpm: number | null;
  beats: number[] | null;
  duration_sec: number | null;
  key: string | null;
  scale: string | null;
  // v2 additive (absent on an older backend)
  key_confidence?: number | null;
  key_strength?: number | null;
  downbeat_phase?: number;
  downbeat_confidence?: number;
  phrase_phase?: number;
  phrase_confidence?: number;
  lufs?: number;
  percussive_ratio?: number;
  low_band_fraction?: number;
  bars?: unknown[];
  beat_grid?: unknown;
  sha256?: string;
}

/** /analyze keys echoed back verbatim inside known_analysis (opaque here). */
const ANALYSIS_EXTRA_KEYS = [
  'downbeat_phase',
  'downbeat_confidence',
  'phrase_phase',
  'phrase_confidence',
  'key_strength',
  'lufs',
  'percussive_ratio',
  'low_band_fraction',
  'bars',
  'sha256',
] as const;

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
      const hasBeatInfo = !!d && (d.bpm != null || (Array.isArray(d.beats) && d.beats.length > 0));
      if (d && (hasBeatInfo || d.key != null)) {
        apply({
          detectedBpm: d.bpm,
          keyNote: d.key,
          keyScale: d.scale,
          beats: d.beats,
          durationSec: d.duration_sec,
        });
        logInfo('chimera', `Analyzed (library) ${item.label}: ${d.bpm ? d.bpm.toFixed(1) : '—'} BPM, key ${d.key ?? '—'} ${d.scale ?? ''}`);
      }
      if (hasBeatInfo) return;
      // A library row without BPM/beats (key-only, or an older analysis) used
      // to end here, which left the clip un-analyzed forever: the background
      // pre-render waits for every clip's beats, so it never fired. Fall
      // through to blob analysis for the beat grid; the key (if any) is kept.
    }
    const form = new FormData();
    const fname = item.label || 'clip.wav';
    form.append('file', new File([item.blob], fname, { type: item.mimeType }));
    const res = await fetch('/api/chimera/analyze', { method: 'POST', body: form });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const body = await res.json() as AnalyzeResponse;
    // v2 extras: every key is optional on an older backend; only keep the
    // ones that are actually present so known_analysis stays byte-minimal.
    const extras: Record<string, unknown> = {};
    for (const k of ANALYSIS_EXTRA_KEYS) {
      const v = (body as unknown as Record<string, unknown>)[k];
      if (v !== undefined && v !== null) extras[k] = v;
    }
    apply({
      detectedBpm: body.bpm,
      beats: body.beats,
      durationSec: body.duration_sec,
      // never overwrite a key the library row already supplied with null
      ...(body.key != null ? { keyNote: body.key, keyScale: body.scale } : {}),
      ...(body.key_confidence != null ? { keyConfidence: body.key_confidence } : {}),
      ...(body.key_strength != null ? { keyStrength: body.key_strength } : {}),
      ...(Object.keys(extras).length ? { analysisExtras: extras } : {}),
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

const chimeraParamsKey = (c: ChimeraState, durationSec: number): string =>
  JSON.stringify({
    clips: c.clips.map((cl) => [cl.id, cl.noise, cl.isBase]),
    // library entry ids resolve cached analysis + stems on the backend
    entries: c.clips.map((cl) => cl.entryId ?? null),
    bpm: c.targetBpm,
    mode: c.alignMode,
    wb: c.weaveBars,
    wtb: c.weaveTotalBars,
    wmp: c.weaveMaxPolyphony,
    // 0 total bars = match the generation Length, so Length is a render param
    dur: durationSec,
    harmony: c.harmony ?? 'auto',
    arc: c.arc ?? 'song',
    engine: c.engine ?? 'v2',
  });

const _cacheRender = (key: string, label: string): Promise<ChimeraRenderResult> => {
  const st = useGenerateParamsStore.getState();
  const promise = renderChimeraOnce(st.chimera, st.duration);
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
  const key = chimeraParamsKey(c, useGenerateParamsStore.getState().duration);
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
  // a Length change re-pre-renders too: with weaveTotalBars 0 the mashup is
  // sized to the Length, so a stale render would be the wrong duration
  if (s.chimera === prev.chimera && s.duration === prev.duration) return;
  if (typeof window === 'undefined') return;
  window.clearTimeout(_preRenderTimer);
  if (s.chimera.clips.length < 2) {
    _renderCache = null;
    return;
  }
  _preRenderTimer = window.setTimeout(() => {
    const st = useGenerateParamsStore.getState();
    const c = st.chimera;
    if (c.clips.length < 2) return;
    if (useGenerateStore.getState().isGenerating) return;
    // wait until every clip's analysis has landed so the mashup can skip
    // detection; a clip counts once it has a beat grid OR its analysis
    // finished without one (beatless material still reports a duration), so
    // an ambient clip no longer holds the pre-render forever
    const analyzed = c.clips.every(
      (cl) => cl.detectedBpm != null || (cl.beats && cl.beats.length) || cl.durationSec != null,
    );
    const key = chimeraParamsKey(c, st.duration);
    if (_renderCache && _renderCache.key === key) return;
    if (!analyzed) {
      logDebug('chimera', 'Pre-render waiting: a clip is still being analysed (re-checks when analysis lands)');
      return; // re-fires on the analysis updateChimeraClip
    }
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

/** The v1 keys plus every v2 additive key (ChimeraMashupMeta is the
 *  structural superset, so the body minus the audio IS the meta). */
type MashupResponse = ChimeraMashupMeta & {
  mix_base64: string;
  mime: string;
};

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

export const renderChimeraOnce = async (
  chimera: ChimeraState,
  /** Generation Length in seconds — the mashup's target duration when
   *  weaveTotalBars is 0. 0/undefined = let the backend fall back (90 bars). */
  durationSec: number = 0,
): Promise<ChimeraRenderResult> => {
  if (chimera.clips.length === 0) {
    throw new Error('Chimera stack is empty');
  }
  const harmony = chimera.harmony ?? 'auto';
  const arc = chimera.arc ?? 'song';
  const engine = chimera.engine ?? 'v2';
  const matchLength = !(chimera.weaveTotalBars > 0) && durationSec > 0;

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
  // beats for every clip (a noticeable chunk of the CREATE wait). An entry
  // with an entryId but no BPM is still sent so the backend can resolve the
  // cached library analysis and Demucs stems.
  const knownAnalysis = chimera.clips.map((c) => {
    const hasBeats = c.detectedBpm != null && !!c.beats && c.beats.length > 0 && !!c.durationSec;
    if (!hasBeats && !c.entryId) return null;
    return {
      ...(c.analysisExtras ?? {}),
      bpm: hasBeats ? c.detectedBpm : null,
      beats: hasBeats ? c.beats : null,
      duration_sec: hasBeats ? c.durationSec : null,
      key: c.keyNote ?? null,
      scale: c.keyScale ?? null,
      key_confidence: c.keyConfidence ?? null,
      key_strength: c.keyStrength ?? null,
      entry_id: c.entryId ?? null,
    };
  });
  if (knownAnalysis.some(Boolean)) {
    form.append('known_analysis', JSON.stringify(knownAnalysis));
  }
  if (chimera.alignMode === 'weave') {
    form.append('weave_bars', String(chimera.weaveBars || 0));
    form.append('weave_total_bars', String(chimera.weaveTotalBars || 0));
    form.append('weave_max_polyphony', String(chimera.weaveMaxPolyphony || 0));
    // v2 additive fields (an older backend ignores unknown form fields)
    form.append('engine', engine);
    form.append('harmony', harmony);
    form.append('arc', arc);
    if (matchLength) form.append('target_duration_sec', String(durationSec));
    form.append('use_stems', 'true');
    form.append('seed', '0');
  }

  const v2Note = chimera.alignMode === 'weave'
    ? `, engine=${engine}, harmony=${harmony}, arc=${arc}${matchLength ? `, target=${durationSec}s` : ''}`
    : '';
  logInfo('chimera', `POST /api/chimera/mashup — ${chimera.clips.length} clips, mode=${chimera.alignMode}, target_bpm=${chimera.targetBpm}${v2Note}`);

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

  // Everything but the audio is the meta: the v1 keys keep their meaning and
  // every v2 key is additive (ChimeraMashupMeta is the structural superset).
  const { mix_base64: _audio, mime: _mime, ...rest } = body;
  void _audio;
  void _mime;
  const meta: ChimeraMashupMeta = {
    ...rest,
    per_clip: body.per_clip ?? [],
    warnings: body.warnings ?? [],
  };

  const keyNote = meta.target_key
    ? `, key=${meta.target_key} ${meta.target_scale ?? ''}${meta.target_camelot ? ` (${meta.target_camelot})` : ''}`
    : '';
  logInfo(
    'chimera',
    `Mashup done: ${meta.duration_sec.toFixed(2)}s @ ${meta.target_bpm_used.toFixed(1)} BPM (${meta.target_bpm_source}), mode=${meta.align_mode_used}${meta.engine_used ? `, engine=${meta.engine_used}` : ''}${meta.arc_used ? `, arc=${meta.arc_used}` : ''}${keyNote}${meta.seams?.length ? `, ${meta.seams.length} seams` : ''}`,
  );
  if (meta.prompt_hint) logInfo('chimera', `prompt hint: ${meta.prompt_hint}`);
  meta.warnings.forEach((w) => {
    // tempo-fit / coverage warnings mean the arrangement was compromised
    const loud = /tempo-fit|coverage/i.test(w);
    logInfo('chimera', `${loud ? 'WARNING' : 'warning'}: ${w}`);
  });

  return { file, meta };
};

