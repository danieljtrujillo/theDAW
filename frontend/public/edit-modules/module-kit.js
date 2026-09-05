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

  window.theDAWKit = { slider: slider, sync: sync, syncAll: syncAll, label: label, pressed: pressed, toggleGroup: toggleGroup };
})();
