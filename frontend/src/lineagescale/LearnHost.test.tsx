// Run with: npx tsx src/lineagescale/LearnHost.test.tsx
//
// The LEARN tab's host, which decides WHICH lineage view the user gets.
//
// The rule the default serves: past the backend's limit, the classic view is
// not mounted until the user asks for it. Mounting it is what fires the
// whole-library request — 194,833 nodes, 475,174 links, 128 MB on the library
// this was written against. So by default the classic pane's ELEMENT is not
// constructed in that state, which means its lazy import does not run either.
// The test proves that with a stand-in that throws if it is ever rendered: a
// passing run is a run in which it was not.
//
// The rule the user is owed: the limit is a threshold nobody measured, so the
// disabled Classic tab carries the warning and an "Open anyway" key, and a
// summary that failed to load warns and does not take the view away.
//
// And on a small library nothing changes. `full_view_ok` from the backend
// means the classic view opens, exactly as the tab always did, and a backend
// too old to answer at all gets the same.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LearnHost, LearnHostSurface, LearnSwitch, LineageView, UNREAD_SUMMARY,
  classicUnavailableReason, classicUnknownSizeReason, decideLearnMode, rememberMode,
  rememberedMode, shouldReadSummary, summaryFromFailure, summaryFromProbe, summaryRearmed,
  type LearnViewProps,
} from './LearnHost.tsx';
import { LineageScaleView, classicPerTrackProps } from './LineageScaleView.tsx';
import { LineageModal } from '../components/library/LineageModal.tsx';
import type { LineageSummary } from './lineageScaleClient.ts';

const summaryOf = (withLineage: number, fullViewOk: boolean): LineageSummary => ({
  entries: withLineage + 100,
  with_lineage: withLineage,
  standalone: 100,
  links_raw: withLineage * 2,
  links_distinct: withLineage,
  by_kind: { derived_from: withLineage },
  largest_connected: withLineage,
  largest_tree: 8618,
  full_view_ok: fullViewOk,
  revision: 3,
});

/** The real library: far past anything that can be drawn at once. */
const BIG = summaryOf(173565, false);
/** A library small enough for the classic picture to be the right one. */
const SMALL = summaryOf(412, true);

/** A stand-in that records the props it was mounted with. */
const spyView = (name: string, seen: LearnViewProps[]): React.FC<LearnViewProps> => (props) => {
  seen.push(props);
  return <i data-view={name} />;
};

/** A stand-in that must never run. If it does, the test fails where it stands. */
const Forbidden: React.FC<LearnViewProps> = () => {
  throw new Error('the classic view was mounted on a library that cannot draw it');
};

const surface = (props: Partial<React.ComponentProps<typeof LearnHostSurface>>): string =>
  renderToStaticMarkup(
    <LearnHostSurface
      read
      summary={null}
      chosen={null}
      onSelect={() => {}}
      {...props}
    />,
  );

// ── the decision ────────────────────────────────────────────────────────────
{
  // Unreadable summary — a 404 from a backend that predates this module, or
  // any other failure. That is today's behaviour, unchanged and unannounced.
  assert.deepEqual(
    decideLearnMode(null, null),
    { mode: 'classic', classicAllowed: true, reason: '', canOpenAnyway: false },
  );
  assert.deepEqual(
    decideLearnMode(null, 'scale'),
    { mode: 'classic', classicAllowed: true, reason: '', canOpenAnyway: false },
    'and a remembered choice cannot be honoured when nothing is known',
  );

  // A small library: the classic picture, exactly as before.
  assert.equal(decideLearnMode(SMALL, null).mode, 'classic');
  assert.equal(decideLearnMode(SMALL, null).classicAllowed, true);
  assert.equal(decideLearnMode(SMALL, null).reason, '');

  // A big one: the new view by default, and the classic one behind "Open
  // anyway" with the warning.
  const big = decideLearnMode(BIG, null);
  assert.equal(big.mode, 'scale');
  assert.equal(big.classicAllowed, false);
  assert.equal(big.canOpenAnyway, true);
  assert.equal(
    big.reason,
    'The classic graph draws every song at once. This library has 173,565 connected songs, past the 2,000 where LEARN opens the scale view instead, so the classic graph may be slow or stop responding.',
  );
  assert.equal(big.reason, classicUnavailableReason(BIG));
  assert.ok(big.reason.includes('173,565'), 'the warning quotes the library’s own number');
  assert.ok(!/cannot load/.test(big.reason), 'and claims nothing the 2,000 limit never measured');

  // The warning quotes the limit the backend decided with. A backend whose
  // limit moved to 5,000 says so in /summary, and a 6,000-song library is
  // told it is past 5,000, not past a 2,000 copied into this file.
  const moved = { ...summaryOf(6000, false), full_view_limit: 5000 };
  const movedReason = decideLearnMode(moved, null).reason;
  assert.ok(movedReason.includes('past the 5,000 where LEARN'), `the backend’s own limit is quoted: ${movedReason}`);
  assert.ok(!movedReason.includes('2,000'), 'and not the fallback');
  assert.ok(big.reason.includes('past the 2,000 where LEARN'), 'a backend that does not send it gets the fallback');

  // "Open anyway" mounts the classic view, still with the warning.
  assert.deepEqual(decideLearnMode(BIG, null, false, true), {
    mode: 'classic', classicAllowed: true, reason: big.reason, canOpenAnyway: false,
  });

  // A remembered choice counts only where there is a choice to be had.
  assert.equal(decideLearnMode(SMALL, 'scale').mode, 'scale', 'honoured on a small library');
  assert.equal(decideLearnMode(SMALL, 'classic').mode, 'classic');
  assert.equal(
    decideLearnMode(BIG, 'classic').mode,
    'scale',
    'past the limit a stored choice alone does not mount it; the scale view stays the default',
  );
  assert.equal(decideLearnMode(BIG, 'classic').canOpenAnyway, true, 'the press does');
}

// ── when the summary is read at all ─────────────────────────────────────────
{
  assert.equal(shouldReadSummary(true, false), true, 'a visible tab that has not asked yet, asks');
  assert.equal(shouldReadSummary(false, false), false, 'a hidden tab asks for nothing');
  assert.equal(shouldReadSummary(true, true), false, 'and it is asked once, not once per render');
}

// ── the remembered choice ───────────────────────────────────────────────────
{
  const store = new Map<string, string>();
  const original = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  try {
    assert.equal(rememberedMode(), null, 'nothing remembered to begin with');
    rememberMode('scale');
    assert.equal(rememberedMode(), 'scale');
    rememberMode('classic');
    assert.equal(rememberedMode(), 'classic', 'the choice survives a tab switch');
    store.set('thedaw.learnMode', 'something else');
    assert.equal(rememberedMode(), null, 'a value that is not a mode is no choice at all');
  } finally {
    if (original === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    else (globalThis as { sessionStorage?: unknown }).sessionStorage = original;
  }
  // No storage at all (a non-browser host) is a missing preference, not a crash.
  assert.equal(rememberedMode(), null);
  rememberMode('scale');
}

// ── THE GUARD: a big library never mounts the classic view ──────────────────
{
  const seen: LearnViewProps[] = [];
  const html = surface({
    read: true,
    summary: BIG,
    chosen: 'classic', // even having asked for it
    scaleView: spyView('scale', seen),
    classicView: Forbidden, // throws if it is so much as rendered
    rootEntryId: 'song-7',
    visible: true,
  });

  assert.ok(html.includes('data-view="scale"'), 'the new view is what opens');
  assert.equal(seen.length, 1, 'and it is mounted exactly once');
  assert.deepEqual(seen[0], { rootEntryId: 'song-7', visible: true }, 'with the tab’s own props');

  // The switch still offers the classic view — visibly, and refused.
  assert.ok(html.includes('role="group"') && html.includes('aria-label="Lineage view"'));
  assert.ok(html.includes('aria-pressed="true"'), 'the active option is pressed');
  assert.ok(html.includes('Classic graph'), 'the option is not hidden away');
  assert.ok(html.includes('disabled=""'), 'it is refused by the attribute, not just by styling');
  assert.ok(
    html.includes('aria-describedby="lineage-scale-classic-unavailable"'),
    'and the refusal is wired to its explanation',
  );
  assert.ok(
    html.includes('id="lineage-scale-classic-unavailable"'),
    'which is on the page for that id to point at',
  );
  assert.ok(html.includes('173,565 connected songs'), 'in the library’s own numbers');
  assert.ok(!/<button[^>]*>Open anyway<\/button>/.test(html), 'no key without a handler to press');

  // The host passes its handler: the key is there, described by the warning.
  const offered = surface({
    read: true, summary: BIG, chosen: null, onOpenAnyway: () => {},
    scaleView: spyView('scale', []), classicView: Forbidden,
  });
  const key = offered.match(/<button[^>]*>Open anyway<\/button>/)?.[0] ?? '';
  assert.ok(key, `the disabled Classic tab offers Open anyway: ${offered}`);
  assert.ok(key.includes('type="button"'));
  assert.ok(key.includes('aria-describedby="lineage-scale-classic-unavailable"'), 'with the warning as its description');
  assert.ok(offered.includes('disabled=""'), 'while the tab itself stays disabled until pressed');
}

// ── a small library: today's behaviour, untouched ───────────────────────────
{
  const seen: LearnViewProps[] = [];
  const html = surface({
    read: true,
    summary: SMALL,
    chosen: null,
    scaleView: () => <i data-view="scale" />,
    classicView: spyView('classic', seen),
    rootEntryId: null,
    visible: true,
  });

  assert.ok(html.includes('data-view="classic"'), 'the classic graph opens, as it always did');
  assert.ok(!html.includes('data-view="scale"'), 'and only it');
  assert.deepEqual(seen[0], { rootEntryId: null, visible: true }, 'with the props it gets today');
  assert.ok(!html.includes('disabled'), 'neither option is refused');
  assert.ok(
    !html.includes('aria-describedby'),
    'and nothing needs explaining when nothing is refused',
  );

  // The remembered choice is honoured here, because here it is a choice.
  const switched = surface({
    read: true, summary: SMALL, chosen: 'scale',
    scaleView: () => <i data-view="scale" />, classicView: spyView('classic', []),
  });
  assert.ok(switched.includes('data-view="scale"'));
  assert.ok(!switched.includes('data-view="classic"'));
}

// ── an older backend: also today's behaviour ────────────────────────────────
{
  const html = surface({
    read: true,
    summary: null,
    chosen: null,
    scaleView: () => <i data-view="scale" />,
    classicView: () => <i data-view="classic" />,
  });
  assert.ok(html.includes('data-view="classic"'), 'a 404 from an old backend falls back, silently');
  assert.ok(!html.includes('disabled'), 'and claims nothing about a library it could not count');
  assert.ok(!/error|failed|unavailable/i.test(html), 'nothing alarming is shown');
}

// ── before the answer is in, NEITHER view exists ────────────────────────────
{
  const html = surface({
    read: false,
    summary: null,
    chosen: null,
    scaleView: Forbidden,
    classicView: Forbidden,
    visible: true,
  });
  assert.ok(html.includes('Reading this library'), 'the tab says what it is waiting for');
  assert.ok(!html.includes('Classic graph'), 'and offers no choice it cannot yet stand behind');

  // Hidden: still nothing mounted, and nothing said.
  const hidden = surface({
    read: false, summary: null, chosen: null,
    scaleView: Forbidden, classicView: Forbidden, visible: false,
  });
  assert.ok(!hidden.includes('Reading this library'), 'a hidden tab does not narrate');
}

// ── a hidden tab fetches nothing ────────────────────────────────────────────
{
  let asked = 0;
  const html = renderToStaticMarkup(
    <LearnHost
      visible={false}
      loadSummary={async () => {
        asked += 1;
        return { kind: 'ok', summary: BIG } as const;
      }}
      scaleView={Forbidden}
      classicView={Forbidden}
    />,
  );
  assert.equal(asked, 0, 'a tab the user is not looking at asks the backend for nothing');
  assert.ok(!html.includes('data-view='), 'and mounts neither view');
}

// ── the switch on its own ───────────────────────────────────────────────────
{
  const html = renderToStaticMarkup(
    <LearnSwitch mode="classic" classicAllowed reason="" onSelect={() => {}} />,
  );
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2, 'two options, no more');
  assert.equal(
    buttons.filter((b) => b.includes('aria-pressed="true"')).length,
    1,
    'exactly one is pressed at a time',
  );
  for (const b of buttons) {
    assert.ok(b.includes('type="button"'), 'neither submits anything');
    assert.ok(b.includes('aria-pressed='), 'both report their state');
  }
  assert.ok(!html.includes('<label'), 'a toggle button is not a form control wrapped in a label');
}

// ── rootEntryId opens the view ON that song ─────────────────────────────────
{
  // The host hands `rootEntryId` straight through (asserted above, in the
  // props the stand-in recorded). This is the other end: the view opens
  // focused on that song rather than on the landing page.
  const focused = renderToStaticMarkup(<LineageScaleView rootEntryId="song-7" visible={false} />);
  assert.ok(focused.includes('aria-label="Focus song-7"'), 'the song is the trail’s first crumb');
  assert.ok(
    focused.includes('aria-label="Back to the lineage landing page"'),
    'and the focus chrome is what opened, not the landing page',
  );
  assert.ok(!focused.includes('id="lineage-scale-search"'), 'the landing search is not what is shown');

  const landing = renderToStaticMarkup(<LineageScaleView visible={false} />);
  assert.ok(landing.includes('id="lineage-scale-search"'), 'and without one, the landing still opens');
}

// ── the mount DAWCenterPanel will use ───────────────────────────────────────
{
  // `LineageView` is the name the LEARN tab mounts, and it takes exactly the
  // props line 154 already passes. This is a compile-time check as much as a
  // runtime one: if the prop shape drifted, tsc would fail on these lines.
  assert.equal(LineageView, LearnHost, 'the named export IS the host');
  const mounted = renderToStaticMarkup(
    <LineageView rootEntryId={null} visible={false} />,
  );
  assert.ok(mounted.length > 0, 'and it renders under the tab’s own props');

  const lazyShape = React.lazy(() =>
    import('./LearnHost.tsx').then((m) => ({ default: m.LineageView })),
  );
  assert.ok(typeof lazyShape === 'object', 'the tab’s lazy() form typechecks and builds');
}

// ── ONLY a 404 is "an older backend" ────────────────────────────────────────
//
// Any other failure leaves the library's size UNKNOWN, and unknown must never
// be read as small: on a 195,000-song library that mounts the classic view and
// brings back "Maximum call stack size exceeded". So the decision splits on the
// status, not on "did it work".
{
  // A 404: no such route. Exactly the old behaviour, nothing alarming said.
  assert.deepEqual(
    decideLearnMode(null, null, false),
    { mode: 'classic', classicAllowed: true, reason: '', canOpenAnyway: false },
  );
  // Anything else: the new view opens, and the classic one is offered with
  // the unknown-size warning, not refused.
  assert.deepEqual(
    decideLearnMode(null, null, true),
    { mode: 'scale', classicAllowed: true, reason: classicUnknownSizeReason, canOpenAnyway: false },
  );
  assert.equal(
    decideLearnMode(null, 'classic', true, false, 'classic').mode,
    'classic',
    'the user’s pick on this mount is honoured when the size is unknown',
  );
  assert.equal(
    decideLearnMode(null, 'classic', true).mode,
    'scale',
    'a choice remembered from before a reload does not mount the classic graph on an unknown size',
  );

  // The 404 branch, through the host: classic mounts, no banner.
  const absent = surface({ summary: null, failure: null, scaleView: Forbidden, classicView: spyView('classic', []) });
  assert.ok(absent.includes('data-view="classic"'), absent);
  assert.ok(!absent.includes('Could not read'), 'a 404 is not an error to show');

  // The failure branch: the SCALE view mounts, the classic one is not built
  // until picked, the warning is on screen, and there is a Retry.
  const seen: LearnViewProps[] = [];
  const failed = surface({
    summary: null,
    failure: 'HTTP 500',
    scaleView: spyView('scale', seen),
    classicView: Forbidden,
  });
  assert.equal(seen.length, 1, 'the scale view is the one that mounted');
  assert.ok(failed.includes('Could not read'), failed);
  assert.ok(failed.includes('HTTP 500'), 'and it says what happened');
  assert.ok(/<button[^>]*>Retry<\/button>/.test(failed), 'with a way to try again');
  assert.ok(!failed.includes('disabled=""'), 'and the classic option is offered, not refused');
  assert.ok(failed.includes('size is unknown'), 'with the warning beside it');
}

// ── what a probe LEAVES BEHIND, and what Retry does to it ──────────────────
//
// The host's effect and its Retry button used to hold this logic inline, where
// `renderToStaticMarkup` — which runs no effects — could never reach it: the
// rejected-probe branch and the re-arm were the two pieces of this file with no
// test at all. They are plain functions now, so both are checked here, and the
// host is only the wiring that calls them.
{
  // A route that answered: the summary is known, there is no failure, and the
  // read is done.
  assert.deepEqual(summaryFromProbe({ kind: 'ok', summary: SMALL }), {
    summary: SMALL, failure: null, read: true,
  });
  // A 404: no summary and STILL no failure — that is the older-backend case,
  // and `decideLearnMode` reads it as the classic view, as it always did.
  assert.deepEqual(summaryFromProbe({ kind: 'absent' }), {
    summary: null, failure: null, read: true,
  });
  assert.equal(decideLearnMode(null, null, false).mode, 'classic');

  // A REJECTED probe: the size is unknown, so the failure is carried and the
  // decision it feeds is the new view, with the classic one offered and warned.
  const failed = summaryFromFailure(new Error('HTTP 500'));
  assert.deepEqual(failed, { summary: null, failure: 'HTTP 500', read: true });
  assert.deepEqual(
    decideLearnMode(failed.summary, null, failed.failure !== null),
    { mode: 'scale', classicAllowed: true, reason: classicUnknownSizeReason, canOpenAnyway: false },
  );
  assert.equal(
    summaryFromFailure('the connection went away').failure,
    'the connection went away',
    'a rejection that is not an Error still says something',
  );

  // Retry: the banner goes, and `read` back to false is what re-arms the one
  // gate the effect has.
  const rearmed = summaryRearmed(failed);
  assert.deepEqual(rearmed, { summary: null, failure: null, read: false });
  assert.deepEqual(rearmed, UNREAD_SUMMARY, 'a retry is the un-read state again');
  assert.ok(shouldReadSummary(true, rearmed.read), 'so the summary is asked for again');
  assert.ok(!shouldReadSummary(true, failed.read), 'while a settled read asks for nothing');
  assert.equal(
    summaryRearmed({ summary: SMALL, failure: null, read: true }).summary,
    SMALL,
    'and a retry does not throw away a summary that was already read',
  );

  // The failure state, rendered: the banner and its Retry are what the user
  // gets, and the classic view is not built until it is picked.
  const html = surface({ ...failed, scaleView: spyView('scale', []), classicView: Forbidden });
  assert.ok(html.includes('HTTP 500'), html);
  assert.ok(/<button[^>]*>Retry<\/button>/.test(html));
}

// ── the classic graph of ONE SONG is never taken away ───────────────────────
//
// The user's complaint, in full: "why would i not be able to see a classic
// graph for individual tracks??? that makes no sense". It did not: hiding the
// whole classic component on a big library took the per-track graph with it,
// and only the WHOLE-LIBRARY half of that component is the one that dies.
//
// So on the big fixture both halves are pinned at once: the whole-library
// element still cannot be constructed (the throwing stand-in proves it), and
// the per-track element CAN — built here, for the song the host handed down,
// with the two library-wide tabs refused.
{
  const seen: LearnViewProps[] = [];
  const html = surface({
    read: true,
    summary: BIG,
    chosen: 'classic',
    scaleView: spyView('scale', seen),
    classicView: Forbidden, // the WHOLE-LIBRARY view: still never built
    rootEntryId: 'song-7',
    visible: true,
  });
  assert.ok(html.includes('data-view="scale"'), 'the scale view is what the tab opens');
  assert.deepEqual(seen[0], { rootEntryId: 'song-7', visible: true }, 'holding the focused song');

  // And that song's own classic graph, built for real.
  const perTrack = renderToStaticMarkup(
    <LineageModal {...classicPerTrackProps('song-7', true)} onClose={() => {}} />,
  );
  assert.ok(perTrack.includes('Track'), `the classic per-track graph renders: ${perTrack}`);
  assert.ok(perTrack.includes('rooted at song-7'), 'rooted at the song in focus');
  const refused = (perTrack.match(/<button[^>]*aria-disabled="true"[^>]*>/g) ?? []);
  assert.equal(refused.length, 2, 'with the two whole-library tabs refused, and only those');
  for (const b of refused) {
    assert.ok(b.includes('library too large'), 'each saying why, on the control itself');
  }

  // The scale view is where that action lives, for whatever song is focused.
  const scale = renderToStaticMarkup(<LineageScaleView rootEntryId="song-7" visible={false} />);
  assert.ok(
    scale.includes('aria-label="Classic graph for song-7"'),
    'and the scale view offers it by name',
  );
}

console.log('LearnHost: all assertions passed');
