// Load a `.gan` back into an editable Foundry project.
//
// A `.gan` written by this app (ganExport.ts) embeds the full editable project
// at source/foundry-project.json — reading it back gives a lossless round-trip
// (every element, texture, custom module preserved). theDAW's backend importer
// embeds the same file, so plugins that went project.json -> .gan round-trip
// too — with two gaps the archive itself closes. A Foundry EXPORT keeps its
// artwork in a file BESIDE project.json, so the embedded project reports no
// background while the .gan carries the artwork as its own entry; the embedded
// path reads it back out. And an export names Image elements it carries no
// pixels for; those would reopen as drawn boxes over the artwork that already
// shows them, so they are left out and reported.
//
// A `.gan` with no embedded project (an older bundle, a hand-made one, a third
// party) is RECONSTRUCTED from what theDAW's runtime wrote. Its index.html IS
// the authored layout: every element is a wrapper `div.gan-el` absolutely
// positioned in percentages of the canvas over a stage whose background is the
// artwork, with the element itself inside — an `iframe.gan-frame` carrying the
// author's own markup, or a native `div.gan-knob`. So every control returns as
// what it was, at its real box, on its real artwork. The manifest's controls
// only fill in names, and place on a grid whatever the runtime did not draw.
// Only a .gan with no readable index.html falls to the grid entirely.

import JSZip from "jszip";
import { UIElement, CanvasState } from "../types";
import { GAN_COMMENT, GanProjectSource } from "./ganExport";
import { GanManifest } from "./ganManifest";

export type GanSourceKind = "embedded" | "reconstructed";

export interface GanImportResult {
  manifest: GanManifest;
  project: GanProjectSource;
  sourceKind: GanSourceKind;
  // Whether the archive carried the "GANv1" comment (some tools strip it; the
  // presence of a valid manifest.json is the authoritative validity check).
  hadGanComment: boolean;
  // Image elements the project named but carried no pixels for, by name. Left
  // out of the canvas rather than drawn as empty boxes over the artwork.
  omittedImages: string[];
}

function defaultCanvas(width: number, height: number): CanvasState {
  return {
    backgroundImage: null,
    width: width || 800,
    height: height || 600,
    scale: 1,
    panX: 0,
    panY: 0,
    showRulers: true,
  };
}

function normalizeProject(
  parsed: unknown,
  manifest: GanManifest,
): GanProjectSource {
  const p = (parsed ?? {}) as Partial<GanProjectSource>;
  return {
    version: 1,
    elements: Array.isArray(p.elements) ? p.elements : [],
    canvasState:
      p.canvasState ??
      defaultCanvas(
        Number(manifest?.canvas?.width) || 800,
        Number(manifest?.canvas?.height) || 600,
      ),
    assets: Array.isArray(p.assets) ? p.assets : [],
    textures: Array.isArray(p.textures) ? p.textures : [],
    customModules: Array.isArray(p.customModules) ? p.customModules : [],
  };
}

// ---- What index.html knows that the manifest does not ------------------------

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PlacementKind = "custom" | "knob";

/** One element as the runtime drew it: its box, what it is, and what the
 *  runtime rendered it with. */
export interface Placement extends FrameRect {
  kind: PlacementKind;
  /** The runtime's own title for the element, when it wrote one. */
  name?: string;
  /** Degrees, 0..360 as Foundry stores them. Absent when unrotated. */
  rotation?: number;
  /** Knob: the value and colours the runtime rendered. */
  value?: number;
  glowColor?: string;
  activeColor?: string;
}

// The runtime lays every element out as a positioned wrapper with the element
// inside it. Wrappers are siblings under #gan-canvas, never nested, so the text
// from one wrapper tag to the next is that element's whole markup:
//   <div class="gan-el" style="position:absolute;left:%;top:%;width:%;height:%;">
//     <iframe class="gan-frame" data-src="el_<id>.html" title="<name>" …>   custom markup
//   <div class="gan-el gan-knob-wrap" style="…">
//     <div class="gan-knob" id="gan-knob-<id>" aria-valuenow="…" style="--gan-glow:…;--gan-active:…">
//   <div class="gan-el gan-image" style="…" title="…"></div>                   no element behind it
const WRAPPER_TAG = /<div\b[^>]*\sclass="gan-el(?:\s[^"]*)?"[^>]*>/g;
const FRAME_TAG = /<iframe\b[^>]*\sclass="[^"]*\bgan-frame\b[^"]*"[^>]*>/;
const KNOB_TAG = /<div\b[^>]*\sclass="gan-knob"[^>]*>/;

// One literal pattern for every `name="value"` pair in a tag; callers pick the
// attribute by name from the matches, so no RegExp is ever built from a string.
const ATTR_PAIR = /(?:^|\s)([A-Za-z_:][-\w:.]*)="([^"]*)"/g;

const attr = (tag: string, name: string): string | null => {
  for (const m of tag.matchAll(ATTR_PAIR)) if (m[1] === name) return m[2];
  return null;
};

// One CSS length out of a style declaration, in canvas pixels. The runtime
// writes percentages so the layout survives resizing; px is accepted too.
// Every `prop: <number>(%|px)` declaration in a style string, matched by name.
const LENGTH_DECL = /(?:^|;)\s*([-\w]+)\s*:\s*(-?[\d.]+)(%|px)/g;

function lengthPx(decl: string, prop: string, span: number): number | null {
  for (const m of decl.matchAll(LENGTH_DECL)) {
    if (m[1] !== prop) continue;
    const v = parseFloat(m[2]);
    if (!Number.isFinite(v)) return null;
    return m[3] === "%" ? (v / 100) * span : v;
  }
  return null;
}

function boxFromStyle(decl: string, canvasW: number, canvasH: number): FrameRect | null {
  const x = lengthPx(decl, "left", canvasW);
  const y = lengthPx(decl, "top", canvasH);
  const width = lengthPx(decl, "width", canvasW);
  const height = lengthPx(decl, "height", canvasH);
  if (x === null || y === null || width === null || height === null) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

// The runtime writes rotation as a signed transform (357 -> -3deg); Foundry
// stores 0..360.
function rotationFromStyle(decl: string): number | undefined {
  const m = /(?:^|;)\s*transform\s*:\s*rotate\((-?[\d.]+)deg\)/.exec(decl);
  if (!m) return undefined;
  const deg = ((parseFloat(m[1]) % 360) + 360) % 360;
  return Math.abs(deg) < 0.005 ? undefined : Math.round(deg * 100) / 100;
}

// Every `--name: value` custom property in a style string, matched by name.
const CSS_VAR_DECL = /(?:^|;)\s*(--[-\w]+)\s*:\s*([^;"]+)/g;

const cssVar = (decl: string, name: string): string | undefined => {
  for (const m of decl.matchAll(CSS_VAR_DECL)) if (m[1] === name) return m[2].trim() || undefined;
  return undefined;
};

/** Element id -> placement for every element the runtime index.html draws, in
 *  stage order (which is z-order). Placeholders with no element behind them and
 *  wrappers without a full box are skipped. */
export function placementsFromIndexHtml(
  html: string,
  canvasW: number,
  canvasH: number,
): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const wrappers = [...html.matchAll(WRAPPER_TAG)];
  wrappers.forEach((m, i) => {
    const tag = m[0];
    const start = (m.index ?? 0) + tag.length;
    const end = i + 1 < wrappers.length ? (wrappers[i + 1].index ?? html.length) : html.length;
    const inner = html.slice(start, end);
    const style = attr(tag, "style") ?? "";
    const box = boxFromStyle(style, canvasW, canvasH);
    if (!box) return;
    const rotation = rotationFromStyle(style);

    const frame = FRAME_TAG.exec(inner)?.[0];
    const customId = frame ? /^el_(.+)\.html$/.exec(attr(frame, "data-src") ?? "")?.[1] : undefined;
    if (frame && customId) {
      out.set(customId, { ...box, kind: "custom", name: attr(frame, "title") ?? undefined, rotation });
      return;
    }
    const knob = KNOB_TAG.exec(inner)?.[0];
    const knobId = knob ? /^gan-knob-(.+)$/.exec(attr(knob, "id") ?? "")?.[1] : undefined;
    if (knob && knobId) {
      const knobStyle = attr(knob, "style") ?? "";
      const value = parseFloat(attr(knob, "aria-valuenow") ?? "");
      out.set(knobId, {
        ...box,
        kind: "knob",
        rotation,
        value: Number.isFinite(value) ? value : undefined,
        glowColor: cssVar(knobStyle, "--gan-glow"),
        activeColor: cssVar(knobStyle, "--gan-active"),
      });
    }
  });
  return out;
}

/** The stage artwork's file name, from the first `background: url(...)`. */
export function backgroundNameFromIndexHtml(html: string): string | null {
  const m = /background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+?)["']?\s*\)/.exec(html);
  return m ? m[1].trim() : null;
}

/** An element's own markup, without the runtime wrapper document around it. */
export function innerMarkup(doc: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(doc);
  return (m ? m[1] : doc).trim();
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/** The in-archive name of the runtime's entry document. */
function entryName(manifest: GanManifest): string {
  return String((manifest as { entry_html?: string })?.entry_html || "index.html");
}

/** The stage artwork as a data URI, read out of the archive itself: the file the
 *  runtime index.html paints on the stage, else the conventional background.png.
 *  Null when the archive carries no artwork. */
async function artworkFromArchive(
  zip: JSZip,
  html: string | null,
): Promise<string | null> {
  const name = (html ? backgroundNameFromIndexHtml(html) : null) ?? "background.png";
  const file = zip.file(name);
  if (!file) return null;
  const ext = name.split(".").pop()?.toLowerCase() ?? "png";
  return `data:${MIME[ext] ?? "image/png"};base64,${await file.async("base64")}`;
}

// An Image element whose asset is not in the project has nothing to show. The
// canvas would draw it as a control-shaped box — for a backend-built bundle a
// box over most of the artwork, which already shows what the image showed. Leave
// it out and say so, rather than hide it where it would still catch clicks.
function withoutGhostImages(
  project: GanProjectSource,
): { project: GanProjectSource; omitted: string[] } {
  const assetIds = new Set(project.assets.map((a) => a.id));
  const ghosts = project.elements.filter(
    (e) => e.type === "Image" && !assetIds.has(e.assetId ?? ""),
  );
  if (ghosts.length === 0) return { project, omitted: [] };
  const drop = new Set(ghosts.map((e) => e.id));
  return {
    project: { ...project, elements: project.elements.filter((e) => !drop.has(e.id)) },
    omitted: ghosts.map((e) => e.name || e.id),
  };
}

// The full reconstruction: every element the runtime drew, as what it drew, at
// its authored box, on the artwork. Falls back to the grid when index.html is
// missing, so the result is never empty.
async function reconstructFromArchive(
  zip: JSZip,
  manifest: GanManifest,
): Promise<GanProjectSource> {
  const base = reconstructFromManifest(manifest);
  const indexFile = zip.file(entryName(manifest));
  if (!indexFile) return base;
  const html = await indexFile.async("string");
  // Artwork first: whatever else this index.html yields, a .gan that carries a
  // stage image must never reopen on a bare canvas.
  const withArt = {
    ...base,
    canvasState: {
      ...base.canvasState,
      backgroundImage: await artworkFromArchive(zip, html),
    },
  };
  const { width: w, height: h } = base.canvasState;
  const placed = placementsFromIndexHtml(html, w, h);
  if (placed.size === 0) return withArt;

  const controls = new Map(
    (Array.isArray(manifest?.controls) ? manifest.controls : []).map((c) => [c.id, c] as const),
  );
  const unplaced = new Map(base.elements.map((e) => [e.id, e] as const));
  const elements: UIElement[] = [];
  // Stage order is z-order; the Map keeps it.
  for (const [id, p] of placed) {
    const name = controls.get(id)?.name || p.name || id;
    const box = { x: p.x, y: p.y, width: p.width, height: p.height };
    const rotation = p.rotation === undefined ? {} : { rotation: p.rotation };
    if (p.kind === "custom") {
      const file = zip.file(`el_${id}.html`);
      elements.push({
        id,
        name,
        type: "CustomCode",
        ...box,
        ...rotation,
        customCode: innerMarkup(file ? await file.async("string") : ""),
        customCodeFit: "stretch",
        // The runtime renders every custom document on a transparent body.
        transparentBackground: true,
      });
    } else {
      elements.push({
        id,
        name,
        type: "Knob",
        ...box,
        ...rotation,
        value: p.value ?? 0,
        min: 0,
        max: 1,
        ...(p.glowColor ? { glowColor: p.glowColor } : {}),
        ...(p.activeColor ? { activeColor: p.activeColor } : {}),
      });
    }
    unplaced.delete(id);
  }
  // A control the runtime did not draw keeps its grid slot; nothing is lost.
  elements.push(...unplaced.values());
  return { ...withArt, elements };
}

// Last resort for a .gan with no readable index.html: one native control per
// manifest control, on a grid.
function reconstructFromManifest(manifest: GanManifest): GanProjectSource {
  const w = Number(manifest?.canvas?.width) || 800;
  const h = Number(manifest?.canvas?.height) || 600;
  const controls = Array.isArray(manifest?.controls) ? manifest.controls : [];
  const cols = Math.max(1, Math.floor(w / 160));
  const elements: UIElement[] = controls.map((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const type: UIElement["type"] =
      c.kind === "trigger"
        ? "Button"
        : c.kind === "xy" || c.kind === "xyz"
          ? "XYPad"
          : "Knob";
    return {
      id: c.id || `ctrl-${i}`,
      name: c.name || c.id || `Control ${i + 1}`,
      type,
      x: 24 + col * 160,
      y: 24 + row * 140,
      width: 96,
      height: 96,
      value: 0,
      min: 0,
      max: 1,
    };
  });
  return {
    version: 1,
    elements,
    canvasState: defaultCanvas(w, h),
    assets: [],
    textures: [],
    customModules: [],
  };
}

/**
 * Parse `.gan` bytes into an editable project. Throws only when the file is not
 * a readable `.gan` (missing/invalid manifest.json).
 */
export async function parseGan(
  data: ArrayBuffer | Uint8Array | Blob,
): Promise<GanImportResult> {
  let zip: JSZip;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    zip = await JSZip.loadAsync(data as any);
  } catch {
    throw new Error("Not a .gan file: could not read the ZIP archive.");
  }

  // JSZip exposes the archive comment at runtime, but @types/jszip omits it.
  const zipComment = (zip as unknown as { comment?: string }).comment || "";
  const hadGanComment = zipComment.trim() === GAN_COMMENT;

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    throw new Error("Not a .gan file: manifest.json is missing.");
  }
  let manifest: GanManifest;
  try {
    manifest = JSON.parse(await manifestFile.async("string")) as GanManifest;
  } catch {
    throw new Error("Invalid .gan: manifest.json is not valid JSON.");
  }

  const sourceFile = zip.file("source/foundry-project.json");
  if (sourceFile) {
    const text = await sourceFile.async("string");
    let embedded: GanProjectSource | null = null;
    try {
      embedded = normalizeProject(JSON.parse(text), manifest);
    } catch {
      // Corrupt embedded source — fall through to reconstruction.
    }
    if (embedded) {
      // A VST Foundry EXPORT keeps its artwork beside project.json as a separate
      // background.png, so its canvasState.backgroundImage is null. theDAW's
      // backend embeds that export byte-for-byte and bundles the artwork as its
      // own archive entry — so the project says "no background" while the .gan
      // plainly has one, and Ares reopened on a bare canvas. Take the artwork
      // from the archive. A Foundry-authored .gan already carries its own data
      // URI here and is left exactly as it was written.
      if (!embedded.canvasState.backgroundImage) {
        const html = (await zip.file(entryName(manifest))?.async("string")) ?? null;
        const artwork = await artworkFromArchive(zip, html);
        if (artwork) {
          embedded = {
            ...embedded,
            canvasState: { ...embedded.canvasState, backgroundImage: artwork },
          };
        }
      }
      const { project, omitted } = withoutGhostImages(embedded);
      return { manifest, project, sourceKind: "embedded", hadGanComment, omittedImages: omitted };
    }
  }

  const { project, omitted } = withoutGhostImages(await reconstructFromArchive(zip, manifest));
  return { manifest, project, sourceKind: "reconstructed", hadGanComment, omittedImages: omitted };
}
