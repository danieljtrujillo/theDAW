// Reopening a .gan in the Foundry.
//
// theDAW's runtime lays every element out as a positioned wrapper `div.gan-el`
// with the element inside it — an `iframe.gan-frame` carrying the author's own
// markup, or a native `div.gan-knob`. Reconstruction has to read exactly that
// shape: the manifest alone carries no positions and no types beyond "value",
// which is how a reopened bundle came back as knobs gridded into a corner on a
// bare canvas — and how fifteen drum pads came back as fifteen knobs.

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  backgroundNameFromIndexHtml,
  innerMarkup,
  parseGan,
  placementsFromIndexHtml,
} from "./ganImport";

// The wrappers exactly as backend/modules/plugin/owl_import.py writes them.
const custom = (id: string, name: string, style: string) =>
  `<div class="gan-el" style="${style}"><iframe class="gan-frame" data-src="el_${id}.html" ` +
  `data-doc="&lt;!doctype html&gt;&lt;body style=&quot;background:transparent&quot;&gt;" ` +
  `title="${name}" scrolling="no"></iframe></div>`;
const knob = (id: string, style: string, value = 0.0, glow = "#525252", active = "#666666") =>
  `<div class="gan-el gan-knob-wrap" style="${style}"><div class="gan-knob" id="gan-knob-${id}" ` +
  `role="slider" aria-label="Knob ${id}" tabindex="0" aria-valuemin="0" aria-valuemax="1" ` +
  `aria-valuenow="${value}" style="--gan-glow:${glow};--gan-active:${active}">` +
  `<span class="gan-knob-ind"></span></div><script>(function(){var id='${id}';})();</script></div>`;
const image = (name: string, style: string) =>
  `<div class="gan-el gan-image" style="${style}" title="${name}"></div>`;
const pct = (l: number, t: number, w: number, h: number, extra = "") =>
  `position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%;${extra}`;

describe("placementsFromIndexHtml", () => {
  it("reads each wrapper's percentage box into canvas pixels, in stage order", () => {
    const html =
      custom("panel", "Panel", pct(0, 0, 100, 100)) +
      knob("k1", pct(10, 20, 30, 40)) +
      custom("pad", "Pad", pct(50, 50, 10, 10));
    const placed = placementsFromIndexHtml(html, 1000, 500);
    expect([...placed.keys()]).toEqual(["panel", "k1", "pad"]);
    expect(placed.get("panel")).toMatchObject({ kind: "custom", name: "Panel", x: 0, y: 0, width: 1000, height: 500 });
    expect(placed.get("k1")).toMatchObject({ kind: "knob", x: 100, y: 100, width: 300, height: 200 });
    expect(placed.get("pad")).toMatchObject({ kind: "custom", x: 500, y: 250, width: 100, height: 50 });
  });

  it("recovers what the runtime rendered a knob with", () => {
    const placed = placementsFromIndexHtml(knob("cut", pct(1, 2, 3, 4), 0.35, "#ff0000", "#00ff00"), 100, 100);
    expect(placed.get("cut")).toMatchObject({ value: 0.35, glowColor: "#ff0000", activeColor: "#00ff00" });
  });

  it("turns the runtime's signed rotation back into Foundry's 0..360", () => {
    const html =
      custom("tilt", "Tilt", pct(0, 0, 10, 10, "transform:rotate(-3.00deg);")) +
      custom("flat", "Flat", pct(0, 0, 10, 10)) +
      custom("pos", "Pos", pct(0, 0, 10, 10, "mix-blend-mode:screen;transform:rotate(2.00deg);"));
    const placed = placementsFromIndexHtml(html, 100, 100);
    expect(placed.get("tilt")?.rotation).toBe(357);
    expect(placed.get("flat")?.rotation).toBeUndefined();
    expect(placed.get("pos")?.rotation).toBe(2);
  });

  it("keeps an element the author parked off-canvas where they parked it", () => {
    const html = custom("side", "Side", pct(-35.8852, 21.254, 10.0478, 15.9405));
    expect(placementsFromIndexHtml(html, 1672, 941).get("side")).toMatchObject({
      x: -600,
      y: 200,
      width: 168,
      height: 150,
    });
  });

  it("skips placeholders with no element behind them, and wrappers without a full box", () => {
    const html =
      image("image_16", pct(15, 4, 73, 95)) +
      custom("half", "Half", "position:absolute;left:5%;top:5%;") +
      knob("ok", "position:absolute;left:12px;top:8px;width:96px;height:96px;");
    const placed = placementsFromIndexHtml(html, 800, 600);
    expect([...placed.keys()]).toEqual(["ok"]);
    expect(placed.get("ok")).toMatchObject({ x: 12, y: 8, width: 96, height: 96 });
  });

  it("is not fooled by the escaped element document in data-doc", () => {
    // data-doc carries the whole element page HTML-escaped; its quotes are
    // entities, so it must never be read as the wrapper's own style.
    const placed = placementsFromIndexHtml(custom("k1", "K", pct(50, 50, 10, 10)), 200, 200);
    expect(placed.get("k1")).toMatchObject({ x: 100, y: 100, width: 20, height: 20 });
  });
});

describe("backgroundNameFromIndexHtml", () => {
  it("finds the stage artwork and ignores plain colours", () => {
    const html =
      "<style>body{background:#07080c}#stage{background:url(background.png) 0 0/100% 100% no-repeat}.gan-frame{background:transparent}</style>";
    expect(backgroundNameFromIndexHtml(html)).toBe("background.png");
  });
  it("handles a quoted url and reports nothing when there is no artwork", () => {
    expect(backgroundNameFromIndexHtml(`background-image: url("art.webp")`)).toBe("art.webp");
    expect(backgroundNameFromIndexHtml("body{background:#000}")).toBeNull();
  });
});

describe("innerMarkup", () => {
  it("drops the runtime wrapper and keeps the element's own markup", () => {
    const doc = "<!doctype html><html><head><script>bus()</script></head><body>\n<div class=\"panel\">hi</div>\n</body></html>";
    expect(innerMarkup(doc)).toBe('<div class="panel">hi</div>');
    expect(innerMarkup("<b>bare</b>")).toBe("<b>bare</b>");
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("parseGan on a .gan with no embedded project", () => {
  // The Owl as it shipped: a native knob and custom drum pads, every one of
  // them a manifest control of kind "value" — the manifest cannot tell a pad
  // from a knob. The runtime markup can.
  async function build(withIndex: boolean): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        format: "gan",
        format_version: 1,
        id: "t",
        name: "T",
        kind: "controller",
        entry_html: "index.html",
        canvas: { width: 1000, height: 500 },
        controls: [
          { id: "cut", name: "Cutoff", kind: "value" },
          { id: "pad", name: "Drum Pad", kind: "value" },
          { id: "ghost", name: "Never Drawn", kind: "value" },
        ],
      }),
    );
    if (withIndex) {
      zip.file(
        "index.html",
        "<style>#gan-canvas{background:url(background.png) 0 0/100% 100%}</style>" +
          '<div id="gan-stage"><div id="gan-canvas">' +
          custom("panel", "decor_panel", pct(0, 0, 100, 100)) +
          knob("cut", pct(10, 20, 30, 40, "transform:rotate(-3.00deg);"), 0.25, "#111111", "#222222") +
          custom("pad", "Drum Pad", pct(50, 50, 10, 10)) +
          image("image_16", pct(15, 4, 73, 95)) +
          "</div></div>",
      );
      zip.file("el_panel.html", "<html><body><div class=\"panel\">art</div></body></html>");
      zip.file("el_pad.html", "<!doctype html><html><head><style>html{background:transparent}</style></head><body><button>hit</button></body></html>");
      zip.file("background.png", PNG);
    }
    return zip.generateAsync({ type: "uint8array", comment: "GANv1" });
  }

  it("returns every element as what the runtime drew, at its box, on its artwork", async () => {
    const { project, sourceKind, omittedImages } = await parseGan(await build(true));
    expect(sourceKind).toBe("reconstructed");
    const byId = new Map(project.elements.map((e) => [e.id, e]));
    // A control that is custom markup comes back as CustomCode, not a knob.
    expect(byId.get("pad")).toMatchObject({
      type: "CustomCode",
      name: "Drum Pad",
      x: 500,
      y: 250,
      width: 100,
      height: 50,
      customCode: "<button>hit</button>",
      transparentBackground: true,
    });
    // A native knob comes back as a knob, with what it was rendered with.
    expect(byId.get("cut")).toMatchObject({
      type: "Knob",
      name: "Cutoff",
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      rotation: 357,
      value: 0.25,
      glowColor: "#111111",
      activeColor: "#222222",
    });
    // Decor the manifest never listed returns as editable markup.
    expect(byId.get("panel")).toMatchObject({
      type: "CustomCode",
      name: "decor_panel",
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      customCode: '<div class="panel">art</div>',
    });
    // A control the runtime never drew keeps its grid slot (third control ->
    // third column) rather than vanishing.
    expect(byId.get("ghost")).toMatchObject({ type: "Knob", x: 24 + 2 * 160, y: 24 });
    // Stage order is z-order; the undrawn control goes on top.
    expect(project.elements.map((e) => e.id)).toEqual(["panel", "cut", "pad", "ghost"]);
    // The image placeholder had no element behind it — and no Image element
    // was invented for it, so there is nothing to report either.
    expect(omittedImages).toEqual([]);
    expect(project.canvasState.backgroundImage?.startsWith("data:image/png;base64,")).toBe(true);
    expect(project.canvasState.width).toBe(1000);
  });

  it("keeps the artwork even when the layout is unreadable", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ id: "t", name: "T", canvas: { width: 1000, height: 500 }, controls: [{ id: "cut", name: "Cutoff", kind: "value" }] }));
    zip.file(
      "index.html",
      "<style>#gan-canvas{background:url(background.png) 0 0/100% 100% no-repeat}</style>" +
        '<div class="gan-el" style="position:absolute;left:48%;top:74%;">' +
        '<iframe class="gan-frame" data-src="el_cut.html"></iframe></div>',
    );
    zip.file("background.png", PNG);
    const { project } = await parseGan(await zip.generateAsync({ type: "uint8array" }));
    expect(project.canvasState.backgroundImage?.startsWith("data:image/png;base64,")).toBe(true);
    // The grid, because nothing readable said otherwise.
    expect(project.elements[0]).toMatchObject({ id: "cut", x: 24, y: 24 });
  });

  it("still never comes back empty when there is no index.html to read", async () => {
    const { project } = await parseGan(await build(false));
    expect(project.elements.map((e) => e.id)).toEqual(["cut", "pad", "ghost"]);
    expect(project.canvasState.backgroundImage).toBeNull();
    // The grid: the only thing left to do without a layout.
    expect(project.elements[0]).toMatchObject({ x: 24, y: 24 });
  });
});

describe("parseGan on a .gan with an embedded project", () => {
  // theDAW's backend embeds a VST Foundry export byte-for-byte. An export keeps
  // its artwork in a file beside project.json (so backgroundImage is null while
  // the archive carries background.png), and names Image elements it has no
  // pixels for (assets: []). Ares is exactly this: the layout came back, the
  // artwork did not, and a 1223x894 empty box sat over the art.
  const canvasState = {
    backgroundImage: null,
    width: 1672,
    height: 941,
    scale: 1,
    panX: 0,
    panY: 0,
    showRulers: true,
  };
  const knobEl = { id: "k1", name: "Cutoff", type: "Knob", x: 240, y: 110, width: 96, height: 96 };
  const imageEl = { id: "1ow4zt9", name: "image_16", type: "Image", x: 250, y: 39, width: 1223, height: 894, assetId: "a68xzr3" };

  async function build(opts: {
    background?: string | null;
    artworkName?: string;
    withArtwork?: boolean;
    elements?: unknown[];
    assets?: unknown[];
  }): Promise<Uint8Array> {
    const zip = new JSZip();
    const art = opts.artworkName ?? "background.png";
    zip.file(
      "manifest.json",
      JSON.stringify({ id: "ares", name: "Ares", entry_html: "index.html", canvas: { width: 1672, height: 941 } }),
    );
    zip.file("index.html", `<style>#stage{background:url(${art}) 0 0/100% 100%}</style>`);
    if (opts.withArtwork !== false) zip.file(art, PNG);
    zip.file(
      "source/foundry-project.json",
      JSON.stringify({
        version: 1,
        elements: opts.elements ?? [knobEl],
        canvasState: { ...canvasState, backgroundImage: opts.background ?? null },
        assets: opts.assets ?? [],
        textures: [],
      }),
    );
    return zip.generateAsync({ type: "uint8array", comment: "GANv1" });
  }

  it("reopens on the archive's artwork, keeping the authored layout", async () => {
    const { project, sourceKind } = await parseGan(await build({}));
    expect(sourceKind).toBe("embedded");
    expect(project.elements).toEqual([knobEl]);
    expect(project.canvasState.backgroundImage?.startsWith("data:image/png;base64,")).toBe(true);
    expect(project.canvasState.width).toBe(1672);
  });

  it("takes the artwork index.html actually paints, not the conventional name", async () => {
    const { project } = await parseGan(await build({ artworkName: "art.webp" }));
    expect(project.canvasState.backgroundImage?.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("leaves a project that brought its own artwork exactly as it was written", async () => {
    const own = "data:image/png;base64,AAAA";
    const { project } = await parseGan(await build({ background: own }));
    expect(project.canvasState.backgroundImage).toBe(own);
  });

  it("stays on the embedded project when the archive has no artwork at all", async () => {
    const { project, sourceKind } = await parseGan(await build({ withArtwork: false }));
    expect(sourceKind).toBe("embedded");
    expect(project.canvasState.backgroundImage).toBeNull();
    expect(project.elements).toHaveLength(1);
  });

  it("leaves out an Image the project has no pixels for, and says which", async () => {
    const { project, omittedImages } = await parseGan(await build({ elements: [imageEl, knobEl] }));
    expect(project.elements).toEqual([knobEl]);
    expect(omittedImages).toEqual(["image_16"]);
  });

  it("keeps an Image whose asset travelled with the project", async () => {
    const asset = { id: "a68xzr3", name: "art", url: "data:image/png;base64,AAAA" };
    const { project, omittedImages } = await parseGan(await build({ elements: [imageEl, knobEl], assets: [asset] }));
    expect(project.elements).toEqual([imageEl, knobEl]);
    expect(project.assets).toEqual([asset]);
    expect(omittedImages).toEqual([]);
  });
});
