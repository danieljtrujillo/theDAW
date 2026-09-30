import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePowerModeSession, preparePowerMode } from "./prepare.ts";

const synthetic = {
  elements: [{ id: "control", name: "Control", type: "CustomCode", x: 0, y: 0, width: 20, height: 20,
    assetId: "used", textureId: "skin", customCode: '<img src="/textures/face.png">' }],
  canvasState: { width: 100, height: 100, scale: 1, panX: 0, panY: 0, backgroundImage: "/textures/face.png" },
  assets: [{ id: "used", name: "Used", url: "/textures/face.png" }, { id: "unused", name: "Unused", url: "/textures/private.png" }],
  textures: [{ id: "skin", name: "Skin", url: "/textures/face.png" }],
  customModules: [{ type: "CustomCode", variant: "control", label: "Control", defaultWidth: 20, defaultHeight: 20,
    customCode: '<img src="/textures/face.png">' }],
  extra: { preserved: true },
};

test("preparation prunes unused resources and inlines referenced URLs throughout the design without mutation", () => {
  const session = parsePowerModeSession(JSON.stringify(synthetic));
  const reads: string[] = [];
  const prepared = preparePowerMode(session, filename => { reads.push(filename); return new Uint8Array([1, 2, 3]); });
  const image = "data:image/png;base64,AQID";
  assert.deepEqual(reads, ["face.png"]);
  assert.equal(prepared.project.assets.length, 1);
  assert.equal(prepared.project.canvasState.backgroundImage, image);
  assert.equal(prepared.project.elements[0].customCode, `<img src="${image}">`);
  assert.equal(prepared.project.customModules[0].customCode, `<img src="${image}">`);
  assert.equal(prepared.project.textures[0].url, image);
  assert.equal(prepared.inlinedTextures, 1);
  assert.deepEqual(session, synthetic);
});

test("missing resources are reported once without silently dropping their URLs", () => {
  const prepared = preparePowerMode(parsePowerModeSession(JSON.stringify(synthetic)), () => undefined);
  assert.deepEqual(prepared.missingTextures, ["face.png"]);
  assert.equal(prepared.project.assets[0].url, "/textures/face.png");
});

test("invalid source input fails with actionable schema errors", () => {
  for (const value of [null, {}, { elements: [], canvasState: { width: -1, height: 100 } },
    { ...synthetic, elements: [null] }, { ...synthetic, assets: {} }]) {
    assert.throws(() => parsePowerModeSession(JSON.stringify(value)), /POWER MODE source/);
  }
});
