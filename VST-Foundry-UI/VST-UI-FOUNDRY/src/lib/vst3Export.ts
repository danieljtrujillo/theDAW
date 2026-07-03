// Feature B (part 1): emit a downloadable VST3 DATA BUNDLE from a Foundry design.
//
// A Foundry-exported plugin is a prebuilt native iPlug2 "shell" that reads a
// per-export data bundle from its VST3 Resources dir. This module produces that
// bundle:
//   - manifest.json  plugin identity + host-visible parameter definitions
//   - ui/index.html  self-contained interactive UI (no external requests)
//   - ui/params.js   the serialized design read by index.html
//   - README.txt     install instructions
//
// Nothing here compiles a binary; it packages the data half of the plugin.

import JSZip from "jszip";
import { saveAs } from "file-saver";
import {
  UIElement,
  CanvasState,
  Asset,
  Texture,
  ElementType,
} from "../types";
import { buildIndexHtml } from "./vst3ExportUi";
import { routesOf } from "./routing";
import { isVstBindId } from "./vstBinds";
import type { RouteCurve } from "../types";

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

export type Vst3ParamKind = "continuous" | "boolean" | "trigger" | "enum";

export interface Vst3ParamBinding {
  // Informational for now: the theDAW target this control routes to in the
  // designer — the first daw-destination route matching this param's axis
  // (routing stack, see src/lib/routing.ts). The native shell may ignore it.
  dawTargetId: string;
}

export interface Vst3Param {
  id: string; // stable slug (matches the id the standalone UI computes)
  elementId: string; // source UIElement.id
  name: string;
  kind: Vst3ParamKind;
  min?: number;
  max?: number;
  default?: number | boolean;
  options?: string[];
  cc: number; // assigned MIDI CC number, or -1 when the CC pool is exhausted
  binding?: Vst3ParamBinding;
}

/**
 * One built-in VST bind (`vst:` catalog id, see src/lib/vstBinds.ts) carried
 * into the export so the native shell can HONOR it:
 *
 *   mode "route"  — when the named param changes (UI or host automation), the
 *                   shell shapes the normalized value through amount → curve →
 *                   range (same math as src/lib/routing.ts applyRoute) and
 *                   performs the action: MIDI CC / note / pitch bend /
 *                   aftertouch / program change, plugin out-gain / pan, ….
 *   mode "listen" — the display element identified by elementId animates from
 *                   the target's live value; the shell pushes transport
 *                   (tempo / beat phase / playing) and its I/O metering via
 *                   window.__foundrySetBindValue(id, v0to100).
 *
 * Binds the shell does not implement are carried and ignored — never an
 * error (the catalog is deliberately wider than any single runtime).
 */
export interface Vst3BindingEntry {
  targetId: string; // vst: catalog id
  elementId: string; // source (route) or display (listen) UIElement.id
  /** Host param driving a route / mirroring a listened Meter. Omitted when
   * the element exports no param (e.g. Waveform listen). */
  paramId?: string;
  axis: "value" | "x" | "y";
  mode: "route" | "listen";
  amount: number; // -100..100 depth; negative inverts
  curve: RouteCurve;
  rangeMin: number; // 0..100 output clamp
  rangeMax: number;
}

export interface Vst3Manifest {
  formatVersion: 1;
  plugin: {
    name: string;
    width: number;
    height: number;
  };
  params: Vst3Param[];
  bindings: Vst3BindingEntry[];
}

export interface Vst3UiFiles {
  "ui/index.html": string;
  "ui/params.js": string;
}

// ---------------------------------------------------------------------------
// Slug: single source of truth, shared with the standalone UI.
//
// SLUGIFY_FN_SOURCE is the JS source injected into ui/index.html; slugify() is
// derived from that SAME source so the manifest and the exported UI compute
// byte-identical parameter ids. (The app has no `script-src` CSP directive, so
// `new Function` on this constant is permitted.)
// ---------------------------------------------------------------------------

export const SLUGIFY_FN_SOURCE = `function foundrySlugify(input) {
  var s = String(input == null ? "" : input).toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return s || "param";
}`;

const slugifyImpl = new Function(
  SLUGIFY_FN_SOURCE + "; return foundrySlugify;",
)() as (input: string) => string;

/** Turn a UIElement id into a stable, host-safe parameter id. */
export function slugify(input: string): string {
  return slugifyImpl(input);
}

// ---------------------------------------------------------------------------
// MIDI CC assignment
// ---------------------------------------------------------------------------

const MAX_PARAMS = 128;

// Ordered, deduped pool of MIDI CC numbers to hand out. Order follows the spec:
// 20..31 first, then 102..119, then fill upward from 64 (skipping any already
// taken) and STOPPING at 119. The 0..19 and 32..63 ranges are intentionally
// avoided (32..63 is the CC LSB / bank-select range). CC 120..127 are also
// excluded: those are MIDI Channel Mode messages (All Sound Off, Reset All
// Controllers, All Notes Off, etc.) — emitting them as parameter automation
// would silence/reset the channel. No two params ever share a CC.
const CC_POOL: number[] = (() => {
  const pool: number[] = [];
  const seen = new Set<number>();
  const add = (c: number) => {
    if (c >= 0 && c <= 127 && !seen.has(c)) {
      seen.add(c);
      pool.push(c);
    }
  };
  for (let c = 20; c <= 31; c++) add(c);
  for (let c = 102; c <= 119; c++) add(c);
  for (let c = 64; c <= 119; c++) add(c);
  return pool;
})();

// Types that never become host parameters.
const SKIP_TYPES: ReadonlySet<ElementType> = new Set<ElementType>([
  "Label",
  "Image",
  "Group",
  "CustomCode",
  "Waveform",
  // StepSequencer (multi-cell pattern) and Keyboard (note input) have no single
  // host-automatable scalar, so they are not exported as VST3 params.
  "StepSequencer",
  "Keyboard",
]);

/**
 * Coerce a styleParams value (number | string | boolean) to a finite number,
 * falling back to `fallback` when it isn't numeric. Used for Envelope stage
 * defaults which are stored in el.styleParams.
 */
function spNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Routing-stack lookup for the informational per-param binding: the target id
 * of the FIRST daw-destination route on `el` whose source axis matches `axis`.
 * Uses routesOf() (which migrates legacy targetId/xTargetId/yTargetId on the
 * fly, and excludes Meter/Waveform listen sources). A route with no explicit
 * axis is treated as "value" (the default for single-value controls).
 */
function firstDawTargetForAxis(
  el: UIElement,
  axis: "value" | "x" | "y",
): string | undefined {
  const match = routesOf(el).find(
    (r) => r.dest === "daw" && (r.axis ?? "value") === axis,
  );
  return match?.targetId;
}

/**
 * The theDAW target bound to a CustomCode element's parameter `key`, if any
 * (see UIElement.paramBindings). Informational, mirroring firstDawTargetForAxis
 * for native controls; the native shell may ignore it.
 */
function customParamDawTarget(el: UIElement, key: string): string | undefined {
  return (el.paramBindings ?? []).find((b) => b.key === key)?.targetId;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Derive the host-visible parameter manifest from a design.
 *
 * Params are emitted in element order. XYPad/Spatial3D produce two params (X/Y);
 * Envelope produces four (Attack/Decay/Sustain/Release); WaveShaper produces one
 * (Drive). MIDI CCs are assigned sequentially from CC_POOL; if the pool is exhausted the
 * remaining params get cc = -1 (and a warning is logged). More than MAX_PARAMS
 * controls are dropped with a warning.
 */
export function buildVst3Manifest(
  elements: UIElement[],
  canvasState: CanvasState,
  pluginName: string,
): Vst3Manifest {
  const params: Vst3Param[] = [];
  let ccIndex = 0;
  let ccWarned = false;

  const nextCc = (): number => {
    if (ccIndex < CC_POOL.length) return CC_POOL[ccIndex++];
    if (!ccWarned) {
      // eslint-disable-next-line no-console
      console.warn(
        `[vst3Export] MIDI CC pool exhausted after ${CC_POOL.length} params; ` +
          `further params get cc = -1 (no CC mapping).`,
      );
      ccWarned = true;
    }
    ccIndex++;
    return -1;
  };

  let capWarned = false;
  const atCap = (): boolean => {
    if (params.length < MAX_PARAMS) return false;
    if (!capWarned) {
      // eslint-disable-next-line no-console
      console.warn(
        `[vst3Export] Parameter cap (${MAX_PARAMS}) reached; remaining controls skipped.`,
      );
      capWarned = true;
    }
    return true;
  };

  for (const el of elements) {
    // CustomCode is not a native control, but each NUMERIC CustomParam becomes a
    // host-automatable continuous param (id: <element-slug>-<param-slug>, matching
    // the id the exported UI computes). Handled BEFORE the SKIP_TYPES gate —
    // CustomCode is a member, so an element with no numeric params still yields
    // nothing (unchanged from prior behavior).
    if (el.type === "CustomCode") {
      const ccBaseId = slugify(el.id);
      for (const p of el.params ?? []) {
        if (p.type !== "number") continue;
        if (atCap()) break;
        const min = typeof p.min === "number" ? p.min : 0;
        let max = typeof p.max === "number" ? p.max : 100;
        if (max === min) max = min + 1;
        const ccParam: Vst3Param = {
          id: `${ccBaseId}-${slugify(p.key)}`,
          elementId: el.id,
          name: `${el.name} ${p.label || p.key}`,
          kind: "continuous",
          min,
          max,
          default: spNumber(p.default, spNumber(p.value, (min + max) / 2)),
          cc: nextCc(),
        };
        const ccTargetId = customParamDawTarget(el, p.key);
        if (ccTargetId) {
          ccParam.binding = { dawTargetId: ccTargetId };
        }
        params.push(ccParam);
      }
      continue;
    }

    if (SKIP_TYPES.has(el.type)) continue;
    if (atCap()) break;

    const baseId = slugify(el.id);

    switch (el.type) {
      case "Knob":
      case "Slider":
      case "Meter": {
        const min = el.min ?? 0;
        const max = el.max ?? 100;
        const param: Vst3Param = {
          id: baseId,
          elementId: el.id,
          name: el.name,
          kind: "continuous",
          min,
          max,
          default: el.value ?? (min + max) / 2,
          cc: nextCc(),
        };
        const dawTargetId = firstDawTargetForAxis(el, "value");
        if (dawTargetId) {
          param.binding = { dawTargetId };
        }
        params.push(param);
        break;
      }

      case "Toggle": {
        const param: Vst3Param = {
          id: baseId,
          elementId: el.id,
          name: el.name,
          kind: "boolean",
          default: false,
          cc: nextCc(),
        };
        const dawTargetId = firstDawTargetForAxis(el, "value");
        if (dawTargetId) {
          param.binding = { dawTargetId };
        }
        params.push(param);
        break;
      }

      case "Button": {
        const param: Vst3Param = {
          id: baseId,
          elementId: el.id,
          name: el.name,
          kind: "trigger",
          cc: nextCc(),
        };
        const dawTargetId = firstDawTargetForAxis(el, "value");
        if (dawTargetId) {
          param.binding = { dawTargetId };
        }
        params.push(param);
        break;
      }

      case "XYPad":
      case "Spatial3D": {
        const xParam: Vst3Param = {
          id: `${baseId}-x`,
          elementId: el.id,
          name: `${el.name} X`,
          kind: "continuous",
          min: 0,
          max: 100,
          default: el.valueX ?? 50,
          cc: nextCc(),
        };
        const xTargetId = firstDawTargetForAxis(el, "x");
        if (xTargetId) {
          xParam.binding = { dawTargetId: xTargetId };
        }
        params.push(xParam);

        const yParam: Vst3Param = {
          id: `${baseId}-y`,
          elementId: el.id,
          name: `${el.name} Y`,
          kind: "continuous",
          min: 0,
          max: 100,
          default: el.valueY ?? 50,
          cc: nextCc(),
        };
        const yTargetId = firstDawTargetForAxis(el, "y");
        if (yTargetId) {
          yParam.binding = { dawTargetId: yTargetId };
        }
        params.push(yParam);
        break;
      }

      case "Select": {
        // Enum params never map to a CC: the native shell does not emit CC for
        // discrete/enum selections, so pulling from the pool would waste a slot
        // (and starve continuous controls). Keep the `cc` field present as -1.
        const param: Vst3Param = {
          id: baseId,
          elementId: el.id,
          name: el.name,
          kind: "enum",
          options: el.options ?? [],
          cc: -1,
        };
        const dawTargetId = firstDawTargetForAxis(el, "value");
        if (dawTargetId) {
          param.binding = { dawTargetId };
        }
        params.push(param);
        break;
      }

      case "WaveShaper": {
        const param: Vst3Param = {
          id: baseId,
          elementId: el.id,
          name: `${el.name} Drive`,
          kind: "continuous",
          min: 0,
          max: 100,
          default: el.value ?? 50,
          cc: nextCc(),
        };
        const dawTargetId = firstDawTargetForAxis(el, "value");
        if (dawTargetId) {
          param.binding = { dawTargetId };
        }
        params.push(param);
        break;
      }

      case "Envelope": {
        // One continuous param per ADSR stage; defaults read from styleParams.
        const sp = el.styleParams ?? {};
        const stages: Array<[string, number]> = [
          ["Attack", spNumber(sp.attack, 15)],
          ["Decay", spNumber(sp.decay, 30)],
          ["Sustain", spNumber(sp.sustain, 70)],
          ["Release", spNumber(sp.release, 25)],
        ];
        for (const [stage, def] of stages) {
          params.push({
            id: `${baseId}-${stage.toLowerCase()}`,
            elementId: el.id,
            name: `${el.name} ${stage}`,
            kind: "continuous",
            min: 0,
            max: 100,
            default: def,
            cc: nextCc(),
          });
        }
        break;
      }

      default:
        // Any other type is not parameterizable.
        break;
    }
  }

  return {
    formatVersion: 1,
    plugin: {
      name: pluginName,
      width: canvasState.width,
      height: canvasState.height,
    },
    params,
    bindings: buildVst3Bindings(elements, params),
  };
}

/**
 * Collect every built-in (`vst:`) bind in the design as manifest entries the
 * native shell can honor (see Vst3BindingEntry). Route entries are emitted
 * only when their source param survived the cap (a dropped param can never
 * change, so its bind could never fire); listen entries always ship —
 * Waveform exports no param at all, yet its bound scope must animate.
 */
function buildVst3Bindings(
  elements: UIElement[],
  params: Vst3Param[],
): Vst3BindingEntry[] {
  const emitted = new Set(params.map((p) => p.id));
  const bindings: Vst3BindingEntry[] = [];

  for (const el of elements) {
    const baseId = slugify(el.id);

    // Routing-stack routes to vst: targets (all of them, not just the first —
    // one control may drive CC 74 AND a macro AND an LFO rate).
    for (const r of routesOf(el)) {
      if (r.dest !== "daw" || !isVstBindId(r.targetId)) continue;
      const axis = r.axis ?? "value";
      const paramId =
        el.type === "XYPad" || el.type === "Spatial3D"
          ? `${baseId}-${axis === "y" ? "y" : "x"}`
          : baseId;
      if (!emitted.has(paramId)) continue;
      bindings.push({
        targetId: r.targetId,
        elementId: el.id,
        paramId,
        axis,
        mode: "route",
        amount: r.amount ?? 100,
        curve: r.curve ?? "linear",
        rangeMin: r.rangeMin ?? 0,
        rangeMax: r.rangeMax ?? 100,
      });
    }

    // CustomCode per-param binds (bidirectional in the designer; exported as
    // an unshaped route — the param IS the value).
    if (el.type === "CustomCode") {
      for (const b of el.paramBindings ?? []) {
        if (!isVstBindId(b.targetId)) continue;
        const paramId = `${baseId}-${slugify(b.key)}`;
        if (!emitted.has(paramId)) continue;
        bindings.push({
          targetId: b.targetId,
          elementId: el.id,
          paramId,
          axis: "value",
          mode: "route",
          amount: 100,
          curve: "linear",
          rangeMin: 0,
          rangeMax: 100,
        });
      }
    }

    // Display LISTEN sources (Meter / Waveform binding.targetId).
    if (
      (el.type === "Meter" || el.type === "Waveform") &&
      isVstBindId(el.binding?.targetId)
    ) {
      bindings.push({
        targetId: el.binding!.targetId!,
        elementId: el.id,
        ...(emitted.has(baseId) ? { paramId: baseId } : {}),
        axis: "value",
        mode: "listen",
        amount: 100,
        curve: "linear",
        rangeMin: 0,
        rangeMax: 100,
      });
    }
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// Standalone UI
// ---------------------------------------------------------------------------

// Serialize a value for embedding in a <script>/JS file. Escapes `<` (so a
// string can never open a tag) and the U+2028/U+2029 line separators that are
// illegal inside JS string literals. Mirrors the hardening in CustomCodeFrame.
function serializeForJs(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(String.fromCharCode(0x2028)).join("\\" + "u2028")
    .split(String.fromCharCode(0x2029)).join("\\" + "u2029");
}

/**
 * Build the two standalone UI files. `index.html` is static (all design data
 * lives in `params.js` as window.FOUNDRY_DESIGN). Asset/texture urls that are
 * already `data:` URLs are inline and self-contained; `/textures/...` urls are
 * passed through untouched (see the note emitted into params.js).
 */
export function buildVst3Ui(
  elements: UIElement[],
  canvasState: CanvasState,
  assets: Asset[],
  textures: Texture[],
): Vst3UiFiles {
  const design = { elements, canvasState, assets, textures };
  const paramsJs = `/* Foundry VST3 bundle - serialized design data (auto-generated).
 * Loaded by index.html as window.FOUNDRY_DESIGN. Holds the exact elements,
 * canvas state, assets and textures from the Foundry project.
 *
 * SELF-CONTAINED NOTE: asset/texture "url" fields that begin with "data:" are
 * already inline. Fields beginning with "/textures/" point at server-side files
 * and are NOT inlined by this step - a later build stage must replace them with
 * data: URLs for the bundle to be fully offline. No network fetches happen here.
 */
window.FOUNDRY_DESIGN = ${serializeForJs(design)};
`;

  return {
    "ui/index.html": buildIndexHtml(SLUGIFY_FN_SOURCE),
    "ui/params.js": paramsJs,
  };
}

// ---------------------------------------------------------------------------
// Bundle assembly
// ---------------------------------------------------------------------------

function buildReadme(name: string, manifest: Vst3Manifest): string {
  return `Foundry VST3 Data Bundle
========================

Plugin: ${name}
Size:   ${manifest.plugin.width} x ${manifest.plugin.height}
Params: ${manifest.params.length}
Binds:  ${manifest.bindings.length} built-in VST bind(s) (MIDI / transport / plugin / macros / LFOs)

WHAT THIS IS
------------
This zip is the DATA half of a Foundry-exported VST3. It does NOT contain a
compiled plugin binary. It carries:

  manifest.json   Plugin identity + host-visible parameter definitions.
  ui/index.html   Self-contained interactive UI (no external requests).
  ui/params.js    The serialized design (elements + canvas) read by index.html.

HOW TO INSTALL
--------------
1. Obtain the prebuilt native shell "FoundryShell.vst3" (from the vst3-shell
   build - a separate artifact).
2. Copy the CONTENTS of this bundle (manifest.json and the ui/ folder) into:
       FoundryShell.vst3/Contents/Resources/
3. Rename the "FoundryShell.vst3" folder to your plugin name, e.g.
       ${name}.vst3
4. Install the .vst3 folder in your system VST3 directory and rescan in your DAW.

NOTES
-----
- ui/index.html talks to the native shell over a tiny JS bridge
  (window.foundryHost.setParam / window.foundryApplyParam).
- ui/index.html expects the shell's "foundry-bridge.js" to sit BESIDE it in
  Resources/ui/. The native shell ships that file; this bundle drops in next to
  it. index.html loads it via <script src="foundry-bridge.js"> before params.js,
  which is what defines window.foundryHost / SPVFD / __foundrySetParamMap inside
  the plugin WebView. In a plain browser (bundle preview) the script 404s
  harmlessly — the UI degrades to view-only.
- Any asset or texture that still uses a "/textures/..." URL must be inlined as a
  data: URL before the UI is fully offline (see the note in ui/params.js).
`;
}

/** Sanitize a plugin name into a safe zip file base name. */
function fileBaseName(pluginName: string): string {
  const slug = slugify(pluginName);
  return slug === "param" ? "foundry-plugin" : slug;
}

/**
 * Assemble the VST3 data bundle and trigger a browser download of the zip.
 * Mirrors the jszip + file-saver pattern used in useProjectPersistence.
 */
export async function exportVst3Bundle(
  elements: UIElement[],
  canvasState: CanvasState,
  assets: Asset[],
  textures: Texture[],
  pluginName: string,
): Promise<void> {
  const name = (pluginName || "").trim() || "Foundry Plugin";
  const manifest = buildVst3Manifest(elements, canvasState, name);
  const ui = buildVst3Ui(elements, canvasState, assets, textures);

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("ui/index.html", ui["ui/index.html"]);
  zip.file("ui/params.js", ui["ui/params.js"]);
  zip.file("README.txt", buildReadme(name, manifest));

  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, `${fileBaseName(name)}-vst3-bundle.zip`);
}
