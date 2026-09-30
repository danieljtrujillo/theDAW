// Run with: npx tsx src/state/generateStore.completion.test.ts
//
// Audit fixes for T17's seed/auto-download items, replayed through the real
// submitGeneration against a stub backend (same shape as generateStore.cancel.test.ts):
//   1. lastSeedUsed comes from the COMPLETED job's per-take seed
//      (result.item.seed / result.items[i].seed), not the POST reply — except
//      as an early fallback when the backend predates that field, and NEVER
//      from a heal pass's own seed (the take's seed is read before `items` is
//      replaced by the heal result).
//   2. The auto-download toggle saves every take that has audio, not just item 0.
//   3. The re-entry claim (isGenerating) runs BEFORE the cloud-model branch, so
//      a call arriving mid-run — e.g. the assistant's generate action, with
//      `model` switched to suno — cannot reset a live local run's caption or
//      fire a Suno submit while that run is still going.
import assert from 'node:assert/strict';
import { useGenerateStore, type GenerateParams } from './generateStore.ts';
import { useGenerateParamsStore } from './generateParamsStore.ts';
import { useLogStore } from './logStore.ts';

(globalThis as { window?: unknown }).window ??= globalThis;

// downloadBlob() needs `document.createElement('a')` + `.click()` — stub just
// enough to record what it tried to save, since this is plain Node (no DOM).
type Download = { filename: string };
const downloads: Download[] = [];
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => {
    assert.equal(tag, 'a', 'downloadBlob only ever creates an anchor');
    const a = {
      href: '',
      download: '',
      click(this: { download: string }) { downloads.push({ filename: this.download }); },
      remove() { /* no-op */ },
    };
    return a;
  },
  body: { appendChild() { /* no-op */ } },
};

type Reply = { status: number; body: unknown };
type Route = (method: string, url: string) => Reply | Promise<Reply> | null;

let route: Route = () => null;
const calls: Array<{ method: string; url: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? 'GET';
  calls.push({ method, url });
  if (url === '/api/storage/model-status') throw new Error('probe offline');
  const reply = (await route(method, url)) ?? { status: 500, body: { detail: `unrouted ${method} ${url}` } };
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const logged = (text: string): boolean => useLogStore.getState().entries.some((e) => e.msg.includes(text));

const gen = useGenerateStore.getState;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, what: string, ms = 6000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (statusLabel=${gen().statusLabel})`);
    await sleep(10);
  }
};
const step = (name: string): void => console.log(`- ${name}`);

const PARAMS: GenerateParams = {
  prompt: 'a test tone',
  negativePrompt: '',
  model: 'small',
  duration: 10,
  steps: 8,
  cfg: 1,
  seed: -1,
  batch: 1,
  initNoise: 1,
  initType: 'Audio',
};

(async () => {
  // (a) Single-take completion: lastSeedUsed is the completed item's own seed.
  {
    step('(a) single-take completion sets lastSeedUsed from result.item.seed');
    route = (method, url) => {
      // Real shape: `seed` nests inside `job` (T01), not a top-level field —
      // an early value (111) the completed result (555) must still win over.
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'a1', seed: 111 } } };
      if (method === 'GET' && url === '/api/jobs/a1') {
        return {
          status: 200,
          body: { id: 'a1', status: 'completed', result: { batch: false, item: { audio_base64: 'AAAA', mime_type: 'audio/wav', filename: 'a1.wav', seed: 555 } } },
        };
      }
      return null;
    };
    downloads.length = 0;
    await gen().submitGeneration(PARAMS);
    await until(() => gen().statusLabel === 'COMPLETE', 'a1 to complete');
    assert.equal(gen().lastSeedUsed, 555);
    assert.equal(downloads.length, 0, 'autoDownload is off by default');
  }

  // (b) POST reply's early seed is used as a fallback when the completed
  // result carries none (an older backend).
  {
    step('(b) POST-reply seed is a fallback, not overridden by an absent completed seed');
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'b1', seed: 777 } } };
      if (method === 'GET' && url === '/api/jobs/b1') {
        return {
          status: 200,
          body: { id: 'b1', status: 'completed', result: { batch: false, item: { audio_base64: 'AAAA', mime_type: 'audio/wav', filename: 'b1.wav' } } },
        };
      }
      return null;
    };
    await gen().submitGeneration(PARAMS);
    await until(() => gen().statusLabel === 'COMPLETE', 'b1 to complete');
    assert.equal(gen().lastSeedUsed, 777, 'falls back to the early POST-reply seed');
  }

  // (c) The completed result's seed wins over the early POST-reply seed when
  // both are present (T01: "the completed result wins").
  {
    step('(c) the completed result seed overrides the early POST-reply seed');
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'c1', seed: 1 } } };
      if (method === 'GET' && url === '/api/jobs/c1') {
        return {
          status: 200,
          body: { id: 'c1', status: 'completed', result: { batch: false, item: { audio_base64: 'AAAA', mime_type: 'audio/wav', filename: 'c1.wav', seed: 999 } } },
        };
      }
      return null;
    };
    await gen().submitGeneration(PARAMS);
    await until(() => gen().statusLabel === 'COMPLETE', 'c1 to complete');
    assert.equal(gen().lastSeedUsed, 999);
  }

  // (d) Batch: lastSeedUsed is the BASE take's seed (items[0]), and auto-
  // download saves every take with audio — not just the first — under
  // distinct filenames, skipping a take with no audio payload.
  {
    step('(d) batch completion: base-take seed, auto-download every take');
    useGenerateParamsStore.getState().patch({ autoDownload: true });
    route = (method, url) => {
      // The early POST-reply seed (500) is the base seed the batch started
      // from; the completed base take's own seed (100) still wins.
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'd1', seed: 500 } } };
      if (method === 'GET' && url === '/api/jobs/d1') {
        return {
          status: 200,
          body: {
            id: 'd1',
            status: 'completed',
            result: {
              batch: true,
              items: [
                { audio_base64: 'AAAA', mime_type: 'audio/wav', filename: 'd1_00.wav', seed: 100 },
                { audio_base64: 'BBBB', mime_type: 'audio/wav', filename: 'd1_01.wav', seed: 101 },
                { seed: 102 }, // no audio_base64: a failed take in the batch — must not be "downloaded"
              ],
            },
          },
        };
      }
      return null;
    };
    downloads.length = 0;
    await gen().submitGeneration({ ...PARAMS, batch: 3 });
    await until(() => gen().statusLabel === 'COMPLETE', 'd1 to complete');
    assert.equal(gen().lastSeedUsed, 100, 'the base take (items[0]) seed, not the last one');
    assert.deepEqual(downloads.map((d) => d.filename), ['d1_00.wav', 'd1_01.wav'], 'every take with audio, distinct filenames, none for the audio-less take');
    useGenerateParamsStore.getState().patch({ autoDownload: false });
  }

  // (e) Chimera HEAL = 'polish': lastSeedUsed is the FIRST pass's take seed,
  // never the heal job's — the heal pass's own seed must not leak in even
  // though its `items` becomes the run's final audio.
  {
    step('(e) heal pass: lastSeedUsed is the first pass’s seed, not the heal job’s');
    const clip = (label: string) => ({ id: label, blob: new Blob([new Uint8Array(8)]), mimeType: 'audio/wav', label, noise: 0.5, isBase: false });
    const base = useGenerateParamsStore.getState().chimera;
    useGenerateParamsStore.getState().patch({ chimera: { ...base, clips: [clip('clip-a'), clip('clip-b')], heal: 'polish' } });
    const mashup: Reply = {
      status: 200,
      body: {
        mix_base64: 'AAAA', mime: 'audio/wav', duration_sec: 10,
        target_bpm_used: 120, target_bpm_source: 'auto', align_mode_used: 'weave',
        seams: [{ heal_start_sec: 4, heal_end_sec: 6 }], per_clip: [], warnings: [],
      },
    };
    let posts = 0;
    route = (method, url) => {
      if (method === 'POST' && url === '/api/chimera/mashup') return mashup;
      if (method === 'POST' && url === '/api/generate-jobs') {
        posts += 1;
        // Real shape for both POSTs: `seed` nests inside `job`. The first
        // pass's early seed (10) is overridden by its own completed seed
        // (42) below; the heal POST's seed (9999) must never reach
        // lastSeedUsed at all — the take's seed is the FIRST pass's.
        return posts === 1
          ? { status: 200, body: { job: { id: 'first-e', seed: 10 } } }
          : { status: 200, body: { job: { id: 'heal-e', seed: 9999 } } };
      }
      if (method === 'GET' && url === '/api/jobs/first-e') {
        return { status: 200, body: { id: 'first-e', status: 'completed', result: { batch: false, item: { audio_base64: 'AAAA', mime_type: 'audio/wav', filename: 'first.wav', seed: 42 } } } };
      }
      if (method === 'GET' && url === '/api/jobs/heal-e') {
        return { status: 200, body: { id: 'heal-e', status: 'completed', result: { batch: false, item: { audio_base64: 'CCCC', mime_type: 'audio/wav', filename: 'heal.wav', seed: 9999 } } } };
      }
      return null;
    };
    await gen().submitGeneration(PARAMS);
    await until(() => gen().statusLabel === 'COMPLETE', 'the healed run to complete');
    assert.equal(posts, 2, 'the heal pass really POSTed a second /api/generate-jobs job');
    assert.equal(gen().lastFilename, 'heal.wav', 'the healed take is the run’s result, confirming the heal pass ran and won');
    assert.equal(gen().lastSeedUsed, 42, 'the first pass’s seed, never the heal job’s 9999');
    useGenerateParamsStore.getState().patch({ chimera: { ...base, clips: [] } });
  }

  // (f) Re-entry claim runs before the cloud branch: a call arriving mid-run
  // (simulating the assistant's generate action, model switched to suno)
  // must not touch the live local run's caption or reach Suno at all.
  {
    step('(f) a call mid-run (model=suno) is ignored, not routed to the cloud branch');
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'f1', seed: 7 } } };
      if (method === 'GET' && url === '/api/jobs/f1') return { status: 200, body: { id: 'f1', status: 'running', progress: { step: 1, steps: 8 } } };
      return null;
    };
    const run = gen().submitGeneration(PARAMS);
    await until(() => gen().jobStatus === 'running', 'f1 to start running');
    const statusBefore = gen().statusLabel;
    const errorBefore = gen().error;
    const callsBefore = calls.length;

    await gen().submitGeneration({ ...PARAMS, model: 'suno' });

    assert.equal(gen().statusLabel, statusBefore, 'the live run’s caption is untouched (the cloud branch never ran its READY reset)');
    assert.equal(gen().error, errorBefore);
    assert.equal(gen().isGenerating, true, 'the local run is still live');
    assert.equal(calls.length, callsBefore, 'no fetch at all from the ignored call — not even a Suno one');
    assert.ok(!calls.slice(callsBefore).some((c) => c.url.startsWith('/api/suno')), 'never reached sunoStore.submit');
    assert.ok(logged('CREATE ignored: a run is already in progress'));

    gen().cancelGeneration();
    await until(() => gen().statusLabel === 'CANCELLING...' || gen().statusLabel === 'CANCELLED', 'f1 to start cancelling');
    await run.catch(() => undefined);
  }

  // (g) A rejecting/missing markAutomaticDownloads (a newer renderer against
  // an older packaged shell, or the IPC call itself failing) must not fail an
  // otherwise-finished run: the completion set() already landed (COMPLETE,
  // lastSeedUsed, lastAudioUrl) before the auto-download block runs, and the
  // steps after it (library refresh etc.) still have to execute.
  {
    step('(g) a rejecting markAutomaticDownloads does not fail the run');
    useGenerateParamsStore.getState().patch({ autoDownload: true });
    (globalThis as unknown as { window: { electronAPI?: unknown } }).window.electronAPI = {
      markAutomaticDownloads: async () => { throw new Error('IPC handler missing on this packaged shell'); },
    };
    route = (method, url) => {
      if (method === 'POST' && url === '/api/generate-jobs') return { status: 200, body: { job: { id: 'g1', seed: 321 } } };
      if (method === 'GET' && url === '/api/jobs/g1') {
        return { status: 200, body: { id: 'g1', status: 'completed', result: { batch: false, item: { audio_base64: 'AAAA', mime_type: 'audio/wav', filename: 'g1.wav', seed: 321 } } } };
      }
      return null;
    };
    downloads.length = 0;
    await gen().submitGeneration(PARAMS);
    await until(() => gen().statusLabel === 'COMPLETE', 'g1 to complete despite the rejecting IPC call');
    assert.equal(gen().jobStatus, 'completed');
    assert.notEqual(gen().statusLabel, 'FAILED');
    assert.equal(gen().lastSeedUsed, 321, 'the completion set() still landed');
    assert.equal(gen().lastAudioUrl !== null, true);
    assert.equal(downloads.length, 0, 'the download itself never ran — markAutomaticDownloads rejected before the click loop');
    assert.ok(logged('Auto-download failed (the run itself still completed)'));
    delete (globalThis as unknown as { window: { electronAPI?: unknown } }).window.electronAPI;
    useGenerateParamsStore.getState().patch({ autoDownload: false });
  }

  console.log('generateStore: seed/auto-download completion contract passed');
  process.exit(0);
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
