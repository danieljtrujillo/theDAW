// Run with: npx tsx src/lineagescale/lineageScaleClient.test.ts
//
// The client for /api/lineage-scale. What this pins:
//
//   * the URL a request is made of — route, escaped id, and every parameter
//     the contract names, so a typo is a failing test and not a 422 in the
//     user's face;
//   * the CLAMPS. up/down are 0..8 and budget is 50..1500 on the server. A
//     depth control that has run past its end, or a saved budget from an older
//     build, must be corrected here rather than sent and rejected — and a
//     fractional or NaN value must never reach the wire at all;
//   * that entry ids are escaped into the path. Ids are data; one containing
//     '/' or '?' must not rewrite the route;
//   * that the requests go through apiJson, so a failure surfaces the FastAPI
//     `detail` instead of a bare status.
import assert from 'node:assert/strict';

const {
  BUDGET_MAX, BUDGET_MIN, DEPTH_MAX, LINEAGE_SCALE_BASE, RELATIVES_LIMIT_MAX,
  clampBudget, clampDepth, clampInt,
  fetchLineageSummary, fetchLineageSummaryProbe, fetchNeighbourhood, fetchRankings, fetchRelatives,
  neighbourhoodUrl, rankingsUrl, relativesUrl, summaryUrl,
} = await import('./lineageScaleClient.ts');

/** Stub fetch, remember the URL it was asked for, answer with `response`. */
const withFetch = async <T>(
  response: Response,
  run: () => Promise<T>,
): Promise<{ url: string; headers: Record<string, string>; value: T | null; error: string | null }> => {
  const original = globalThis.fetch;
  let url = '';
  let headers: Record<string, string> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    return response;
  }) as typeof fetch;
  try {
    // `run()` is awaited BEFORE the result object is built: an object literal
    // reads `url` in source order, so building it inline would capture the
    // empty string that was there before fetch ran.
    const value = await run();
    return { url, headers, value, error: null };
  } catch (e) {
    return { url, headers, value: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    globalThis.fetch = original;
  }
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The query part of a built URL, as a plain object. */
const params = (url: string): Record<string, string> => {
  const q = url.slice(url.indexOf('?') + 1);
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(q)) out[k] = v;
  return out;
};

// ── clampInt: the one arithmetic every clamp is built on ────────────────────
{
  assert.equal(clampInt(5, 0, 8, 2), 5);
  assert.equal(clampInt(-3, 0, 8, 2), 0, 'below the floor lands ON the floor');
  assert.equal(clampInt(99, 0, 8, 2), 8, 'above the ceiling lands ON the ceiling');
  assert.equal(clampInt(2.9, 0, 8, 2), 2, 'a fraction truncates — the wire wants an integer');
  assert.equal(clampInt(Number.NaN, 0, 8, 2), 2, 'NaN is not a depth; the default is');
  assert.equal(clampInt(Infinity, 0, 8, 2), 2, 'Infinity is not a number of generations either');
  assert.equal(clampInt(undefined, 0, 8, 2), 2);
  assert.equal(clampInt('4', 0, 8, 2), 4, 'a number that arrived as text still clamps');
  assert.equal(clampInt('nope', 0, 8, 2), 2);

  assert.equal(clampDepth(12, 1), DEPTH_MAX);
  assert.equal(clampDepth(undefined, 3), 3);
  assert.equal(clampBudget(10), BUDGET_MIN, 'the server floor is 50, not 10');
  assert.equal(clampBudget(99999), BUDGET_MAX);
  assert.equal(clampBudget(undefined), 400, 'the documented default');
}

// ── summary ─────────────────────────────────────────────────────────────────
{
  assert.equal(summaryUrl(), `${LINEAGE_SCALE_BASE}/summary`);

  const body = {
    entries: 194833, with_lineage: 173877, standalone: 20652,
    links_raw: 475174, links_distinct: 400000, by_kind: { derived_from: 164779 },
    largest_connected: 81501, largest_tree: 8618, full_view_ok: false, revision: 7,
    // The backend reports whether this answer was served from the cache (true)
    // or paid for by this request (false). It must survive the round trip.
    warm: true,
  };
  const r = await withFetch(json(body), () => fetchLineageSummary());
  assert.equal(r.error, null);
  assert.equal(r.url, '/api/lineage-scale/summary');
  assert.equal(r.value?.largest_tree, 8618);
  assert.equal(r.value?.full_view_ok, false);
  assert.equal(r.value?.warm, true, 'warm comes through as sent');

  // A cold answer is `false`, not missing — the two mean different things and
  // a reader has to be able to tell them apart.
  const cold = await withFetch(json({ ...body, warm: false }), () => fetchLineageSummary());
  assert.equal(cold.value?.warm, false);
  const older = await withFetch(
    json(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'warm'))),
    () => fetchLineageSummary(),
  );
  assert.equal(older.value?.warm, undefined, 'a backend that omits it leaves the field absent');
}

// ── rankings ────────────────────────────────────────────────────────────────
{
  assert.deepEqual(params(rankingsUrl('deepest', 25)), { list: 'deepest', limit: '25' });
  assert.deepEqual(params(rankingsUrl('most_derived')), { list: 'most_derived', limit: '50' });
  assert.equal(params(rankingsUrl('recent', 0)).limit, '1', 'a zero-row list is not a request');
  assert.equal(params(rankingsUrl('recent', 5000)).limit, '200', 'and neither is an unbounded one');

  const r = await withFetch(
    json({ list: 'mashup_sources', rows: [{ id: 'a', title: 'T', model: 'm', count: 3, detail: 'd' }] }),
    () => fetchRankings('mashup_sources', 50),
  );
  assert.equal(r.error, null);
  assert.ok(r.url.startsWith('/api/lineage-scale/rankings?'), r.url);
  assert.equal(r.value?.rows[0].count, 3);
}

// ── neighbourhood: clamps, defaults, escaping ───────────────────────────────
{
  assert.deepEqual(
    params(neighbourhoodUrl('song-1', { up: 2, down: 1, budget: 400 })),
    { up: '2', down: '1', budget: '400' },
  );
  assert.deepEqual(
    params(neighbourhoodUrl('song-1')),
    { up: '2', down: '1', budget: '400' },
    'the contract defaults are what an un-parameterised call sends',
  );
  assert.deepEqual(
    params(neighbourhoodUrl('song-1', { up: 99, down: -4, budget: 9 })),
    { up: '8', down: '0', budget: '50' },
    'out-of-range controls are corrected, never sent',
  );

  assert.ok(
    neighbourhoodUrl('a/b?c=d').startsWith(`${LINEAGE_SCALE_BASE}/a%2Fb%3Fc%3Dd/neighbourhood?`),
    'an id is escaped into the path: it cannot add a segment or a parameter',
  );

  const r = await withFetch(
    json({
      focus: 'song-1', nodes: [], edges: [], groups: [], hidden: {}, truncated: true, budget: 400,
    }),
    () => fetchNeighbourhood('song-1', { up: 3, down: 2, budget: 600 }),
  );
  assert.equal(r.error, null);
  assert.equal(r.url, '/api/lineage-scale/song-1/neighbourhood?up=3&down=2&budget=600');
  assert.equal(r.value?.truncated, true);
}

// ── relatives: direction / kind / sort / paging ─────────────────────────────
{
  assert.deepEqual(
    params(relativesUrl({ entryId: 'x', direction: 'down', kind: 'cover_of', sort: 'plays', offset: 200, limit: 100 })),
    { direction: 'down', kind: 'cover_of', sort: 'plays', offset: '200', limit: '100' },
  );
  assert.equal(
    params(relativesUrl({ entryId: 'x', direction: 'up', kind: '', sort: 'title', offset: -5, limit: 9999 })).kind,
    'all',
    'no kind means every kind, spelled the way the route spells it',
  );
  assert.equal(
    params(relativesUrl({ entryId: 'x', direction: 'up', kind: '', sort: 'title', offset: -5, limit: 9999 })).offset,
    '0',
    'a negative offset is page one',
  );
  assert.equal(
    params(relativesUrl({ entryId: 'x', direction: 'up', kind: 'all', sort: 'title', offset: 0, limit: 9999 })).limit,
    String(RELATIVES_LIMIT_MAX),
    'the page size ceiling is the route’s, applied before the request',
  );

  const r = await withFetch(
    json({ total: 312, rows: [{ id: 'c1', title: 'Cover', model: 'm', duration_sec: 61, play_count: 2, kinds: ['cover_of'] }] }),
    () => fetchRelatives({ entryId: 'x', direction: 'down', kind: 'cover_of', sort: 'recent', offset: 100, limit: 100 }),
  );
  assert.equal(r.error, null);
  assert.equal(r.url, '/api/lineage-scale/x/relatives?direction=down&kind=cover_of&sort=recent&offset=100&limit=100');
  assert.equal(r.value?.total, 312);
}

// ── errors come back as words, not statuses ─────────────────────────────────
{
  const r = await withFetch(json({ detail: 'no such entry' }, 404), () => fetchNeighbourhood('ghost'));
  assert.equal(r.value, null);
  assert.equal(r.error, 'no such entry', 'the route’s own words reach the user');

  const bare = await withFetch(new Response('', { status: 500 }), () => fetchLineageSummary());
  assert.ok(bare.error && bare.error.length > 0, 'a bodiless failure still says something');
}

// ── the summary PROBE: a 404 is not "it failed" ─────────────────────────────
//
// `getJson` turns every failure into an Error whose message is the FastAPI
// detail, so the status is gone by the time a caller sees it. The LEARN host
// needs that one status: a 404 means the backend predates this module and the
// classic whole-library view is right; anything else leaves the library's size
// unknown, and mounting the classic view on a guess is the crash this module
// exists to escape. So the probe reports 'absent' for 404 ONLY and throws for
// everything else.
{
  const body = {
    entries: 4, with_lineage: 3, standalone: 1,
    links_raw: 2, links_distinct: 2, by_kind: { cover_of: 1 },
    largest_connected: 3, largest_tree: 3, full_view_ok: true, revision: 1,
  };
  const ok = await withFetch(json(body), () => fetchLineageSummaryProbe());
  assert.equal(ok.error, null);
  assert.equal(ok.url, '/api/lineage-scale/summary');
  assert.deepEqual(ok.value, { kind: 'ok', summary: body });

  const absent = await withFetch(json({ detail: 'Not Found' }, 404), () => fetchLineageSummaryProbe());
  assert.equal(absent.error, null, 'a 404 is an answer, not a failure');
  assert.deepEqual(absent.value, { kind: 'absent' });

  for (const status of [500, 503, 502, 422]) {
    const bad = await withFetch(json({ detail: `boom ${status}` }, status), () => fetchLineageSummaryProbe());
    assert.equal(bad.value, null, `${status} must not read as absent`);
    assert.ok(bad.error && bad.error.length > 0, `${status} must say something`);
  }

  // A dropped request throws too — it is not a 404 either.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  try {
    await fetchLineageSummaryProbe();
    assert.fail('a dropped request must not resolve');
  } catch (e) {
    assert.match(e instanceof Error ? e.message : String(e), /network down/);
  } finally {
    globalThis.fetch = original;
  }
}

// ── the probe obeys apiJson's rules because it USES them ───────────────────
//
// The probe cannot go through `getJson` (it needs the status), but everything
// else about it must be the same request `getJson` would have made. It had its
// own copy of the pairing-header rule and a DIFFERENT body reader, so this
// app's own `{"error": "..."}` bodies — which `getJson` surfaces — came out of
// the probe as "HTTP 500". Both now come from `lib/apiJson.ts`.
{
  // A window is required for the same-origin comparison the header rule makes;
  // node has none, which is why the assertion below needs one built by hand.
  const token = 'pair-token-9';
  const fakeWindow = {
    location: { href: 'http://localhost:5173/learn', origin: 'http://localhost:5173' },
    localStorage: { getItem: () => token, setItem: () => {} },
  };
  const host = globalThis as { window?: unknown };
  const hadWindow = 'window' in host;
  const previous = host.window;
  host.window = fakeWindow;
  try {
    const body = {
      entries: 4, with_lineage: 3, standalone: 1,
      links_raw: 2, links_distinct: 2, by_kind: { cover_of: 1 },
      largest_connected: 3, largest_tree: 3, full_view_ok: true, revision: 1,
    };
    const paired = await withFetch(json(body), () => fetchLineageSummaryProbe());
    assert.equal(paired.error, null);
    assert.equal(
      paired.headers['X-TheDAW-Pair'],
      token,
      'the LAN pairing secret rides along, exactly as it does for getJson',
    );

    // The same request through `getJson` carries the same header: one rule,
    // one implementation, so the probe cannot drift away from it again.
    const viaGetJson = await withFetch(json(body), () => fetchLineageSummary());
    assert.deepEqual(viaGetJson.headers, paired.headers);
  } finally {
    if (hadWindow) host.window = previous;
    else delete host.window;
  }

  // This app's own routes answer `{"error": "..."}`. `getJson` reads that key;
  // the probe read only `detail`, so a real reason arrived as a bare status.
  const spoken = await withFetch(
    json({ error: 'the library is still opening' }, 500),
    () => fetchLineageSummaryProbe(),
  );
  assert.equal(spoken.value, null);
  assert.equal(
    spoken.error,
    'the library is still opening',
    'the route’s own words reach the user, the same as through getJson',
  );
}

console.log('lineageScaleClient: all assertions passed');
