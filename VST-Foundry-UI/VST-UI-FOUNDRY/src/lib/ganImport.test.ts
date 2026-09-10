// Reopening a .gan that has no embedded Foundry project.
//
// The runtime index.html is the layout the author built: every element is an
// absolutely positioned gan-frame in percentages of the canvas, over a stage
// whose background is the artwork. Reconstruction has to read that — the
// manifest alone carries no positions and no background, which is how a
// reopened plugin came back as knobs gridded into a corner on a bare canvas.

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  backgroundNameFromIndexHtml,
  innerMarkup,
  parseGan,
  placementsFromIndexHtml,
} from "./ganImport";

const frame = (id: string, style: string) =>
  `<iframe class="gan-frame" data-src="el_${id}.html" data-doc="&lt;!doctype html&gt;&lt;body style=&quot;x&quot;&gt;" style="${style}"></iframe>`;

describe("placementsFromIndexHtml", () => {
  it("turns the runtime's percentage boxes into canvas pixels, in stage order", () => {
    const html =
      frame("bg", "position:absolute;left:0%;top:0%;width:100%;height:100%;") +
      frame("k1", "position:absolute;left:10%;top:20%;width:30%;height:40%;");
    const placed = placementsFromIndexHtml(html, 1000, 500);
    expect([...placed.keys()]).toEqual(["bg", "k1"]);
    expect(placed.get("k1")).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    expect(placed.get("bg")).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });

  it("keeps an element the author parked off-canvas where they parked it", () => {
    const html = frame("side", "position:absolute;left:-35.8852%;top:21.254%;width:10.0478%;height:15.9405%;");
    expect(placementsFromIndexHtml(html, 1672, 941).get("side")).toEqual({
      x: -600,
      y: 200,
      width: 168,
      height: 150,
    });
  });

  it("accepts px, and skips a frame without a full box", () => {
    const html =
      frame("px", "position:absolute;left:12px;top:8px;width:96px;height:96px;") +
      frame("half", "position:absolute;left:5%;top:5%;");
    const placed = placementsFromIndexHtml(html, 800, 600);
    expect(placed.get("px")).toEqual({ x: 12, y: 8, width: 96, height: 96 });
    expect(placed.has("half")).toBe(false);
  });

  it("is not fooled by the escaped element document in data-doc", () => {
    // data-doc carries the whole element page HTML-escaped; its quotes are
    // entities, so it must never be read as the tag's own style attribute.
    const html = frame("k1", "left:50%;top:50%;width:10%;height:10%;");
    expect(placementsFromIndexHtml(html, 200, 200).get("k1")).toEqual({
      x: 100,
      y: 100,
      width: 20,
      height: 20,
    });
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

describe("parseGan on a .gan with no embedded project", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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
          { id: "go", name: "Go", kind: "trigger" },
        ],
      }),
    );
    if (withIndex) {
      zip.file(
        "index.html",
        "<style>#stage{background:url(background.png) 0 0/100% 100%}</style>" +
          frame("panel", "left:0%;top:0%;width:100%;height:100%;") +
          frame("cut", "left:10%;top:20%;width:30%;height:40%;") +
          frame("go", "left:50%;top:50%;width:10%;height:10%;"),
      );
      zip.file("el_panel.html", "<html><body><div class=\"panel\">art</div></body></html>");
      zip.file("background.png", PNG);
    }
    return zip.generateAsync({ type: "uint8array", comment: "GANv1" });
  }

  it("puts every control at its authored box, on its artwork, with decor as CustomCode", async () => {
    const { project, sourceKind } = await parseGan(await build(true));
    expect(sourceKind).toBe("reconstructed");
    const byId = new Map(project.elements.map((e) => [e.id, e]));
    expect(byId.get("cut")).toMatchObject({ type: "Knob", x: 100, y: 100, width: 300, height: 200 });
    expect(byId.get("go")).toMatchObject({ type: "Button", x: 500, y: 250, width: 100, height: 50 });
    expect(byId.get("panel")).toMatchObject({
      type: "CustomCode",
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      customCode: '<div class="panel">art</div>',
    });
    // Stage order is z-order: the panel was drawn first, so it sits under the controls.
    expect(project.elements.map((e) => e.id)).toEqual(["panel", "cut", "go"]);
    expect(project.canvasState.backgroundImage?.startsWith("data:image/png;base64,")).toBe(true);
    expect(project.canvasState.width).toBe(1000);
  });

  it("still never comes back empty when there is no index.html to read", async () => {
    const { project } = await parseGan(await build(false));
    expect(project.elements.map((e) => e.id)).toEqual(["cut", "go"]);
    expect(project.canvasState.backgroundImage).toBeNull();
    // The grid: the only thing left to do without a layout.
    expect(project.elements[0]).toMatchObject({ x: 24, y: 24 });
  });
});
