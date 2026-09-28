/**
 * Batch-12 T14 fixes for DJView + djSamplerStore — pure helpers behind:
 *
 *   1. automixTransitionDue — the automix interval's mix-out decision
 *      (DJView.tsx), pulled out so the "when do we start blending" logic is
 *      testable without the deck/audio engine.
 *   2. useLatestRef — the fix for the automix interval effect calling
 *      `syncDeck` through a closure captured once at mount (the effect only
 *      depends on `[automixOn, automixRestart]`, by design — it must not
 *      restart the sequence on every tick — so a plain closure over
 *      `syncDeck` froze the beatmatch at whatever deck state existed the
 *      moment automix turned on). `syncDeckRef = useLatestRef(syncDeck)`
 *      re-points a ref at the latest `syncDeck` every render; a mounted-once
 *      interval reads `syncDeckRef.current` each tick instead. Rendered with
 *      jsdom + react-dom so the actual hook (not a re-implementation of it)
 *      is what gets exercised across a re-render. A source-text assertion
 *      below also pins that the transition calls `syncDeckRef.current(nxt)`
 *      and never a bare `syncDeck(nxt)` — the ref indirection is easy to
 *      accidentally undo in a future edit without either test noticing.
 *   3. automixTransitionSteps — the ordered engine calls (seek, play, sync)
 *      an automix transition makes. `sync` used to run BEFORE `play`:
 *      syncDeck's phase-align branch only nudges playback into phase when
 *      BOTH decks already read as playing, so with the incoming deck not
 *      yet playing, only the tempo (pitch) half of the beatmatch ever
 *      applied — automix matched BPM but never phase.
 *   4. samplerTriggerOpts — the per-pad gain/loop/choke defaulting
 *      (DJView.tsx sampler section). `djSamplerStore.setPadOpts` existed but
 *      nothing called it and `SamplerRail` never read `pad.gain/.loop/.choke`
 *      before firing a pad, so the persisted options were unreachable.
 *   5. samplerLoopToggle — turning a pad's Loop option OFF used to leave a
 *      currently-looping voice stuck: djEngine only stops a loop when the
 *      NEXT trigger itself carries `loop: true` (djEngine.ts:894), so once
 *      the stored option flipped to `false` there was no press left that
 *      would ever hit that stop branch. The toggle must call
 *      `djEngine.stopSample` itself when it turns Loop off.
 *
 * djSamplerStore.setPad / setPadOpts / clearPad are also exercised directly:
 * they are what the new pad-options panel calls, and had no test coverage.
 * jsdom's `localStorage` is installed as a global BEFORE djSamplerStore is
 * imported, so zustand's persist middleware finds real storage instead of
 * warning "the given storage is currently unavailable" on every write.
 *
 * Run: `npx tsx src/views/DJView.b12.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// jsdom's `window`/`localStorage` installed as globals BEFORE djSamplerStore
// is imported: zustand's `persist` middleware reads `window.localStorage`
// exactly once, at module-evaluation time (zustand/esm/middleware.mjs:
// `createJSONStorage(() => window.localStorage)` runs immediately, not
// lazily) — so `window` has to be a real global at THAT import, not merely
// before some later re-import (ESM caches the module; a second import
// returns the same already-warned store). The resolved storage object is
// captured by closure inside `createJSONStorage`, so it keeps working even
// after `window` is uninstalled again below.
//
// `window` is uninstalled again immediately after, before importing
// DJView.tsx: DJView.tsx transitively imports `state/playerStore.ts`, whose
// module body does `if (typeof window !== 'undefined' && import.meta.env.DEV)`
// — under plain tsx (no Vite), `import.meta.env` doesn't exist at all, so
// with `window` defined that line throws `Cannot read properties of
// undefined (reading 'DEV')`. playerStore.ts is outside this ticket's write
// set, so the environment is arranged around it instead of touching it:
// `window` is real only while djSamplerStore's storage is being resolved.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const win = dom.window;
const jsdomGlobals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const installJsdomGlobals = () => {
  for (const [key, value] of Object.entries(jsdomGlobals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
};
const uninstallJsdomGlobals = () => {
  for (const key of Object.keys(jsdomGlobals)) {
    Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
  }
};

installJsdomGlobals();
const { useDjSampler } = await import('../state/djSamplerStore.ts');
uninstallJsdomGlobals();

const {
  automixKeylockStep,
  automixTransitionDue,
  automixTransitionSteps,
  samplerLoopToggle,
  samplerTriggerOpts,
  useLatestRef,
} = await import('./DJView.tsx');

/* ------------------------------ automixTransitionDue ------------------------------ */
{
  const base = { playing: true, currentTime: 100, duration: 120, mixOut: undefined as number | null | undefined, tailSec: 18, pendingTransition: false, incomingHasBuffer: true };

  // Classic sets: due once inside `tailSec` of the outgoing track's end.
  assert.equal(automixTransitionDue({ ...base, currentTime: 101, duration: 120 }), false, '19s left: not due yet');
  assert.equal(automixTransitionDue({ ...base, currentTime: 103, duration: 120 }), true, '17s left: due');
  assert.equal(automixTransitionDue({ ...base, currentTime: 102, duration: 120 }), true, 'exactly tailSec left: due (>=)');

  // Prepared sets: an exact mixOut point on the outgoing track wins outright,
  // even when it sits well outside the fixed tail window.
  assert.equal(automixTransitionDue({ ...base, currentTime: 50, duration: 120, mixOut: 50 }), true, 'mixOut reached, far from the end');
  assert.equal(automixTransitionDue({ ...base, currentTime: 49, duration: 120, mixOut: 50 }), false, 'mixOut not reached yet');
  assert.equal(automixTransitionDue({ ...base, currentTime: 119, duration: 120, mixOut: 200 }), false, 'a mixOut past the track length never fires from the tail rule');

  // The assistant's "transition NOW" override.
  assert.equal(automixTransitionDue({ ...base, currentTime: 10, duration: 120, pendingTransition: true }), true, 'pendingTransition forces it regardless of position');
  assert.equal(automixTransitionDue({ ...base, currentTime: 10, duration: 120, mixOut: 500, pendingTransition: true }), true, 'pendingTransition overrides an unreached mixOut too');

  // Nothing to blend into: never due, no matter how ready the outgoing track is.
  assert.equal(automixTransitionDue({ ...base, currentTime: 118, duration: 120, incomingHasBuffer: false }), false, 'incoming deck has no buffer yet');
  assert.equal(automixTransitionDue({ ...base, currentTime: 118, duration: 120, pendingTransition: true, incomingHasBuffer: false }), false, 'even a forced transition needs a decoded incoming buffer');

  // The outgoing deck must actually be playing.
  assert.equal(automixTransitionDue({ ...base, playing: false, currentTime: 118, duration: 120 }), false, 'paused outgoing deck: never due');

  // Zero-length / unknown duration with no mixOut: the tail rule needs a
  // positive duration, so it never fires on its own (matches the source
  // `cs.duration > 0 && ...` guard) — pendingTransition can still force it.
  assert.equal(automixTransitionDue({ ...base, currentTime: 0, duration: 0 }), false, 'unknown duration: tail rule inert');
  assert.equal(automixTransitionDue({ ...base, currentTime: 0, duration: 0, pendingTransition: true }), true, 'unknown duration, but forced');
}

/* ------------------------------ automixTransitionSteps ------------------------------ */
{
  const steps = automixTransitionSteps('B', 12.5, { masterPlaying: true, keylock: null });
  assert.deepEqual(
    steps,
    [
      { type: 'seek', deck: 'B', to: 12.5 },
      { type: 'play', deck: 'B' },
      { type: 'sync', deck: 'B' },
    ],
    'seek, then play, then sync — sync must be LAST so both decks read as playing when it runs',
  );
  assert.equal(steps[steps.length - 1].type, 'sync', 'sync is never anything but the final step');
  const playIndex = steps.findIndex((s) => s.type === 'play');
  const syncIndex = steps.findIndex((s) => s.type === 'sync');
  assert.ok(playIndex < syncIndex, 'play must come before sync (THE BUG: sync before play skips phase-align entirely)');

  // The other deck is addressed throughout, and the cue-in point is carried
  // through untouched (0 is a legitimate cue-in, not "unset").
  assert.deepEqual(automixTransitionSteps('A', 0, { masterPlaying: true, keylock: null }), [
    { type: 'seek', deck: 'A', to: 0 },
    { type: 'play', deck: 'A' },
    { type: 'sync', deck: 'A' },
  ]);

  // Key-lock is set BEFORE play (PR #207 review): engaging it swaps the
  // insert and moves this deck's delay line, silent on a deck that has not
  // started and a warble on one that has.
  const locked = automixTransitionSteps('B', 0, { masterPlaying: true, keylock: true });
  assert.deepEqual(locked.map((s) => s.type), ['seek', 'keylock', 'play', 'sync']);
  assert.deepEqual(locked[1], { type: 'keylock', deck: 'B', on: true });
  assert.deepEqual(automixTransitionSteps('B', 0, { masterPlaying: true, keylock: false })[1], { type: 'keylock', deck: 'B', on: false });

  // The dead-air rescue: the outgoing deck is not playing, so there is
  // nothing to sync to. With one deck playing syncDeck picks the STOPPED one
  // as its follower, so the rescue used to pitch the finished outgoing deck.
  assert.deepEqual(
    automixTransitionSteps('A', 0, { masterPlaying: false, keylock: null }).map((s) => s.type),
    ['seek', 'play'],
    'no sync without a playing master',
  );
}

/* ------------------------------ automixKeylockStep ------------------------------ */
{
  assert.equal(automixKeylockStep({ pullPct: 4, masterPlaying: true, lockedByAutomix: false }), true, 'a real pull engages');
  assert.equal(automixKeylockStep({ pullPct: -4, masterPlaying: true, lockedByAutomix: false }), true, 'either direction');
  assert.equal(automixKeylockStep({ pullPct: 2, masterPlaying: true, lockedByAutomix: true }), false, 'a small pull releases a lock automix owns');
  assert.equal(automixKeylockStep({ pullPct: 2, masterPlaying: true, lockedByAutomix: false }), null, 'and leaves the DJ\'s own lock alone');
  assert.equal(automixKeylockStep({ pullPct: 8, masterPlaying: false, lockedByAutomix: false }), null,
    'the rescue has no playing master, so no pull to compensate');
}

/* ------------------------------ source: syncDeckRef, never a bare syncDeck(nxt) ------------------------------
 * Pins the useLatestRef wiring itself: it is easy for a future edit to
 * "simplify" the ref indirection back down to a direct `syncDeck(nxt)` call
 * inside the automix interval without either the rendered useLatestRef test
 * below or the automixTransitionSteps order test noticing, since neither one
 * touches the real `syncDeck` closure. The automix transition dispatches
 * `automixTransitionSteps`' output by `step.type` (see DJView.tsx), so the
 * ref call reads `syncDeckRef.current(step.deck)` rather than the literal
 * `(nxt)` — same deck argument, just named through the step. */
{
  const djViewSrc = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  assert.ok(djViewSrc.includes('syncDeckRef.current(step.deck)'), 'the automix transition calls syncDeck through syncDeckRef, dispatched from automixTransitionSteps');
  assert.ok(!djViewSrc.includes('syncDeck(nxt)'), 'never a bare syncDeck(nxt) call — that closes over the automix effect\'s stale syncDeck');
  assert.ok(!/[^.]\bsyncDeck\(step\.deck\)/.test(djViewSrc), 'never a bare syncDeck(step.deck) call either — must always go through syncDeckRef.current(...)');
}

/* ------------------------------ samplerTriggerOpts ------------------------------ */
{
  assert.deepEqual(samplerTriggerOpts(undefined), { gain: 1, loop: false, choke: false }, 'no pad assigned: plain one-shot defaults');
  assert.deepEqual(
    samplerTriggerOpts({ entryId: 'a', name: 'Kick' } as never),
    { gain: 1, loop: false, choke: false },
    'a pad with no options set: same plain defaults as before per-pad options existed',
  );
  assert.deepEqual(samplerTriggerOpts({ gain: 0.5, loop: true, choke: true }), { gain: 0.5, loop: true, choke: true }, 'every option carried through as set');
  assert.deepEqual(samplerTriggerOpts({ gain: 0, loop: false, choke: false }), { gain: 0, loop: false, choke: false }, 'an explicit zero gain is not treated as unset');
}

/* ------------------------------ djSamplerStore ------------------------------ */
{
  const { setPad, setPadOpts, clearPad } = useDjSampler.getState();

  setPad(3, { entryId: 'e1', name: 'Snare' });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare' }, 'setPad stores a fresh pad with no options');

  // setPadOpts merges into the existing pad rather than replacing it.
  setPadOpts(3, { gain: 0.7 });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare', gain: 0.7 }, 'gain merged in, entryId/name preserved');
  setPadOpts(3, { loop: true });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare', gain: 0.7, loop: true }, 'loop merged in on top of the earlier gain change');
  setPadOpts(3, { choke: true, gain: 0.2 });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare', gain: 0.2, loop: true, choke: true }, 'a multi-field patch merges all of it');

  // setPadOpts on an empty slot is a no-op — nothing to attach options to.
  setPadOpts(7, { gain: 0.3 });
  assert.equal(useDjSampler.getState().pads[7], undefined, 'setPadOpts on an unassigned pad does nothing');

  clearPad(3);
  assert.equal(useDjSampler.getState().pads[3], undefined, 'clearPad removes the pad (and its options) entirely');
}

/* ------------------------------ samplerLoopToggle ------------------------------ */
{
  assert.deepEqual(samplerLoopToggle(false), { loop: true, stopSample: false }, 'turning Loop ON: no stop, the next press should loop');
  assert.deepEqual(samplerLoopToggle(true), { loop: false, stopSample: true }, 'turning Loop OFF: must stop whatever voice is currently looping');
}

/* ------------------------------ useLatestRef (rendered) ------------------------------
 * A tick must call the fn from the render that just committed, not the one
 * an effect closed over when it last (re)subscribed — the exact shape of the
 * automix interval, which intentionally never re-subscribes on a syncDeck
 * change. jsdom + react-dom mount the real hook rather than re-implementing
 * the pattern here. */
{
  installJsdomGlobals();
  mock.timers.enable({ apis: ['setInterval'] });

  const React = await import('react');
  const { act, useEffect } = React;
  const { createRoot } = await import('react-dom/client');
  const document = win.document;

  const calls: Array<{ who: string; arg: string }> = [];
  const fnA = (arg: string) => calls.push({ who: 'A', arg });
  const fnB = (arg: string) => calls.push({ who: 'B', arg });

  // Mirrors DJView.tsx's automix interval effect exactly: a ref that tracks
  // the latest `fn`, and an interval mounted once (empty deps) that reads
  // `fnRef.current` on every tick instead of closing over `fn` directly.
  function Harness({ fn }: { fn: (x: string) => void }) {
    const fnRef = useLatestRef(fn);
    useEffect(() => {
      const id = setInterval(() => { fnRef.current('tick'); }, 100);
      return () => clearInterval(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => { root.render(React.createElement(Harness, { fn: fnA })); });
  await act(async () => { mock.timers.tick(100); });
  assert.deepEqual(calls, [{ who: 'A', arg: 'tick' }], 'first tick after mount calls the fn passed in at mount');

  // Re-render with a NEW fn — same mount, the interval effect does not
  // restart (deps are []). The bug this replaces: without useLatestRef, the
  // next tick would still call fnA.
  await act(async () => { root.render(React.createElement(Harness, { fn: fnB })); });
  await act(async () => { mock.timers.tick(100); });
  assert.deepEqual(
    calls,
    [{ who: 'A', arg: 'tick' }, { who: 'B', arg: 'tick' }],
    'after a re-render with a new fn, the next tick calls the NEW fn (THE BUG: a stale closure would have called fnA again)',
  );

  await act(async () => { root.unmount(); });
  mock.timers.reset();
}

/* ───────────────── source: the DJ-4 automix rewire (ticket DJ-4) ─────────────────
 * The automix sequencer is a `setInterval` inside a 3,500-line view that needs
 * the whole DJ store/engine graph to render, so its DECISIONS were extracted
 * into `lib/djAutomixPlan.ts` and are tested there, behaviourally, branch by
 * branch. What cannot be reached that way is the WIRING: that the interval
 * actually calls the engine with what the plan returned. Each assertion below
 * fails against the pre-DJ-4 DJView.tsx, which is what makes it worth having.
 */
{
  const src = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  // Comments describe the bugs being fixed BY NAME, so every "this must no
  // longer appear" assertion runs on comment-stripped source.
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const automix = src.slice(src.indexOf('// Automix (D7): auto-sequence'));
  assert.ok(automix.length > 1000, 'found the automix effect');
  const intervalStart = automix.indexOf('const id = window.setInterval');
  const interval = automix.slice(intervalStart, automix.indexOf('}, 500);', intervalStart));
  assert.ok(interval.length > 500, 'found the 500 ms automix tick');
  const seed = automix.slice(automix.indexOf('const curEntry ='), automix.indexOf('const id = window.setInterval'));

  // fix 1 — the bass swap runs on every tick of the fade, per deck.
  assert.ok(/eqSwap\(step\.progress\)/.test(interval), 'the fade computes an EQ swap from its progress (blendTick)');
  assert.ok(/setDeckEq\((cur|nxt), 'low'/.test(interval), 'and pushes it to the deck EQ (setDeckEq was never called here before)');
  assert.equal((interval.match(/setDeckEq\(/g) ?? []).length >= 4, true,
    'both decks during the fade, and both restored when it finishes');

  // fix 2 — phase alignment nudges the platter; it never re-seeks (which
  // rebuilds the AudioBufferSourceNode and is audible as a restart).
  const sync = src.slice(src.indexOf('const syncDeck = ('), src.indexOf('const syncDeckRef'));
  assert.ok(sync.includes('djEngine.nudgePhase('), 'syncDeck nudges phase');
  assert.ok(!code(sync).includes('djEngine.seekDeck('), 'THE BUG: syncDeck must not seek to phase-align');
  assert.ok(sync.indexOf('djEngine.setDeckPitch(') < sync.indexOf('const ms = djEngine.getStatus(master)'),
    'the positions used for the phase error are read AFTER the pitch change re-anchors them');

  // fix 3 — the sync-lock PLL is armed by automix, and released on the swap.
  assert.ok(/setSyncLock\(nxt\)/.test(interval), 'the transition arms the PLL on the incoming deck');
  assert.ok(/setSyncLock\(null\)/.test(interval), 'and clears it when the decks swap');

  // fix 4/5 — honest messaging, and key-lock on a real pull.
  assert.ok(/NOT beatmatched/.test(sync), 'syncDeck says so when the pitch range cannot deliver the match');
  assert.ok(/mixing unmatched/.test(interval), 'the automix flash says so too');
  // Both sites engage key-lock on a real pull AND release it when the pull is
  // gone — but only a lock they engaged themselves. The release half and the
  // ownership flag are pinned in the DJ-5 review block below; the original
  // intent here is unchanged: key-lock follows the size of the pitch pull.
  assert.ok(/setDeckKeylock\(step\.deck, true\)/.test(interval), 'key-lock engages for the automix follower on a real pull');
  assert.ok(/setDeckKeylock\(follower, true\)/.test(sync), 'and for a manual SYNC');
  assert.ok(/KEYLOCK_PITCH_PCT/.test(interval) && /KEYLOCK_PITCH_PCT/.test(sync), 'both off the same threshold');

  // fix 9 — phase comes off the constant beatgrid, never the raw beats.
  assert.ok(!/\.a\?\.beats/.test(code(sync)), 'THE BUG: raw analysis beats drift; syncDeck uses gridBeats');
  assert.ok(sync.includes('followerCtl.gridBeats') && sync.includes('masterCtl.gridBeats'));

  // The interval's clock is the audio clock.
  assert.ok(/const now = cs\.ctxTime/.test(interval), 'the fade is timed off the AudioContext clock');
  assert.ok(!/performance\.now\(\)/.test(code(interval)), 'THE BUG: performance.now() skews against the audio it is fading');

  // fix 7 — the fade always lands exactly on its destination. The position
  // comes from blendTick (which runs fadeStep, and holds the fade while a deck
  // is paused), and the swap writes the destination outright.
  assert.ok(/blendTick\(mix\.blend, now, outRun, inRun, AUTOMIX_RESCUE_XFADE\)/.test(interval), 'the fade is stepped by blendTick');
  assert.ok(/applyCrossfade\(step\.fader\)/.test(interval), 'the fader position comes from it');
  assert.ok(/applyCrossfade\(mix\.blend\.fadeTo\)/.test(interval), 'and the swap branch writes the destination outright');
  // PR #207 review: the swap used to run on `progress >= 1 || !outPlaying`,
  // which cut the rescue's fade off (its outgoing deck is already stopped)
  // and handed a paused blend over. Only blendTick's `finish` swaps now.
  assert.ok(/if \(step\.action === 'finish'\)/.test(interval), 'the swap waits for the fade to finish');
  assert.ok(!/progress >= 1 \|\| !outPlaying/.test(code(interval)), 'THE BUG: a stopped outgoing deck swapped mid-fade');

  // fix 8/11 — the seed block owns both the fader normalisation and the wait
  // for analysis before the first track starts.
  assert.ok(/applyCrossfade\(current === 'A' \? -1 : 1\)/.test(seed),
    'the crossfader is normalised where the deck is seeded, so the manual toggle gets it too');
  assert.ok(/AUTOMIX_SEED_WAIT_MS/.test(seed), 'the seed waits for analysis (bounded)');
  assert.ok(/ctl\.firstBeat/.test(seed), 'and starts the first track on its first beat, not at 0');
  assert.ok(!/pendingPlayRef/.test(code(seed)), 'THE BUG: pendingPlayRef punched play the instant the buffer decoded');
  // Both `pendingStart`/`pendingStop` selectors are declared before either
  // effect, so the bridge slice has to run to the next section, not to the
  // second selector (which would make the assertion below vacuous).
  const bridge = src.slice(src.indexOf('const automixPendingStart'), src.indexOf('// Deck-load bridge'));
  assert.ok(bridge.includes('consumeStart()'), 'found the Send-to-DJ bridge effect');
  assert.ok(!/applyCrossfade\(-1\)/.test(code(bridge)), 'the bridge no longer normalises the fader on its own');

  // Teardown: switching automix off mid-blend restores the bass it cut and
  // releases the sync-lock it armed (nothing else ever would).
  const teardown = automix.slice(automix.indexOf('return () => {', intervalStart));
  assert.ok(/setDeckEq\('A', 'low'/.test(teardown) && /setDeckEq\('B', 'low'/.test(teardown),
    'the effect teardown puts both decks\' low EQ back');
  assert.ok(/setSyncLock\(null\)/.test(teardown), 'and drops the PLL it armed');

  // fix 10 — the next track may be chosen harmonically, through the run's
  // queue (lib/djAutomixPlan createAutomixQueue), behind the persisted toggle.
  assert.ok(/createAutomixQueue\(/.test(automix), 'the next track goes through the harmonic queue');
  assert.ok(/preferHarmonic/.test(automix), 'behind a flag');
}

/* ───────────────── DJ-4R: the review rework (ticket DJ-4R) ───────────────── */
{
  const src = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const automix = src.slice(src.indexOf('// Automix (D7): auto-sequence'));
  const intervalStart = automix.indexOf('const id = window.setInterval');
  const interval = automix.slice(intervalStart, automix.indexOf('}, 500);', intervalStart));
  const seed = automix.slice(automix.indexOf('const curEntry ='), intervalStart);
  const pllStart = src.indexOf('if (!syncLock) return;');
  const pll = src.slice(pllStart, src.indexOf('}, 350);', pllStart));
  assert.ok(pll.includes('getStatus(follower)'), 'found the sync-lock PLL');

  // 2 — the phrase grid gets the REAL downbeats DJ-3's rhythm store supplies.
  assert.ok(/downbeats: outCtl\.downbeats/.test(interval),
    'the plan is handed the outgoing deck\'s downbeats');
  assert.ok(!/downbeats: null/.test(code(interval)),
    'THE BUG: the plan was wired to a literal null, so phrase alignment never saw a real bar line');

  // 3 — the PLL must not cancel a phase bend that is still running.
  assert.ok(/hasPendingBend\(/.test(pll), 'the PLL asks the engine whether a bend is in flight');
  const bendGuard = pll.indexOf('hasPendingBend(');
  assert.ok(bendGuard >= 0 && bendGuard < pll.indexOf('setDeckPitch('),
    'THE BUG: setDeckPitch cancels the bend, so the guard has to come first');

  // 4 — a partly-delivered nudge is finished, not dropped.
  const sync = src.slice(src.indexOf('const syncDeck = ('), src.indexOf('const syncDeckRef'));
  assert.ok(/residualNudge\(/.test(sync), 'syncDeck measures what the nudge could not deliver');
  assert.ok(!/^\s*djEngine\.nudgePhase\(follower, delta\);\s*$/m.test(code(sync)),
    'THE BUG: the return value of nudgePhase was thrown away');
  assert.ok(/nudgePhase\(/.test(pll), 'and the PLL applies the remainder on a later tick');

  // 5 — a deck that never decodes must stop polling and say so.
  assert.ok(/AUTOMIX_LOAD_TIMEOUT_MS/.test(seed), 'the seed poll has a hard give-up deadline');
  assert.ok(/never finished loading/.test(seed), 'and tells the user why the set did not start');
  assert.ok(seed.indexOf('AUTOMIX_LOAD_TIMEOUT_MS') < seed.indexOf('if (!st.hasBuffer'),
    'THE BUG: the no-buffer branch returned before any deadline was ever checked');

  // 6 — no cast onto a store field that does not exist. The store has one
  // now (djAutomixPrefsStore, the "Harmonic order" toggle), so the local
  // constant that stood in for it is gone.
  assert.ok(!/as \{ preferHarmonic/.test(automix),
    'THE BUG: preferHarmonic was read through a cast on a non-existent store field');
  assert.ok(/useDjAutomixPrefs\.getState\(\)\.preferHarmonic/.test(automix), 'the sequencer reads the persisted toggle');
  assert.ok(!/PREFER_HARMONIC/.test(code(automix)), 'no hard-wired constant is left');

  // 7 — the shared frozen empties cannot be mutated through the status type.
  const engine = readFileSync(fileURLToPath(new URL('../state/djEngine.ts', import.meta.url)), 'utf8');
  assert.ok(/stems: readonly string\[\]/.test(engine), 'DeckStatus.stems is readonly');
  assert.ok(/stemLevels: Readonly<Record<string, number>>/.test(engine), 'DeckStatus.stemLevels is readonly');
  assert.ok(!/NO_STEMS as string\[\]/.test(engine), 'THE BUG: the readonly empties were cast back to mutable');
}

/* ───────────────── DJ-5: the live-app hotfix (ticket DJ-5) ─────────────────
 * Two defects the lead watched happen with START AUTO DJ on a bundled 18-track
 * set. Both decide what the ENGINE is told, so neither is reachable from the
 * pure plan tests — this is the wiring.
 *
 *  A · Deck A was loaded (title + BPM on screen) but still decoding when the
 *      500 ms interval first ran. `playing` was false, so the dead-air rescue
 *      fired, the incoming deck became `current` with an undecoded buffer of
 *      its own, and the next tick did it again: a new track loaded every 3-5 s,
 *      nothing ever played, the footer stayed PAUSED. The plan can only tell
 *      "ran out" from "never started" if the interval hands it that fact.
 *  B · A bogus 36.6 BPM detection made the match unreachable. The flash was
 *      already honest ("NOT beatmatched") — but syncDeck and the PLL applied
 *      the CLAMPED `pct` regardless, parking Deck A at +10 % and Deck B at
 *      −10 % for no benefit at all.
 */
{
  const src = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const automix = src.slice(src.indexOf('// Automix (D7): auto-sequence'));
  const intervalStart = automix.indexOf('const id = window.setInterval');
  const interval = automix.slice(intervalStart, automix.indexOf('}, 500);', intervalStart));
  const seed = automix.slice(automix.indexOf('const curEntry ='), intervalStart);
  const sync = src.slice(src.indexOf('const syncDeck = ('), src.indexOf('const syncDeckRef'));
  const pllStart = src.indexOf('if (!syncLock) return;');
  const pll = src.slice(pllStart, src.indexOf('}, 350);', pllStart));
  assert.ok(pll.includes('getStatus(follower)'), 'found the sync-lock PLL');

  // A — the run tracks whether the outgoing deck ever actually played.
  assert.ok(/started: mix\.started/.test(interval),
    'the plan call passes the run\'s `started` flag (THE BUG: without it every undecoded deck read as dead air)');
  assert.ok(/djEngine\.playDeck\(current\);[\s\S]{0,240}?started = true/.test(seed),
    'the seed poll marks the run as started where it actually plays the deck');
  // The swap maintains `started` for the deck it just moved to; the exact
  // expression (which reads the deck rather than asserting the play took) is
  // pinned in the DJ-5 review block below.
  assert.ok(/mix\.current = nxt;[\s\S]{0,600}?mix\.started =/.test(interval),
    'and the swap marks the deck it just played as started');
  // The 15 s give-up path never plays anything, so `started` stays false and
  // the interval can never transition — nothing else would ever switch automix
  // off, so it says so once and stops rather than ticking forever doing nothing.
  assert.ok(/never finished loading[\s\S]{0,400}?setAutomixOn\(false\)/.test(seed),
    'the load give-up path stops automix instead of leaving it on over a deck that never played');
  // A deck that is LOADED BUT PAUSED has to be seeded too, not just an empty
  // one. `started` now gates the dead-air rescue, so the old `if (!curEntry)`
  // gate left the manual Automix toggle with no seed poll and nothing else
  // that would ever play the deck it was pointed at: the interval sat on
  // `outgoing-not-started` forever. Track 1 is only loaded onto a deck that is
  // actually empty — a deck that already holds a track keeps it.
  assert.ok(/if \(!curEntry\) loadOnto\(current, list\[0\]\);/.test(seed),
    'only an EMPTY deck gets track 1 loaded onto it');
  assert.ok(/if \(!curEntry \|\| !djEngine\.getStatus\(current\)\.playing\)/.test(seed),
    'the seed poll is armed for a loaded-but-paused deck as well as an empty one');
  assert.ok(
    seed.indexOf("applyCrossfade(current === 'A' ? -1 : 1)")
      > seed.indexOf('if (!curEntry || !djEngine.getStatus(current).playing)'),
    'and the crossfader normalisation sits inside that widened gate, so a paused deck gets it too',
  );

  // B — an unreachable tempo match pulls nothing, in BOTH places that pitch.
  assert.ok(/const pct = match\.appliedPct/.test(sync),
    'syncDeck puts the tempo match\'s appliedPct on the fader');
  assert.ok(!/match\.pct/.test(code(sync)),
    'THE BUG: syncDeck applied the CLAMPED pct even when `matched` was false');
  assert.ok(/match\.matched &&/.test(sync),
    'and skips the phase nudge for a tempo pair it cannot hold');
  assert.ok(/NOT beatmatched/.test(sync), 'the honest flash is unchanged');
  assert.ok(/base\.appliedPct/.test(pll), 'the sync-lock PLL applies appliedPct too');
  assert.ok(!/base\.pct/.test(code(pll)),
    'THE BUG: the PLL walked an unmatchable deck to the pitch rail every 350 ms');
  assert.ok(/base\.matched &&/.test(pll), 'and adds no bend to a tempo it cannot hold');
}

/* ─────────── DJ-5 review follow-ups: three notes on the hotfix ───────────
 * Each one is a consequence of widening the seed gate / adding `started`,
 * and each is invisible to the pure plan tests because it is a call the
 * interval makes on the engine.
 */
{
  const src = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const automix = src.slice(src.indexOf('// Automix (D7): auto-sequence'));
  const intervalStart = automix.indexOf('const id = window.setInterval');
  const interval = automix.slice(intervalStart, automix.indexOf('}, 500);', intervalStart));
  const seed = automix.slice(automix.indexOf('const curEntry ='), intervalStart);
  const sync = src.slice(src.indexOf('const syncDeck = ('), src.indexOf('const syncDeckRef'));

  // 1 — the widened gate now seeds decks that are ALREADY mid-track, and the
  // unconditional seek dragged them back to their first beat. Seeking to
  // `firstBeat` is a start-of-track courtesy (fix 8); a deck the user parked
  // 90 s in must resume from where it sits.
  // The position is re-read from the engine, not taken from the `st` bound at
  // the top of the poll: djEngine hands back ONE status object per deck and
  // rewrites it in place, so `st.currentTime` is whatever the last engine call
  // left there rather than the position this decision is about.
  assert.ok(/djEngine\.getStatus\(current\)\.currentTime < firstBeat/.test(seed),
    'the seed only seeks to the first beat when the deck is still before it (THE BUG: a paused deck mid-track got rewound)');
  assert.ok(/firstBeat > 0\.02 && djEngine\.getStatus\(current\)\.currentTime < firstBeat/.test(seed),
    'the guard is part of the same seek condition, not a separate branch');

  // 2 — key-lock was engaged on a real pull and NEVER released, so a deck
  // that later matched at 0 % kept the formant processing from a previous
  // track. Both sync paths must write the boolean, not just the `true` case.
  assert.ok(/setDeckKeylock\(follower, false\)/.test(sync),
    'syncDeck releases key-lock once the pull no longer warrants it');
  // The automix site now sets key-lock BEFORE play (PR #207 review), from
  // the pull the tempo match will need, through automixKeylockStep.
  assert.ok(/setDeckKeylock\(step\.deck, false\)/.test(interval),
    'the automix key-lock step releases it too');
  assert.ok(/const want = Math\.abs\(pct\) > KEYLOCK_PITCH_PCT/.test(sync)
    && /automixKeylockStep\(\{\s*pullPct: pull\.appliedPct/.test(interval),
    'THE BUG: key-lock was only ever turned ON — both sites now decide from the pull itself');

  // 4 — …but a key-lock the USER engaged by hand is not automix's to release.
  // Writing the bare boolean (the note-2 form) switched off a lock set from
  // the deck's own Key-Lock toggle the moment a sync computed a ≤3 % pull.
  // `autoKeylockRef` records which locks the sync paths own; everything else
  // is left exactly as the user set it.
  assert.ok(/autoKeylockRef\.current\[follower\]/.test(sync),
    'syncDeck only releases a key-lock it engaged itself');
  assert.ok(/lockedByAutomix: autoKeylockRef\.current\[nxt\]/.test(interval),
    'and the automix site only releases its own too');
  // …and it only CLAIMS one it actually engaged. `setDeckKeylock` early-returns
  // when the deck is already locked (djEngine.ts: `if (d.keylock === on)
  // return;`), so a >3 % pull on a deck the USER had locked by hand was a no-op
  // on the engine but still flipped the flag to true — handing automix a lock
  // it never engaged, which the next ≤3 % sync then released.
  assert.ok(/const wasOn = djEngine\.getStatus\(follower\)\.keylock/.test(sync)
    && /if \(!wasOn\) autoKeylockRef\.current\[follower\] = true/.test(sync),
    'syncDeck claims ownership only when the engine lock was actually OFF');
  assert.ok(/const wasOn = djEngine\.getStatus\(step\.deck\)\.keylock/.test(interval)
    && /if \(!wasOn\) autoKeylockRef\.current\[step\.deck\] = true/.test(interval),
    'and so does the automix site (THE BUG: both claimed unconditionally on a >3 % pull)');
  const keylockToggle = src.slice(src.indexOf('setKeylock: (on: boolean)'), src.indexOf('setSlip: (on: boolean)'));
  assert.ok(keylockToggle.length > 0 && keylockToggle.length < 600, 'found the deck Key-Lock toggle handler');
  assert.ok(/setUserKeylock\(deckId, on\)/.test(keylockToggle),
    'the user\'s own Key-Lock toggle hands the deck back — automix may no longer release that lock');

  // 5 — ONE entry point for a key-lock the user drives. The deck toggle above
  // cleared the flag, but the MIDI-mappable `dj.keylock.${d}` target called
  // djEngine.setDeckKeylock directly and did not, so a lock engaged from a
  // mapped controller was still switched off by the next ≤3 % pull.
  //
  // The flag and the function live in bindableTargets.ts rather than here:
  // DJView already imports DJ_TARGETS from it, and the reverse edge would put
  // this whole view module inside a file that xrControlDjSource.ts and
  // swayRouting.ts import LAZILY on purpose ("so it stays in the DJ chunk and
  // never loads at app boot").
  const bind = readFileSync(fileURLToPath(new URL('../state/bindableTargets.ts', import.meta.url)), 'utf8');
  assert.ok(/export const setUserKeylock|export function setUserKeylock/.test(bind),
    'setUserKeylock is exported once, from where the ownership flag lives');
  assert.ok(!/from '\.\.\/views\/DJView/.test(bind),
    'and bindableTargets never imports the view back — that would drag DJView into the lazy DJ chunk');
  // Anchored on the target-literal syntax, not the bare id: `dj.keylock.` also
  // appears in setUserKeylock's own docblock further up the file, and slicing
  // from there to the slip target swept up the whole helper.
  const keylockTarget = bind.slice(bind.indexOf('{ id: `dj.keylock.'), bind.indexOf('{ id: `dj.slip.'));
  assert.ok(keylockTarget.length > 0 && keylockTarget.length < 400, 'found the dj.keylock MIDI target');
  assert.ok(/setUserKeylock\(d, Boolean\(v\)\)/.test(keylockTarget),
    'the MIDI key-lock target goes through setUserKeylock too');
  assert.ok(!/setDeckKeylock/.test(keylockTarget),
    'THE BUG: it called djEngine.setDeckKeylock directly, bypassing the ownership flag entirely');

  // 3 — the swap asserted the incoming deck had started instead of reading
  // it. A play that never took (a buffer evicted, an engine refusal) would
  // have latched `started` true over a deck making no sound, putting the
  // dead-air rescue back in charge of exactly the case DJ-5 removed it from.
  assert.ok(/mix\.started = djEngine\.getStatus\(nxt\)\.playing \|\| mix\.started/.test(interval),
    'the swap reads the incoming deck\'s real state and never clears a `started` already earned');
  // Deliberately loose: an anchored, semicolon-exact pattern would let a
  // reformat (`mix.started  =  true`, a trailing comment, no semicolon) put
  // the unconditional assignment back without this noticing.
  assert.ok(!/mix\.started\s*=\s*true\b/.test(code(interval)),
    'THE BUG: `started` was set true unconditionally on every swap');
}

/* djEngine.hasPendingBend — the accessor the PLL gates on, exercised directly.
 * A deck that was never built has nothing scheduled, and asking must not
 * build one (that would need an AudioContext). */
{
  const djEngine = await import('../state/djEngine.ts');
  assert.equal(typeof djEngine.hasPendingBend, 'function', 'the accessor is exported');
  assert.equal(djEngine.hasPendingBend('A'), false, 'an unbuilt deck has no bend in flight');
  assert.equal(djEngine.hasPendingBend('B'), false);
  // Asking did not construct a deck (which would have needed an AudioContext
  // and thrown under plain tsx).
  assert.equal(djEngine.getStatus('A').hasBuffer, false, 'and the deck is still unbuilt');
}

console.log('DJView.b12: ok');
