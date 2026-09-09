/**
 * node:assert regression for the highway engine. Run from `frontend/`:
 *
 *   npx tsx src/components/layout/score/highway/HighwayScene.test.ts
 *
 * Uses the REAL three.js module (geometries, materials, sprites, textures all
 * work under node) with only `WebGLRenderer` swapped for a recorder, a fake
 * canvas that can dispatch context-loss events, and a hand-built glyph atlas
 * (no 2D canvas). The chart is the same kind of tiny synthetic
 * `gantasmo.notechart` schedule.test.ts uses.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { blankChartEvent, type ChartEvent, type ChartPart, type NoteChart } from '../../../../lib/notechart.ts';
import { computeCanvasBox } from '../../../../lib/canvasScale.ts';
import { NOTE_HIGHLIGHT_COLOR } from '../scoreShared.tsx';
import { usePlayAlongStore } from '../../../../state/playAlongStore.ts';
import {
  atlasSizeFor,
  cellsPerRow,
  FALLBACK_CODEPOINT,
  fitCell,
  isNoteGlyph,
  type GlyphAtlas,
  type GlyphRect,
} from './glyphAtlas.ts';
import {
  barWindow,
  BLOCK_BLUE,
  BLOCK_RED,
  CAMERA_FOV,
  CAMERA_POS,
  CAMERA_TARGET,
  cutRotation,
  HIT_RIBBON_HEIGHT,
  HIT_RIBBON_Y,
  HIT_WINDOW_SEC,
  HighwayScene,
  highwayWidth,
  itemPhase,
  PAST_FADE_SEC,
  PAST_Z_LIMIT,
  pastAlpha,
  pastSecFor,
  POOL_MAX,
  POOL_MIN,
  poolSizeFor,
} from './HighwayScene.ts';
import { BLOCK_PITCH, buildSchedule, DEFAULT_LAYOUT, DRUM_LANES, DRUM_PAD_SPACING, laneX, zForTime } from './schedule.ts';

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

assert.equal(atlasSizeFor(1, 96), 1024);
assert.equal(atlasSizeFor(100, 96), 1024); // 10 x 10 cells
assert.equal(atlasSizeFor(101, 96), 2048);
assert.equal(atlasSizeFor(21 * 21 + 1, 96), 4096);
assert.equal(atlasSizeFor(100000, 96), 4096); // capped: fitCell shrinks the cell
assert.equal(cellsPerRow(1024, 96), 10);
assert.equal(fitCell(50, 1024, 96), 96);
assert.ok(fitCell(3000, 4096, 96) < 96);
assert.ok(cellsPerRow(4096, fitCell(3000, 4096, 96)) ** 2 >= 3000);
assert.equal(FALLBACK_CODEPOINT, 0xe0a4);
assert.ok(isNoteGlyph(0xe0a4)); // noteheadBlack
assert.ok(isNoteGlyph(0xe1d5)); // noteQuarterUp
assert.ok(!isNoteGlyph(0xe4e5)); // restQuarter
assert.ok(!isNoteGlyph(0xe050)); // gClef

assert.equal(poolSizeFor(0, 0, 3), POOL_MIN);
assert.equal(poolSizeFor(10000, 100, 3), 450); // 100/s * 3 s * 1.5
assert.equal(poolSizeFor(100000, 10, 5), POOL_MAX);
assert.equal(poolSizeFor(10, 1, 2, 8, 128), 30);

assert.equal(cutRotation(0), 0);
assert.equal(cutRotation(1), Math.PI);
assert.equal(cutRotation(2), Math.PI / 2);
assert.equal(cutRotation(3), -Math.PI / 2);
assert.equal(cutRotation(4), Math.PI / 4);
assert.equal(cutRotation(5), -Math.PI / 4);
assert.equal(cutRotation(6), (3 * Math.PI) / 4);
assert.equal(cutRotation(7), (-3 * Math.PI) / 4);
assert.equal(cutRotation(8), 0);

assert.equal(itemPhase(2, 1.9), 'ahead');
assert.equal(itemPhase(2, 2), 'hit');
assert.equal(itemPhase(2, 2 + HIT_WINDOW_SEC), 'hit');
assert.equal(itemPhase(2, 2.2), 'past');
// The past window is world-space: PAST_Z_LIMIT units behind the hit line, but
// never shorter than the hit window plus its fade (or a fast chart would retire
// a note that is still meant to be glowing, or delete one with no fade at all).
assert.equal(PAST_Z_LIMIT, 1.6);
assert.equal(pastSecFor(4), 0.4); // the z limit binds below speed 13.3
assert.ok(Math.abs(pastSecFor(8) - 0.22) < 1e-9); // the floor binds: 1.6/8 = 0.2
assert.ok(Math.abs(pastSecFor(20) - (HIT_WINDOW_SEC + PAST_FADE_SEC)) < 1e-9);
assert.equal(pastSecFor(0), PAST_Z_LIMIT); // guard: a bad speed reads as 1
// The fade span is never zero: an item always fades out, it is never deleted
// while still lit — the slider reaches 20 and the store accepts up to 40.
for (const speed of [1, 3, 8, 13.3, 14, 20, 40]) {
  assert.ok(pastSecFor(speed) - HIT_WINDOW_SEC >= PAST_FADE_SEC - 1e-9, `fade span at speed ${speed}`);
}
const PAST_8 = pastSecFor(8);
assert.equal(pastAlpha(2, 1, PAST_8), 1);
assert.equal(pastAlpha(2, 2 + HIT_WINDOW_SEC, PAST_8), 1);
assert.ok(pastAlpha(2, 2.16, PAST_8) > 0 && pastAlpha(2, 2.16, PAST_8) < 1);
assert.equal(pastAlpha(2, 2 + PAST_8, PAST_8), 0);
assert.equal(pastAlpha(2, 9, PAST_8), 0);

const BARS = [0, 2, 4, 6, 8];
assert.deepEqual(barWindow(BARS, 4, 3, 0.5), [2, 4]); // 4 and 6
assert.deepEqual(barWindow(BARS, 0, 1, 0.5), [0, 1]);
assert.deepEqual(barWindow(BARS, 20, 1, 0.5), [5, 5]);
assert.deepEqual(barWindow([], 1, 1, 1), [0, 0]);

assert.equal(highwayWidth('blocks', 9, 1.2), 2.4);
assert.ok(Math.abs(highwayWidth('drums', 9, 1.2) - 2.8) < 1e-9);
assert.ok(Math.abs(highwayWidth('notation', 3, 1.2) - 3.6) < 1e-9);
assert.ok(Math.abs(highwayWidth('notation', 0, 1.2) - 1.2) < 1e-9);

// ---------------------------------------------------------------------------
// camera framing
// ---------------------------------------------------------------------------

// The camera constants exist for one reason: the screen row the hit line lands
// on. A pitch too shallow puts z = 0 in the bottom sliver, so notes reach their
// hit time below the canvas edge. Assert the framing with the real projection.
const framingCam = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 80);
framingCam.position.set(...CAMERA_POS);
framingCam.lookAt(...CAMERA_TARGET);
framingCam.updateMatrixWorld(true);
/** Screen row of a world point on the centre line, in % of pane height. */
const screenRow = (y: number, z: number): number => ((1 - new THREE.Vector3(0, y, z).project(framingCam).y) / 2) * 100;

const hitRow = screenRow(0, 0);
assert.ok(hitRow > 55 && hitRow < 80, `hit line at ${hitRow.toFixed(1)}% of the pane height`);
// The first ledger below the staff and the second staff of a grand staff have
// to be on screen at their own hit time.
assert.ok(screenRow(-2 * DEFAULT_LAYOUT.stepHeight, 0) < 100, 'first ledger below the staff is on screen');
assert.ok(screenRow(-DEFAULT_LAYOUT.staffDrop, 0) < 100, 'grand-staff second staff is on screen');
// The standing ribbon is what makes the NOW line unmistakable: an edge-on floor
// slab 0.02 tall is under half a percent of the pane at this camera.
const ribbonSpan = screenRow(HIT_RIBBON_Y - HIT_RIBBON_HEIGHT / 2, 0) - screenRow(HIT_RIBBON_Y + HIT_RIBBON_HEIGHT / 2, 0);
assert.ok(ribbonSpan >= 5, `hit ribbon spans ${ribbonSpan.toFixed(1)}% of the pane height`);
assert.ok(screenRow(-0.015, 0) - screenRow(0.005, 0) < 1, 'a floor slab is the thing the ribbon replaces');
// A note on the bottom staff line has to outlive its hit window on screen, or
// the ink tint is painted below the canvas.
let exitZ = 0;
while (exitZ < 2.5 && screenRow(0, exitZ + 0.002) <= 100) exitZ += 0.002;
assert.ok(exitZ / 8 >= 0.12, `${((exitZ / 8) * 1000).toFixed(0)} ms on screen past the hit at speed 8`);
assert.ok(exitZ / 8 > HIT_WINDOW_SEC, 'the whole hit window happens on screen');
assert.ok(PAST_Z_LIMIT > exitZ, 'items are retired only after they leave the pane');
// The BLOCKS frame and the DRUMS pads still fit the band the camera sees.
assert.ok(screenRow(3 * BLOCK_PITCH, 0) > 0, 'blocks frame top edge is on screen');
assert.ok(screenRow(0.03, 0) < 100, 'drum kick bar is on screen');

// ---------------------------------------------------------------------------
// fixture: chart + schedule
// ---------------------------------------------------------------------------

let nextId = 1;
function ev(overrides: Partial<ChartEvent>): ChartEvent {
  const onsetSec = overrides.onsetSec ?? 0;
  return {
    ...blankChartEvent(),
    id: nextId++,
    onsetSecRaw: onsetSec,
    durationSec: 0.5,
    durationSecRaw: 0.5,
    durationBeats: 1,
    noteType: 'quarter',
    glyph: 'noteQuarterUp',
    glyphCodepoint: 0xe1d5,
    noteheadGlyph: 'noteheadBlack',
    noteheadCodepoint: 0xe0a4,
    staffStep: 4,
    midi: 60,
    ...overrides,
  };
}

function part(index: number, name: string, events: ChartEvent[], isPercussion = false): ChartPart {
  return {
    index,
    id: `P${index + 1}`,
    name,
    abbreviation: name.slice(0, 3),
    instrumentName: name,
    midiProgram: isPercussion ? -1 : 0,
    midiChannel: isPercussion ? 10 : 1,
    staffCount: 1,
    isPercussion,
    transposeSemitones: 0,
    clefs: [],
    events,
  };
}

// Part 0: eight quarter notes at 1 s spacing, Beat Saber candidates.
const melody = Array.from({ length: 8 }, (_, i) =>
  ev({
    onsetSec: i + 1,
    staffStep: i,
    bsLine: i % 4,
    bsLayer: i % 3,
    bsColor: i % 2,
    bsCut: i,
    bsMinDifficulty: 0,
  }),
);
// One rest at 2.5 s (never a block).
melody.push(
  ev({
    onsetSec: 2.5,
    isRest: true,
    glyph: 'restQuarter',
    glyphCodepoint: 0xe4e5,
    noteheadGlyph: '',
    noteheadCodepoint: 0,
    staffStep: 4,
    midi: 0,
    bsMinDifficulty: -1,
  }),
);
// Part 1: drums at 1 s spacing (kick + closed hat on the beat, open hat at 3).
const drums: ChartEvent[] = [];
for (let i = 1; i <= 8; i += 1) {
  drums.push(ev({ onsetSec: i, midi: 36, drumVoice: 'kick', bsMinDifficulty: -1 }));
  drums.push(
    ev({
      onsetSec: i,
      midi: i === 3 ? 46 : 42,
      drumVoice: 'hihat',
      noteheadCodepoint: i === 3 ? 0xe0b3 : 0xe0a9,
      glyphCodepoint: 0,
      bsMinDifficulty: -1,
    }),
  );
}
drums.push(ev({ onsetSec: 3, midi: 38, drumVoice: 'snare', bsMinDifficulty: -1 }));

const chart = {
  schema: 'gantasmo.notechart',
  schemaVersion: 1,
  quantization: { rawIsQuantized: true },
  measures: [0, 2, 4, 6, 8].map((timeSec, i) => ({ number: i + 1, timeSec })),
  parts: [part(0, 'Piano', melody), part(1, 'Drums', drums, true)],
} as unknown as NoteChart;

const notationSchedule = buildSchedule(chart, [true, true], { skin: 'notation', difficulty: 0 });
const blocksSchedule = buildSchedule(chart, [true, true], { skin: 'blocks', difficulty: 0 });
const drumsSchedule = buildSchedule(chart, [true, true], { skin: 'drums', difficulty: 0 });
assert.equal(blocksSchedule.items.length, 8);
assert.equal(drumsSchedule.items.length, 17);

// ---------------------------------------------------------------------------
// fakes: renderer, canvas, atlas
// ---------------------------------------------------------------------------

class FakeRenderer {
  renders = 0;
  disposed = 0;
  forced = 0;
  size: [number, number, boolean | undefined] = [0, 0, undefined];
  pixelRatio = 1;
  clear = '';
  constructor(_params: unknown) {}
  setClearColor(c: string | number) {
    this.clear = String(c);
  }
  setPixelRatio(r: number) {
    this.pixelRatio = r;
  }
  setSize(w: number, h: number, updateStyle?: boolean) {
    this.size = [w, h, updateStyle];
  }
  render() {
    this.renders += 1;
  }
  dispose() {
    this.disposed += 1;
  }
  forceContextLoss() {
    this.forced += 1;
  }
}
let lastRenderer: FakeRenderer | null = null;
const three = {
  ...THREE,
  WebGLRenderer: class extends FakeRenderer {
    constructor(params: unknown) {
      super(params);
      lastRenderer = this;
    }
  },
} as unknown as typeof import('three');

class FakeCanvas {
  width = 300;
  height = 150;
  private listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, fn: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string): number {
    const set = this.listeners.get(type);
    if (!set) return 0;
    let prevented = 0;
    for (const fn of set) {
      fn({ type, preventDefault: () => (prevented += 1) } as unknown as Event);
    }
    return prevented;
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fakeAtlas(codepoints: number[]): GlyphAtlas {
  const size = 1024;
  const cell = 96;
  const emPx = 58;
  const rects = new Map<number, GlyphRect>();
  const all = [FALLBACK_CODEPOINT, ...codepoints.filter((c) => c !== FALLBACK_CODEPOINT)];
  all.forEach((cp, i) => {
    const col = i % 10;
    const row = Math.floor(i / 10);
    const px = { x: col * cell + 20, y: row * cell + 20, w: cp === FALLBACK_CODEPOINT ? 17 : 24, h: cp === FALLBACK_CODEPOINT ? 14 : 50 };
    rects.set(cp, {
      u: px.x / size,
      v: px.y / size,
      w: px.w / size,
      h: px.h / size,
      ax: px.w / 2 / size,
      ay: (cp === FALLBACK_CODEPOINT ? px.h / 2 : px.h - 7) / size,
      emPx,
    });
  });
  const fallback = rects.get(FALLBACK_CODEPOINT)!;
  return {
    canvas: { width: size, height: size } as unknown as HTMLCanvasElement,
    cell,
    size,
    emPx,
    rects,
    has: (cp) => rects.has(cp),
    rect: (cp) => rects.get(cp) ?? fallback,
  };
}

const atlas = fakeAtlas([0xe1d5, 0xe4e5]);
const canvas = new FakeCanvas();
const hitHex = new THREE.Color(NOTE_HIGHLIGHT_COLOR).getHexString();

// ---------------------------------------------------------------------------
// notation skin
// ---------------------------------------------------------------------------

const scene = new HighwayScene(three, canvas as unknown as HTMLCanvasElement, atlas, notationSchedule, {
  approachSpeed: 8,
  leadInSec: 3,
  skin: 'notation',
  laneCount: 2,
});
const renderer = lastRenderer as unknown as FakeRenderer;
assert.ok(renderer, 'renderer constructed through the injected three module');
assert.equal(canvas.listenerCount('webglcontextlost'), 1);
assert.equal(canvas.listenerCount('webglcontextrestored'), 1);
assert.ok(scene.poolSize >= POOL_MIN);
assert.equal(scene.activeItems, 0);

scene.resize(computeCanvasBox(800, 400, 1.1, 2));
assert.deepEqual(renderer.size, [800 / 1.1, 400 / 1.1, false]);
assert.equal(renderer.pixelRatio, 2); // min(2, 1.1 * 2)
assert.ok(renderer.renders >= 1);

// t = 2: window is [1.8, 5] -> melody 2,3,4,5 + rest 2.5 + drums at 2..5.
const rendersBefore = renderer.renders;
scene.frame(2);
assert.equal(renderer.renders, rendersBefore + 1);
const items = notationSchedule.items;
const inWindow = items.map((it, i) => [it, i] as const).filter(([it]) => it.hitTime >= 2 - PAST_8 && it.hitTime <= 5);
assert.equal(scene.activeItems, inWindow.length);
for (const [it, i] of inWindow) {
  const view = scene.inspect(i);
  assert.ok(view, `item ${i} bound`);
  assert.ok(view.visible);
  assert.equal(view.kind, 'sprite');
  assert.ok(Math.abs(view.z - zForTime(it.hitTime, 2, 8)) < 1e-9);
  assert.equal(view.x, it.x);
  assert.equal(view.y, it.y);
}
// Item exactly on the hit line glows; ahead items keep their base colour.
const onLine = items.findIndex((it) => it.hitTime === 2 && it.color === 0);
assert.ok(onLine >= 0);
assert.equal(scene.inspect(onLine)!.colorHex, hitHex);
const ahead = items.findIndex((it) => it.hitTime === 4 && it.color === 0);
assert.equal(scene.inspect(ahead)!.colorHex, new THREE.Color('#f4f4f5').getHexString());
assert.equal(scene.inspect(ahead)!.opacity, 1);
// Rest is dimmed and uses the rest glyph; percussion items are amber.
const restIndex = items.findIndex((it) => it.color === 1);
assert.ok(restIndex >= 0);
const restView = scene.inspect(restIndex)!;
assert.equal(restView.codepoint, 0xe4e5);
assert.ok(restView.opacity < 1 && restView.opacity > 0.5);
// The closed hi-hat at 4 s: percussion colour, x-notehead codepoint.
const percIndex = items.findIndex((it) => it.color === 2 && it.hitTime === 4 && it.codepoint === 0xe0a9);
assert.ok(percIndex >= 0);
assert.equal(scene.inspect(percIndex)!.colorHex, new THREE.Color('#fbbf24').getHexString());
// A codepoint the atlas lacks (the x notehead) falls back to the notehead and
// is sized from the fallback rect (17 x 14 px at 58 px/em), not left at 1.
assert.equal(scene.inspect(percIndex)!.codepoint, -1);
const EM = 8 * DEFAULT_LAYOUT.stepHeight; // 1 em = 4 staff spaces
assert.equal(EM, 0.6);
assert.ok(Math.abs(scene.inspect(percIndex)!.scaleY - (14 / 58) * EM) < 1e-9);
assert.ok(Math.abs(scene.inspect(percIndex)!.scaleX - (17 / 58) * EM) < 1e-9);
// Sprite scale: 1 em = 8 * stepHeight world units; the quarter note is 50 px
// tall at 58 px/em.
const noteView = scene.inspect(onLine)!;
assert.ok(Math.abs(noteView.scaleY - (50 / 58) * EM) < 1e-9);
assert.ok(Math.abs(noteView.scaleX - (24 / 58) * EM) < 1e-9);
// Items outside the window are not bound.
const far = items.findIndex((it) => it.hitTime === 8);
assert.equal(scene.inspect(far), null);

// Stable slots: advancing time keeps a still-visible item in its slot.
const keepSlot = scene.inspect(ahead)!.slot;
scene.frame(2.16);
assert.equal(scene.inspect(ahead)!.slot, keepSlot);
// The item at 2 s is now fading (past the hit window). With the default
// 'hold' trail it keeps the ink while it fades (one colour change per note,
// nothing strobes); with 'flash' it returns to its base colour.
const fading = scene.inspect(onLine)!;
assert.ok(fading.opacity < 1 && fading.opacity > 0);
assert.equal(fading.colorHex, hitHex, 'hold: a played note keeps the ink while fading');
usePlayAlongStore.getState().setInkTrail('flash');
scene.frame(2.16);
assert.notEqual(scene.inspect(onLine)!.colorHex, hitHex, 'flash: a played note returns to its base colour');
usePlayAlongStore.getState().setInkTrail('hold');
scene.frame(2.16);
// Past pastSecFor(speed) it is released.
scene.frame(2 + PAST_8 + 1e-6);
assert.equal(scene.inspect(onLine), null);
// Seeking backwards is just another frame.
scene.frame(0);
assert.equal(scene.activeItems, items.filter((it) => it.hitTime <= 3).length);
scene.frame(100);
assert.equal(scene.activeItems, 0);
// Non-finite time is treated as 0, never throws.
scene.frame(Number.NaN);
assert.equal(scene.activeItems, items.filter((it) => it.hitTime <= 3).length);

// Settings: speed change rescales z without rebinding.
scene.frame(2);
const beforeSlot = scene.inspect(ahead)!.slot;
scene.setSettings({ approachSpeed: 4 });
assert.equal(scene.inspect(ahead)!.slot, beforeSlot);
assert.ok(Math.abs(scene.inspect(ahead)!.z - zForTime(4, 2, 4)) < 1e-9);
scene.setSettings({ approachSpeed: 8 });

// INK: the strike zone and the hit tint both follow it, live. The materials
// are private, so reach them the way only a test may.
const strike = (scene as unknown as {
  strikeMaterials: Array<{ color: { getHexString(): string }; depthTest: boolean; depthWrite: boolean }>;
}).strikeMaterials;
assert.equal(strike.length, 5, 'glow, floor line, two posts, ribbon');
assert.ok(strike.every((m) => !m.depthTest && !m.depthWrite), 'nothing can bury the strike zone');
assert.ok(strike.every((m) => m.color.getHexString() === hitHex));
assert.equal(scene.inspect(onLine)!.colorHex, hitHex);
scene.setInk('#00ff00');
assert.ok(strike.every((m) => m.color.getHexString() === '00ff00'), 'setInk repaints the strike zone');
assert.equal(scene.inspect(onLine)!.colorHex, '00ff00', 'setInk repaints the hit tint');
scene.setInk(NOTE_HIGHLIGHT_COLOR);
assert.equal(scene.inspect(onLine)!.colorHex, hitHex);

// Context loss: preventDefault, report, stop rendering; restore resumes.
let reported = -1;
scene.onContextLost = (n) => {
  reported = n;
};
assert.equal(canvas.dispatch('webglcontextlost'), 1);
assert.equal(reported, 1);
assert.ok(scene.isContextLost);
const rendersLost = renderer.renders;
scene.frame(2.1);
assert.equal(renderer.renders, rendersLost);
canvas.dispatch('webglcontextrestored');
assert.ok(!scene.isContextLost);
assert.ok(renderer.renders > rendersLost);
assert.equal(scene.contextLosses, 1);

// ---------------------------------------------------------------------------
// blocks skin
// ---------------------------------------------------------------------------

scene.setSchedule(blocksSchedule);
scene.setSettings({ skin: 'blocks' });
scene.frame(2);
const bItems = blocksSchedule.items;
for (let i = 0; i < bItems.length; i += 1) {
  const it = bItems[i];
  const view = scene.inspect(i);
  if (it.hitTime < 2 - PAST_8 || it.hitTime > 5) {
    assert.equal(view, null);
    continue;
  }
  assert.ok(view);
  assert.equal(view.kind, 'block');
  assert.equal(view.geometryType, 'BoxGeometry');
  assert.equal(view.x, it.x);
  assert.ok(Math.abs(view.y - (it.y + 0.2)) < 1e-9, 'cube rests on its layer');
  assert.ok(Math.abs(view.decalRotationZ - cutRotation(it.block!.cut)) < 1e-9);
  const expected = it.hitTime === 2 ? hitHex : new THREE.Color(it.block!.color === 1 ? BLOCK_BLUE : BLOCK_RED).getHexString();
  assert.equal(view.colorHex, expected);
}

// ---------------------------------------------------------------------------
// drums skin
// ---------------------------------------------------------------------------

scene.setSchedule(drumsSchedule);
scene.setSettings({ skin: 'drums' });
scene.frame(3);
const dItems = drumsSchedule.items;
const kickAt3 = dItems.findIndex((it) => it.hitTime === 3 && it.drum!.voice === 'kick');
const openHat = dItems.findIndex((it) => it.hitTime === 3 && it.drum!.voice === 'hihat');
const closedHat = dItems.findIndex((it) => it.hitTime === 4 && it.drum!.voice === 'hihat');
const snare = dItems.findIndex((it) => it.drum!.voice === 'snare');
assert.ok(kickAt3 >= 0 && openHat >= 0 && closedHat >= 0 && snare >= 0);
assert.ok(dItems[openHat].drum!.open);
assert.ok(!dItems[closedHat].drum!.open);

const kickView = scene.inspect(kickAt3)!;
assert.equal(kickView.kind, 'drum');
assert.equal(kickView.geometryType, 'BoxGeometry');
assert.equal(kickView.rotationX, 0);
assert.equal(kickView.x, 0);
assert.equal(kickView.colorHex, hitHex); // on the hit line right now

const openView = scene.inspect(openHat)!;
assert.equal(openView.geometryType, 'RingGeometry');
assert.ok(Math.abs(openView.rotationX + Math.PI / 2) < 1e-9);
assert.ok(Math.abs(openView.x - laneX(1, 4, DRUM_PAD_SPACING)) < 1e-9);

const closedView = scene.inspect(closedHat)!;
assert.equal(closedView.geometryType, 'CircleGeometry');
assert.equal(closedView.colorHex, new THREE.Color(DRUM_LANES[2].color).getHexString());
assert.ok(Math.abs(closedView.z - zForTime(4, 3, 8)) < 1e-9);

// The snare shares the hit line with the kick right now (both glow); half a
// second earlier it shows its own lane colour on the snare lane.
assert.equal(scene.inspect(snare)!.colorHex, hitHex);
scene.frame(2.5);
const snareView = scene.inspect(snare)!;
assert.equal(snareView.geometryType, 'CircleGeometry');
assert.equal(snareView.colorHex, new THREE.Color(DRUM_LANES[1].color).getHexString());
assert.ok(Math.abs(snareView.x - laneX(0, 4, DRUM_PAD_SPACING)) < 1e-9);
assert.ok(Math.abs(snareView.z - zForTime(3, 2.5, 8)) < 1e-9);

// Switching back to notation with a new atlas rebinds glyphs cleanly.
scene.setSchedule(notationSchedule);
scene.setSettings({ skin: 'notation', laneCount: 2 });
scene.setAtlas(fakeAtlas([0xe1d5, 0xe4e5, 0xe0a9, 0xe0b3]));
scene.frame(3);
assert.equal(scene.inspect(percIndex)!.codepoint, 0xe0a9);
assert.ok(Math.abs(scene.inspect(percIndex)!.scaleY - (50 / 58) * EM) < 1e-9);
// Every bound sprite was re-configured against the new atlas (no slot kept a
// scale from the disposed textures).
for (let i = 0; i < items.length; i += 1) {
  const view = scene.inspect(i);
  if (view) assert.ok(view.scaleX > 0.05 && view.scaleY > 0.05, `item ${i} sized from the new atlas`);
}

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

scene.dispose();
assert.equal(renderer.disposed, 1);
assert.equal(renderer.forced, 1);
assert.equal(canvas.listenerCount('webglcontextlost'), 0);
assert.equal(canvas.listenerCount('webglcontextrestored'), 0);
const rendersAfter = renderer.renders;
scene.frame(1);
scene.setSettings({ skin: 'blocks' });
scene.resize(computeCanvasBox(100, 100, 1, 1));
assert.equal(renderer.renders, rendersAfter);
assert.equal(scene.poolSize, 0);
scene.dispose(); // idempotent
assert.equal(renderer.disposed, 1);

console.log('HighwayScene + glyphAtlas regression passed');
