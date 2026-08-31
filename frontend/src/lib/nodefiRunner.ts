/**
 * Nodefi runner — drives a node graph to produce audio.
 *
 * Topologically walks the graph (feedback back-edges cut first), runs each
 * node's underlying async action (Stable Audio generate, Magenta, studio
 * effect, offline merge, library fetch, library save), and feeds output blobs
 * downstream. Feedback loops are bounded: the sub-graph reachable from a
 * Feedback node re-runs up to its iteration count, each pass feeding the
 * previous pass's captured input back out. Everything not reachable from a
 * feedback node runs once and is cached.
 *
 * All network calls reuse the existing backend contracts (see the Nodefi
 * integration notes): POST /api/generate-jobs + poll /api/jobs/{id};
 * POST /api/magenta/generate + poll /api/magenta/jobs/{id}; single-shot
 * POST /api/studio/process. No new backend endpoints.
 */
import {
  buildGenerateJobFormData,
  buildMagentaFormData,
  type GenerateParams,
} from '../state/generateStore';
import { useLibraryStore } from '../state/libraryStore';
import { EFFECT_DEFAULTS } from '../state/effectChainStore';
import { getEngineCtx } from '../state/playerStore';
import { encodeWav } from './wavEncode';
import { fetchStemBlob } from './nodefiLive';
import type { GraphEdge, GraphNode, NodeRunStatus } from './nodefiTypes';

export interface RunnerCallbacks {
  onStatus: (nodeId: string, status: NodeRunStatus, message?: string) => void;
  onOutput: (nodeId: string, blob: Blob | null) => void;
  onLog?: (msg: string) => void;
}

export interface RunController {
  promise: Promise<void>;
  cancel: () => void;
}

const base64ToBlob = (b64: string, mime: string): Blob => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'audio/wav' });
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Poll a generation job (SA3 or Magenta share the envelope) until it yields audio. */
async function pollJob(
  base: string,
  jobId: string,
  signal: AbortSignal,
  ensureLive: () => void,
): Promise<Blob> {
  for (;;) {
    ensureLive();
    await wait(1000);
    ensureLive();
    const r = await fetch(`${base}/${jobId}`, { signal });
    if (r.status === 404) throw new Error('job lost (server reset)');
    if (!r.ok) throw new Error(`poll failed: ${r.status}`);
    const j = (await r.json()) as {
      status?: string;
      result?: {
        batch?: boolean;
        item?: { audio_base64?: string; mime_type?: string };
        items?: Array<{ audio_base64?: string; mime_type?: string }>;
      };
      error?: string;
    };
    if (j.status === 'completed') {
      const item = j.result?.batch ? j.result?.items?.[0] : j.result?.item;
      if (!item?.audio_base64) throw new Error('no audio in result');
      return base64ToBlob(item.audio_base64, item.mime_type || 'audio/wav');
    }
    if (j.status === 'failed') throw new Error(j.error || 'generation failed');
  }
}

function normalizeBuffer(buf: AudioBuffer): AudioBuffer {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c += 1) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0.999 && peak > 0) {
    const g = 0.98 / peak;
    for (let c = 0; c < buf.numberOfChannels; c += 1) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) data[i] *= g;
    }
  }
  return buf;
}

export function runGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  cb: RunnerCallbacks,
): RunController {
  let cancelled = false;
  const ac = new AbortController();
  const cancel = () => {
    cancelled = true;
    ac.abort();
  };
  const ensureLive = () => {
    if (cancelled) throw new Error('cancelled');
  };
  const log = (m: string) => cb.onLog?.(m);

  const feedbackIds = new Set(nodes.filter((n) => n.kind === 'feedback').map((n) => n.id));
  // Cut feedback OUTPUT edges so the remaining graph is a DAG for topo sort.
  const activeEdges = edges.filter((e) => !feedbackIds.has(e.from));

  const outputs = new Map<string, Blob | null>(); // node -> latest output value

  const incoming = (nodeId: string, portId: string): GraphEdge[] =>
    activeEdges.filter((e) => e.to === nodeId && e.toPort === portId);
  const inputBlob = (nodeId: string, portId: string): Blob | null => {
    for (const e of incoming(nodeId, portId)) {
      const b = outputs.get(e.from);
      if (b) return b;
    }
    return null;
  };
  const inputBlobs = (nodeId: string, portId: string): Blob[] => {
    const out: Blob[] = [];
    for (const e of incoming(nodeId, portId)) {
      const b = outputs.get(e.from);
      if (b) out.push(b);
    }
    return out;
  };

  async function runNode(node: GraphNode): Promise<Blob> {
    switch (node.kind) {
      case 'input': {
        const id = String(node.params.libraryId || '');
        if (!id) throw new Error('no library entry selected');
        const lib = useLibraryStore.getState();
        let entry = lib.entries.find((e) => e.id === id);
        if (!entry) {
          await lib.load();
          entry = useLibraryStore.getState().entries.find((e) => e.id === id);
        }
        if (!entry) throw new Error('library entry not found');
        return useLibraryStore.getState().fetchAudioBlob(entry);
      }
      case 'generate': {
        const init = inputBlob(node.id, 'init');
        const p: GenerateParams = {
          prompt: String(node.params.prompt || ''),
          negativePrompt: '',
          model: String(node.params.model || 'medium'),
          duration: num(node.params.duration, 8),
          steps: num(node.params.steps, 8),
          cfg: num(node.params.cfg, 1),
          seed: num(node.params.seed, -1),
          batch: 1,
          initNoise: num(node.params.initNoise, 0.7),
          initType: init ? 'audio' : 'noise',
          initAudioEnabled: !!init,
          initAudioFile: init ? new File([init], 'init.wav', { type: 'audio/wav' }) : null,
        };
        const form = buildGenerateJobFormData(p, p.prompt.trim());
        const res = await fetch('/api/generate-jobs', { method: 'POST', body: form, signal: ac.signal });
        if (!res.ok) throw new Error(`submit failed: ${res.status}`);
        const { job } = (await res.json()) as { job?: { id?: string } };
        if (!job?.id) throw new Error('no job id');
        return pollJob('/api/jobs', job.id, ac.signal, ensureLive);
      }
      case 'magenta': {
        const style = inputBlob(node.id, 'style');
        const p: GenerateParams = {
          prompt: String(node.params.prompt || ''),
          negativePrompt: '',
          model: String(node.params.model || 'magenta-small'),
          duration: num(node.params.duration, 8),
          steps: 8,
          cfg: 1,
          seed: -1,
          batch: 1,
          initNoise: 0.7,
          initType: 'noise',
          magTemperature: num(node.params.magTemperature, 1.1),
          initAudioEnabled: !!style,
          initAudioFile: style ? new File([style], 'style.wav', { type: 'audio/wav' }) : null,
        };
        const form = buildMagentaFormData(p, p.prompt.trim());
        const res = await fetch('/api/magenta/generate', { method: 'POST', body: form, signal: ac.signal });
        if (!res.ok) throw new Error(`magenta submit failed: ${res.status} (is the engine running?)`);
        const { job } = (await res.json()) as { job?: { id?: string } };
        if (!job?.id) throw new Error('no job id');
        return pollJob('/api/magenta/jobs', job.id, ac.signal, ensureLive);
      }
      case 'effect': {
        const input = inputBlob(node.id, 'in');
        if (!input) throw new Error('no input audio');
        const effect = String(node.params.effect || 'mastering_chain');
        // Start from the effect's own defaults: the backend 400s on any
        // missing key, and a node created before the params were seeded (or
        // whose params were pruned) must still run.
        const params: Record<string, number> = { ...(EFFECT_DEFAULTS[effect] ?? {}) };
        for (const [k, v] of Object.entries(node.params)) {
          if (k !== 'effect' && typeof v === 'number') params[k] = v;
        }
        const form = new FormData();
        form.append('audio', input, 'input.wav');
        form.append('effect', effect);
        form.append('params', JSON.stringify(params));
        form.append('output_format', 'wav');
        const res = await fetch('/api/studio/process', { method: 'POST', body: form, signal: ac.signal });
        if (!res.ok) throw new Error(`effect ${effect} failed: ${res.status}`);
        return res.blob();
      }
      case 'merge': {
        const ins = inputBlobs(node.id, 'in');
        if (!ins.length) throw new Error('no inputs to merge');
        if (ins.length === 1) return ins[0];
        const ctx = getEngineCtx();
        if (!ctx) throw new Error('audio engine unavailable');
        const bufs = await Promise.all(
          ins.map(async (b) => ctx.decodeAudioData(await b.arrayBuffer())),
        );
        const sr = ctx.sampleRate;
        const length = Math.max(...bufs.map((b) => b.length));
        const channels = Math.min(2, Math.max(1, ...bufs.map((b) => b.numberOfChannels)));
        const off = new OfflineAudioContext(channels, length, sr);
        for (const b of bufs) {
          const src = off.createBufferSource();
          src.buffer = b;
          src.connect(off.destination);
          src.start(0);
        }
        let rendered = await off.startRendering();
        if (String(node.params.normalize ?? '1') === '1') rendered = normalizeBuffer(rendered);
        return encodeWav(rendered);
      }
      case 'output': {
        const input = inputBlob(node.id, 'in');
        if (!input) throw new Error('no input audio');
        if (String(node.params.save ?? '1') === '1') {
          const name = String(node.params.name || '').trim() || 'nodefi-output';
          await useLibraryStore.getState().importEntry({
            blob: input,
            filename: `${name}.wav`,
            mimeType: 'audio/wav',
          });
        }
        return input;
      }
      case 'feedback':
        // Handled inline in the pass loop; never dispatched here.
        return inputBlob(node.id, 'in') ?? new Blob();
      case 'suno': {
        // Cloud generation through the backend Suno proxy — zero local GPU.
        // The key lives server-side (Settings → Models); we submit, poll, and
        // pull the finished MP3 back as this node's output blob.
        const prompt = String(node.params.prompt || '').trim();
        if (!prompt) throw new Error('enter a description / style');
        const { sunoApi } = await import('../suno/sunoApi');
        const status = await sunoApi.getStatus();
        if (!status.configured) throw new Error('Suno API key not set — Settings → Models');
        const title = String(node.params.title || '').trim() || undefined;
        const job =
          String(node.params.mode || 'simple') === 'custom'
            ? await sunoApi.custom({
                style: prompt,
                lyrics: String(node.params.lyrics || '').trim() || undefined,
                title,
                instrumental: String(node.params.instrumental ?? '1') === '1',
              })
            : await sunoApi.simple({ description: prompt, title });
        for (;;) {
          ensureLive();
          await wait(3000);
          ensureLive();
          const j = await sunoApi.poll(job.id);
          if (j.status === 'complete') return sunoApi.fetchAudioBlob(job.id);
          if (j.status === 'error') throw new Error(j.error || 'Suno generation failed');
        }
      }
      case 'stem':
        // A stem is a plain source — usable in offline AI graphs too.
        return fetchStemBlob(String(node.params.libraryId || ''), String(node.params.stem || 'mix'));
      case 'lfilter':
      case 'lgain':
      case 'ldelay':
      case 'xfade':
      case 'lrack':
      case 'lfo':
      case 'lout':
        throw new Error('live-only node — press LIVE to perform this graph');
    }
  }

  // Kahn topological order over the DAG (feedback outputs cut).
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of activeEdges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const e of activeEdges.filter((x) => x.from === id)) {
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }

  // Nodes reachable from any feedback output re-run every iteration.
  const dependentOnFeedback = new Set<string>();
  {
    const stack: string[] = [];
    for (const e of edges) if (feedbackIds.has(e.from)) stack.push(e.to);
    for (const fid of feedbackIds) dependentOnFeedback.add(fid);
    while (stack.length) {
      const id = stack.pop()!;
      if (dependentOnFeedback.has(id)) continue;
      dependentOnFeedback.add(id);
      for (const e of edges.filter((x) => x.from === id)) stack.push(e.to);
    }
  }

  const feedbackVal = new Map<string, Blob | null>();
  for (const fid of feedbackIds) feedbackVal.set(fid, null);
  const maxIter = feedbackIds.size
    ? Math.max(1, ...nodes.filter((n) => n.kind === 'feedback').map((n) => num(n.params.iterations, 3)))
    : 1;

  const promise = (async () => {
    if (topo.length < nodes.length) {
      throw new Error('graph has a cycle that does not pass through a Feedback node');
    }
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) cb.onStatus(n.id, 'queued');

    for (let iter = 0; iter < maxIter; iter += 1) {
      ensureLive();
      if (maxIter > 1) log(`feedback pass ${iter + 1}/${maxIter}`);
      const capturedFeedbackInput = new Map<string, Blob | null>();

      for (const id of topo) {
        ensureLive();
        const node = nodeById.get(id)!;

        if (feedbackIds.has(id)) {
          capturedFeedbackInput.set(id, inputBlob(id, 'in'));
          const val = feedbackVal.get(id) ?? null;
          outputs.set(id, val);
          cb.onOutput(id, val);
          cb.onStatus(id, 'done');
          continue;
        }

        // Skip nodes already computed and not affected by feedback.
        if (!dependentOnFeedback.has(id) && outputs.has(id)) continue;

        cb.onStatus(id, 'running');
        try {
          const out = await runNode(node);
          ensureLive();
          outputs.set(id, out);
          cb.onOutput(id, out);
          cb.onStatus(id, 'done');
        } catch (err) {
          if (cancelled) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          outputs.set(id, null);
          cb.onStatus(id, 'error', msg);
          log(`${node.title || node.kind} error: ${msg}`);
        }
      }

      for (const [fid, val] of capturedFeedbackInput) feedbackVal.set(fid, val);
    }
  })();

  return { promise, cancel };
}
