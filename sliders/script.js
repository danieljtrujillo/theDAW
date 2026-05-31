/* ============================================================================
   Track Slider — reusable vertical fader (dependency-free)

   createSlider(rootEl, opts) builds one slider inside rootEl and returns a
   handle { el, getValue, setValue, on, destroy }. Any element with
   [data-slider] is auto-initialised on load.

   Two layouts:
     - full    (default): ruler on the left, big readout below. The premium
                hero look — used by index.html / verify.html / sync-demo.html.
     - compact: a narrow card (name on top, capsule, small value + mapping
                chip below) that tiles many-across in the SLIDE dock. Same
                visual language (rounded capsule, smooth color fill, glowing
                knob) at mixer scale. Pass { compact: true }.

   Geometry is positioned in percentage / value-space, so nothing depends on
   measuring the DOM at init time — it renders correctly even inside a hidden
   (display:none) tab.

   Color blends SMOOTHLY across the range: cyan→blue→green→lime→orange→red.
   ========================================================================= */

(function () {
  "use strict";

  /* --- color ramp (0..1) --------------------------------------------------- */
  const STOPS = [
    [0.00, [0, 229, 255]],   // cyan
    [0.20, [0, 150, 255]],   // blue
    [0.42, [0, 230, 118]],   // green
    [0.62, [198, 224, 0]],   // lime
    [0.82, [255, 150, 0]],   // orange
    [1.00, [255, 31, 75]],   // red/pink
  ];

  const STATUS = [
    [0.18, "FREEZING"],
    [0.38, "COLD"],
    [0.55, "COOL"],
    [0.72, "WARM"],
    [0.88, "HOT"],
    [Infinity, "EXTREME"],
  ];

  /* --- math helpers -------------------------------------------------------- */
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  // Blend in linear-light space (gamma-correct) so midpoints stay bright and
  // clean instead of the muddy/dark dip you get lerping raw sRGB.
  const srgbToLin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const linToSrgb = (v) => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return clamp(s * 255, 0, 255);
  };
  const LIN_STOPS = STOPS.map(([p, c]) => [p, c.map(srgbToLin)]);

  function colorAt(t) {
    t = clamp(t, 0, 1);
    for (let i = 0; i < LIN_STOPS.length - 1; i++) {
      const [p0, c0] = LIN_STOPS[i];
      const [p1, c1] = LIN_STOPS[i + 1];
      if (t >= p0 && t <= p1) {
        const n = (t - p0) / (p1 - p0 || 1);
        return [
          linToSrgb(lerp(c0[0], c1[0], n)),
          linToSrgb(lerp(c0[1], c1[1], n)),
          linToSrgb(lerp(c0[2], c1[2], n)),
        ];
      }
    }
    return STOPS[STOPS.length - 1][1].slice();
  }

  // amt > 0 lightens toward white, amt < 0 darkens toward black
  function shade(c, amt) {
    const target = amt >= 0 ? 255 : 0;
    const a = Math.abs(amt);
    return [lerp(c[0], target, a), lerp(c[1], target, a), lerp(c[2], target, a)];
  }

  const rgb = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

  function statusFor(t) {
    for (const [edge, label] of STATUS) if (t < edge) return label;
    return "EXTREME";
  }

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* --- component ----------------------------------------------------------- */
  function createSlider(root, opts) {
    opts = opts || {};
    const MIN = Number.isFinite(+opts.min) ? +opts.min : 0;
    const MAX = Number.isFinite(+opts.max) ? +opts.max : 100;
    const RANGE = MAX - MIN || 1;
    const STEP = Number.isFinite(+opts.step) && +opts.step > 0 ? +opts.step : 1;
    const STEP_TICK = 2;                 // a ruler tick every 2 units (full mode)
    const FOCUS_UNITS = RANGE * 0.22;    // magnifier reach, in value units
    const compact = !!opts.compact;
    const listeners = [];

    const snap = (v) => MIN + Math.round((clamp(v, MIN, MAX) - MIN) / STEP) * STEP;
    let value = snap(Number.isNaN(parseFloat(opts.value)) ? MIN + RANGE * 0.7 : parseFloat(opts.value));
    const name = opts.name != null ? opts.name : "MASTER";
    const suffix = opts.suffix != null ? opts.suffix : "";
    const mapping = opts.mapping != null ? opts.mapping : "";

    /* build DOM */
    root.classList.add("ts");
    if (compact) root.classList.add("ts--compact");

    const capsule = `
      <div class="ts-stage">
        <div class="ts-scale"></div>
        <div class="ts-body">
          <div class="ts-track">
            <div class="ts-fill"></div>
            <div class="ts-knob" tabindex="0" role="slider" aria-orientation="vertical"
                 aria-valuemin="${MIN}" aria-valuemax="${MAX}" aria-label="${esc(name)}"></div>
          </div>
        </div>
      </div>`;

    // Compact uses the shared 4-row widget rhythm (tw-name / tw-body / tw-value
    // / tw-map) so faders, knobs, and pads all align row-for-row.
    root.innerHTML = compact
      ? `
        <div class="ts-name-top tw-name" title="${esc(name)}">${esc(name)}</div>
        <div class="tw-body">${capsule}</div>
        <div class="ts-value-sm tw-value"></div>
        <div class="ts-map tw-map" title="${esc(mapping || "UNMAPPED")}">${esc(mapping || "UNMAPPED")}</div>`
      : `
        ${capsule}
        <div class="ts-readout">
          <div class="ts-value"></div>
          <div class="ts-name">${esc(name)}</div>
          <div class="ts-status"></div>
        </div>`;

    const body = root.querySelector(".ts-body");
    const track = root.querySelector(".ts-track");
    const fill = root.querySelector(".ts-fill");
    const knob = root.querySelector(".ts-knob");
    const scale = root.querySelector(".ts-scale");
    const valEl = root.querySelector(".ts-value, .ts-value-sm");
    const statusEl = root.querySelector(".ts-status");

    let marks = [];        // { el, tick, value }

    function buildScale() {
      if (!scale) return;
      scale.innerHTML = "";
      marks = [];
      for (let v = MIN; v <= MAX; v += STEP_TICK) {
        const isMajor = v % 10 === 0;
        const isMid = v % 5 === 0;
        const el = document.createElement("div");
        el.className = "ts-mark";
        el.style.top = (1 - (v - MIN) / RANGE) * 100 + "%";

        if (isMajor) {
          const num = document.createElement("span");
          num.className = "ts-num";
          num.textContent = v;
          el.appendChild(num);
        }
        const tick = document.createElement("span");
        tick.className = "ts-tick";
        tick.style.width = compact
          ? (isMajor ? "12px" : isMid ? "8px" : "4px")
          : (isMajor ? "20px" : isMid ? "13px" : "7px");
        el.appendChild(tick);

        scale.appendChild(el);
        marks.push({ el, tick, value: v });
      }
    }

    function render() {
      const t = (value - MIN) / RANGE;       // 0..1
      const base = colorAt(t);

      root.style.setProperty("--accent", rgb(base));
      root.style.setProperty("--accent-bright", rgb(shade(base, 0.42)));
      root.style.setProperty("--accent-deep", rgb(shade(base, -0.28)));
      root.style.setProperty("--accent-glow", rgba(base, 0.55));
      root.style.setProperty("--accent-faint", rgba(base, 0.16));

      // fill + knob (both in % of the track). A small floor keeps a rounded
      // colored bulb visible at the bottom; value semantics stay exact.
      fill.style.height = Math.max(t * 100, 3.5) + "%";
      knob.style.top = (1 - t) * 100 + "%";

      if (valEl) valEl.textContent = Math.round(value) + suffix;
      if (statusEl) statusEl.textContent = statusFor(t);
      knob.setAttribute("aria-valuenow", Math.round(value));

      const push = compact ? 7 : 16;
      const grow = compact ? 0.6 : 0.95;
      for (const m of marks) {
        const p = smooth(1 - Math.abs(m.value - value) / FOCUS_UNITS);
        m.el.style.transform = `translate(${-p * push}px, -50%) scale(${1 + p * grow})`;
        m.el.style.opacity = lerp(0.22, 1, p);
        m.el.style.color = rgb([lerp(150, 255, p), lerp(150, 255, p), lerp(155, 255, p)]);
        m.el.style.setProperty(
          "--mark-glow",
          p > 0.02 ? `0 0 ${6 + p * 12}px ${rgba(base, 0.85 * p)}` : "none"
        );
        m.tick.style.background = rgb([
          lerp(150, base[0], p), lerp(150, base[1], p), lerp(155, base[2], p),
        ]);
      }
    }

    /* --- interaction ------------------------------------------------------- */
    function valueFromClientY(clientY) {
      const r = track.getBoundingClientRect();
      const yl = clamp(clientY - r.top, 0, r.height);
      return snap((1 - yl / r.height) * RANGE + MIN);
    }

    function setValue(v, opt) {
      const next = snap(v);
      if (next === value && !(opt && opt.force)) return;
      value = next;
      render();
      listeners.forEach((fn) => fn(value));
    }

    let dragging = false;
    function onPointerDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragging = true;
      root.classList.add("is-dragging");
      knob.focus({ preventScroll: true });
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
      setValue(valueFromClientY(e.clientY));
      e.preventDefault();
    }
    function onPointerMove(e) {
      if (!dragging) return;
      setValue(valueFromClientY(e.clientY));
    }
    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("is-dragging");
      try { body.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    function onWheel(e) {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      setValue(value + dir * STEP * (e.shiftKey ? 10 : 1));
    }
    function onKeydown(e) {
      let handled = true;
      const big = STEP * 10;
      switch (e.key) {
        case "ArrowUp": case "ArrowRight": setValue(value + STEP * (e.shiftKey ? 10 : 1)); break;
        case "ArrowDown": case "ArrowLeft": setValue(value - STEP * (e.shiftKey ? 10 : 1)); break;
        case "PageUp": setValue(value + big); break;
        case "PageDown": setValue(value - big); break;
        case "Home": setValue(MAX); break;
        case "End": setValue(MIN); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    }

    body.addEventListener("pointerdown", onPointerDown);
    body.addEventListener("pointermove", onPointerMove);
    body.addEventListener("pointerup", onPointerUp);
    body.addEventListener("pointercancel", onPointerUp);
    body.addEventListener("wheel", onWheel, { passive: false });
    knob.addEventListener("keydown", onKeydown);

    function destroy() {
      body.removeEventListener("pointerdown", onPointerDown);
      body.removeEventListener("pointermove", onPointerMove);
      body.removeEventListener("pointerup", onPointerUp);
      body.removeEventListener("pointercancel", onPointerUp);
      body.removeEventListener("wheel", onWheel);
      knob.removeEventListener("keydown", onKeydown);
      listeners.length = 0;
      root.classList.remove("ts", "ts--compact", "is-dragging");
      root.innerHTML = "";
      delete root.__tsInit;
    }

    /* --- init -------------------------------------------------------------- */
    buildScale();
    render();

    return {
      el: root,
      getValue: () => value,
      setValue: (v) => setValue(v, { force: true }),
      on: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
      destroy,
    };
  }

  window.createSlider = createSlider;

  /* ==========================================================================
     Rotary knob — same smooth color ramp, drawn as a 270° arc with a glowing
     pointer. Drag vertically (up = increase), wheel, or arrow keys.
     ========================================================================= */
  function createKnob(root, opts) {
    opts = opts || {};
    const MIN = Number.isFinite(+opts.min) ? +opts.min : 0;
    const MAX = Number.isFinite(+opts.max) ? +opts.max : 100;
    const RANGE = MAX - MIN || 1;
    const STEP = Number.isFinite(+opts.step) && +opts.step > 0 ? +opts.step : 1;
    const listeners = [];
    const snap = (v) => MIN + Math.round((clamp(v, MIN, MAX) - MIN) / STEP) * STEP;
    let value = snap(Number.isNaN(parseFloat(opts.value)) ? MIN + RANGE * 0.5 : parseFloat(opts.value));
    const name = opts.name != null ? opts.name : "KNOB";
    const suffix = opts.suffix != null ? opts.suffix : "";
    const mapping = opts.mapping != null ? opts.mapping : "";

    root.classList.add("tk");
    // Shared 4-row rhythm (tw-name / tw-body / tw-value / tw-map): the dial is
    // centered in a body zone equal to the fader's capsule height so a knob
    // lines up row-for-row with faders and pads.
    root.innerHTML = `
      <div class="tk-name tw-name" title="${esc(name)}">${esc(name)}</div>
      <div class="tw-body">
        <div class="tk-dial" tabindex="0" role="slider" aria-orientation="vertical"
             aria-valuemin="${MIN}" aria-valuemax="${MAX}" aria-label="${esc(name)}">
          <div class="tk-arc"></div>
          <div class="tk-face"></div>
          <div class="tk-point"><span></span></div>
        </div>
      </div>
      <div class="tk-value tw-value"></div>
      <div class="tk-map tw-map" title="${esc(mapping || "UNMAPPED")}">${esc(mapping || "UNMAPPED")}</div>`;

    const dial = root.querySelector(".tk-dial");
    const arc = root.querySelector(".tk-arc");
    const point = root.querySelector(".tk-point");
    const valEl = root.querySelector(".tk-value");

    function render() {
      const t = (value - MIN) / RANGE;
      const base = colorAt(t);
      root.style.setProperty("--accent", rgb(base));
      root.style.setProperty("--accent-bright", rgb(shade(base, 0.45)));
      root.style.setProperty("--accent-deep", rgb(shade(base, -0.3)));
      root.style.setProperty("--accent-glow", rgba(base, 0.6));
      root.style.setProperty("--accent-faint", rgba(base, 0.18));
      // Gap centered at the BOTTOM (6 o'clock): fill sweeps 270° from the
      // 7:30 position (225°) clockwise to 4:30 — matching a physical knob's
      // rest orientation (empty span points down).
      const sweep = t * 270;
      arc.style.background =
        `conic-gradient(from 225deg, ${rgb(base)} 0deg ${sweep}deg, ` +
        `rgba(255,255,255,0.09) ${sweep}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`;
      point.style.transform = `rotate(${225 + t * 270}deg)`;
      valEl.textContent = Math.round(value) + suffix;
      dial.setAttribute("aria-valuenow", Math.round(value));
    }

    function setValue(v, opt) {
      const next = snap(v);
      if (next === value && !(opt && opt.force)) return;
      value = next;
      render();
      listeners.forEach((fn) => fn(value));
    }

    let dragging = false, lastY = 0;
    const PX_FULL = 200;   // px of vertical travel for the full range
    function onDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragging = true; lastY = e.clientY;
      root.classList.add("is-dragging");
      dial.focus({ preventScroll: true });
      try { dial.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      const dy = lastY - e.clientY; lastY = e.clientY;
      setValue(value + (dy / PX_FULL) * RANGE * (e.shiftKey ? 0.25 : 1));
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("is-dragging");
      try { dial.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    function onWheel(e) {
      e.preventDefault();
      setValue(value + (e.deltaY < 0 ? 1 : -1) * STEP * (e.shiftKey ? 10 : 1));
    }
    function onKeydown(e) {
      let h = true;
      switch (e.key) {
        case "ArrowUp": case "ArrowRight": setValue(value + STEP * (e.shiftKey ? 10 : 1)); break;
        case "ArrowDown": case "ArrowLeft": setValue(value - STEP * (e.shiftKey ? 10 : 1)); break;
        case "Home": setValue(MAX); break;
        case "End": setValue(MIN); break;
        default: h = false;
      }
      if (h) e.preventDefault();
    }
    dial.addEventListener("pointerdown", onDown);
    dial.addEventListener("pointermove", onMove);
    dial.addEventListener("pointerup", onUp);
    dial.addEventListener("pointercancel", onUp);
    dial.addEventListener("wheel", onWheel, { passive: false });
    dial.addEventListener("keydown", onKeydown);

    function destroy() {
      dial.removeEventListener("pointerdown", onDown);
      dial.removeEventListener("pointermove", onMove);
      dial.removeEventListener("pointerup", onUp);
      dial.removeEventListener("pointercancel", onUp);
      dial.removeEventListener("wheel", onWheel);
      dial.removeEventListener("keydown", onKeydown);
      listeners.length = 0;
      root.classList.remove("tk", "is-dragging");
      root.innerHTML = "";
      delete root.__tkInit;
    }

    render();
    return {
      el: root,
      getValue: () => value,
      setValue: (v) => setValue(v, { force: true }),
      on: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
      destroy,
    };
  }
  window.createKnob = createKnob;

  /* ==========================================================================
     Toggle / momentary pad — lights up in its assigned color when active.
     ========================================================================= */
  function parseColor(c) {
    if (Array.isArray(c)) return c.slice(0, 3);
    return [0, 229, 255];
  }
  function createPad(root, opts) {
    opts = opts || {};
    const listeners = [];
    let on = !!opts.active;
    const momentary = !!opts.momentary;
    const name = opts.name != null ? opts.name : "PAD";
    const mapping = opts.mapping != null ? opts.mapping : "";
    const col = parseColor(opts.color);

    root.classList.add("tp");
    // Shared 4-row rhythm (tw-name / tw-body / tw-value / tw-map): the button
    // is centered in a body zone equal to the fader's capsule height, and the
    // ON/OFF state sits in the value row — so a pad lines up row-for-row with
    // faders and knobs.
    root.innerHTML = `
      <div class="tp-name tw-name" title="${esc(name)}">${esc(name)}</div>
      <div class="tw-body">
        <button class="tp-btn" type="button" aria-pressed="${on}" title="${esc(name)}">
          <span class="tp-led"></span>
        </button>
      </div>
      <div class="tp-value tw-value"></div>
      <div class="tp-map tw-map" title="${esc(mapping || "UNMAPPED")}">${esc(mapping || "UNMAPPED")}</div>`;
    const btn = root.querySelector(".tp-btn");
    const valEl = root.querySelector(".tp-value");
    root.style.setProperty("--pad", rgb(col));
    root.style.setProperty("--pad-bright", rgb(shade(col, 0.4)));
    root.style.setProperty("--pad-glow", rgba(col, 0.65));

    function paint() {
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
      valEl.textContent = on ? "ON" : "OFF";
      valEl.classList.toggle("on", on);
    }
    function setOn(v) { on = !!v; paint(); listeners.forEach((fn) => fn(on)); }

    function onDown() { if (momentary) setOn(true); }
    function onUp() { if (momentary && on) setOn(false); }
    function onClick() { if (!momentary) setOn(!on); }
    function onKey(e) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (momentary) { setOn(true); window.setTimeout(() => setOn(false), 120); }
        else setOn(!on);
      }
    }
    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointerleave", onUp);
    btn.addEventListener("click", onClick);
    btn.addEventListener("keydown", onKey);

    function destroy() {
      btn.removeEventListener("pointerdown", onDown);
      btn.removeEventListener("pointerup", onUp);
      btn.removeEventListener("pointerleave", onUp);
      btn.removeEventListener("click", onClick);
      btn.removeEventListener("keydown", onKey);
      listeners.length = 0;
      root.classList.remove("tp");
      root.innerHTML = "";
      delete root.__tpInit;
    }
    paint();
    return {
      el: root,
      getValue: () => on,
      setValue: (v) => setOn(v),
      on: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
      destroy,
    };
  }
  window.createPad = createPad;

  function autoInit() {
    document.querySelectorAll("[data-slider]").forEach((el) => {
      if (el.__tsInit) return;
      el.__tsInit = true;
      createSlider(el, {
        value: el.dataset.value,
        name: el.dataset.name,
        suffix: el.dataset.suffix,
        mapping: el.dataset.mapping,
        min: el.dataset.min,
        max: el.dataset.max,
        step: el.dataset.step,
        compact: el.hasAttribute("data-compact"),
      });
    });
    document.querySelectorAll("[data-knob]").forEach((el) => {
      if (el.__tkInit) return;
      el.__tkInit = true;
      createKnob(el, {
        value: el.dataset.value,
        name: el.dataset.name,
        suffix: el.dataset.suffix,
        mapping: el.dataset.mapping,
        min: el.dataset.min,
        max: el.dataset.max,
        step: el.dataset.step,
      });
    });
    document.querySelectorAll("[data-pad]").forEach((el) => {
      if (el.__tpInit) return;
      el.__tpInit = true;
      createPad(el, {
        name: el.dataset.name,
        active: el.hasAttribute("data-active"),
        momentary: el.hasAttribute("data-momentary"),
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }
})();
