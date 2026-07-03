import { CustomCodeDiagnostic, UIElement } from "../types";

// The postMessage protocol between the host and a CustomCode sandboxed iframe.
// ONE implementation, shared by the live app (CustomCodeFrame) and the exported
// VST3 bundle (vst3ExportUi) so the two can never drift. The bootstrap below is
// an exact superset of the original inline bridge in CustomCodeFrame — existing
// custom code that only touches window.PARAMS / window.onFoundryParams /
// window.foundryRegisterParams keeps working unchanged.
export const BRIDGE_MESSAGES = {
  // Host -> iframe
  setParams: "foundry:setParams", // live parameter values { params: {key: value} }
  setStyle: "foundry:setStyle", // skin/material CSS vars { vars: {"--el-*": value} }
  // iframe -> host
  registerParams: "foundry:registerParams", // self-described schema { params: [...] }
  paramChanged: "foundry:paramChanged", // a control moved inside the iframe { key, value }
  contentSize: "foundry:contentSize", // natural content size { w, h }
  error: "foundry:error", // runtime error { message, stack? }
  ready: "foundry:ready", // bootstrap handshake
} as const;

type ParamValue = number | string | boolean;

export interface SetParamsMessage {
  type: "foundry:setParams";
  params: Record<string, ParamValue>;
}
export interface SetStyleMessage {
  type: "foundry:setStyle";
  vars: Record<string, string>;
}
export type HostToFrameMessage = SetParamsMessage | SetStyleMessage;

export interface RegisterParamsMessage {
  type: "foundry:registerParams";
  params: unknown[];
}
export interface ParamChangedMessage {
  type: "foundry:paramChanged";
  key: string;
  value: ParamValue;
}
export interface ContentSizeMessage {
  type: "foundry:contentSize";
  w: number;
  h: number;
}
export interface ErrorMessage {
  type: "foundry:error";
  message: string;
  stack?: string;
}
export interface ReadyMessage {
  type: "foundry:ready";
}
export type FrameToHostMessage =
  | RegisterParamsMessage
  | ParamChangedMessage
  | ContentSizeMessage
  | ErrorMessage
  | ReadyMessage;

// The in-iframe half of the bridge, as a self-contained source STRING (embedded
// into the sandboxed document's <script>, and into the standalone exported
// bundle where a live import is impossible). Written in ES5 style to match the
// original bootstrap and run in any sandbox. The message-type string literals
// here MUST match BRIDGE_MESSAGES above.
export const BRIDGE_BOOTSTRAP_SOURCE = `(function () {
  var SET_PARAMS = "foundry:setParams";
  var SET_STYLE = "foundry:setStyle";
  var REGISTER = "foundry:registerParams";
  var PARAM_CHANGED = "foundry:paramChanged";
  var CONTENT_SIZE = "foundry:contentSize";
  var ERROR = "foundry:error";
  var READY = "foundry:ready";

  if (!window.PARAMS || typeof window.PARAMS !== "object") window.PARAMS = {};
  var userRegistered = false;

  function post(msg) {
    try { parent.postMessage(msg, "*"); } catch (e) {}
  }

  // Host -> iframe: live values and skin/material style vars. Values arrive
  // without a reload; onFoundryParams lets cooperative code react.
  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === SET_PARAMS && d.params && typeof d.params === "object") {
      window.PARAMS = Object.assign({}, window.PARAMS, d.params);
      if (typeof window.onFoundryParams === "function") {
        try { window.onFoundryParams(window.PARAMS); } catch (err) {}
      }
    } else if (d.type === SET_STYLE && d.vars && typeof d.vars === "object") {
      var root = document.documentElement;
      for (var k in d.vars) {
        if (Object.prototype.hasOwnProperty.call(d.vars, k)) {
          try { root.style.setProperty(k, String(d.vars[k])); } catch (err) {}
        }
      }
    }
  });

  // Preserved API: code advertises its own parameter schema to the host.
  window.foundryRegisterParams = function (schema) {
    userRegistered = true;
    post({ type: REGISTER, params: schema });
  };

  // New API: code (or an auto-discovered control) reports a value change so the
  // host params + any theDAW binding stay in sync with what the user did.
  window.foundrySetParam = function (key, value) {
    if (typeof key !== "string" || !key) return;
    window.PARAMS[key] = value;
    post({ type: PARAM_CHANGED, key: key, value: value });
  };

  // Runtime failures flow to the host instead of dying silently in the sandbox.
  window.addEventListener("error", function (e) {
    post({
      type: ERROR,
      message: (e && e.message) || "script error",
      stack: e && e.error && e.error.stack ? String(e.error.stack) : undefined,
    });
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    post({
      type: ERROR,
      message: r && r.message ? String(r.message) : String(r),
      stack: r && r.stack ? String(r.stack) : undefined,
    });
  });

  // Natural content size drives the host's scale-fit. Children rects are used
  // (not just body scrollWidth) so a 100%-height body doesn't hide the real
  // content extent.
  function reportSize() {
    var b = document.body;
    var w = 0, h = 0;
    if (b) {
      for (var i = 0; i < b.children.length; i++) {
        var r = b.children[i].getBoundingClientRect();
        if (r.right > w) w = r.right;
        if (r.bottom > h) h = r.bottom;
      }
      if (b.scrollWidth > w) w = b.scrollWidth;
      if (b.scrollHeight > h) h = b.scrollHeight;
    }
    post({ type: CONTENT_SIZE, w: Math.round(w), h: Math.round(h) });
  }

  function deriveKey(node, index) {
    var raw = node.id || node.name || node.getAttribute("aria-label") || "";
    if (!raw && node.labels && node.labels.length && node.labels[0].textContent) {
      raw = node.labels[0].textContent;
    }
    var cleaned = String(raw).replace(/[^a-zA-Z0-9_$]/g, "");
    return cleaned || ("param" + (index + 1));
  }

  // Fallback for code that never calls foundryRegisterParams: scan the DOM for
  // standard form controls and expose them as params, wiring each back out via
  // foundrySetParam so the host panel and bindings reflect user interaction.
  function discover() {
    if (userRegistered) return;
    var nodes = document.querySelectorAll(
      "input[type=range], input[type=number], input[type=color], input[type=checkbox], select"
    );
    if (!nodes.length) return;
    var schema = [];
    var seen = {};
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = deriveKey(node, i);
      if (seen[key]) continue;
      seen[key] = true;
      var labelText =
        node.getAttribute("aria-label") ||
        (node.labels && node.labels[0] && node.labels[0].textContent) ||
        key;
      var p = { key: key, label: String(labelText).trim() || key };
      (function (n, param) {
        var tag = n.tagName.toLowerCase();
        if (tag === "select") {
          param.type = "select";
          var opts = [];
          for (var j = 0; j < n.options.length; j++) opts.push(n.options[j].value);
          param.options = opts;
          param.value = n.value;
          n.addEventListener("input", function () { window.foundrySetParam(param.key, n.value); });
        } else if (n.type === "checkbox") {
          param.type = "toggle";
          param.value = n.checked;
          n.addEventListener("input", function () { window.foundrySetParam(param.key, n.checked); });
        } else if (n.type === "color") {
          param.type = "color";
          param.value = n.value;
          n.addEventListener("input", function () { window.foundrySetParam(param.key, n.value); });
        } else {
          param.type = "number";
          if (n.min !== "") param.min = Number(n.min);
          if (n.max !== "") param.max = Number(n.max);
          if (n.step !== "" && n.step !== "any") param.step = Number(n.step);
          param.value = Number(n.value);
          n.addEventListener("input", function () { window.foundrySetParam(param.key, Number(n.value)); });
        }
      })(node, p);
      schema.push(p);
    }
    if (schema.length) post({ type: REGISTER, params: schema });
  }

  function init() {
    reportSize();
    try {
      if (typeof ResizeObserver === "function") {
        var ro = new ResizeObserver(function () { reportSize(); });
        if (document.body) ro.observe(document.body);
        ro.observe(document.documentElement);
      }
    } catch (e) {}
    // One macrotask of grace for user code to register before we scan the DOM.
    setTimeout(discover, 0);
    post({ type: READY });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();`;

// Escape a JSON string so it can't break out of / corrupt the <script> that
// embeds it: `</script>` and the U+2028/U+2029 line separators (illegal in JS
// string literals). The separators are matched via String.fromCharCode so this
// source stays plain-ASCII. Same escaping rules as the original bootstrap.
export function escapeScriptJson(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
}

// Assemble the full sandboxed document. `paramsJson` is a raw JSON.stringify of
// the initial { key: value } map; `themeCss` / `styleVarsCss` are CSS custom
// property declarations (`--app-*` theme tokens and `--el-*` style tokens) for
// :root. The bridge bootstrap runs before the user markup so window.PARAMS and
// the message wiring exist by the time their code executes.
export function buildBridgeDoc(opts: {
  code: string;
  paramsJson: string;
  themeCss: string;
  styleVarsCss: string;
}): string {
  const paramsJson = escapeScriptJson(opts.paramsJson || "{}");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
:root { ${opts.themeCss || ""} ${opts.styleVarsCss || ""} }
body { color: var(--el-text-color, var(--app-main, inherit)); accent-color: var(--el-active-color, var(--app-accent)); }
</style>
<script>window.PARAMS = ${paramsJson};</script>
<script>${BRIDGE_BOOTSTRAP_SOURCE}</script>
</head>
<body>${opts.code || ""}</body>
</html>`;
}

// Map a CustomCode element's visual fields onto the --el-* CSS variables the
// bridge exposes inside the iframe, so skins/materials apply to custom content
// (cooperative code reads the vars; the bridge stylesheet applies sensible
// defaults for auto-discovered controls). Only defined fields are emitted.
export function elementStyleTokens(el: UIElement): Record<string, string> {
  const tokens: Record<string, string> = {};
  if (el.baseColor) tokens["--el-base-color"] = el.baseColor;
  if (el.activeColor) tokens["--el-active-color"] = el.activeColor;
  if (el.borderColor) tokens["--el-border-color"] = el.borderColor;
  if (el.textColor) tokens["--el-text-color"] = el.textColor;
  if (typeof el.opacity === "number") tokens["--el-opacity"] = String(el.opacity / 100);
  if (el.skin) tokens["--el-skin"] = el.skin;
  return tokens;
}

// Serialize a CSS-var token map into `name: value;` declarations for :root.
export function cssVarDeclarations(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

// Runtime diagnostics reported by CustomCode iframes, keyed by element id.
// Written by CustomCodeFrame on `foundry:error`, read by CustomCodePanel and the
// assistant's getCustomCode tool. Capped so a spinning error loop can't grow it
// without bound; newest entries last.
const MAX_DIAGNOSTICS_PER_ELEMENT = 20;
export const customCodeDiagnostics = new Map<string, CustomCodeDiagnostic[]>();

export function pushCustomCodeDiagnostic(
  elementId: string,
  diag: CustomCodeDiagnostic,
): void {
  const list = customCodeDiagnostics.get(elementId) || [];
  list.push(diag);
  while (list.length > MAX_DIAGNOSTICS_PER_ELEMENT) list.shift();
  customCodeDiagnostics.set(elementId, list);
}

export function clearCustomCodeDiagnostics(elementId: string): void {
  customCodeDiagnostics.delete(elementId);
}
