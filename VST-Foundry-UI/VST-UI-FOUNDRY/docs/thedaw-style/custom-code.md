# Custom Code — First-Class Code Components

Reference for Foundry's **CustomCode** element: a canvas element whose contents
are your own HTML/CSS/JS, rendered in a sandboxed iframe with a live two-way
bridge to the rest of the design. Unlike the built-in controls (Knob, Slider,
Meter, …) a CustomCode element has no fixed shape — it is whatever your code
draws — yet it still participates in the same parameter, skin, texture, and
theDAW control-bus systems every native control uses. This doc covers what runs
inside the frame, the postMessage protocol that connects it to the host, how its
parameters are declared and kept sane, how per-parameter theDAW bindings work in
both directions, and what the unit tests pin down. It is written for someone
authoring custom elements or working on the subsystem itself.

For how native controls render and route, see
[canvas-and-controls.md](canvas-and-controls.md); for how CustomCode params turn
into exported plugin parameters, see [vst3-export.md](vst3-export.md) and
[gan-format.md](gan-format.md); for the theDAW side of the control bus, see
[thedaw-integration.md](thedaw-integration.md).

## The pieces

Three core source files own the subsystem. Everything else (the assistant, the
Bind tab, export) composes them.

| File | Role |
|---|---|
| `src/components/CustomCodeFrame.tsx` | React host: builds the sandboxed iframe document, pushes live values/styles in, receives register/param-changed/size/error/ready out, and wires per-param theDAW bindings. |
| `src/lib/customCodeBridge.ts` | The postMessage protocol constants, the in-iframe bootstrap source string, the document assembler, `--el-*`/`--app-*` style-token mapping, and the runtime-diagnostics store. |
| `src/lib/customParams.ts` | `sanitizeCustomParams` / `mergeCustomParams`: validate untrusted param schemas and reconcile a re-registered schema against existing user values. |

Authoring is not a single dedicated panel on this branch. A CustomCode element's
HTML and parameter schema are written by the AI assistant's `getCustomCode` /
`setCustomCode` tools (`src/components/orb/useToolActions.ts`) and can be
hand-edited through the properties **Raw** tab — a Monaco JSON editor over the
whole element in `src/components/CompactElementProperties.tsx`. Per-parameter
theDAW bindings are surfaced by the **Bind** tab
(`src/components/properties/BindingPicker.tsx`). See **Editing a CustomCode
element** below.

> Note: an earlier dedicated properties panel (`CustomCodePanel.tsx`, mounted by
> `PropertiesPanel.tsx`) owned code editing, per-param editing, the fit-mode
> select, the runtime-error banner, and a Save-to-Library button. Both files now
> live only under `deprecated/src/components/` and are mounted nowhere in the
> live app; a couple of stale `see CustomCodePanel` comments still linger in
> `src/types.ts` and `src/lib/customCodeBridge.ts`. Treat any reference to
> `CustomCodePanel` as historical.

The bridge protocol lives in one place on purpose: the exact same
`BRIDGE_BOOTSTRAP_SOURCE` and message names are used by the live app
(`CustomCodeFrame`) **and** by the standalone VST3 export renderer
(`src/lib/vst3ExportUi.ts`), so a custom element behaves identically in the
designer and in a shipped plugin.

> A CustomCode element is a normal `UIElement` with `type: "CustomCode"`. Its
> code lives in `el.customCode`, its parameter schema in `el.params`, its
> per-param theDAW bindings in `el.paramBindings`, and its fit mode in
> `el.customCodeFit`. All of those ride the ordinary autosave / project-save /
> zip-export path because the whole element is serialized as-is.

## The frame model

`CustomCodeFrame` renders an `<iframe sandbox="allow-scripts">` whose `srcDoc` is
a self-contained document assembled by `buildBridgeDoc()`. The sandbox grants
scripts only — no `allow-same-origin`, no `allow-forms`, no top-navigation — so
the code runs in an opaque origin and cannot reach the host DOM, cookies, or
storage. All communication is by `postMessage`.

Key behaviors:

- **The document is rebuilt only when the code or theme changes.** Parameter
  values and style tokens are delivered over `postMessage`, never by rebuilding
  the `srcDoc` — so dragging a control or applying a skin updates the element
  without reloading or flickering it. The `srcDoc` memo depends only on
  `el.customCode` and the theme-var string (read once at mount).
- **One inbound message listener per element,** bound by `el.id`. It reads the
  current element and callbacks through refs so it never re-binds on unrelated
  re-renders, and it ignores any message whose `e.source` is not this iframe's
  `contentWindow`.
- **State is re-pushed on `foundry:ready`** (and again in the iframe's `onLoad`)
  to beat any race where the host's first `setParams`/`setStyle` lands before
  the bootstrap installed its listener.
- **In design mode a transparent overlay** (`zIndex: 3`) sits over the iframe so
  the element can be dragged/resized/rotated; in preview mode the overlay is
  removed so the iframe is interactive. The wrapper is `pointer-events-auto`
  only in preview.
- **Material shell.** The host paints the same background / glow / skin
  (`getSkinLayers`) / texture layers around the iframe that `InteractiveControl`
  paints for native controls, so skins and textures apply to custom content
  regardless of whether the code cooperates. See
  [textures-and-skins.md](textures-and-skins.md).

## The bridge protocol

`BRIDGE_MESSAGES` in `customCodeBridge.ts` defines every message. All wire types
are namespaced `foundry:` and the string literals are shared by both halves of
the bridge and by the exported bundle.

| Constant | Wire `type` | Direction | Payload | Purpose |
|---|---|---|---|---|
| `setParams` | `foundry:setParams` | host → iframe | `{ params: { key: value } }` | Push live parameter values. Merged into `window.PARAMS`. |
| `setStyle` | `foundry:setStyle` | host → iframe | `{ vars: { "--el-*"/"--foundry-*": string } }` | Push skin/material CSS vars and size vars onto `:root`. |
| `registerParams` | `foundry:registerParams` | iframe → host | `{ params: [...] }` | Code advertises its own parameter schema. |
| `paramChanged` | `foundry:paramChanged` | iframe → host | `{ key, value }` | A control inside the iframe moved. |
| `contentSize` | `foundry:contentSize` | iframe → host | `{ w, h }` | Natural content size, drives the `scale` fit. |
| `error` | `foundry:error` | iframe → host | `{ message, stack? }` | A runtime error caught in the sandbox. |
| `ready` | `foundry:ready` | iframe → host | — | Bootstrap handshake; host re-pushes state. |

Each message has a matching TypeScript interface in `customCodeBridge.ts`
(`SetParamsMessage`, `RegisterParamsMessage`, etc.) grouped into the
`HostToFrameMessage` and `FrameToHostMessage` unions.

## What your code sees inside the frame

`BRIDGE_BOOTSTRAP_SOURCE` runs before your markup (it is injected as a `<script>`
in `<head>`, after the `window.PARAMS` seed). It is written in ES5 so it runs in
any sandbox and is byte-identical between the live app and the export. It gives
your code these globals:

| Global | Provided by | What it does |
|---|---|---|
| `window.PARAMS` | bridge (seeded from `el.params`, then merged on each `setParams`) | The flat `{ key: value }` map of current parameter values. Read a value as `window.PARAMS.myKey`. |
| `window.onFoundryParams` | you assign it | If it is a function, the bridge calls it with the full `window.PARAMS` object every time new values arrive — react to live edits here. |
| `window.foundryRegisterParams(schema)` | bridge | Advertise your own parameter schema to the host (posts `registerParams`). Marks the frame as user-registered so DOM auto-discovery is skipped. |
| `window.foundrySetParam(key, value)` | bridge | Report that a control changed. Updates `window.PARAMS[key]` and posts `paramChanged` so the host element state, undo history, and any theDAW binding stay in sync. |

Example custom element:

```html
<input id="gain" type="range" min="0" max="100" value="50" />
<div id="readout">50</div>
<script>
  var slider = document.getElementById("gain");
  var readout = document.getElementById("readout");
  function render() {
    readout.textContent = window.PARAMS.gain;
  }
  // React to host-pushed values (bindings, assistant/raw-JSON edits).
  window.onFoundryParams = function () {
    slider.value = window.PARAMS.gain;
    render();
  };
  // Report user drags back to the host.
  slider.addEventListener("input", function () {
    window.foundrySetParam("gain", Number(slider.value));
    render();
  });
</script>
```

> If your code never calls `foundryRegisterParams`, the bootstrap runs a
> one-macrotask-delayed DOM scan (`discover`) for standard form controls —
> `input[type=range|number|color|checkbox]` and `select` — and registers each as
> a param, deriving the key from `id` / `name` / `aria-label` / associated
> `<label>` text (falling back to `param1`, `param2`, …) and wiring each
> control's `input` event to `foundrySetParam`. Registering explicitly disables
> this scan.

The bootstrap also reports **content size** from the union of body children
rects plus `scrollWidth`/`scrollHeight` (re-fired via a `ResizeObserver`), and
forwards `window.onerror` / `unhandledrejection` to the host as `foundry:error`.

## Parameters: the CustomParam schema

A parameter is a `CustomParam` (declared in `src/types.ts`). The host pushes the
current values into the iframe as `window.PARAMS`; the assistant and the Raw JSON
editor edit the schema itself.

| Field | Type | Applies to | Notes |
|---|---|---|---|
| `id?` | `string` | all | Optional stable per-param React list key. Preserved across a sanitize/merge when present; the Bind-tab picker falls back to `key` when it is absent. |
| `key` | `string` | all | Read in code as `window.PARAMS[key]`. Sanitized to `[a-zA-Z0-9_$]`. |
| `label` | `string` | all | Display name in the UI (e.g. the Bind-tab picker); falls back to `key`. |
| `type` | `"number" \| "color" \| "select" \| "toggle" \| "text"` | all | Determines the editor and the value coercion. |
| `value` | `number \| string \| boolean` | all | Current value, coerced to `type`. |
| `default?` | `number \| string \| boolean` | all | Optional default (used by VST3 export). |
| `min` / `max` / `step` | `number` | `number` | Range and increment for the slider/number editor. |
| `options?` | `string[]` | `select` | Choices; value must be one of them. |

Params reach an element from four places: authored by the assistant when it
writes the element (`setCustomCode`), self-registered by the running code via
`foundryRegisterParams`, restored from a saved project / library module, or
hand-edited in the Raw JSON editor.

### Sanitizing untrusted schemas

`sanitizeCustomParams(raw)` is the gate for any schema from an untrusted source —
an iframe self-registering via `foundryRegisterParams`, params passed to the
assistant's `setCustomCode`, hand-edited JSON, or older data. It guarantees the
shape the UI and bridge depend on so a malformed entry can never crash a render
or feed a bad value into the iframe.

| Rule | Behavior |
|---|---|
| Non-array input | Returns `[]`. |
| Missing/empty `key`, or key after stripping `[^a-zA-Z0-9_$]` is empty | Entry dropped. |
| Duplicate `key` | First occurrence wins; later ones dropped. |
| Unknown `type` | Coerced to `"text"`. |
| `number` value | Coerced via `Number(...)`; non-finite → `0`; clamped to `min`/`max` (skipped when `min > max`). |
| `toggle` value | Booleans pass through; strings parsed explicitly so `"false"`/`"0"` are `false`; others via `!!`. |
| `color` value | Non-string → `"#ffffff"`. |
| `select` value | `options` filtered to strings; value not in `options` falls back to the first option (or `""`). |
| `text`/other value | Coerced to string (`null`/`undefined` → `""`). |
| `id` | Preserved only if it is a string. |

### Merging a re-registered schema

`mergeCustomParams(existing, registered)` reconciles a freshly registered schema
against the element's existing params so a code regen or an iframe re-register
never wipes values the user set. The registered schema defines structure and
order; user values survive.

| Aspect | Source of truth |
|---|---|
| Order, `type`, `label`, `min`, `max`, `step`, `options` | The registered schema. |
| `value` for a key present in both | The **existing** value, re-coerced/clamped to the registered type and range. |
| `value` for a new key | The registered value. |
| Keys absent from the registered schema | Pruned. |
| `id` for a key present in both | The existing id is preserved (stable React keys). |

Everything runs back through `sanitizeCustomParams`, so the result is always
valid. In `App.tsx`, `handleRegisterParams` applies this through
`setElementsWithoutHistory` (the undo-bypassing setter) and bails before touching
state when the merge produces no change — a re-register on every iframe reload
must not spam undo/redo.

## Editing a CustomCode element

There is no dedicated CustomCode properties panel on this branch (the former
`CustomCodePanel` is deprecated — see **The pieces** above). Editing is surfaced
three ways:

- **The AI assistant (primary).** The orb's `getCustomCode` / `setCustomCode`
  tools (`src/components/orb/useToolActions.ts`) are the main authoring path.
  `getCustomCode(id)` returns the element's full, never-truncated
  `{ customCode, params, customCodeFit, diagnostics }`, so the model edits the
  real current source and can see whether its last edit threw.
  `setCustomCode(id, { customCode, params? })` writes `el.customCode` and, when
  `params` is supplied, runs it through `sanitizeCustomParams`.
- **Raw JSON editor.** The properties **Raw** tab
  (`CompactElementProperties.tsx`) is a Monaco (`@monaco-editor/react`) JSON
  editor over the whole element, so `customCode`, `params`, `customCodeFit`, and
  `paramBindings` can all be hand-edited there. It is generic (every element type
  has it), not CustomCode-specific.
- **Bind tab.** The per-numeric-param theDAW binding picker — see **theDAW
  control-bus wiring** below.

**Library modules.** Adding a CustomCode element or calling `setCustomCode`
persists `{ name, customCode, params }` as a reusable `CustomModule` in the
sidebar palette via `onRegisterModule`, so a saved module tracks edits instead of
drifting.

## Fit modes

`el.customCodeFit` controls how the sandboxed content fills the element box. It
is honored by `CustomCodeFrame` and the export renderer; on this branch it is set
through the Raw JSON editor or the assistant (there is no dedicated fit control).

| Value | Behavior |
|---|---|
| `scale` (default) | Render at the iframe's natural content size, then CSS-transform-scale it to the element box. Before the first `contentSize` arrives, it falls back to filling the box so the element is never invisible. |
| `stretch` | The iframe fills the box; responsive code reads `--foundry-width` / `--foundry-height` (pushed as style vars). |
| `none` | Legacy 1:1 iframe filling the box, no scaling. |

## Skins, materials, and theme in the frame

`elementStyleTokens(el)` maps the element's visual fields onto `--el-*` CSS
variables that are declared on the iframe's `:root` and pushed live on every
change via `setStyle`. Only defined fields are emitted.

| CSS var | Source field |
|---|---|
| `--el-base-color` | `el.baseColor` |
| `--el-active-color` | `el.activeColor` |
| `--el-border-color` | `el.borderColor` |
| `--el-text-color` | `el.textColor` |
| `--el-opacity` | `el.opacity / 100` |
| `--el-skin` | `el.skin` |

The `--foundry-width` / `--foundry-height` size vars (used by the `stretch` fit)
are **not** part of `elementStyleTokens`. `sizeVars()` / `styleVarsFor()` in
`CustomCodeFrame.tsx` derive them from `el.width` / `el.height` and merge them
into the same `setStyle` push.

The app's theme tokens (`--app-base`, `--app-surface`, `--app-main`,
`--app-accent`, …) are also injected once so embedded markup can reference the
same palette as the rest of the app. The document's default `body` styles wire
`color` to `--el-text-color` (falling back to `--app-main`) and `accent-color`
to `--el-active-color` (falling back to `--app-accent`), so auto-discovered form
controls inherit the theme without any cooperation from your code.

## theDAW control-bus wiring

A native control has one value and routes it through an element-level routing
stack. CustomCode has **no single value**, so it binds theDAW targets **per
numeric parameter** instead. The capability helpers live in `dawControlBus.ts`.

| Helper | Result for CustomCode | Meaning |
|---|---|---|
| `bindableKindsFor("CustomCode")` | `null` | Not part of the element-level routing/write UI. |
| `listenKindsFor("CustomCode")` | `null` | Not an element-level listener. |
| `customCodeBindableParams(el)` | the element's `type: "number"` params, in order (`[]` for any non-CustomCode element) | The per-param bindable/listenable set. |
| `customCodeParamKinds()` | `["knob", "fader"]` | The continuous, writable theDAW kinds a numeric param may bind to. |

Each binding is a `CustomParamBinding` (`{ key, targetId }`) stored in
`el.paramBindings`. The properties **Bind** tab (`BindingPicker` →
`CustomParamBindingPicker`) shows one theDAW-target dropdown per numeric param,
and the tab is offered only when `customCodeBindableParams(el).length > 0`. A
single binding is **bidirectional**: one numeric param serves both directions.

**LISTEN (theDAW → iframe).** For each `paramBinding`, `CustomCodeFrame` starts
the bus (`startDawControlBus`) and the local `vst:` runtime
(`startVstBindRuntime`, for LFO/macro/transport binds), seeds from
`getDawValue(targetId)`, and subscribes with `subscribeDawValue`. Each incoming
target value `raw` is mapped to a percentage with
`scaleFromTarget(raw, getDawTarget(targetId))` and then onto the param's own
range: `min + (pct / 100) * (max - min)`, pushed into the iframe as a
`setParams` for that one key.

**WRITE (iframe → theDAW).** When the iframe posts `paramChanged` with a numeric
value and a matching `paramBinding` exists, the host computes the percentage from
the param's range — `pct = (value - min) / (max - min) * 100` — and calls
`setDawTarget(targetId, scaleToTarget(pct, getDawTarget(targetId)))`.

`setDawTarget` dispatches to the local `vst:` write handler first (for built-in
LFOs / macros / transport) and then forwards the same `control-set` frame on the
bus. The bus itself is a WebSocket controller peer that connects to theDAW's XR
relay at `ws(s)://<hostname>:8600/api/xr/control/ws`, mirroring theDAW's
`frontend/src/state/xrControlClient.ts` wire contract. See
[thedaw-integration.md](thedaw-integration.md) for the manifest/listen-value
architecture and the built-in `vst:` bind catalog.

> The Foundry sidecar serves this app on port **5472**; theDAW's backend (which
> owns the XR relay and the bindable-target manifest) runs on **8600**. If no
> theDAW host is present the bus simply keeps trying to reconnect every 2000ms —
> unbound custom code and preview `vst:` binds still work.

## Export parity

CustomCode is a first-class citizen of both export formats.

- **VST3 data bundle** (`src/lib/vst3Export.ts`). CustomCode is handled *before*
  the `SKIP_TYPES` gate: each **numeric** param becomes a host-automatable
  continuous VST3 param with id `<element-slug>-<param-slug>` (matching the id
  the exported UI computes), a `min`/`max` from the param (with `max === min`
  bumped to `min + 1`), and a MIDI CC from the shared pool. A `paramBinding`'s
  target id is emitted as an informational `binding.dawTargetId` (any bound
  theDAW target, not only `vst:` ids). The standalone renderer (`vst3ExportUi.ts`) reproduces
  the bidirectional per-param bind exactly as the in-app frame does. See
  [vst3-export.md](vst3-export.md).
- **`.gan` package** (`src/lib/ganExport.ts`). The `.gan` `index.html` swaps the
  native bridge script for an inline GAN bridge; the full editable project
  (including `customModules`) is embedded for a lossless round-trip. See
  [gan-format.md](gan-format.md).

## Diagnostics

Runtime errors from the sandbox are captured centrally in `customCodeBridge.ts`.

- `customCodeDiagnostics` is a `Map<elementId, CustomCodeDiagnostic[]>`, capped
  at 20 entries per element (`MAX_DIAGNOSTICS_PER_ELEMENT`, oldest dropped) so a
  spinning error loop cannot grow it without bound.
- `pushCustomCodeDiagnostic(elementId, diag)` is called by `CustomCodeFrame` on
  every `foundry:error`; a `CustomCodeDiagnostic` is `{ message, stack?, ts }`
  where `ts` is a `Date.now()` stamp.
- `clearCustomCodeDiagnostics(elementId)` empties one element's list.
- The map is **not reactive** — the assistant's `getCustomCode` tool reads it on
  demand (the former `CustomCodePanel` polled it on a 1s interval, but that panel
  is deprecated). See [assistant-and-mcp.md](assistant-and-mcp.md).

## Security notes

> **The sandbox is `allow-scripts` only.** No `allow-same-origin`, so the frame
> is an opaque origin that cannot touch the host DOM, storage, or cookies. Treat
> all iframe → host messages as untrusted: the host validates `e.source`,
> ignores non-object data, and runs every registered schema through
> `sanitizeCustomParams`.

> **Injection hardening.** `buildBridgeDoc` embeds the initial params as JSON
> escaped by `escapeScriptJson`, which turns `<` into `\u003c` and escapes the
> U+2028/U+2029 line separators (illegal in JS string literals) — so a param
> value containing `</script>` can never break out of the seed `<script>` or
> inject markup. The same escaping is mirrored in `vst3Export`'s
> `serializeForJs`.

## What the tests lock in

Two Vitest suites pin the subsystem's contract.

`src/lib/customParams.test.ts` (and the shared-bridge checks in it):

| Test area | Guarantee |
|---|---|
| `sanitizeCustomParams` | Non-array → `[]`; illegal key chars stripped and keyless entries dropped; duplicate keys deduped (first wins); number values coerced and clamped to `min`/`max`; `toggle` values parsed explicitly — the strings `"false"`/`"true"` map to the right boolean and the number `1` coerces truthy; `select` options filtered to strings and value falls back to the first option. |
| `mergeCustomParams` | Existing value survives a re-register; keys absent from the registered schema are pruned; new keys arrive with registered values in registered order; the registered type is adopted and the old value re-coerced; the preserved value is clamped into the new range; the existing stable `id` is kept; handles `undefined` existing and empty registered. |
| `escapeScriptJson` | `<` → `\u003c`; U+2028 → `\u2028`; U+2029 → `\u2029`. |
| `buildBridgeDoc` | Contains the seeded `window.PARAMS`, the bootstrap source, the `foundry:paramChanged` literal, and the injected theme/style CSS. A param value carrying `</script>` yields exactly two real closing `</script>` tags (the injected one is escaped). |
| `BRIDGE_BOOTSTRAP_SOURCE` | Is syntactically valid JS (`new Function(...)` does not throw). |
| `elementStyleTokens` | Maps set fields (`--el-base-color`, `--el-opacity` = `opacity/100`) and omits undefined ones. |

`src/lib/dawControlBus.customcode.test.ts`:

| Test area | Guarantee |
|---|---|
| `customCodeBindableParams` | Returns only the numeric params of a CustomCode element, in order; `[]` when there are no numeric params, no params at all, or the element is not CustomCode (even if it carries params). |
| `customCodeParamKinds` | Exactly `["knob", "fader"]`. |
| Kind-map regression | `bindableKindsFor("CustomCode")` and `listenKindsFor("CustomCode")` stay `null`; the native maps (`Knob`, `Toggle`, `Meter`) are unchanged — the per-param path must not disturb the element-level routing/listen UI. |

> Note: Foundry source is under active development by concurrent contributors.
> The behaviors above were read directly from the source files named throughout
> this doc; if a panel layout or picker looks different from what you see, trust
> the code and the tests over this description, and cross-check against
> [troubleshooting.md](troubleshooting.md).
