/**
 * The DJ waveform's analysis loop, off the main thread (DJ-2).
 *
 * `analyzeBuffer` is ~51M inner iterations for a 3.5-minute track (≈6,400
 * bins x 723 samples x 11 Goertzel frequencies) plus one `Float32Array` per
 * bin. Run inline in a `useEffect` — once per waveform instance, and the
 * default layout mounts four of them across two decks — that is 0.6-2 s of
 * frozen UI at automix start.
 *
 * This worker runs the exact same {@link analyzeChannels} function the
 * in-process path runs, on transferred COPIES of the buffer's channel data,
 * so the result is identical arithmetic on identical `Float32Array`s.
 *
 * It keeps the channel data of the LAST buffer it analysed for
 * {@link WORKER_RETAIN_MS}, so another analysis of the same audio (a resize
 * or a zoom that changes the bin count, a `normalize` flip) arrives without
 * any channel data and costs the main thread no copy. A request for audio it
 * no longer holds is answered `missing`, and the main thread sends it.
 *
 * Instantiated lazily by `djSemanticWaveformAnalysis.analyzeBufferAsync`;
 * where `Worker` does not exist (node/tsx tests, inside a worker) that module
 * falls back to the synchronous path and this file is never loaded.
 */
import {
  WORKER_RETAIN_MS,
  analyzeChannels,
  type AnalyzeRequest,
  type AnalyzeResponse,
} from './djSemanticWaveformAnalysis';

/** The worker globals this file uses. Declared structurally rather than as
 *  `DedicatedWorkerGlobalScope`: the project's `lib` is the DOM one, and
 *  adding `webworker` to it would collide with half of the DOM types. */
type WorkerScope = {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResponse): void;
};

const scope = self as unknown as WorkerScope;

type HeldAudio = { dataKey: string; channels: Float32Array[]; length: number; sampleRate: number };
let held: HeldAudio | null = null;
let dropTimer: ReturnType<typeof setTimeout> | null = null;

/** Keep `held` for another {@link WORKER_RETAIN_MS}, then let it go. */
function keepHeld(): void {
  if (dropTimer !== null) clearTimeout(dropTimer);
  dropTimer = setTimeout(() => {
    dropTimer = null;
    held = null;
  }, WORKER_RETAIN_MS);
}

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const request = event.data;
  if (request.type === 'drop') {
    if (request.dataKey === null || held?.dataKey === request.dataKey) held = null;
    return;
  }
  const { id, dataKey, channels, length, sampleRate, bins, normalize } = request;
  if (channels) {
    held = { dataKey, channels, length, sampleRate };
  } else if (held?.dataKey !== dataKey) {
    scope.postMessage({ id, missing: true });
    return;
  }
  keepHeld();
  const audio = held as HeldAudio;
  let response: AnalyzeResponse;
  try {
    response = { id, bins: analyzeChannels(audio.channels, audio.length, audio.sampleRate, bins, normalize) };
  } catch (err) {
    response = { id, error: err instanceof Error ? err.message : 'waveform analysis failed' };
  }
  scope.postMessage(response);
};
