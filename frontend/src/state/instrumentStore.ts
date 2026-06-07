import { create } from 'zustand';

/* ── instrumentStore ─────────────────────────────────────────────────────────
   Cache of AI-generated instruments (short Magenta RT2 renders decoded to
   AudioBuffers) so the Step Sequencer, Library, and assistant can trigger them
   without re-generating. Buffers are in-memory only (not persisted). */

export interface Instrument {
  id: string;
  label: string;
  source: 'text-to-synth' | 'audio-clone';
  sourcePrompt?: string;
  sourceEntryId?: string;
  buffer: AudioBuffer;
  createdAt: number;
}

interface InstrumentStoreState {
  instruments: Instrument[];
  register: (inst: Instrument) => void;
  remove: (id: string) => void;
  getBuffer: (id: string) => AudioBuffer | null;
  getByPrompt: (prompt: string) => Instrument | null;
}

export const useInstrumentStore = create<InstrumentStoreState>((set, get) => ({
  instruments: [],
  register: (inst) =>
    set((s) => ({ instruments: [...s.instruments.filter((i) => i.id !== inst.id), inst] })),
  remove: (id) => set((s) => ({ instruments: s.instruments.filter((i) => i.id !== id) })),
  getBuffer: (id) => get().instruments.find((i) => i.id === id)?.buffer ?? null,
  getByPrompt: (prompt) => get().instruments.find((i) => i.sourcePrompt === prompt) ?? null,
}));

/* ── shared helper: generate a short instrument via the Magenta sidecar ───────
   POSTs a text prompt to /api/magenta/generate, polls the job, decodes the WAV
   into an AudioBuffer, and registers it. Reused by Step Sequencer + Library. */
export async function generateInstrumentFromPrompt(
  prompt: string,
  opts: { duration?: number; label?: string } = {},
): Promise<Instrument> {
  const existing = useInstrumentStore.getState().getByPrompt(prompt);
  if (existing) return existing;

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('duration', String(opts.duration ?? 2));
  form.append('model_size', 'small');

  const res = await fetch('/api/magenta/generate', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`magenta generate failed: ${res.status}`);
  const { job } = await res.json();

  const arrayBuf = await pollMagentaJob(job.id);
  const audioBuf = await new AudioContext().decodeAudioData(arrayBuf);

  const inst: Instrument = {
    id: crypto.randomUUID(),
    label: opts.label ?? prompt,
    source: 'text-to-synth',
    sourcePrompt: prompt,
    buffer: audioBuf,
    createdAt: Date.now(),
  };
  useInstrumentStore.getState().register(inst);
  return inst;
}

/** Poll a /api/magenta job until it completes; resolves the decoded WAV bytes. */
export async function pollMagentaJob(jobId: string): Promise<ArrayBuffer> {
  for (;;) {
    const r = await fetch(`/api/magenta/jobs/${jobId}`);
    const j = await r.json();
    if (j.status === 'completed') {
      const b64: string = j.result.item.audio_base64;
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    }
    if (j.status === 'failed') throw new Error(j.error || 'magenta job failed');
    await new Promise((res) => setTimeout(res, 1000));
  }
}
