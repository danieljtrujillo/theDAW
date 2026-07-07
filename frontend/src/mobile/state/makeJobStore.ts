/** Standalone generate-job runner for the phone MAKE tab. Pure REST — no
 *  desktop host needed: submit to /api/generate-jobs (SA3) or
 *  /api/magenta/generate (magenta-*), poll for status, then surface the
 *  finished take as a library entry streamed from /api/library/audio/{id}.
 *
 *  Lives at module scope (zustand) so a run survives tab switches — the
 *  component unmounts but the poll loop keeps going.
 *
 *  Polling deliberately differs from the desktop's generateStore: SA3 polls
 *  the GET /api/jobs LIST (summaries with result stripped) instead of
 *  GET /api/jobs/{id}, so the phone never downloads the multi-megabyte
 *  base64 result — playback streams from the library entry instead.
 *  Magenta has no list endpoint, so those jobs poll by id. */
import { create } from 'zustand';
import { useLibraryStore } from '../../state/libraryStore';

export type MakePhase =
  | 'idle'
  | 'starting'
  | 'queued'
  | 'sampling'
  | 'saving'
  | 'done'
  | 'error';

type JobSummary = {
  id?: string;
  status?: string;
  progress?: { step?: number; steps?: number };
  error?: string;
};

export type MakeSubmit = {
  model: string;
  prompt: string;
  duration: number;
  /** Registered local checkpoint ckpt_path (fallback: display name) by id —
   *  used only to detect RF checkpoints (they need RF sampler defaults).
   *  Path first, matching the desktop picker: the registry defaults a
   *  checkpoint's display name to its parent FOLDER, so the "-rf" marker
   *  usually lives only in the filename. */
  localNames: Record<string, string>;
};

type MakeJobState = {
  phase: MakePhase;
  /** Sampling progress 0-100 (raw step/steps, not the desktop's paced pct). */
  pct: number;
  jobId: string | null;
  error: string;
  /** Library entry id of the finished take (null if it could not be located —
   *  the take still exists in the Library). */
  entryId: string | null;
  title: string;
  /** Form state lives here (not in the component) so it survives tab
   *  switches, same as the run itself. */
  prompt: string;
  model: string;
  duration: number;
  setPrompt: (v: string) => void;
  setModel: (v: string) => void;
  setDuration: (v: number) => void;
  submit: (req: MakeSubmit) => Promise<void>;
  cancel: () => void;
  dismiss: () => void;
};

const POLL_MS = 1000;

/** Bumped to invalidate an in-flight run (cancel / superseding submit). */
let runToken = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errText(payload: unknown, fallback: string): string {
  const p = payload as { error?: unknown; detail?: unknown } | null;
  if (p && typeof p.error === 'string' && p.error) return p.error;
  if (p && typeof p.detail === 'string' && p.detail) return p.detail;
  return fallback;
}

/** Mirror of the desktop CREATE guard (generateStore.ts): block only when the
 *  backend says no model is usable, or the chosen SA3 model is missing /
 *  download-blocked. Probe failures never block. Magenta and local
 *  checkpoints are exempt like on desktop. */
async function guardModel(model: string): Promise<string | null> {
  if (model.startsWith('magenta-') || model.startsWith('local:')) return null;
  try {
    const r = await fetch('/api/storage/model-status');
    if (!r.ok) return null;
    const s = (await r.json()) as {
      usable_generation?: boolean;
      local_only?: boolean;
      providers?: Array<{ id?: string; models?: Array<{ id?: string; source?: string }> }>;
    };
    if (s.usable_generation === false) {
      return 'No usable generation model. Set one up in Settings > Models on the desktop.';
    }
    const stable = s.providers?.find((p) => p.id === 'stable');
    const m = stable?.models?.find((x) => x.id === model);
    if (m?.source === 'missing') {
      return `Model "${model}" is not available on the desktop.`;
    }
    if (m?.source === 'download' && s.local_only) {
      return `Model "${model}" needs a download, but the desktop is in local-only mode.`;
    }
  } catch {
    /* status probe unreachable — proceed, the job submit will surface real errors */
  }
  return null;
}

function buildForm(req: MakeSubmit): { endpoint: string; form: FormData; magenta: boolean } {
  const magenta = req.model.startsWith('magenta-');
  const form = new FormData();
  if (magenta) {
    form.append('prompt', req.prompt);
    form.append('duration', String(req.duration));
    form.append('model_size', req.model.slice('magenta-'.length) || 'small');
    return { endpoint: '/api/magenta/generate', form, magenta };
  }
  // RF checkpoints need RF sampler defaults (same rule as the desktop model
  // picker): id ends in -rf, or a registered local checkpoint whose name
  // reads as an RF export.
  const localName = req.localNames[req.model] ?? '';
  const isRf = req.model.endsWith('-rf') || /-rf\b|-rf[._-]/i.test(localName);
  form.append('model_name', req.model);
  form.append('prompt', req.prompt);
  form.append('negative_prompt', '');
  form.append('duration', String(req.duration));
  form.append('steps', String(isRf ? 50 : 8));
  form.append('cfg_scale', String(isRf ? 7.0 : 1.0));
  form.append('seed', '-1');
  form.append('batch_size', '1');
  form.append('file_format', 'wav');
  form.append('file_naming', 'verbose');
  return { endpoint: '/api/generate-jobs', form, magenta };
}

/** Poll error that retrying cannot fix (the job is definitively gone). */
class JobLostError extends Error {}

/** One poll tick -> the job's current summary, or a thrown error. */
async function pollOnce(jobId: string, magenta: boolean): Promise<JobSummary> {
  if (magenta) {
    // summary=1 strips the result payload (base64 WAV) server-side; older
    // backends ignore the param and return the full job, which still works.
    const r = await fetch(`/api/magenta/jobs/${jobId}?summary=1`);
    if (r.status === 404) throw new JobLostError('Server restarted or lost the job. Try again.');
    if (!r.ok) {
      throw new Error(errText(await r.json().catch(() => null), `Polling failed (HTTP ${r.status}).`));
    }
    return (await r.json()) as JobSummary;
  }
  const r = await fetch('/api/jobs');
  if (!r.ok) {
    throw new Error(errText(await r.json().catch(() => null), `Polling failed (HTTP ${r.status}).`));
  }
  const list = (await r.json()) as { jobs?: JobSummary[] };
  const job = (list.jobs ?? []).find((j) => j.id === jobId);
  if (!job) throw new JobLostError('Server restarted or lost the job. Try again.');
  return job;
}

export const useMakeJobStore = create<MakeJobState>((set, get) => ({
  phase: 'idle',
  pct: 0,
  jobId: null,
  error: '',
  entryId: null,
  title: '',
  prompt: '',
  model: 'medium',
  duration: 110,

  setPrompt: (v) => set({ prompt: v }),
  setModel: (v) => set({ model: v }),
  setDuration: (v) => set({ duration: v }),

  submit: async (req) => {
    const prompt = req.prompt.trim();
    if (!prompt) return;
    const phase = get().phase;
    if (phase !== 'idle' && phase !== 'done' && phase !== 'error') return;

    const token = ++runToken;
    const live = () => runToken === token;
    set({ phase: 'starting', pct: 0, jobId: null, error: '', entryId: null, title: '' });

    try {
      const blocked = await guardModel(req.model);
      if (!live()) return;
      if (blocked) throw new Error(blocked);

      const { endpoint, form, magenta } = buildForm({ ...req, prompt });
      const r = await fetch(endpoint, { method: 'POST', body: form });
      const payload: unknown = await r.json().catch(() => null);
      if (!live()) return;
      if (!r.ok) throw new Error(errText(payload, `HTTP ${r.status} ${r.statusText}`));
      const jobId = (payload as { job?: { id?: string } } | null)?.job?.id;
      if (!jobId) throw new Error(`Backend did not return a job id for ${endpoint}.`);
      set({ phase: 'queued', jobId });

      // Poll until the job leaves queued/running. Transient poll failures
      // (Wi-Fi blip, screen-lock suspend/resume, backend hiccup) must not
      // kill the watch on a multi-minute generation — ride out up to ~30s
      // of consecutive misses before surfacing an error. Real job failures
      // still surface immediately via status === 'failed'.
      let misses = 0;
      for (;;) {
        await sleep(POLL_MS);
        if (!live()) return;
        let job: JobSummary;
        try {
          job = await pollOnce(jobId, magenta);
          misses = 0;
        } catch (e) {
          if (!live()) return;
          if (e instanceof JobLostError) throw e;
          if (++misses <= 30) continue;
          throw e;
        }
        if (!live()) return;
        const status = job.status ?? '';
        if (status === 'queued') {
          set({ phase: 'queued' });
        } else if (status === 'running') {
          const steps = Math.max(1, job.progress?.steps ?? 1);
          const step = Math.max(0, job.progress?.step ?? 0);
          set({ phase: 'sampling', pct: Math.min(99, Math.round((step / steps) * 100)) });
        } else if (status === 'completed') {
          break;
        } else if (status === 'failed') {
          throw new Error(job.error || 'Generation failed.');
        } else {
          throw new Error(`Unexpected job status: ${status || '(none)'}.`);
        }
      }

      // The backend has saved the take as library entry {jobId}_00 (first
      // batch item) — refresh and locate it, retrying briefly since the
      // artifact write is asynchronous relative to job completion.
      set({ phase: 'saving', pct: 100 });
      const lib = useLibraryStore.getState();
      let entryId: string | null = null;
      let title = '';
      for (let i = 0; i < 6; i++) {
        await lib.refresh();
        if (!live()) return;
        const entries = useLibraryStore.getState().entries;
        const hit = entries.find((e) => e.id === `${jobId}_00`) ?? entries.find((e) => e.id === jobId);
        if (hit) {
          entryId = hit.id;
          title = hit.title || prompt;
          break;
        }
        await sleep(500);
        if (!live()) return;
      }
      set({ phase: 'done', entryId, title: title || prompt });
    } catch (e) {
      if (!live()) return;
      set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },

  cancel: () => {
    // Client-side only (matches desktop): stops watching, the backend job
    // keeps running and its take still lands in the Library when it finishes.
    runToken++;
    set({ phase: 'idle', pct: 0, jobId: null, error: '' });
  },

  dismiss: () => {
    set({ phase: 'idle', pct: 0, jobId: null, error: '', entryId: null, title: '' });
  },
}));
