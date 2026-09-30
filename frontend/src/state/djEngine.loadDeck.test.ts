/**
 * djEngine.loadDeck — the same URL again leaves a deck alone, and a deck
 * shares its decode with its waveform lanes.
 *
 * The bug (PR #207 review): DJView re-ran its deck-load effect on every
 * library lookup, and `loadDeck` had no same-URL guard. Each re-run stopped
 * the deck, rewound it to 0:00, dropped its buffer and fetched and decoded
 * the whole file again, so a playing track cut out whenever an unrelated
 * lookup landed. `loadDeck` also did its own fetch + decode outside
 * `lib/djAudioCache`, so a deck and its two lanes downloaded the file twice.
 *
 * Each case below replays the order a real session produces, against the real
 * engine on a fake AudioContext (`djEngineTestRig`).
 *
 * Run: `npx tsx src/state/djEngine.loadDeck.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

const djEngine = await import('./djEngine.ts');
const { decodeAudio } = await import('../components/audio/djSemanticWaveformAnalysis.ts');
const { evictAll } = await import('../lib/djAudioCache.ts');
const { installDjEngineRig } = await import('./djEngineTestRig.ts');

const rig = installDjEngineRig(48000);
const fetchesOf = (url: string) => rig.fetches.filter((f) => f === url).length;

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

const reset = async () => {
  await djEngine.loadDeck('A', null, null);
  await djEngine.loadDeck('B', null, null);
  evictAll();
  rig.fetches.length = 0;
};

await test('a playing deck loaded again with its own URL keeps playing where it is', async () => {
  await reset();
  const url = rig.audioUrlOf('track-x');
  await djEngine.loadDeck('A', url, 'Track X');
  djEngine.playDeck('A');
  rig.advance(30);
  assert.equal(djEngine.getStatus('A').playing, true);
  const before = djEngine.getStatus('A').currentTime;
  assert.ok(Math.abs(before - 30) < 1e-6, `deck at ${before}s`);

  // The effect re-ran (a lookup for some other row landed).
  await djEngine.loadDeck('A', url, 'Track X');
  await rig.settle();

  const st = djEngine.getStatus('A');
  assert.equal(st.playing, true, 'THE BUG: the re-run stopped the deck');
  assert.ok(Math.abs(st.currentTime - 30) < 1e-6, `THE BUG: the re-run rewound the deck to ${st.currentTime}s`);
  assert.equal(st.hasBuffer, true);
  assert.equal(fetchesOf(url), 1, 'THE BUG: the re-run fetched the whole file again');
});

await test('a second load of the same URL while the first is decoding joins it', async () => {
  await reset();
  const url = rig.audioUrlOf('track-y');
  const first = djEngine.loadDeck('B', url, 'Track Y');
  // Before the decode lands, the lookup lands too and the effect re-runs.
  const second = djEngine.loadDeck('B', url, 'Track Y');
  await Promise.all([first, second]);
  await rig.settle();
  assert.equal(fetchesOf(url), 1, 'one fetch for one track');
  assert.equal(djEngine.getStatus('B').hasBuffer, true);
  assert.equal(djEngine.getStatus('B').decoding, false);
});

await test('the same URL still reloads after a failed load, so a retry works', async () => {
  await reset();
  const url = '/api/library/audio-missing/gone.wav';
  await djEngine.loadDeck('A', url, 'Gone');
  assert.equal(djEngine.getStatus('A').hasBuffer, false, 'the fake answers 404 for this URL');
  await djEngine.loadDeck('A', url, 'Gone');
  assert.equal(fetchesOf(url), 2, 'a failed URL is fetched again');
});

await test('a different URL still replaces the track', async () => {
  await reset();
  const x = rig.audioUrlOf('track-x');
  const z = rig.audioUrlOf('track-z');
  await djEngine.loadDeck('A', x, 'X');
  djEngine.playDeck('A');
  rig.advance(12);
  await djEngine.loadDeck('A', z, 'Z');
  const st = djEngine.getStatus('A');
  assert.equal(st.loadedUrl, z);
  assert.equal(st.playing, false, 'a new track starts stopped');
  assert.equal(st.currentTime, 0, 'at its top');
  assert.equal(st.label, 'Z');
});

await test('a deck and its waveform lane share one fetch and one decode', async () => {
  await reset();
  const url = rig.audioUrlOf('track-shared');
  const decodesBefore = rig.decodes();
  await djEngine.loadDeck('A', url, 'Shared');
  // A lane asks with no context, exactly as DJSemanticWaveform does.
  const laneBuffer = await decodeAudio(url);
  assert.equal(fetchesOf(url), 1, 'THE BUG: the deck and the lane fetched the file separately');
  assert.equal(rig.decodes() - decodesBefore, 1, 'THE BUG: the deck and the lane decoded it separately');
  assert.equal((laneBuffer as unknown as { url: string }).url, url);
});

await test('a lane that asks first is joined by the deck, not repeated', async () => {
  await reset();
  // DJView registers the engine context on mount, before any lane exists.
  djEngine.shareDecodeContext();
  const url = rig.audioUrlOf('track-lane-first');
  const decodesBefore = rig.decodes();
  const lane = decodeAudio(url);
  await djEngine.loadDeck('B', url, 'Lane first');
  await lane;
  assert.equal(fetchesOf(url), 1);
  assert.equal(rig.decodes() - decodesBefore, 1);
  assert.equal(djEngine.getStatus('B').hasBuffer, true);
});

console.log(`\ndjEngine.loadDeck: ${passed} passed`);
