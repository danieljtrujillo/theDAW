/**
 * Test-only rig that lets the real `djEngine` run under plain `tsx`.
 *
 * `djEngine` builds its graph on `playerStore.getEngineCtx()`, which constructs
 * `window.AudioContext`, and loads a deck through `lib/djAudioCache`, which
 * fetches the URL and decodes it through that context. This installs a fake
 * context whose nodes accept every call the engine makes, a `fetch` that
 * serves audio and library rows and records every request, and a clock the
 * test moves by hand, so a test can load a deck, play it, let time pass and
 * then check what a later event did to it.
 *
 * Install it AFTER importing anything that pulls in `playerStore`: that module
 * reads `import.meta.env.DEV` behind a `typeof window` check at load time, and
 * plain tsx has no `import.meta.env`.
 *
 * Nothing in the app imports this file.
 */

/** An AudioParam that takes every scheduling call, keeps the last value and
 *  records every value it was sent in `history`. */
function fakeParam(): Record<string, unknown> {
  const history: number[] = [];
  const p: Record<string, unknown> = { value: 0, history };
  for (const name of [
    'setValueAtTime',
    'linearRampToValueAtTime',
    'exponentialRampToValueAtTime',
    'setTargetAtTime',
    'cancelScheduledValues',
  ]) {
    p[name] = (v: unknown) => {
      if (typeof v === 'number') {
        p.value = v;
        history.push(v);
      }
      return p;
    };
  }
  return p;
}

/** One node type for every node the engine creates. */
class FakeNode {
  gain = fakeParam();
  frequency = fakeParam();
  Q = fakeParam();
  delayTime = fakeParam();
  playbackRate = fakeParam();
  threshold = fakeParam();
  knee = fakeParam();
  ratio = fakeParam();
  attack = fakeParam();
  release = fakeParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  fftSize = 2048;
  smoothingTimeConstant = 0;
  stream = {};
  onended: (() => void) | null = null;
  connect<T>(to: T): T {
    return to;
  }
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}

/** The decoded audio for a URL: only what the engine reads. */
export interface FakeAudioBuffer {
  duration: number;
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  url: string;
  getChannelData: (ch: number) => Float32Array;
}

/** The fake key-lock insert (`signalsmith-stretch`'s node): records what the
 *  engine asks of it. */
export interface FakeStretch {
  /** Every `schedule({...})` call, in order. */
  schedules: Array<Record<string, unknown>>;
  /** Every remote call by name, in order. */
  calls: string[];
}

export interface DjEngineRig {
  /** Every URL fetched, in order. */
  fetches: string[];
  /** How many times the fake context decoded something. */
  decodes: () => number;
  /** Move the audio clock forward. */
  advance: (seconds: number) => void;
  /** The audio URL the rig serves for a library entry id. */
  audioUrlOf: (entryId: string) => string;
  /** Library rows the rig serves on `/api/library/entries/{id}`. Add or
   *  remove ids to change what a single-entry lookup answers. */
  rows: Map<string, { title: string }>;
  /** Hold every single-entry lookup for these ids until `release(id)`. */
  hold: Set<string>;
  release: (entryId: string) => Promise<void>;
  /** The page `GET /api/library/entries?...` answers with (ids, in order). */
  page: string[];
  /** Wait for every pending promise job and timer tick. */
  settle: () => Promise<void>;
  /** The delay-line `delayTime` of every Delay node the engine built, in
   *  creation order (a deck builds one; the first deck built is first). */
  delays: Array<{ value: number; history: number[] }>;
  /** The `gain` of every BiquadFilter the engine built, in creation order. A
   *  deck builds its low, mid and high EQ bands first, then its DJ filter. */
  biquadGains: Array<{ value: number; history: number[] }>;
  /** Every AudioBufferSourceNode the engine started, in order. Call the last
   *  one's `onended` to replay a track reaching its natural end. */
  sources: Array<{ onended: (() => void) | null }>;
  /** Key-lock inserts. Set `hold` before a first engage to keep the
   *  stretcher "loading" until `releaseStretch()`. */
  stretch: { hold: boolean; latency: number; nodes: FakeStretch[] };
  releaseStretch: () => Promise<void>;
}

/** Install the rig on `globalThis`. `sampleRate` is the fake engine's rate. */
export function installDjEngineRig(sampleRate = 48000): DjEngineRig {
  let now = 0;
  let decodeCount = 0;
  const fetches: string[] = [];
  const rows = new Map<string, { title: string }>();
  const hold = new Set<string>();
  const held = new Map<string, () => void>();
  const page: string[] = [];
  const audioUrlOf = (entryId: string) => `/api/library/audio/${entryId}.wav`;
  const delays: Array<{ value: number; history: number[] }> = [];
  const biquadGains: Array<{ value: number; history: number[] }> = [];
  const sources: Array<{ onended: (() => void) | null }> = [];
  const stretch = { hold: false, latency: 0.08, nodes: [] as FakeStretch[] };
  const readyWaiters: Array<() => void> = [];

  class FakeAudioContext {
    sampleRate = sampleRate;
    state = 'running';
    destination = new FakeNode();
    get currentTime(): number {
      return now;
    }
    resume(): Promise<void> {
      return Promise.resolve();
    }
    createGain() { return new FakeNode(); }
    createBiquadFilter() {
      const n = new FakeNode();
      biquadGains.push(n.gain as unknown as { value: number; history: number[] });
      return n;
    }
    createDelay() {
      const n = new FakeNode();
      delays.push(n.delayTime as unknown as { value: number; history: number[] });
      return n;
    }
    createDynamicsCompressor() { return new FakeNode(); }
    createMediaStreamDestination() { return new FakeNode(); }
    createAnalyser() { return new FakeNode(); }
    createMediaElementSource() { return new FakeNode(); }
    createBufferSource() {
      const n = new FakeNode();
      sources.push(n);
      return n;
    }
    createConvolver() { return new FakeNode(); }
    createBuffer(channels: number, length: number, rate: number) {
      return fakeBuffer('', length / rate, channels, rate);
    }
    decodeAudioData(data: ArrayBuffer): Promise<FakeAudioBuffer> {
      decodeCount += 1;
      const text = new TextDecoder().decode(data);
      const [url, seconds] = text.split('|');
      return Promise.resolve(fakeBuffer(url, Number(seconds), 2, sampleRate));
    }
  }

  function fakeBuffer(url: string, seconds: number, channels: number, rate: number): FakeAudioBuffer {
    const length = Math.round(seconds * rate);
    return {
      duration: seconds,
      length,
      numberOfChannels: channels,
      sampleRate: rate,
      url,
      getChannelData: () => new Float32Array(16),
    };
  }

  // What `signalsmith-stretch` builds: an AudioWorkletNode whose port answers
  // a 'ready' handshake, then one reply per remote call.
  class FakeStretchNode extends FakeNode implements FakeStretch {
    schedules: Array<Record<string, unknown>> = [];
    calls: string[] = [];
    port: { onmessage: ((e: { data: unknown[] }) => void) | null; postMessage: (msg: unknown[]) => void };
    constructor() {
      super();
      const port = {
        onmessage: null as ((e: { data: unknown[] }) => void) | null,
        postMessage: (msg: unknown[]) => {
          const [id, key, ...args] = msg as [number, string, ...unknown[]];
          this.calls.push(key);
          if (key === 'schedule') this.schedules.push(args[0] as Record<string, unknown>);
          const reply = key === 'latency' ? stretch.latency : undefined;
          queueMicrotask(() => port.onmessage?.({ data: [id, reply] }));
        },
      };
      this.port = port;
      stretch.nodes.push(this);
      const ready = () => port.onmessage?.({ data: ['ready', { schedule: 1, start: 5, stop: 1, latency: 0 }] });
      if (stretch.hold) readyWaiters.push(ready);
      else setTimeout(ready, 0);
    }
  }

  class FakeAudioElement {
    crossOrigin = '';
    preload = '';
    srcObject: unknown = null;
    addEventListener(): void {}
    pause(): void {}
  }

  const row = (id: string) => ({
    id,
    title: rows.get(id)?.title ?? id,
    prompt: '',
    negative_prompt: '',
    model: '',
    duration: 180,
    steps: 0,
    cfg: 0,
    seed: 0,
    audio_url: audioUrlOf(id),
    audio_filename: `${id}.wav`,
    file_size_bytes: 1,
    mime_type: 'audio/wav',
    timestamp: '2026-09-27T00:00:00Z',
    favorite: false,
    rating: null,
    tags: [],
    notes: '',
    source: 'import',
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetches.push(url);
    const audio = url.match(/^\/api\/library\/audio\/(.+)\.wav$/);
    if (audio) return new Response(new TextEncoder().encode(`${url}|180`));
    const one = url.match(/^\/api\/library\/entries\/([^/?]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (hold.has(id)) await new Promise<void>((resolve) => held.set(id, resolve));
      return rows.has(id) ? json(row(id)) : json({ detail: 'not found' }, 404);
    }
    if (url.startsWith('/api/library/entries?')) {
      return json({ entries: page.map(row), total: page.length, offset: 0, limit: 200, revision: 1 });
    }
    return json({}, 404);
  }) as typeof fetch;

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    AudioContext: FakeAudioContext,
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  g.Audio = FakeAudioElement;
  g.AudioWorkletNode = FakeStretchNode;
  // The engine re-arms rAF while a deck plays; a frame that never fires keeps
  // the test in charge of time.
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};

  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  return {
    fetches,
    decodes: () => decodeCount,
    advance: (seconds) => {
      now += seconds;
    },
    audioUrlOf,
    rows,
    hold,
    release: async (entryId) => {
      hold.delete(entryId);
      held.get(entryId)?.();
      held.delete(entryId);
      await settle();
    },
    page,
    settle,
    delays,
    biquadGains,
    sources,
    stretch,
    releaseStretch: async () => {
      stretch.hold = false;
      for (const ready of readyWaiters.splice(0)) ready();
      await settle();
    },
  };
}
