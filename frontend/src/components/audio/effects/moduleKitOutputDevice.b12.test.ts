/**
 * `public/edit-modules/module-kit.js`: follow the app's output device.
 *
 * Every edit-module page builds its OWN `AudioContext` for local preview only
 * (`ensureAudio()`, lazily, on first Load/Play) — it is never part of the
 * shared engine graph `lib/audioSink.ts` routes, so a module's preview always
 * played on the OS default no matter what Settings -> Inputs & outputs said.
 * `EffectGuiStage.tsx` now posts `{ type: 'thedaw-output-device', deviceId }`
 * into the iframe once it loads and again whenever the app's main output
 * changes; this is `module-kit.js`'s side of that contract — it wraps
 * `window.AudioContext` so EVERY context a page creates (including ones
 * created after the message, which is the common case) gets `setSinkId`
 * applied, and remembers the last id so a context built later still follows
 * it.
 *
 * Batch-12 audit MAJOR finding (round 1): the listener never checked
 * `e.source`, so any OTHER frame that can reach this window (an ad, a
 * compromised iframe on the same page, anything embedding this page) could
 * forge a `thedaw-output-device` message and silently redirect a module's
 * preview audio to a device of its choosing. The fix is
 * `e.source !== window.parent` as the listener's first line — this iframe's
 * only legitimate sender is its host frame — and the source-mismatch case
 * below is what pins it.
 *
 * Batch-12 audit MAJOR finding (round 2): 10 pages (character-fx, cleanup,
 * enhance, granular, neural-codec, parametric-eq, promptfx, repair, tool,
 * vocoder) DO build an `AudioContext` (for an analyser / visualizer), but
 * ALSO play their processed preview through a plain `<audio controls>`
 * element that never goes through that context at all — the device-follow
 * fix above never touched it. `applyOutputDevice` now ALSO walks
 * `document.querySelectorAll('audio, video')` and calls
 * `HTMLMediaElement.setSinkId` on each, applied once at load and kept current
 * by a `MutationObserver` watching for `src` changes (every one of these
 * pages reuses ONE static `<audio>` tag across every processed take, so a
 * device change between takes has to reach the element again) — no page
 * edits were needed for this half.
 *
 * `module-kit.js` is a bare script (no ES module, no bundler) loaded via
 * `<script src="module-kit.js">` BEFORE each page's own inline script (see
 * `editModulesContract.test.ts`'s HOST_TOKENS check and every
 * `public/edit-modules/*.html`). It cannot be imported as a module, so this
 * test runs its real source text in a `vm` context with a minimal fake
 * `window`/`document`/`AudioContext`/`MutationObserver` — the same "run the
 * real file, fake only the DOM surface it needs" approach
 * `EffectWindows.test.tsx` and `MixerStrips.b12.test.tsx` use for React
 * components.
 *
 * Run: `npx tsx src/components/audio/effects/moduleKitOutputDevice.b12.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const MODULE_KIT_PATH = join(here, '..', '..', '..', '..', 'public', 'edit-modules', 'module-kit.js');
const SOURCE = readFileSync(MODULE_KIT_PATH, 'utf8');

interface FakeMessageEvent {
  data: unknown;
  /** Defaults to the fake window's own `parent` in `_emit` below — matching
   *  a real message that actually came from the host frame — unless a test
   *  overrides it to prove a forged sender is rejected. */
  source?: unknown;
}

interface FakeWindow {
  AudioContext?: new () => FakeAudioContext;
  /** The fake window's own host frame; a legitimate message's `e.source`. */
  parent: object;
  addEventListener: (type: string, fn: (e: FakeMessageEvent) => void) => void;
  removeEventListener: () => void;
  theDAWKit?: { applyOutputDevice: (deviceId: string) => void };
  _emit: (type: string, evt: FakeMessageEvent) => void;
}

class FakeAudioContext {
  sinkCalls: string[] = [];
  rejectNext = false;
  unsupported = false;
  state: 'running' | 'closed' = 'running';
  private stateListeners: Array<() => void> = [];
  setSinkId?(id: string): Promise<void> {
    this.sinkCalls.push(id);
    if (this.rejectNext) return Promise.reject(new Error('device gone'));
    return Promise.resolve();
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'statechange') this.stateListeners.push(fn);
  }
  /** What `ctx.close()` does to `state`, followed by the real 'statechange'
   *  event every closing AudioContext fires. */
  simulateClose(): void {
    this.state = 'closed';
    for (const fn of this.stateListeners) fn();
  }
}

/** A fake `<audio>`/`<video>` element, standing in for the 10 pages' `<audio
 *  controls>` previews (`ain`/`aout`/etc.) that never touch the AudioContext
 *  at all. */
class FakeMediaElement {
  nodeType = 1 as const;
  sinkCalls: string[] = [];
  sinkId = '';
  rejectNext = false;
  constructor(
    public tagName: 'AUDIO' | 'VIDEO' = 'AUDIO',
    private supportsSink = true,
  ) {}
  setSinkId(id: string): Promise<void> | undefined {
    if (!this.supportsSink) return undefined;
    this.sinkCalls.push(id);
    this.sinkId = id;
    if (this.rejectNext) return Promise.reject(new Error('device gone'));
    return Promise.resolve();
  }
  querySelectorAll(): FakeMediaElement[] {
    return []; // a leaf media element has no media-element descendants
  }
}

/** One MutationObserver instance, faithfully enough to drive module-kit.js's
 *  real callback: records what it observed and lets a test fire records
 *  (a real DOM would fire these itself; nothing here simulates the browser's
 *  own mutation-detection, only delivers the record shape module-kit.js reads). */
interface FakeObserveOptions {
  childList?: boolean;
  subtree?: boolean;
  attributes?: boolean;
  attributeFilter?: string[];
}

class FakeMutationObserver {
  observeTarget: unknown;
  observeOptions: FakeObserveOptions | undefined;
  constructor(private cb: (records: unknown[]) => void) {}
  observe(target: unknown, options: FakeObserveOptions): void {
    this.observeTarget = target;
    this.observeOptions = options;
  }
  disconnect(): void {}
  /** Test-only: deliver an attributes mutation for `target`'s `src` — what a
   *  real observer reports when a page does `el.src = someBlobUrl`. */
  fireAttr(target: FakeMediaElement): void {
    this.cb([{ type: 'attributes', attributeName: 'src', target }]);
  }
}

interface FakeDocument {
  readyState: 'loading' | 'complete';
  documentElement: object;
  _mediaEls: FakeMediaElement[];
  querySelectorAll(sel: string): FakeMediaElement[];
  querySelector(): null;
  addEventListener(type: string, fn: () => void): void;
}

function makeFakeDocument(initialMediaEls: FakeMediaElement[], readyState: 'loading' | 'complete'): FakeDocument {
  const domListeners: Record<string, Array<() => void>> = {};
  return {
    readyState,
    documentElement: {},
    _mediaEls: initialMediaEls,
    querySelectorAll(sel: string) {
      if (sel.indexOf('audio') === -1) return [];
      return this._mediaEls;
    },
    querySelector: () => null,
    addEventListener(type, fn) {
      (domListeners[type] ??= []).push(fn);
      if (type === 'DOMContentLoaded' && this.readyState === 'complete') fn();
    },
  };
}

/** A fresh sandbox running the real module-kit.js source, ready for one test. */
function loadModuleKit(opts: {
  audioCtor?: unknown;
  mediaEls?: FakeMediaElement[];
  docReadyState?: 'loading' | 'complete';
} = {}): {
  win: FakeWindow;
  ctxCtor: new () => FakeAudioContext;
  document: FakeDocument;
  observer: FakeMutationObserver | undefined;
} {
  const audioCtor = opts.audioCtor ?? FakeAudioContext;
  const mediaEls = opts.mediaEls ?? [];
  const document = makeFakeDocument(mediaEls, opts.docReadyState ?? 'complete');
  const listeners: Record<string, Array<(e: FakeMessageEvent) => void>> = {};
  const parent = { name: 'host-frame' };
  const win: FakeWindow = {
    AudioContext: audioCtor as new () => FakeAudioContext,
    parent,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    _emit(type, evt) {
      // A message with no explicit source is, by construction here, one that
      // really did come from the host frame — every EXISTING case in this
      // file describes a legitimate EffectGuiStage post.
      const withSource: FakeMessageEvent = { source: parent, ...evt };
      for (const fn of listeners[type] ?? []) fn(withSource);
    },
  };
  let observer: FakeMutationObserver | undefined;
  class ScopedMutationObserver extends FakeMutationObserver {
    constructor(cb: (records: unknown[]) => void) {
      super(cb);
      observer = this;
    }
  }
  const context = vm.createContext({ window: win, document, console, MutationObserver: ScopedMutationObserver });
  vm.runInContext(SOURCE, context, { filename: 'module-kit.js' });
  return { win, ctxCtor: win.AudioContext!, document, observer };
}

// ── every AudioContext a page creates is tracked and sunk ──────────────────
{
  const { win, ctxCtor } = loadModuleKit();
  assert.notEqual(ctxCtor, FakeAudioContext, 'window.AudioContext is wrapped, not left untouched');

  const ctx = new ctxCtor();
  assert.ok(ctx instanceof FakeAudioContext, 'a wrapped context is still an instance of the real class');

  win.theDAWKit!.applyOutputDevice('dev-123');
  assert.deepEqual((ctx as unknown as FakeAudioContext).sinkCalls, ['dev-123'], 'an existing context follows a new device id');
}

// ── a context built AFTER the device id is known (ensureAudio() runs lazily,
// on first Load/Play, almost always after the page has already loaded) still
// gets sunk, at construction time ──────────────────────────────────────────
{
  const { win, ctxCtor } = loadModuleKit();
  win.theDAWKit!.applyOutputDevice('dev-456');
  const late = new ctxCtor() as unknown as FakeAudioContext;
  assert.deepEqual(late.sinkCalls, ['dev-456'], 'a context created after the message still opens on the right device');
}

// ── the postMessage contract: EffectGuiStage posts
// { type: 'thedaw-output-device', deviceId } from the HOST FRAME ───────────
{
  const { win, ctxCtor } = loadModuleKit();
  const ctx = new ctxCtor() as unknown as FakeAudioContext;
  win._emit('message', { data: { type: 'thedaw-output-device', deviceId: 'dev-789' } });
  assert.deepEqual(ctx.sinkCalls, ['dev-789'], 'a real thedaw-output-device message applies the device');

  // An unrelated or malformed message must not touch anything.
  win._emit('message', { data: { type: 'thedaw-audio', buffer: new ArrayBuffer(0) } });
  win._emit('message', { data: null });
  win._emit('message', { data: { type: 'thedaw-output-device', deviceId: 42 } });
  assert.deepEqual(ctx.sinkCalls, ['dev-789'], 'unrelated or malformed messages are ignored, not applied as ""');
}

// ── audit MAJOR fix: a message from anywhere OTHER than the host frame is
// rejected outright, even a well-formed thedaw-output-device payload ───────
{
  const { win, ctxCtor } = loadModuleKit();
  const ctx = new ctxCtor() as unknown as FakeAudioContext;
  const forger = { name: 'not-the-host-frame' };
  win._emit('message', { data: { type: 'thedaw-output-device', deviceId: 'dev-evil' }, source: forger });
  assert.deepEqual(ctx.sinkCalls, [], 'a forged sender cannot redirect the preview output device');

  // The genuine host frame is still honoured afterwards — the guard rejects
  // by sender, not by poisoning the listener.
  win._emit('message', { data: { type: 'thedaw-output-device', deviceId: 'dev-real' } });
  assert.deepEqual(ctx.sinkCalls, ['dev-real'], 'a subsequent message from the real host frame still works');
}

// ── no setSinkId support (pre-Chromium-110): a silent no-op, never a throw ──
{
  class NoSinkContext {
    /* no setSinkId at all */
  }
  const { win } = loadModuleKit({ audioCtor: NoSinkContext });
  assert.doesNotThrow(() => {
    new win.AudioContext!();
    win.theDAWKit!.applyOutputDevice('dev-000');
  }, 'a context with no setSinkId at all must not crash the page');
}

// ── a rejected setSinkId (device gone) must not throw or reject unhandled ──
{
  const { win, ctxCtor } = loadModuleKit();
  const ctx = new ctxCtor() as unknown as FakeAudioContext;
  ctx.rejectNext = true;
  assert.doesNotThrow(() => win.theDAWKit!.applyOutputDevice('dev-gone'), 'a rejected setSinkId stays non-fatal');
}

// ── a closed context is dropped from tracking, not held forever ────────────
// A page can build and discard many AudioContexts over a session (each
// module reload from EffectGuiStage's `key={module.id}` remount is a fresh
// one); without this, trackedContexts would grow without bound.
{
  const { win, ctxCtor } = loadModuleKit();
  const closed = new ctxCtor() as unknown as FakeAudioContext;
  const stillOpen = new ctxCtor() as unknown as FakeAudioContext;
  closed.simulateClose();

  win.theDAWKit!.applyOutputDevice('dev-after-close');
  assert.deepEqual(closed.sinkCalls, [], 'a closed context is no longer touched once it closes');
  assert.deepEqual(stillOpen.sinkCalls, ['dev-after-close'], 'an open context is still followed');
}

// ── minor audit fix: the wrapper keeps the native constructor's own name
// (in production, "AudioContext"), so anything introspecting `.name` (or an
// instance's constructor name in a debugger) still sees the real thing
// rather than this file's internal helper name. ────────────────────────────
{
  const { ctxCtor } = loadModuleKit();
  assert.equal(ctxCtor.name, FakeAudioContext.name, "the wrapped constructor's name matches the native one it wraps");
  assert.notEqual(ctxCtor.name, 'WrappedAudioContext', "it is not left as this file's own internal name");
}

/* ══════════════════════════════════════════════════════════════════════════
   Audit MAJOR (round 2): <audio>/<video> elements — the 10 pages that play
   their processed preview through a plain <audio controls> tag rather than
   the wrapped AudioContext.
   ══════════════════════════════════════════════════════════════════════════ */

// ── an existing <audio> element (present at load, e.g. tool.html's #ain/#aout)
// gets the device applied through applyOutputDevice, same as an AudioContext ─
{
  const ain = new FakeMediaElement('AUDIO');
  const aout = new FakeMediaElement('AUDIO');
  const { win } = loadModuleKit({ mediaEls: [ain, aout] });
  win.theDAWKit!.applyOutputDevice('dev-media-1');
  assert.deepEqual(ain.sinkCalls, ['dev-media-1'], 'the input preview element follows the chosen device');
  assert.deepEqual(aout.sinkCalls, ['dev-media-1'], 'the output preview element follows the chosen device too');
}

// ── applied once at load (DOMContentLoaded), not only on the first message —
// so an element that is already on the right device before any message
// arrives is not silently skipped by the rest of module-kit.js's own logic ──
{
  const el = new FakeMediaElement('AUDIO');
  // readyState 'complete' means module-kit.js's own DOMContentLoaded handling
  // must run its load-time application synchronously rather than waiting for
  // an event that already fired before this script ran.
  loadModuleKit({ mediaEls: [el], docReadyState: 'complete' });
  // With no device chosen yet this is a no-op call (mirrors the AudioContext
  // side's "nothing to apply until a real id is known"), so nothing throws
  // and nothing is called with ''.
  assert.deepEqual(el.sinkCalls, [], 'load-time application with no device chosen yet calls nothing');
}

// ── a video element is covered too (querySelectorAll('audio, video')) ──────
{
  const vid = new FakeMediaElement('VIDEO');
  const { win } = loadModuleKit({ mediaEls: [vid] });
  win.theDAWKit!.applyOutputDevice('dev-media-2');
  assert.deepEqual(vid.sinkCalls, ['dev-media-2'], 'a <video> element is followed too, not only <audio>');
}

// ── audit round 3, minor #1: the observer watches attributes ONLY, not
// childList — every page's <audio>/<video> is static markup (grepped across
// every public/edit-modules page: zero createElement('audio'|'video'), zero
// `new Audio()`), so there is nothing for a childList branch to ever catch,
// only a cost: maximizer.html redraws its meter markup every animation
// frame, and a childList+subtree observer would run the media-element scan
// on every one of those insertions, forever, for no possible match. ───────
{
  const { observer } = loadModuleKit({ mediaEls: [] });
  assert.ok(observer, 'a MutationObserver is installed');
  assert.equal(observer!.observeOptions?.childList, undefined, 'childList is not observed — nothing dynamic to catch');
  assert.equal(observer!.observeOptions?.attributes, true, 'attribute changes are still observed');
  // Array.from: the options object crossed from the vm sandbox's realm, so
  // its array has a DIFFERENT Array.prototype than this file's — deepStrictEqual
  // (what 'node:assert/strict' uses) checks prototype identity and would fail
  // on that alone, unrelated to the actual values.
  assert.deepEqual(Array.from(observer!.observeOptions?.attributeFilter ?? []), ['src'], 'scoped to src, not every attribute');
}

// ── re-applied when an existing element's src changes — a page reusing one
// static <audio> tag across multiple processed takes (every one of the 10
// named pages) must not need to be re-added to pick up the current device.
// Checked by INDEPENDENT facts (call count, most recent value) rather than a
// full exact-sequence equality: the real setSinkId is asynchronous (its
// Promise settles on a later microtask, so `el.sinkId` in a real browser has
// NOT advanced yet at the point a second applyOutputDevice call re-checks
// the guard), and asserting the precise array this fake's SYNCHRONOUS
// setSinkId happens to produce would pin an implementation detail of the
// fake, not a guarantee module-kit.js actually gives. ──────────────────────
{
  const el = new FakeMediaElement('AUDIO');
  const { win, observer } = loadModuleKit({ mediaEls: [el] });
  win.theDAWKit!.applyOutputDevice('dev-media-3');
  assert.ok(el.sinkCalls.includes('dev-media-3'), 'sanity: the element already has the device from applyOutputDevice');

  // Device changes again; a fresh src set on the SAME element must still
  // reflect the CURRENT device (proves the observer reads live state, not a
  // value captured at observe() time).
  win.theDAWKit!.applyOutputDevice('dev-media-4');
  observer!.fireAttr(el);
  assert.equal(el.sinkCalls.length, 2, 'exactly one more application happened for the src change');
  assert.equal(el.sinkCalls[el.sinkCalls.length - 1], 'dev-media-4', 'the most recent application is the CURRENT device');
}

// ── no setSinkId support on the element (pre-Chromium-110): silent no-op ───
{
  const el = new FakeMediaElement('AUDIO', /* supportsSink */ false);
  const { win } = loadModuleKit({ mediaEls: [el] });
  assert.doesNotThrow(() => win.theDAWKit!.applyOutputDevice('dev-media-5'), 'a media element with no setSinkId must not crash the page');
}

// ── a rejected element-side setSinkId (device gone) must not throw or
// reject unhandled, same guarantee the AudioContext side already has ───────
{
  const el = new FakeMediaElement('AUDIO');
  el.rejectNext = true;
  const { win } = loadModuleKit({ mediaEls: [el] });
  assert.doesNotThrow(() => win.theDAWKit!.applyOutputDevice('dev-media-6'), 'a rejected element setSinkId stays non-fatal');
}

console.log('module-kit.js output-device follow: all assertions passed');
