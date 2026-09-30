/**
 * pairing.ts — the phone-companion LAN pairing token (backend/lib/pairing.py).
 *
 * `initPairing()` runs once at module import, so each scenario imports the
 * module fresh (a cache-busting query, same trick as mediaBucketStore.b12.test.ts)
 * over a stubbed `window` set up before that import.
 *
 * Run: npx tsx src/lib/pairing.test.ts
 */
import assert from 'node:assert/strict';

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

function stubWindow(
  hash: string,
  pathname = '/mobile.html',
  search = '',
  storage: typeof localStorage = localStorage,
) {
  let currentHash = hash;
  const replaceStateCalls: string[] = [];
  const origin = 'http://localhost';
  const location = {
    get hash() {
      return currentHash;
    },
    pathname,
    search,
    origin,
    // apiJson.ts's pairingHeaderFor resolves relative URLs against
    // location.href -- every stubWindow caller in this file exercises a
    // relative "/api/..." URL, so a fixed origin + the live pathname/search
    // is enough; only hash is read live via the getter above.
    get href() {
      return `${origin}${pathname}${search}${currentHash}`;
    },
  };
  const history = {
    replaceState: (_state: unknown, _title: string, url: string) => {
      replaceStateCalls.push(url);
      // Emulate the browser: replaceState with a URL containing no fragment
      // clears location.hash; one containing "#..." sets it.
      const hashIdx = url.indexOf('#');
      currentHash = hashIdx === -1 ? '' : url.slice(hashIdx);
    },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { localStorage: storage, location, history };
  return { replaceStateCalls, location };
}

const importFresh = (scenario: string) =>
  import(`./pairing.ts?scenario=${scenario}`) as Promise<typeof import('./pairing.ts')>;

// No #pair= in the URL: nothing stored, header empty.
{
  store.clear();
  stubWindow('', '/', '');
  const { pairingToken, pairingHeader } = await importFresh('no-fragment');
  assert.equal(pairingToken(), null);
  assert.deepEqual(pairingHeader(), {});
}

// #pair=<token> alone: stored, stripped from the URL, header set.
{
  store.clear();
  const { replaceStateCalls, location } = stubWindow('#pair=abc123', '/mobile.html', '');
  const { pairingToken, pairingHeader, PAIRING_HEADER } = await importFresh('bare-fragment');
  assert.equal(pairingToken(), 'abc123');
  assert.deepEqual(pairingHeader(), { [PAIRING_HEADER]: 'abc123' });
  assert.equal(replaceStateCalls.length, 1, 'strips the fragment exactly once');
  assert.equal(location.hash, '', 'the token never stays in the visible URL');
}

// pair= alongside other fragment content: only pair= is removed.
{
  store.clear();
  const { location } = stubWindow('#foo=1&pair=abc123&bar=2', '/mobile.html', '');
  const { pairingToken } = await importFresh('mixed-fragment');
  assert.equal(pairingToken(), 'abc123');
  assert.equal(location.hash, '#foo=1&bar=2', 'only pair= is dropped, nothing else moves');
}

// #pair=A&pair=B: a `g`-less regex would strip only the first occurrence,
// leaving a live token in the address bar. Every occurrence must go.
{
  store.clear();
  const { location } = stubWindow('#pair=first&pair=second', '/mobile.html', '');
  const { pairingToken } = await importFresh('repeated-pair-amp');
  assert.equal(pairingToken(), 'first', 'the first occurrence is the one used');
  assert.equal(location.hash, '', 'both occurrences are stripped, not just the first');
}

// #pair=a&x=1: removing "pair=a" alone leaves a dangling leading '&' ('#&x=1').
// Every token is still gone, but the residue should be cleaned up.
{
  store.clear();
  const { location } = stubWindow('#pair=a&x=1', '/mobile.html', '');
  const { pairingToken } = await importFresh('dangling-amp');
  assert.equal(pairingToken(), 'a');
  assert.equal(location.hash, '#x=1', 'no dangling leading "&" after the "#"');
}

// #pair=A#foo=1: the literal second '#' is unrelated fragment content (not a
// pair= key), so it survives -- but the removed "#pair=A" shouldn't leave a
// dangling leading "##" in front of it.
{
  store.clear();
  const { location } = stubWindow('#pair=A#foo=1', '/mobile.html', '');
  const { pairingToken } = await importFresh('dangling-hash');
  assert.equal(pairingToken(), 'A');
  assert.equal(location.hash, '#foo=1', 'no dangling leading "##"');
}

// #pair=A#pair=B: a literal second '#' — only the first '#' in a URL starts
// the fragment, so this is one fragment string containing two pair= values,
// not two fragments.
{
  store.clear();
  const { location } = stubWindow('#pair=first#pair=second', '/mobile.html', '');
  const { pairingToken } = await importFresh('repeated-pair-hash');
  assert.equal(pairingToken(), 'first');
  assert.equal(location.hash, '', 'the stray literal #pair= is stripped too');
}

// A percent-encoded token round-trips.
{
  store.clear();
  stubWindow(`#pair=${encodeURIComponent('a b+c')}`, '/mobile.html', '');
  const { pairingToken } = await importFresh('encoded-fragment');
  assert.equal(pairingToken(), 'a b+c');
}

// A page with no fragment leaves an already-stored token alone (the common
// case: the phone paired once, then navigates around the app).
{
  store.clear();
  store.set('thedaw.pairingToken', 'already-paired');
  stubWindow('', '/mobile.html', '?view=library');
  const { pairingToken } = await importFresh('already-paired');
  assert.equal(pairingToken(), 'already-paired');
}

// Item 4: localStorage throws on every call (private browsing / quota) --
// the token must still work for the rest of THIS page load via the
// module-scope variable, not just via localStorage.
{
  store.clear();
  const throwingStorage = {
    getItem: () => {
      throw new Error('storage blocked');
    },
    setItem: () => {
      throw new Error('storage blocked');
    },
    removeItem: () => {
      throw new Error('storage blocked');
    },
  };
  stubWindow('#pair=blocked-token', '/mobile.html', '', throwingStorage);
  const { pairingToken, pairingHeader, PAIRING_HEADER } = await importFresh('storage-blocked');
  assert.equal(
    pairingToken(),
    'blocked-token',
    'module-scope fallback still returns the token when localStorage throws',
  );
  assert.deepEqual(pairingHeader(), { [PAIRING_HEADER]: 'blocked-token' });
}

// Item 3: postJson/postForm (frontend/src/lib/apiJson.ts) -- used by
// projectClient.ts for /save and /save-session -- must attach the pairing
// header. apiJson.ts imports pairing.ts by its plain (unversioned) specifier,
// so this is the first time in this run that instance is created; the
// fragment token set on `window` just before the dynamic import is what it
// picks up.
{
  store.clear();
  stubWindow('#pair=api-token', '/mobile.html', '');

  const capturedRequests: { url: string; init: RequestInit | undefined }[] = [];
  const g = globalThis as unknown as { fetch: typeof fetch };
  g.fetch = (async (url: string, init?: RequestInit) => {
    capturedRequests.push({ url: String(url), init });
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const apiJsonScenario = 'attaches-pairing-header';
  const { postJson, postForm } = await (import(
    `./apiJson.ts?scenario=${apiJsonScenario}`
  ) as Promise<typeof import('./apiJson.ts')>);

  await postJson('/api/project/save', { path: 'x' });
  const jsonHeaders = new Headers(capturedRequests[0]?.init?.headers);
  assert.equal(
    jsonHeaders.get('X-TheDAW-Pair'),
    'api-token',
    'postJson must attach the pairing header',
  );

  await postForm('/api/project/save-session', new FormData());
  const formHeaders = new Headers(capturedRequests[1]?.init?.headers);
  assert.equal(
    formHeaders.get('X-TheDAW-Pair'),
    'api-token',
    'postForm must attach the pairing header',
  );

  // Finding 1: getJson (frontend/src/lib/apiJson.ts) was the one helper in
  // the file that never called pairingHeaderFor(url) -- a LAN phone got 403
  // on /recent, /default-dir, /info and /list-audio, all reached only through
  // getJson. Attached for a relative URL, withheld for an absolute one (the
  // same rule postJson/postForm already follow via pairingHeaderFor).
  const { getJson } = await (import(
    `./apiJson.ts?scenario=${apiJsonScenario}`
  ) as Promise<typeof import('./apiJson.ts')>);

  await getJson('/api/project/recent');
  const relativeHeaders = new Headers(capturedRequests[2]?.init?.headers);
  assert.equal(
    relativeHeaders.get('X-TheDAW-Pair'),
    'api-token',
    'getJson must attach the pairing header for a relative URL',
  );

  await getJson('https://example.com/api/project/recent');
  const absoluteHeaders = new Headers(capturedRequests[3]?.init?.headers);
  assert.equal(
    absoluteHeaders.get('X-TheDAW-Pair'),
    null,
    'getJson must NOT attach the pairing header for an absolute URL',
  );

  // apiJson.ts minor: `url.startsWith('/')` admitted protocol-relative
  // ("//evil.example/...") and slash-backslash ("/\evil.example/...") URLs,
  // both of which the URL parser resolves OFF-ORIGIN -- so the old guard
  // shipped the pairing token cross-origin for those two forms even though
  // its comment claimed it stopped exactly this. Reproduces the audit's six
  // rows at the demonstrated page origin (http://192.168.1.34:8600) through
  // the real getJson(), asserting the fixed origin-comparison guard
  // (new URL(url, location.href).origin === location.origin) sends the
  // header only for same-origin requests.
  const g2 = globalThis as unknown as Record<string, unknown>;
  g2.window = {
    localStorage,
    location: {
      href: 'http://192.168.1.34:8600/mobile.html',
      origin: 'http://192.168.1.34:8600',
    },
  };
  const originGuardCases: [string, boolean][] = [
    ['/api/project/recent', true],
    ['//evil.example/api/project/recent', false],
    ['/\\evil.example/api/project/recent', false],
    ['https://evil.example/api/project/recent', false],
    ['javascript:alert(1)', false],
    ['data:text/plain,hi', false],
  ];
  for (const [caseUrl, shouldSend] of originGuardCases) {
    const before = capturedRequests.length;
    await getJson(caseUrl).catch(() => {});
    const req = capturedRequests[before];
    const headers = new Headers(req?.init?.headers);
    assert.equal(
      headers.get('X-TheDAW-Pair'),
      shouldSend ? 'api-token' : null,
      `getJson(${JSON.stringify(caseUrl)}) pairing header mismatch`,
    );
  }
}

// Finding 2: four bare `fetch()` call sites for /clip-audio
// (projectImport.ts:311, projectImport.ts:363, dawProjectToEditor.ts:74,
// DawSessionGrid.tsx:801) never sent the pairing header, so no clip audio
// loaded for a LAN phone once /clip-audio was gated. This drives the real
// loader end to end (loadProjectIntoEditor -> buildClip -> the fixed
// projectImport.ts:363 call site) and asserts the header the backend's gate
// actually checks for is present on the request.
{
  // spessasynth_core (pulled in transitively via projectImport.ts ->
  // midiSynth.ts -> soundfontEngine.ts) takes a browser code path that
  // touches `document` the moment it sees a truthy global `window` at
  // IMPORT time -- every earlier block in this file stubs `window`, so it
  // must come down before this import runs, the same "no window at all"
  // environment projectImport.test.ts imports this module under.
  const realWindow = (globalThis as { window?: unknown }).window;
  delete (globalThis as { window?: unknown }).window;

  const { loadProjectIntoEditor } = await (import(
    './projectImport.ts'
  ) as Promise<typeof import('./projectImport.ts')>);
  const { useEditorStore } = await (import(
    '../state/editorStore.ts'
  ) as Promise<typeof import('../state/editorStore.ts')>);

  class FakeAudioContext {
    async decodeAudioData(buf: ArrayBuffer) {
      return { duration: buf.byteLength, numberOfChannels: 1, getChannelData: () => new Float32Array(1) };
    }
    async close() {}
  }
  // Only needed at CALL time (computePeaks), once the import above is done.
  (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

  const realFetch = globalThis.fetch;
  const clipAudioRequests: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    clipAudioRequests.push({ url: String(url), init });
    return new Response(new Blob(['AAAA'], { type: 'audio/wav' }), { status: 200 });
  }) as typeof fetch;

  try {
    await loadProjectIntoEditor({
      project_name: 'Clip audio pairing',
      tempo: 120,
      sample_rate: 48000,
      tracks: [
        {
          id: 't1',
          name: 'Vox',
          type: 'audio',
          clips: [
            { id: 'c1', name: 'clip', clip_type: 'audio', audio_file: 'audio/c1.wav', start_time: 0, end_time: 1 },
          ],
        },
      ],
    });
    assert.equal(clipAudioRequests.length, 1, 'the clip-audio call site fetched exactly once');
    const clipHeaders = new Headers(clipAudioRequests[0]?.init?.headers);
    assert.equal(
      clipHeaders.get('X-TheDAW-Pair'),
      'api-token',
      'the clip-audio call site (projectImport.ts buildClip) must attach the pairing header',
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
    useEditorStore.setState({ tracks: [], clips: [] } as never);
  }
}

// Regression: `window` defined but `location` is not -- every tsx test
// harness in this repo, SSR, a worker, or a bare node script that only
// stubs part of `window`. Module import (which runs `initPairing()` at
// top level) must not throw.
{
  store.clear();
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { localStorage };
  await assert.doesNotReject(
    importFresh('window-without-location'),
    'importing pairing.ts must not throw when window.location is undefined',
  );
  const { pairingToken, pairingHeader } = await importFresh('window-without-location-2');
  assert.equal(pairingToken(), null);
  assert.deepEqual(pairingHeader(), {});
}

console.log('pairing.test.ts: all assertions passed');
