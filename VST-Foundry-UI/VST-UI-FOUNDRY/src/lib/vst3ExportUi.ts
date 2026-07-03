// Standalone UI template for a Foundry VST3 data bundle.
//
// This module emits the STATIC `ui/index.html` shell. All design-specific data
// lives in the sibling `ui/params.js` (window.FOUNDRY_DESIGN), so this HTML is
// identical for every export. The inline renderer is plain ES5-ish vanilla JS
// (no React, no build step) and makes NO external network requests.
//
// The renderer talks to the native iPlug2 shell over a tiny bridge:
//   - window.foundryHost.setParam(paramId, normalized0to1)   UI -> host
//   - window.foundryApplyParam(paramId, normalized0to1)      host -> UI
// Params are keyed by the SAME slug ids the manifest uses; the slug function is
// injected verbatim (see SLUGIFY_FN_SOURCE in vst3Export.ts) so ids match byte
// for byte.
//
// NOTE FOR MAINTAINERS: RENDERER_JS is embedded inside a TS template literal, so
// it must contain NO backticks and NO `${` sequences — string concatenation only.

import { BRIDGE_BOOTSTRAP_SOURCE } from "./customCodeBridge";

const BASE_CSS = `* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; background: #0b0b0f; }
body { -webkit-font-smoothing: antialiased; }
#foundry-root { position: relative; }
img { -webkit-user-drag: none; user-select: none; }`;

const RENDERER_JS = `(function () {
  "use strict";

  // --- slug (single source of truth, injected from the manifest builder) ----
  __SLUG_FN_SOURCE__

  // --- shared CustomCode bridge (in-iframe half, injected as a JS string) ----
  // The SAME source the live app uses (customCodeBridge.ts) so exported custom
  // code gets window.PARAMS + the setParams/paramChanged bridge — params are live
  // in the plugin, not dead. '<' is escaped in the injected literal (see
  // buildIndexHtml) so it can never break this outer <script>.
  var BRIDGE_SOURCE = __BRIDGE_BOOTSTRAP__;
  var U2028 = String.fromCharCode(0x2028), U2029 = String.fromCharCode(0x2029);

  function clamp01(v) { v = Number(v); if (isNaN(v)) return 0; return v < 0 ? 0 : v > 1 ? 1 : v; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v, d) { var n = Number(v); return isNaN(n) ? d : n; }

  var DESIGN = (window.FOUNDRY_DESIGN && typeof window.FOUNDRY_DESIGN === "object")
    ? window.FOUNDRY_DESIGN
    : { elements: [], canvasState: { width: 800, height: 600 }, assets: [] };

  var elements = Array.isArray(DESIGN.elements) ? DESIGN.elements : [];
  var canvasState = DESIGN.canvasState || { width: 800, height: 600 };
  var assets = Array.isArray(DESIGN.assets) ? DESIGN.assets : [];

  var assetById = {};
  var ai;
  for (ai = 0; ai < assets.length; ai++) {
    if (assets[ai] && assets[ai].id) assetById[assets[ai].id] = assets[ai];
  }
  var elById = {};
  var ei;
  for (ei = 0; ei < elements.length; ei++) {
    if (elements[ei] && elements[ei].id) elById[elements[ei].id] = elements[ei];
  }

  // --- host bridge ----------------------------------------------------------
  var applyHandlers = {};
  window.foundryApplyParam = function (paramId, normalized) {
    var fn = applyHandlers[paramId];
    if (typeof fn === "function") { try { fn(clamp01(normalized)); } catch (e) {} }
  };
  function sendParam(paramId, normalized) {
    try {
      if (window.foundryHost && typeof window.foundryHost.setParam === "function") {
        window.foundryHost.setParam(paramId, clamp01(normalized));
      }
    } catch (e) {}
  }

  // --- built-in vst: bind runtime -------------------------------------------
  // Mirrors src/lib/vstBindRuntime.ts inside the exported plugin: LFOs,
  // macros, random S&H and a local transport animate bound displays with no
  // host data at all. The native shell pushes REAL host values (transport,
  // I/O metering) through window.__foundrySetBindValue(id, v) — v is
  // normalized 0..100 or boolean — and a shell-pushed id suppresses the local
  // publisher for 1s, so real data always outranks the simulation. MIDI /
  // preset / plugin-master binds are NOT handled here: the shell acts on
  // those from the manifest bindings whenever the underlying param changes.
  function isVstBind(id) { return typeof id === "string" && id.indexOf("vst:") === 0; }

  var bindApply = {}; // targetId -> [handler(v0to100 | bool)]
  var shellSeen = {}; // targetId -> ms timestamp of the last shell push
  function onBindValue(id, fn) { (bindApply[id] = bindApply[id] || []).push(fn); }
  function publishBind(id, v) {
    var fns = bindApply[id];
    if (!fns) return;
    for (var bi = 0; bi < fns.length; bi++) { try { fns[bi](v); } catch (e) {} }
  }
  window.__foundrySetBindValue = function (id, v) {
    shellSeen[id] = Date.now();
    publishBind(id, v);
  };
  // Normalize a bind value (0..100 number or boolean) to a 0..100 number.
  function bindPct(v) { return v === true ? 100 : v === false ? 0 : clamp(num(v, 0), 0, 100); }

  // Real-unit ranges for the ids the LOCAL runtime owns (write scaling).
  function vstRange(id) {
    if (id === "vst:transport.tempo") return [20, 300];
    if (id === "vst:mod.random.rate") return [0.1, 20];
    if (/^vst:lfo\.\d+\.rate$/.test(id)) return [0.05, 20];
    if (/^vst:lfo\.\d+\.shape$/.test(id)) return [0, 4];
    return [0, 100];
  }

  var LFO_N = 4, MACRO_N = 8;
  var lfos = [];
  var li;
  for (li = 0; li < LFO_N; li++) lfos.push({ rate: 1, depth: 100, shape: 0, phase: 0, held: 50 });
  var macros = [];
  var mci;
  for (mci = 0; mci < MACRO_N; mci++) macros.push(0);
  var rndSrc = { rate: 2, phase: 0, value: 50 };
  var trans = { playing: false, tempo: 120, head: 0 };

  // Shape index: 0 sine / 1 triangle / 2 saw / 3 square / 4 s&h (held by tick).
  function lfoSample(shape, p, depth) {
    p = ((p % 1) + 1) % 1;
    var b;
    if (shape === 1) b = 4 * Math.abs(p - 0.5) - 1;
    else if (shape === 2) b = p * 2 - 1;
    else if (shape === 3 || shape === 4) b = p < 0.5 ? 1 : -1;
    else b = Math.sin(p * Math.PI * 2);
    return 50 + b * 50 * (clamp(depth, 0, 100) / 100);
  }

  // Local write: shaped 0..100 -> real units -> runtime state.
  function vstLocalWrite(id, v0to100) {
    var r = vstRange(id);
    var real = r[0] + clamp01(v0to100 / 100) * (r[1] - r[0]);
    var m = /^vst:macro\.(\d+)$/.exec(id);
    if (m) {
      var mn = parseInt(m[1], 10);
      if (mn >= 1 && mn <= MACRO_N) {
        macros[mn - 1] = clamp(real, 0, 100);
        publishBind(id, macros[mn - 1]);
      }
      return;
    }
    m = /^vst:lfo\.(\d+)\.(rate|depth|shape)$/.exec(id);
    if (m) {
      var ln = parseInt(m[1], 10);
      if (ln >= 1 && ln <= LFO_N) {
        if (m[2] === "rate") lfos[ln - 1].rate = real;
        else if (m[2] === "depth") lfos[ln - 1].depth = real;
        else lfos[ln - 1].shape = Math.round(real);
      }
      return;
    }
    if (id === "vst:mod.random.rate") { rndSrc.rate = real; return; }
    if (id === "vst:transport.play") {
      trans.playing = v0to100 >= 50;
      publishBind("vst:transport.playing", trans.playing);
      return;
    }
    if (id === "vst:transport.stop") {
      if (v0to100 >= 50) { trans.playing = false; publishBind("vst:transport.playing", false); }
      return;
    }
    if (id === "vst:transport.rtz") { if (v0to100 >= 50) trans.head = 0; return; }
    if (id === "vst:transport.tempo") { trans.tempo = clamp(real, 20, 300); return; }
  }

  // Route stack per element: explicit routes + migrated legacy single-target
  // fields (same rules as src/lib/routing.ts routesOf).
  var routesByEl = {};
  (function () {
    var i2, e2, b2, rs, given, j2;
    var hasRoute = function (tid, ax) {
      var k2;
      for (k2 = 0; k2 < rs.length; k2++) {
        if (rs[k2] && rs[k2].dest === "daw" && rs[k2].targetId === tid && (rs[k2].axis || "value") === ax) return true;
      }
      return false;
    };
    for (i2 = 0; i2 < elements.length; i2++) {
      e2 = elements[i2];
      b2 = e2 && e2.binding;
      if (!e2 || !b2) continue;
      rs = [];
      given = Array.isArray(b2.routes) ? b2.routes : [];
      for (j2 = 0; j2 < given.length; j2++) rs.push(given[j2]);
      var isListenType = e2.type === "Meter" || e2.type === "Waveform";
      if (b2.targetId && !isListenType && !hasRoute(b2.targetId, "value")) rs.push({ dest: "daw", targetId: b2.targetId, axis: "value" });
      if (b2.xTargetId && !hasRoute(b2.xTargetId, "x")) rs.push({ dest: "daw", targetId: b2.xTargetId, axis: "x" });
      if (b2.yTargetId && !hasRoute(b2.yTargetId, "y")) rs.push({ dest: "daw", targetId: b2.yTargetId, axis: "y" });
      if (rs.length) routesByEl[e2.id] = rs;
    }
  })();

  // amount -> curve -> range shaping (mirror of src/lib/routing.ts applyRoute).
  function shapeRoute(v0to100, r) {
    var src = clamp(v0to100, 0, 100) / 100;
    var amt = (r.amount == null ? 100 : r.amount) / 100;
    var v = amt >= 0 ? src * amt : (1 - src) * -amt;
    v = clamp01(v);
    var c = r.curve || "linear";
    if (c === "exp") v = v * v * v;
    else if (c === "log") v = 1 - (1 - v) * (1 - v) * (1 - v);
    else if (c === "scurve") v = v * v * (3 - 2 * v);
    var lo = clamp(r.rangeMin == null ? 0 : r.rangeMin, 0, 100);
    var hi = clamp(r.rangeMax == null ? 100 : r.rangeMax, 0, 100);
    return clamp(lo + v * (hi - lo), 0, 100);
  }

  // Fan a moving control's value out to its vst: routes (local runtime side).
  function emitVstRoutes(elId, axis, v0to100) {
    var rs = routesByEl[elId];
    if (!rs) return;
    var i3, r3;
    for (i3 = 0; i3 < rs.length; i3++) {
      r3 = rs[i3];
      if (!r3 || r3.dest !== "daw" || !isVstBind(r3.targetId)) continue;
      if ((r3.axis || "value") !== axis) continue;
      vstLocalWrite(r3.targetId, shapeRoute(v0to100, r3));
    }
  }

  // Animation loop: advance LFOs / random / transport, publish to handlers.
  function shellOwns(id) { var t = shellSeen[id]; return !!t && (Date.now() - t) < 1000; }
  // UI-clocked pull: ask the native shell for LISTEN bind values (transport /
  // I/O metering) ~20x/s. IPlugSendMsg is injected by the shell; in a plain
  // browser it is undefined and the pull is skipped — local runtime only.
  var lastPull = 0;
  function pullShellBinds() {
    if (typeof window.IPlugSendMsg !== "function") return;
    var now = Date.now();
    if (now - lastPull < 50) return;
    lastPull = now;
    try {
      window.IPlugSendMsg({ msg: "SAMFUI", msgTag: 1 /* kMsgTagGetBindValues */, ctrlTag: -1 });
    } catch (e) {}
  }
  var lastTick = 0;
  function bindTick(ts) {
    var dt = lastTick > 0 ? Math.min((ts - lastTick) / 1000, 0.25) : 0;
    lastTick = ts;
    pullShellBinds();
    var i4, L, lid;
    for (i4 = 0; i4 < LFO_N; i4++) {
      L = lfos[i4];
      var prevPhase = L.phase;
      L.phase = (L.phase + dt * L.rate) % 1;
      if (L.shape === 4) {
        if (L.phase < prevPhase) L.held = 50 + (Math.random() * 2 - 1) * 50 * (clamp(L.depth, 0, 100) / 100);
      } else {
        L.held = lfoSample(L.shape, L.phase, L.depth);
      }
      lid = "vst:lfo." + (i4 + 1);
      if (!shellOwns(lid)) publishBind(lid, L.held);
    }
    var prevRnd = rndSrc.phase;
    rndSrc.phase = (rndSrc.phase + dt * rndSrc.rate) % 1;
    if (rndSrc.phase < prevRnd) {
      rndSrc.value = Math.random() * 100;
      if (!shellOwns("vst:mod.random")) publishBind("vst:mod.random", rndSrc.value);
    }
    if (trans.playing) {
      trans.head += dt;
      var beats = (trans.head * trans.tempo) / 60;
      if (!shellOwns("vst:transport.beat")) publishBind("vst:transport.beat", (beats % 1) * 100);
      if (!shellOwns("vst:transport.bar")) publishBind("vst:transport.bar", ((beats / 4) % 1) * 100);
      if (!shellOwns("vst:transport.playhead")) publishBind("vst:transport.playhead", clamp(trans.head / 6, 0, 100));
    }
    window.requestAnimationFrame(bindTick);
  }
  if (window.requestAnimationFrame) window.requestAnimationFrame(bindTick);

  // --- colors ---------------------------------------------------------------
  var DEFAULT_BASE = "#121116";
  var DEFAULT_ACTIVE = "#a855f7";
  var DEFAULT_TEXT = "#f8fafc";
  var DEFAULT_BORDER = "#221f2e";
  function baseColor(el) { return el.transparentBackground ? "transparent" : (el.baseColor || DEFAULT_BASE); }
  function solidBase(el) { var c = baseColor(el); return c === "transparent" ? DEFAULT_BASE : c; }
  function activeColor(el) { return el.activeColor || DEFAULT_ACTIVE; }
  function textColor(el) { return el.textColor || DEFAULT_TEXT; }
  function borderColor(el) { return el.borderColor || DEFAULT_BORDER; }
  function indicatorColor(el) { return el.indicatorColor || activeColor(el); }

  // --- geometry -------------------------------------------------------------
  // Elements inside a group store x/y RELATIVE to the group; walk ancestors to
  // recover absolute canvas coordinates.
  function absPos(el) {
    var x = num(el.x, 0), y = num(el.y, 0), g = el.groupId, guard = 0;
    while (g && elById[g] && guard < 64) {
      x += num(elById[g].x, 0);
      y += num(elById[g].y, 0);
      g = elById[g].groupId;
      guard++;
    }
    return { x: x, y: y };
  }
  function mkBox(el) {
    var pos = absPos(el);
    var d = document.createElement("div");
    d.style.position = "absolute";
    d.style.left = pos.x + "px";
    d.style.top = pos.y + "px";
    d.style.width = num(el.width, 40) + "px";
    d.style.height = num(el.height, 40) + "px";
    d.style.boxSizing = "border-box";
    if (el.rotation) {
      d.style.transform = "rotate(" + num(el.rotation, 0) + "deg)";
      d.style.transformOrigin = "center center";
    }
    return d;
  }

  // --- continuous-value helpers ---------------------------------------------
  function contRange(el) {
    var mn = num(el.min, 0), mx = num(el.max, 100);
    if (mx === mn) mx = mn + 1;
    return { min: mn, max: mx };
  }
  function contDefault(el) {
    var r = contRange(el);
    return clamp(num(el.value, (r.min + r.max) / 2), r.min, r.max);
  }
  function toNorm(el, value) { var r = contRange(el); return clamp01((value - r.min) / (r.max - r.min)); }
  function fromNorm(el, n) { var r = contRange(el); return r.min + clamp01(n) * (r.max - r.min); }

  function attachVerticalDrag(node, el, getVal, setVal) {
    node.addEventListener("mousedown", function (e) {
      e.preventDefault();
      var r = contRange(el);
      var startY = e.clientY;
      var startVal = getVal();
      var perPx = (r.max - r.min) / 150;
      function move(me) { setVal(clamp(startVal + (startY - me.clientY) * perPx, r.min, r.max)); }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // --- renderers ------------------------------------------------------------
  function renderKnob(el) {
    var box = mkBox(el);
    box.style.borderRadius = "50%";
    box.style.background = baseColor(el);
    box.style.border = "2px solid " + borderColor(el);
    box.style.cursor = "ns-resize";
    var ind = document.createElement("div");
    ind.style.position = "absolute";
    ind.style.left = "50%";
    ind.style.top = "50%";
    ind.style.width = "3px";
    ind.style.height = "42%";
    ind.style.background = indicatorColor(el);
    ind.style.borderRadius = "2px";
    ind.style.transformOrigin = "50% 100%";
    box.appendChild(ind);
    var pid = foundrySlugify(el.id);
    var value = contDefault(el);
    function paint() {
      var deg = -135 + toNorm(el, value) * 270;
      ind.style.transform = "translate(-50%, -100%) rotate(" + deg + "deg)";
    }
    paint();
    attachVerticalDrag(box, el, function () { return value; }, function (v) {
      value = v; paint(); sendParam(pid, toNorm(el, value));
      emitVstRoutes(el.id, "value", toNorm(el, value) * 100);
    });
    applyHandlers[pid] = function (n) {
      value = fromNorm(el, n); paint();
      // Host automation drives the routes too (mirrors the shell contract).
      emitVstRoutes(el.id, "value", clamp01(n) * 100);
    };
    return box;
  }

  function renderSlider(el) {
    var box = mkBox(el);
    box.style.cursor = "ns-resize";
    var vertical = num(el.height, 40) >= num(el.width, 40);
    var track = document.createElement("div");
    track.style.position = "absolute";
    track.style.background = solidBase(el);
    track.style.border = "1px solid " + borderColor(el);
    track.style.borderRadius = "4px";
    var handle = document.createElement("div");
    handle.style.position = "absolute";
    handle.style.background = activeColor(el);
    handle.style.borderRadius = "3px";
    if (vertical) {
      track.style.left = "50%"; track.style.top = "0"; track.style.bottom = "0";
      track.style.width = "6px"; track.style.transform = "translateX(-50%)";
      handle.style.left = "50%"; handle.style.width = "80%"; handle.style.height = "10%";
      handle.style.transform = "translateX(-50%)";
    } else {
      track.style.top = "50%"; track.style.left = "0"; track.style.right = "0";
      track.style.height = "6px"; track.style.transform = "translateY(-50%)";
      handle.style.top = "50%"; handle.style.height = "80%"; handle.style.width = "10%";
      handle.style.transform = "translateY(-50%)";
    }
    box.appendChild(track); box.appendChild(handle);
    var pid = foundrySlugify(el.id);
    var value = contDefault(el);
    function paint() {
      var pct = toNorm(el, value) * 90;
      if (vertical) { handle.style.top = "auto"; handle.style.bottom = pct + "%"; }
      else { handle.style.left = pct + "%"; }
    }
    paint();
    attachVerticalDrag(box, el, function () { return value; }, function (v) {
      value = v; paint(); sendParam(pid, toNorm(el, value));
      emitVstRoutes(el.id, "value", toNorm(el, value) * 100);
    });
    applyHandlers[pid] = function (n) {
      value = fromNorm(el, n); paint();
      emitVstRoutes(el.id, "value", clamp01(n) * 100);
    };
    return box;
  }

  function renderMeter(el) {
    var box = mkBox(el);
    box.style.background = solidBase(el);
    box.style.border = "1px solid " + borderColor(el);
    box.style.borderRadius = "4px";
    box.style.overflow = "hidden";
    var vertical = num(el.height, 40) >= num(el.width, 40);
    var fill = document.createElement("div");
    fill.style.position = "absolute";
    fill.style.background = activeColor(el);
    if (vertical) { fill.style.left = "0"; fill.style.right = "0"; fill.style.bottom = "0"; }
    else { fill.style.left = "0"; fill.style.top = "0"; fill.style.bottom = "0"; }
    box.appendChild(fill);
    var pid = foundrySlugify(el.id);
    var value = contDefault(el);
    function paint() {
      var pct = toNorm(el, value) * 100;
      if (vertical) fill.style.height = pct + "%"; else fill.style.width = pct + "%";
    }
    paint();
    applyHandlers[pid] = function (n) { value = fromNorm(el, n); paint(); };
    // LISTEN: a bound vst: source (LFO / macro / transport / shell meters)
    // animates the fill live — real signal, no host automation needed.
    if (el.binding && isVstBind(el.binding.targetId)) {
      onBindValue(el.binding.targetId, function (v) {
        value = fromNorm(el, bindPct(v) / 100);
        paint();
      });
    }
    return box;
  }

  function renderToggle(el) {
    var box = mkBox(el);
    box.style.cursor = "pointer";
    var track = document.createElement("div");
    track.style.position = "absolute"; track.style.left = "0"; track.style.top = "0";
    track.style.right = "0"; track.style.bottom = "0";
    track.style.borderRadius = "9999px";
    track.style.border = "1px solid " + borderColor(el);
    track.style.transition = "background 120ms";
    var knob = document.createElement("div");
    knob.style.position = "absolute"; knob.style.top = "10%"; knob.style.height = "80%";
    knob.style.aspectRatio = "1 / 1"; knob.style.borderRadius = "9999px";
    knob.style.background = "#ffffff"; knob.style.transition = "left 120ms, right 120ms";
    box.appendChild(track); box.appendChild(knob);
    var pid = foundrySlugify(el.id);
    var on = false;
    function paint() {
      track.style.background = on ? activeColor(el) : solidBase(el);
      if (on) { knob.style.left = "auto"; knob.style.right = "10%"; }
      else { knob.style.right = "auto"; knob.style.left = "10%"; }
    }
    paint();
    box.addEventListener("click", function () {
      on = !on; paint(); sendParam(pid, on ? 1 : 0);
      emitVstRoutes(el.id, "value", on ? 100 : 0);
    });
    applyHandlers[pid] = function (n) {
      on = n >= 0.5; paint();
      emitVstRoutes(el.id, "value", on ? 100 : 0);
    };
    return box;
  }

  function renderButton(el) {
    var box = mkBox(el);
    box.style.cursor = "pointer";
    box.style.userSelect = "none";
    box.style.display = "flex";
    box.style.alignItems = "center";
    box.style.justifyContent = "center";
    box.style.background = baseColor(el);
    box.style.border = "1px solid " + borderColor(el);
    box.style.borderRadius = (el.cornerRadius != null ? num(el.cornerRadius, 8) : 8) + "px";
    box.style.color = textColor(el);
    box.style.fontFamily = "system-ui, -apple-system, sans-serif";
    box.style.fontSize = "13px";
    box.textContent = el.label || el.name || "Button";
    var pid = foundrySlugify(el.id);
    var pressed = false;
    function setPressed(p) {
      if (p === pressed) return;
      pressed = p;
      box.style.background = p ? activeColor(el) : baseColor(el);
      sendParam(pid, p ? 1 : 0);
      // Leading edge only, matching the in-app dispatch (a pad action must
      // not double-fire on release). Note on/off pairs are shell-side, driven
      // by the trigger param's edges.
      if (p) emitVstRoutes(el.id, "value", 100);
    }
    box.addEventListener("mousedown", function (e) { e.preventDefault(); setPressed(true); });
    document.addEventListener("mouseup", function () { setPressed(false); });
    applyHandlers[pid] = function (n) {
      pressed = n >= 0.5;
      box.style.background = pressed ? activeColor(el) : baseColor(el);
    };
    return box;
  }

  function renderXY(el) {
    var box = mkBox(el);
    box.style.background = solidBase(el);
    box.style.border = "1px solid " + borderColor(el);
    box.style.borderRadius = (el.type === "Spatial3D") ? "50%" : "6px";
    box.style.cursor = "crosshair";
    box.style.overflow = "hidden";
    var dot = document.createElement("div");
    dot.style.position = "absolute"; dot.style.width = "14px"; dot.style.height = "14px";
    dot.style.borderRadius = "50%"; dot.style.background = activeColor(el);
    dot.style.transform = "translate(-50%, -50%)";
    box.appendChild(dot);
    var base = foundrySlugify(el.id);
    var pidX = base + "-x", pidY = base + "-y";
    var vx = clamp(num(el.valueX, 50), 0, 100);
    var vy = clamp(num(el.valueY, 50), 0, 100);
    function paint() { dot.style.left = vx + "%"; dot.style.top = (100 - vy) + "%"; }
    paint();
    function setFromEvent(e) {
      var r = box.getBoundingClientRect();
      vx = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100);
      vy = clamp(100 - ((e.clientY - r.top) / r.height) * 100, 0, 100);
      paint();
      sendParam(pidX, vx / 100);
      sendParam(pidY, vy / 100);
      emitVstRoutes(el.id, "x", vx);
      emitVstRoutes(el.id, "y", vy);
    }
    box.addEventListener("mousedown", function (e) {
      e.preventDefault();
      setFromEvent(e);
      function move(me) { setFromEvent(me); }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    applyHandlers[pidX] = function (n) {
      vx = clamp01(n) * 100; paint();
      emitVstRoutes(el.id, "x", vx);
    };
    applyHandlers[pidY] = function (n) {
      vy = clamp01(n) * 100; paint();
      emitVstRoutes(el.id, "y", vy);
    };
    return box;
  }

  function renderLabel(el) {
    var box = mkBox(el);
    box.style.display = "flex";
    box.style.alignItems = "center";
    box.style.justifyContent = "center";
    box.style.color = textColor(el);
    box.style.fontFamily = "system-ui, -apple-system, sans-serif";
    box.style.fontSize = clamp(num(el.height, 24) * 0.5, 10, 40) + "px";
    box.style.overflow = "hidden";
    box.style.whiteSpace = "nowrap";
    box.textContent = el.label || el.name || "Label";
    return box;
  }

  function renderSelect(el) {
    var box = mkBox(el);
    var sel = document.createElement("select");
    var domId = "sel-" + foundrySlugify(el.id);
    sel.id = domId;
    sel.name = domId;
    sel.setAttribute("aria-label", el.name || el.label || "select");
    sel.style.width = "100%"; sel.style.height = "100%";
    sel.style.background = solidBase(el);
    sel.style.color = textColor(el);
    sel.style.border = "1px solid " + borderColor(el);
    sel.style.borderRadius = "4px";
    sel.style.fontFamily = "system-ui, -apple-system, sans-serif";
    sel.style.fontSize = "13px";
    var opts = Array.isArray(el.options) ? el.options : [];
    var i;
    for (i = 0; i < opts.length; i++) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = String(opts[i]);
      sel.appendChild(o);
    }
    box.appendChild(sel);
    var pid = foundrySlugify(el.id);
    function norm(idx) { return opts.length > 1 ? idx / (opts.length - 1) : 0; }
    sel.addEventListener("change", function () { sendParam(pid, norm(sel.selectedIndex)); });
    applyHandlers[pid] = function (n) {
      if (opts.length === 0) return;
      sel.selectedIndex = Math.round(clamp01(n) * (opts.length - 1));
    };
    return box;
  }

  function renderImage(el) {
    var box = mkBox(el);
    box.style.overflow = "hidden";
    var asset = el.assetId ? assetById[el.assetId] : null;
    var url = asset ? (asset.processedUrl || asset.url) : null;
    if (url) {
      var img = document.createElement("img");
      img.src = url;
      img.alt = el.label || el.name || "image";
      img.style.width = "100%"; img.style.height = "100%";
      img.style.objectFit = "contain"; img.style.display = "block";
      if (el.opacity != null) img.style.opacity = String(num(el.opacity, 100) / 100);
      box.appendChild(img);
    } else {
      box.style.border = "1px dashed " + borderColor(el);
    }
    return box;
  }

  // Map a CustomCode element's visual fields onto the --el-* CSS vars the bridge
  // exposes inside the iframe (mirrors elementStyleTokens in customCodeBridge.ts)
  // so skins/materials survive export.
  function ccStyleVars(el) {
    var m = {};
    if (el.baseColor) m["--el-base-color"] = el.baseColor;
    if (el.activeColor) m["--el-active-color"] = el.activeColor;
    if (el.borderColor) m["--el-border-color"] = el.borderColor;
    if (el.textColor) m["--el-text-color"] = el.textColor;
    if (el.opacity != null) m["--el-opacity"] = String(num(el.opacity, 100) / 100);
    if (el.skin) m["--el-skin"] = el.skin;
    return m;
  }
  function cssDecls(m) {
    var s = "", k;
    for (k in m) {
      if (Object.prototype.hasOwnProperty.call(m, k)) s += k + ":" + m[k] + ";";
    }
    return s;
  }
  // Escape a JSON string embedded in the iframe's <script> (same rules as the
  // shared bridge's escapeScriptJson): neutralize '<' and the U+2028/9 line
  // separators that are illegal in JS string literals.
  function escForScript(json) {
    return String(json).split("<").join("\\u003c")
      .split(U2028).join("\\u2028")
      .split(U2029).join("\\u2029");
  }

  function buildCustomDoc(code, paramsJson, styleVarsCss) {
    // Script tags are split so their literal text never appears in the OUTER
    // renderer <script>; the browser reassembles them when parsing srcdoc.
    return "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
      "<style>*{margin:0;padding:0;box-sizing:border-box;}" +
      "html,body{width:100%;height:100%;overflow:hidden;background:transparent;}" +
      ":root{" + (styleVarsCss || "") + "}" +
      "body{color:var(--el-text-color,inherit);accent-color:var(--el-active-color);}</style>" +
      "<scr" + "ipt>window.PARAMS=" + (paramsJson || "{}") + ";</scr" + "ipt>" +
      "<scr" + "ipt>" + BRIDGE_SOURCE + "</scr" + "ipt>" +
      "</head><body>" + (code || "") + "</body></html>";
  }

  function renderCustomCode(el) {
    var box = mkBox(el);
    box.style.overflow = "hidden";

    var fit = el.customCodeFit || "scale";
    var params = Array.isArray(el.params) ? el.params : [];

    // Numeric params <-> host param ids. MUST match buildVst3Manifest:
    // <element-slug>-<param-slug>, continuous, normalized 0..1 over [min,max].
    var numeric = [];
    var initial = {};
    var pi, p;
    for (pi = 0; pi < params.length; pi++) {
      p = params[pi];
      if (!p || !p.key) continue;
      initial[p.key] = p.value;
      if (p.type === "number") {
        var mn = num(p.min, 0), mx = num(p.max, 100);
        if (mx === mn) mx = mn + 1;
        numeric.push({
          key: p.key,
          paramId: foundrySlugify(el.id) + "-" + foundrySlugify(p.key),
          min: mn, max: mx
        });
      }
    }

    var iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.position = "absolute";
    iframe.style.left = "0"; iframe.style.top = "0";
    iframe.style.width = "100%"; iframe.style.height = "100%";
    iframe.style.border = "none"; iframe.style.background = "transparent";
    iframe.title = "custom-" + (el.name || el.id);
    iframe.srcdoc = buildCustomDoc(
      el.customCode || "",
      escForScript(JSON.stringify(initial)),
      cssDecls(ccStyleVars(el))
    );
    box.appendChild(iframe);

    function postToFrame(msg) {
      try { if (iframe.contentWindow) iframe.contentWindow.postMessage(msg, "*"); } catch (e) {}
    }
    function setParamsMsg(key, value) {
      var p = {}; p[key] = value;
      return { type: "foundry:setParams", params: p };
    }

    // scale-fit: render at natural content size (from foundry:contentSize) and
    // transform-scale to fill the box. "stretch"/"none" leave the iframe at 100%
    // (the static bundle has no live resize channel, so they behave alike here).
    var natural = { w: 0, h: 0 };
    function applyFit() {
      if (fit === "scale" && natural.w > 0 && natural.h > 0) {
        iframe.style.width = natural.w + "px";
        iframe.style.height = natural.h + "px";
        iframe.style.transformOrigin = "top left";
        iframe.style.transform = "scale(" +
          (num(el.width, 40) / natural.w) + "," + (num(el.height, 40) / natural.h) + ")";
      } else {
        iframe.style.width = "100%"; iframe.style.height = "100%";
        iframe.style.transform = "none";
      }
    }
    applyFit();

    var byKey = {};
    var lastNorm = {};
    var ni;
    for (ni = 0; ni < numeric.length; ni++) {
      byKey[numeric[ni].key] = numeric[ni];
      (function (m) {
        // host -> UI: plugin sets the param; forward the denormalized value in.
        applyHandlers[m.paramId] = function (n) {
          var norm = clamp01(n);
          lastNorm[m.paramId] = norm;
          postToFrame(setParamsMsg(m.key, m.min + norm * (m.max - m.min)));
        };
      })(numeric[ni]);
    }

    // Per-param vst: binds (el.paramBindings) — bidirectional, mirroring the
    // in-app CustomCodeFrame: a bound LISTEN source pushes into the iframe
    // param; iframe-side changes to a bound param write the local runtime.
    var vstByKey = {};
    var pbs = Array.isArray(el.paramBindings) ? el.paramBindings : [];
    var pbi;
    for (pbi = 0; pbi < pbs.length; pbi++) {
      (function (pb) {
        if (!pb || !isVstBind(pb.targetId)) return;
        var meta = byKey[pb.key];
        if (!meta) return;
        vstByKey[pb.key] = pb.targetId;
        onBindValue(pb.targetId, function (v) {
          postToFrame(setParamsMsg(meta.key, meta.min + (bindPct(v) / 100) * (meta.max - meta.min)));
        });
      })(pbs[pbi]);
    }

    window.addEventListener("message", function (e) {
      if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
      var d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "foundry:paramChanged") {
        // UI -> host: a control moved inside the iframe.
        var m = byKey[d.key];
        if (m) {
          var norm = clamp01((num(d.value, m.min) - m.min) / (m.max - m.min));
          sendParam(m.paramId, norm);
          if (vstByKey[d.key]) vstLocalWrite(vstByKey[d.key], norm * 100);
        }
      } else if (d.type === "foundry:contentSize") {
        natural.w = num(d.w, 0); natural.h = num(d.h, 0);
        applyFit();
      } else if (d.type === "foundry:ready") {
        // Flush any values the host set before the iframe was listening.
        var q, m2;
        for (q = 0; q < numeric.length; q++) {
          m2 = numeric[q];
          if (lastNorm[m2.paramId] != null) {
            postToFrame(setParamsMsg(m2.key, m2.min + lastNorm[m2.paramId] * (m2.max - m2.min)));
          }
        }
      }
    });

    return box;
  }

  function renderWaveform(el) {
    var box = mkBox(el);
    box.style.background = solidBase(el);
    box.style.border = "1px solid " + borderColor(el);
    box.style.borderRadius = "4px";
    box.style.overflow = "hidden";
    var line = document.createElement("div");
    line.style.position = "absolute"; line.style.left = "0"; line.style.right = "0";
    line.style.top = "50%"; line.style.height = "2px";
    line.style.background = activeColor(el); line.style.opacity = "0.7";
    box.appendChild(line);
    // LISTEN: a bound vst: source breathes the trace (thickness + glow) —
    // unbound Waveforms render byte-identical to before.
    if (el.binding && isVstBind(el.binding.targetId)) {
      line.style.transformOrigin = "center center";
      onBindValue(el.binding.targetId, function (v) {
        var pct = bindPct(v) / 100;
        line.style.opacity = String(0.3 + 0.7 * pct);
        line.style.transform = "scaleY(" + (1 + pct * 8) + ")";
      });
    }
    return box;
  }

  function renderWaveShaper(el) {
    var box = mkBox(el);
    box.style.background = solidBase(el);
    box.style.border = "1px solid " + borderColor(el);
    box.style.borderRadius = "6px";
    box.style.overflow = "hidden";
    box.style.cursor = "ns-resize";
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", activeColor(el));
    path.setAttribute("stroke-width", "2");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(path);
    box.appendChild(svg);
    var pid = foundrySlugify(el.id);
    // drive is the normalized 0..1 param value (manifest range is 0..100).
    var drive = clamp01(toNorm(el, contDefault(el)));
    function th(x) { var e = Math.exp(2 * x); return (e - 1) / (e + 1); }
    function paint() {
      var k = 1 + drive * 9; // tanh sharpness, 1 (linear-ish) .. 10 (hard clip)
      var norm = th(k);
      if (norm === 0) norm = 1;
      var d = "";
      var i;
      for (i = 0; i <= 40; i++) {
        var x = i / 40;
        var xin = x * 2 - 1;
        var yout = th(k * xin) / norm;
        d += (i === 0 ? "M" : "L") + (x * 100).toFixed(2) + " " + (50 - yout * 50).toFixed(2) + " ";
      }
      path.setAttribute("d", d);
    }
    paint();
    // vertical-drag adjusts drive 0..1
    box.addEventListener("mousedown", function (e) {
      e.preventDefault();
      var startY = e.clientY;
      var startDrive = drive;
      function move(me) {
        drive = clamp01(startDrive + (startY - me.clientY) / 150);
        paint();
        sendParam(pid, drive);
        emitVstRoutes(el.id, "value", drive * 100);
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    applyHandlers[pid] = function (n) {
      drive = clamp01(n); paint();
      emitVstRoutes(el.id, "value", drive * 100);
    };
    return box;
  }

  function renderEnvelope(el) {
    var box = mkBox(el);
    box.style.background = solidBase(el);
    box.style.border = "1px solid " + borderColor(el);
    box.style.borderRadius = "6px";
    box.style.overflow = "hidden";
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.position = "absolute";
    svg.style.left = "0"; svg.style.top = "0";
    var poly = document.createElementNS(NS, "polyline");
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", activeColor(el));
    poly.setAttribute("stroke-width", "2");
    poly.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(poly);
    box.appendChild(svg);

    var base = foundrySlugify(el.id);
    // Param id suffixes MUST match buildVst3Manifest: <slug>-attack/-decay/
    // -sustain/-release. styleParams stores each stage 0..100; normalize to 0..1.
    var sp = el.styleParams || {};
    var stages = {
      attack: clamp01(num(sp.attack, 15) / 100),
      decay: clamp01(num(sp.decay, 30) / 100),
      sustain: clamp01(num(sp.sustain, 70) / 100),
      release: clamp01(num(sp.release, 25) / 100)
    };
    var pids = {
      attack: base + "-attack",
      decay: base + "-decay",
      sustain: base + "-sustain",
      release: base + "-release"
    };

    function mkNode() {
      var n = document.createElement("div");
      n.style.position = "absolute";
      n.style.width = "10px"; n.style.height = "10px";
      n.style.marginLeft = "-5px"; n.style.marginTop = "-5px";
      n.style.borderRadius = "50%";
      n.style.background = activeColor(el);
      n.style.border = "1px solid " + solidBase(el);
      n.style.cursor = "ns-resize";
      box.appendChild(n);
      return n;
    }
    var nodes = {
      attack: mkNode(), decay: mkNode(), sustain: mkNode(), release: mkNode()
    };

    function paint() {
      var a = stages.attack, d = stages.decay, s = stages.sustain, r = stages.release;
      var hold = 0.6; // fixed sustain-hold segment so the shape never collapses
      var total = a + d + hold + r;
      if (total <= 0) total = 1;
      var x1 = 100 * a / total;             // peak (end of attack)
      var x2 = 100 * (a + d) / total;       // sustain level reached (end of decay)
      var x3 = 100 * (a + d + hold) / total; // end of sustain hold
      var sy = 100 - s * 100;               // sustain level as svg y (0 = top)
      poly.setAttribute("points",
        "0,100 " + x1.toFixed(2) + ",0 " + x2.toFixed(2) + "," + sy.toFixed(2) +
        " " + x3.toFixed(2) + "," + sy.toFixed(2) + " 100,100");
      nodes.attack.style.left = x1.toFixed(2) + "%"; nodes.attack.style.top = "0%";
      nodes.decay.style.left = x2.toFixed(2) + "%"; nodes.decay.style.top = sy.toFixed(2) + "%";
      nodes.sustain.style.left = ((x2 + x3) / 2).toFixed(2) + "%"; nodes.sustain.style.top = sy.toFixed(2) + "%";
      nodes.release.style.left = "100%"; nodes.release.style.top = "100%";
    }
    paint();

    function drag(stage) {
      nodes[stage].addEventListener("mousedown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var startY = e.clientY;
        var startVal = stages[stage];
        function move(me) {
          stages[stage] = clamp01(startVal + (startY - me.clientY) / 150);
          paint();
          sendParam(pids[stage], stages[stage]);
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    }
    drag("attack"); drag("decay"); drag("sustain"); drag("release");

    applyHandlers[pids.attack] = function (n) { stages.attack = clamp01(n); paint(); };
    applyHandlers[pids.decay] = function (n) { stages.decay = clamp01(n); paint(); };
    applyHandlers[pids.sustain] = function (n) { stages.sustain = clamp01(n); paint(); };
    applyHandlers[pids.release] = function (n) { stages.release = clamp01(n); paint(); };
    return box;
  }

  function renderGroup(el) {
    var box = mkBox(el);
    if (el.baseColor && !el.transparentBackground) box.style.background = el.baseColor;
    box.style.pointerEvents = "none";
    return box;
  }

  function renderElement(el) {
    switch (el.type) {
      case "Knob": return renderKnob(el);
      case "Slider": return renderSlider(el);
      case "Meter": return renderMeter(el);
      case "Toggle": return renderToggle(el);
      case "Button": return renderButton(el);
      case "XYPad": return renderXY(el);
      case "Spatial3D": return renderXY(el);
      case "Label": return renderLabel(el);
      case "Select": return renderSelect(el);
      case "Image": return renderImage(el);
      case "CustomCode": return renderCustomCode(el);
      case "Waveform": return renderWaveform(el);
      case "WaveShaper": return renderWaveShaper(el);
      case "Envelope": return renderEnvelope(el);
      case "Group": return renderGroup(el);
      default: return null;
    }
  }

  // --- mount ----------------------------------------------------------------
  var root = document.getElementById("foundry-root");
  if (!root) { root = document.createElement("div"); root.id = "foundry-root"; document.body.appendChild(root); }
  root.style.position = "relative";
  root.style.width = num(canvasState.width, 800) + "px";
  root.style.height = num(canvasState.height, 600) + "px";
  root.style.overflow = "hidden";
  if (canvasState.backgroundImage) {
    root.style.backgroundImage = "url(" + canvasState.backgroundImage + ")";
    root.style.backgroundSize = "contain";
    root.style.backgroundRepeat = "no-repeat";
    root.style.backgroundPosition = "center";
  }

  // Groups first so they paint behind their (absolutely-positioned) children.
  var ordered = elements.slice().sort(function (a, b) {
    return (a.type === "Group" ? 0 : 1) - (b.type === "Group" ? 0 : 1);
  });
  var k;
  for (k = 0; k < ordered.length; k++) {
    var node = renderElement(ordered[k]);
    if (node) root.appendChild(node);
  }
})();`;

/**
 * Build the static `ui/index.html` for a VST3 data bundle. The design-specific
 * data is supplied separately via `ui/params.js` (window.FOUNDRY_DESIGN), so the
 * returned HTML is identical across exports.
 *
 * @param slugFnSource JS source of the slug function (see SLUGIFY_FN_SOURCE in
 *   vst3Export.ts). It is injected verbatim so the renderer derives the same
 *   param ids as the manifest.
 */
export function buildIndexHtml(slugFnSource: string): string {
  // Inject the shared bridge as a JS string literal. JSON.stringify makes it a
  // valid literal; escaping '<' -> < ensures it can't terminate the outer
  // <script> (a function replacer avoids $-pattern interpretation).
  const bridgeLiteral = JSON.stringify(BRIDGE_BOOTSTRAP_SOURCE).replace(
    /</g,
    "\\u003c",
  );
  const renderer = RENDERER_JS.replace(
    "__SLUG_FN_SOURCE__",
    () => slugFnSource,
  ).replace("__BRIDGE_BOOTSTRAP__", () => bridgeLiteral);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Foundry Plugin</title>
<style>
${BASE_CSS}
</style>
</head>
<body>
<div id="foundry-root"></div>
<!--
  Host bridge, shipped by the native shell beside this file in Resources/ui/.
  It defines window.foundryHost / SPVFD / __foundrySetParamMap so the renderer
  can talk to the plugin WebView. MUST load before params.js and the renderer.
  In a plain browser (bundle preview) this 404s and window.foundryHost stays
  undefined; the renderer's optional-chaining guards (see sendParam / the
  window.foundryHost checks) make that harmless — the UI just runs view-only.
-->
<script src="foundry-bridge.js"></script>
<script src="params.js"></script>
<script>
${renderer}
</script>
</body>
</html>
`;
}
