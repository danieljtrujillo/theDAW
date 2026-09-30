/* theDAW edit-module kit — shared by every /edit-modules page.
   Two small jobs, no framework:
     1. theDAWKit.slider(el, opts) turns a page's custom pointer control (SVG
        knob, DIV fader) into a real slider for keyboards and assistive tech:
        role="slider", tabindex, aria-valuemin/max/now/valuetext, arrow keys
        (Shift = coarse), PageUp/Down, Home/End, Delete/Backspace + double-click
        reset. The page keeps its own drawing and pointer code; after a pointer
        change it calls the returned sync() (or theDAWKit.sync(el)).
     2. theDAWKit.pressed / toggleGroup keep aria-pressed truthful on the pages'
        class-toggled pill buttons, and theDAWKit.label gives an unlabeled
        native input/select an accessible name.
   Pages stay self-contained instruments; this file only adds the plumbing the
   scaffold left out. */
(function () {
  'use strict';
  var registry = new WeakMap();
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  function defaultFormat(v, step) {
    var d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return Number(v).toFixed(d);
  }

  function slider(el, opts) {
    if (!el || !opts) return null;
    var o = opts;
    var step = o.step || 1;
    var fmt = o.format || function (v) { return defaultFormat(v, step); };
    var read = function () { var v = Number(o.get()); return isFinite(v) ? v : o.min; };
    var write = function (v) {
      var snapped = o.min + Math.round((v - o.min) / step) * step;
      o.set(clamp(+snapped.toFixed(6), o.min, o.max));
      sync();
    };
    var resetValue = function () { return typeof o.reset === 'function' ? o.reset() : o.reset; };
    var sync = function () {
      var v = read();
      el.setAttribute('aria-valuemin', String(o.min));
      el.setAttribute('aria-valuemax', String(o.max));
      el.setAttribute('aria-valuenow', String(+v.toFixed(4)));
      el.setAttribute('aria-valuetext', String(fmt(v)));
      if (o.label) el.setAttribute('aria-label', o.label);
    };
    el.setAttribute('role', 'slider');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (o.vertical) el.setAttribute('aria-orientation', 'vertical');
    if (o.label && !el.getAttribute('title')) el.setAttribute('title', o.label + (o.reset != null ? ' — double-click resets' : ''));
    el.addEventListener('keydown', function (e) {
      var mult = e.shiftKey ? 10 : 1;
      var v = read();
      var handled = true;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': write(v + step * mult); break;
        case 'ArrowDown': case 'ArrowLeft': write(v - step * mult); break;
        case 'PageUp': write(v + step * 10); break;
        case 'PageDown': write(v - step * 10); break;
        case 'Home': write(o.min); break;
        case 'End': write(o.max); break;
        case 'Backspace': case 'Delete':
          if (o.reset != null) write(resetValue()); else handled = false; break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
    if (o.reset != null && !o.noDblClick) {
      el.addEventListener('dblclick', function (e) { e.preventDefault(); write(resetValue()); });
    }
    if (o.wheel) {
      el.addEventListener('wheel', function (e) {
        e.preventDefault();
        write(read() + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      }, { passive: false });
    }
    var handle = { sync: sync, el: el, opts: o };
    registry.set(el, handle);
    sync();
    return handle;
  }

  function sync(el) { var h = registry.get(el); if (h) h.sync(); }
  function syncAll(root) {
    var scope = root || document;
    scope.querySelectorAll('[role="slider"]').forEach(function (el) { sync(el); });
  }

  /* ── output-device follow ────────────────────────────────────────────────
     Each edit-module page builds its OWN AudioContext lazily (ensureAudio(),
     on first Load/Play), for local preview only — it is never part of the
     shared engine graph lib/audioSink.ts routes. Without this, a module's
     preview always plays on the OS default output no matter what
     Settings -> Inputs & outputs says, which is silent-but-wrong on any rig
     with more than one output.

     EffectGuiStage posts { type: 'thedaw-output-device', deviceId } into this
     iframe once it loads and again whenever the app's main output changes
     (EffectGuiStage.tsx); this file remembers the last id and applies it to
     EVERY AudioContext a page creates — including ones created LATER than the
     message, which is the common case, since ensureAudio() runs on first
     Load/Play rather than at page load.

     AudioContext.setSinkId is Chromium 110+ (see lib/audioSink.ts
     supportsContextSink); its absence, and a rejection (device unplugged), are
     both silent no-ops — same degrade path the app's own main-output control
     takes, so a module keeps previewing on the current device rather than
     losing audio over a missing API or a stale choice.

     Audit round 2: several pages (character-fx, cleanup, enhance, granular,
     neural-codec, parametric-eq, promptfx, repair, tool, vocoder) DO build an
     AudioContext (for an analyser / visualizer), but ALSO play their
     processed preview through a plain <audio controls> element that never
     goes through that context at all (lib/audioSink.ts's OWN "tier 2" for
     exactly this reason: HTMLMediaElement.setSinkId moves one element). The
     AudioContext wrapper above never touches those, so applyOutputDevice ALSO
     walks every <audio>/<video> on the page below. No page edits were needed:
     this only reads the DOM, the same way theDAWKit's other helpers already
     do (see slider/syncAll above). */
  var lastOutputDeviceId = '';
  var trackedContexts = [];

  function applySinkId(ctx) {
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    if (ctx.sinkId === lastOutputDeviceId) return;
    try {
      var result = ctx.setSinkId(lastOutputDeviceId);
      if (result && typeof result.then === 'function') {
        result.then(null, function () { /* stays on the previous device */ });
      }
    } catch (e) { /* stays on the previous device */ }
  }

  /** Same shape as applySinkId, for an <audio>/<video> element rather than an
   *  AudioContext — kept as its own function because the two have unrelated
   *  types even though the call looks identical. */
  function applyElementSink(el) {
    if (!el || typeof el.setSinkId !== 'function') return;
    if (el.sinkId === lastOutputDeviceId) return;
    try {
      var result = el.setSinkId(lastOutputDeviceId);
      if (result && typeof result.then === 'function') {
        result.then(null, function () { /* stays on the previous device */ });
      }
    } catch (e) { /* stays on the previous device */ }
  }

  /** Every <audio>/<video> currently under `root` (default: the whole
   *  document) gets the current device applied. Safe to call repeatedly —
   *  applyElementSink no-ops an element already on the right device. */
  function applyToMediaElements(root) {
    var scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    var els = scope.querySelectorAll('audio, video');
    for (var i = 0; i < els.length; i++) applyElementSink(els[i]);
  }

  function applyOutputDevice(deviceId) {
    lastOutputDeviceId = typeof deviceId === 'string' ? deviceId : '';
    trackedContexts.forEach(applySinkId);
    applyToMediaElements();
  }

  // Applied once at load — covers every <audio>/<video> already in the
  // static HTML (every named page's #ain/#aout-style elements) as soon as a
  // device id is known, without waiting for a page action. A no-op until
  // applyOutputDevice has run at least once (lastOutputDeviceId is still '').
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyToMediaElements(); });
  } else {
    applyToMediaElements();
  }

  // `applyOutputDevice` already re-applies to every element on the page each
  // time it runs (a device CHOSEN while an element already exists is already
  // covered by that direct call, with no help needed from this observer —
  // and per the Audio Output Devices spec, `[[SinkId]]` is a plain element
  // slot that a new `src` does not touch, so it is not "lost" across a take
  // either). This is deliberate belt-and-braces for the one thing neither of
  // those already covers: a `setSinkId` call this script made LOST the race
  // — rejected, or silently a no-op because the element was not yet in a
  // state that accepted it — before a page's own `src` write (which always
  // queues an attribute mutation record, even for the same value) gives a
  // second, later chance to apply the CURRENT `lastOutputDeviceId` again.
  // `document.documentElement` rather than `document.body`: the element this
  // script attaches to always exists once the DOM starts parsing, so this
  // does not depend on where in the page module-kit.js's own <script> tag
  // happens to sit.
  //
  // NOT watching childList: every page's <audio>/<video> is static markup —
  // checked across every page in public/edit-modules (zero
  // createElement('audio'|'video'), zero `new Audio()`) — so there is
  // nothing for a childList observer to ever catch, only cost: it would fire
  // on every element any page inserts for ANY reason (maximizer.html redraws
  // its meter markup on every animation frame), for four
  // querySelectorAll('audio, video') calls a frame that can never find
  // anything new. If a future page ever builds its preview element
  // dynamically, `applyToMediaElements()` still needs calling for it
  // directly at the point it is created — this observer is not the place to
  // discover that node.
  if (typeof MutationObserver === 'function') {
    var mediaObserver = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var target = records[i].target;
        if (target && (target.tagName === 'AUDIO' || target.tagName === 'VIDEO')) applyElementSink(target);
      }
    });
    mediaObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }

  function dropClosedContext(ctx) {
    var idx = trackedContexts.indexOf(ctx);
    if (idx !== -1) trackedContexts.splice(idx, 1);
  }

  var NativeAudioContext = window.AudioContext;
  if (NativeAudioContext) {
    var WrappedAudioContext = function () {
      var ctx = Reflect.construct(NativeAudioContext, arguments, WrappedAudioContext);
      trackedContexts.push(ctx);
      // A fresh context already opens on the OS default, so there is nothing
      // to apply until a real (non-default) device id is known — skips a
      // no-op setSinkId('') on every single context a page creates.
      if (lastOutputDeviceId) applySinkId(ctx);
      // Not exercised by any page today — every ensureAudio() creates at
      // most one context, guarded (`if (actx) return;`), nothing calls
      // .close(), and a module reload remounts EffectGuiStage's iframe into
      // a FRESH JS realm, which discards trackedContexts (and everything
      // else in the old realm) wholesale rather than accumulating across
      // reloads. Kept anyway as correct, cheap bookkeeping for the page this
      // is not yet true of — one that closes and rebuilds a context without
      // a full iframe remount — rather than assuming today's one-context
      // pattern is permanent. ctx.close() always fires 'statechange' on its
      // way to 'closed', which is the only thing this listens for.
      if (typeof ctx.addEventListener === 'function') {
        ctx.addEventListener('statechange', function () {
          if (ctx.state === 'closed') dropClosedContext(ctx);
        });
      }
      return ctx;
    };
    // Keep the native constructor's own name (`AudioContext`) rather than the
    // wrapper's inferred one, so anything introspecting `AudioContext.name`
    // still sees the real thing.
    Object.defineProperty(WrappedAudioContext, 'name', { value: NativeAudioContext.name, configurable: true });
    // Deliberately NOT `WrappedAudioContext.prototype.constructor = WrappedAudioContext`:
    // this line assigns the SAME prototype OBJECT the native constructor
    // uses (not a copy), so repointing `.constructor` here would mutate it
    // for every AudioContext instance on the page, including any built
    // through the native constructor directly and any other code (ours or
    // third-party) that reads `instance.constructor` expecting the native
    // identity — a much bigger blast radius than this file. Nothing in these
    // pages reads `.constructor` off an AudioContext, so there is no upside
    // to taking that risk; `instanceof` and every native method still work
    // unchanged either way.
    WrappedAudioContext.prototype = NativeAudioContext.prototype;
    window.AudioContext = WrappedAudioContext;
  }

  window.addEventListener('message', function (e) {
    // Assumes the stage is always an <iframe> mounted directly in the host
    // document (EffectGuiStage.tsx today) — if a future DetachableWindow ever
    // pops this stage into its own OS window, its opener (not window.parent)
    // becomes the legitimate sender, and this guard must accept that realm too.
    if (e.source !== window.parent) return;
    var data = e.data;
    if (data && data.type === 'thedaw-output-device' && typeof data.deviceId === 'string') {
      applyOutputDevice(data.deviceId);
    }
  });

  /** Accessible name for a native control that has no <label for>. */
  function label(el, text) {
    if (!el) return;
    if (el.id && document.querySelector('label[for="' + el.id + '"]')) return;
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', text);
    if (!el.name && el.id) el.name = el.id;
  }

  /** Keep aria-pressed in step with a button's on/off class. */
  function pressed(el, isOn) { if (el) el.setAttribute('aria-pressed', isOn ? 'true' : 'false'); }

  /** Buttons that flip `className` on click (the pages' pill pattern) also
   *  report aria-pressed. Pass exclusive=true for radio-like groups. */
  function toggleGroup(selector, className, exclusive) {
    var els = Array.prototype.slice.call(document.querySelectorAll(selector));
    var refresh = function () { els.forEach(function (b) { pressed(b, b.classList.contains(className)); }); };
    els.forEach(function (b) {
      if (!b.getAttribute('type') && b.tagName === 'BUTTON') b.setAttribute('type', 'button');
      if (b.tagName !== 'BUTTON' && !b.hasAttribute('tabindex')) {
        b.setAttribute('tabindex', '0');
        b.setAttribute('role', 'button');
        b.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
        });
      }
      b.addEventListener('click', function () { setTimeout(refresh, 0); });
    });
    if (exclusive) els.forEach(function (b) { b.setAttribute('aria-pressed', b.classList.contains(className) ? 'true' : 'false'); });
    refresh();
    return refresh;
  }

  window.theDAWKit = {
    slider: slider,
    sync: sync,
    syncAll: syncAll,
    label: label,
    pressed: pressed,
    toggleGroup: toggleGroup,
    applyOutputDevice: applyOutputDevice,
  };
})();
