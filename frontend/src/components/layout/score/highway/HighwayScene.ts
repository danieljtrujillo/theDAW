/**
 * three.js renderer for the note highway. No React, no DOM lookups: the caller
 * (Highway.tsx) hands over the canvas, the `three` module it dynamically
 * imported, a Bravura glyph atlas and a `Schedule`, then drives `frame(t)`
 * with song time from the play-along clock. Every object's position is a pure
 * function of song time (`zForTime`), so seeking is just another frame.
 *
 * Skins:
 *   - 'notation'  one lane per visible part; pooled `THREE.Sprite`s textured
 *                 with the chart's own SMuFL glyphs from the atlas, y = staff
 *                 step. Each lane shows a staff frame at the hit line and faint
 *                 rails running down the highway.
 *   - 'blocks'    exactly what the Beat Saber export contains: red/blue cubes
 *                 on the 4 x 3 grid with an arrow (or dot) decal rotated by
 *                 the cut direction.
 *   - 'drums'     Rock Band order: a wide orange bar for kicks across the
 *                 highway, flat discs per pad lane (snare, hi-hat, tom,
 *                 cymbal) in the lane colour; open hi-hats are hollow rings.
 *
 * Rendering budget: the visible set is bounded by the lead-in window, so
 * objects are pooled once per schedule/skin change and `frame()` allocates
 * nothing — it only moves, tints and toggles pooled objects and renders.
 *
 * `three` is passed in rather than imported so this module stays in the
 * ScoreView chunk and the (already split) three chunk loads only when the
 * highway mounts. The module carries no type declarations in this repo, so the
 * few structural interfaces below describe exactly what the scene touches.
 */

import type { CanvasBox } from '../../../../lib/canvasScale';
import { highlightColor, inkHolds } from '../scoreShared';
import type { GlyphAtlas } from './glyphAtlas';
import {
  DEFAULT_LAYOUT,
  DRUM_LANE_COUNT,
  DRUM_LANES,
  DRUM_PAD_SPACING,
  BLOCK_PITCH,
  laneX,
  windowFor,
  zForTime,
  type HighwayLayout,
  type HighwaySkin,
  type Schedule,
  type ScheduleItem,
} from './schedule';

type ThreeModule = typeof import('three');

export interface HighwaySettings {
  /** World units the highway moves per second (z = -(hitTime - t) * speed). */
  approachSpeed: number;
  /** Seconds of upcoming material visible ahead of the hit line. */
  leadInSec: number;
  skin: HighwaySkin;
  /** Visible part lanes (notation skin); ignored by the other skins. */
  laneCount: number;
  /** Must match the layout the schedule was built with. */
  layout?: Partial<HighwayLayout>;
}

/** Seconds an item stays visible after crossing the hit line. */
export const PAST_SEC = 0.5;
/** Seconds after the hit time an item glows in the highlight colour. */
export const HIT_WINDOW_SEC = 0.12;
/** Pool bounds for the item sprites/meshes. */
export const POOL_MIN = 64;
export const POOL_MAX = 1024;
export const BAR_POOL_MIN = 8;
export const BAR_POOL_MAX = 128;
export const HIGHWAY_BG = '#0b0e14';
export const BLOCK_RED = '#ff2f4f';
export const BLOCK_BLUE = '#2f7fff';
export const BLOCK_SIZE = 0.4;
export const DRUM_DISC_RADIUS = 0.18;
/** Item base colours by `ScheduleItem.color` (notation skin). */
export const ITEM_COLORS: readonly string[] = ['#f4f4f5', '#71717a', '#fbbf24'];
export const REST_OPACITY = 0.55;
/** `Slot.codepoint` sentinel: the sprite has not been configured yet (the
 *  fallback notehead itself is -1, so a bind to it still runs). */
const UNCONFIGURED = -2;

// ---------------------------------------------------------------------------
// pure helpers (node-testable)
// ---------------------------------------------------------------------------

/**
 * Pool size for `itemCount` items spread over `spanSec` seconds of song when
 * `leadInSec` seconds are visible: 1.5x the expected window population,
 * clamped to [POOL_MIN, POOL_MAX].
 */
export function poolSizeFor(itemCount: number, spanSec: number, leadInSec: number, min = POOL_MIN, max = POOL_MAX): number {
  const span = Number.isFinite(spanSec) && spanSec > 0 ? spanSec : 1;
  const density = Math.max(0, itemCount) / span;
  const wanted = Math.ceil(density * Math.max(0, leadInSec) * 1.5);
  return Math.max(min, Math.min(max, Number.isFinite(wanted) ? wanted : min));
}

/**
 * Rotation (radians about z) of an arrow decal drawn pointing UP for a Beat
 * Saber cut direction: 0 up, 1 down, 2 left, 3 right, 4 up-left, 5 up-right,
 * 6 down-left, 7 down-right, 8 any (dot; rotation 0).
 */
export function cutRotation(cut: number): number {
  switch (cut) {
    case 1:
      return Math.PI;
    case 2:
      return Math.PI / 2;
    case 3:
      return -Math.PI / 2;
    case 4:
      return Math.PI / 4;
    case 5:
      return -Math.PI / 4;
    case 6:
      return (3 * Math.PI) / 4;
    case 7:
      return (-3 * Math.PI) / 4;
    default:
      return 0;
  }
}

export type ItemPhase = 'ahead' | 'hit' | 'past';

/** Where an item is relative to the hit line at song time `t`. */
export function itemPhase(hitTime: number, t: number): ItemPhase {
  if (t < hitTime) return 'ahead';
  if (t <= hitTime + HIT_WINDOW_SEC) return 'hit';
  return 'past';
}

/** Opacity multiplier for an item: 1 until the hit window ends, then a
 *  linear fade to 0 at `hitTime + PAST_SEC`. */
export function pastAlpha(hitTime: number, t: number): number {
  const age = t - hitTime - HIT_WINDOW_SEC;
  if (age <= 1e-9) return 1; // epsilon: t = hitTime + HIT_WINDOW_SEC is still fully lit
  const fadeSpan = Math.max(1e-6, PAST_SEC - HIT_WINDOW_SEC);
  return Math.max(0, Math.min(1, 1 - age / fadeSpan));
}

/** Half-open index range of `bars` (sorted ascending) inside the window. */
export function barWindow(bars: readonly number[], t: number, lookaheadSec: number, pastSec: number): [number, number] {
  let lo = 0;
  let hi = bars.length;
  const lowT = t - pastSec;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid] < lowT) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  hi = bars.length;
  const highT = t + lookaheadSec;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid] <= highT) lo = mid + 1;
    else hi = mid;
  }
  return [from, Math.max(from, lo)];
}

/** Total highway width (world units) for a skin. */
export function highwayWidth(skin: HighwaySkin, laneCount: number, laneSpacing: number): number {
  if (skin === 'blocks') return 4 * BLOCK_PITCH;
  if (skin === 'drums') return (DRUM_LANE_COUNT - 1) * DRUM_PAD_SPACING;
  return Math.max(1, laneCount) * laneSpacing;
}

// ---------------------------------------------------------------------------
// minimal structural view of the three.js objects the scene touches
// ---------------------------------------------------------------------------

interface Vec2Like {
  set(x: number, y: number): unknown;
}
interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): unknown;
}
interface ColorLike {
  copy(c: ColorLike): ColorLike;
  set(v: string | number): ColorLike;
  getHexString(): string;
}
interface TextureLike {
  offset: Vec2Like;
  repeat: Vec2Like;
  needsUpdate: boolean;
  colorSpace: unknown;
  minFilter: unknown;
  magFilter: unknown;
  generateMipmaps: boolean;
  clone(): TextureLike;
  dispose(): void;
}
interface MaterialLike {
  color: ColorLike;
  opacity: number;
  transparent: boolean;
  needsUpdate: boolean;
  map?: TextureLike | null;
  dispose(): void;
}
interface GeometryLike {
  dispose(): void;
}
interface Object3DLike {
  position: Vec3Like;
  scale: Vec3Like;
  rotation: Vec3Like;
  visible: boolean;
  children: Object3DLike[];
  geometry?: GeometryLike;
  material?: MaterialLike | MaterialLike[];
  center?: Vec2Like;
  add(o: Object3DLike): unknown;
  remove(o: Object3DLike): unknown;
  traverse(cb: (o: Object3DLike) => void): void;
}
interface CameraLike extends Object3DLike {
  aspect: number;
  updateProjectionMatrix(): void;
  lookAt(x: number, y: number, z: number): void;
}
interface SceneLike extends Object3DLike {
  fog: unknown;
  background: unknown;
}
interface RendererLike {
  setPixelRatio(r: number): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  setClearColor(c: string | number, alpha?: number): void;
  render(scene: SceneLike, camera: CameraLike): void;
  dispose(): void;
  forceContextLoss?(): void;
}

type SlotKind = 'sprite' | 'block' | 'drum';

export interface HighwayItemView {
  slot: number;
  kind: SlotKind;
  visible: boolean;
  x: number;
  y: number;
  z: number;
  colorHex: string;
  opacity: number;
  /** Notation skin: atlas codepoint shown (-1 = fallback notehead). */
  codepoint: number;
  geometryType: string;
  rotationX: number;
  decalRotationZ: number;
  scaleX: number;
  scaleY: number;
}

interface Slot {
  kind: SlotKind;
  obj: Object3DLike;
  material: MaterialLike;
  /** Blocks skin: the arrow/dot plane on the cube's front face. */
  decal: Object3DLike | null;
  decalMaterial: MaterialLike | null;
  /** Index into `schedule.items`, -1 while free. */
  itemIndex: number;
  /** Base colour the item returns to outside the hit window. */
  base: ColorLike;
  baseOpacity: number;
  /** Notation skin: codepoint the sprite's map currently shows (-1 = the
   *  fallback notehead, UNCONFIGURED = never bound since the last atlas). */
  codepoint: number;
}

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

export class HighwayScene {
  readonly canvas: HTMLCanvasElement;

  /** Set by the host to be told about WebGL context loss (count so far). */
  onContextLost: ((count: number) => void) | null = null;

  private readonly three: ThreeModule;
  private readonly renderer: RendererLike;
  private readonly scene: SceneLike;
  private readonly camera: CameraLike;
  private atlas: GlyphAtlas;
  private schedule: Schedule;
  private settings: HighwaySettings & { layout: HighwayLayout };

  private atlasTexture: TextureLike | null = null;
  private readonly glyphTextures = new Map<number, TextureLike>();
  private arrowTexture: TextureLike | null = null;
  private dotTexture: TextureLike | null = null;

  private readonly staticGroup: Object3DLike;
  private readonly itemGroup: Object3DLike;
  private readonly barGroup: Object3DLike;
  private slots: Slot[] = [];
  private slotOf: Int32Array = new Int32Array(0);
  private freeSlots: Int32Array = new Int32Array(0);
  private freeCount = 0;
  private bars: Object3DLike[] = [];

  private readonly sharedGeometries: GeometryLike[] = [];
  private boxGeometry: GeometryLike | null = null;
  private decalGeometry: GeometryLike | null = null;
  private discGeometry: GeometryLike | null = null;
  private ringGeometry: GeometryLike | null = null;
  private kickGeometry: GeometryLike | null = null;
  private barGeometry: GeometryLike | null = null;

  private readonly colors: {
    hit: ColorLike;
    items: ColorLike[];
    red: ColorLike;
    blue: ColorLike;
    lanes: ColorLike[];
  };

  private lastTime = 0;
  private disposed = false;
  private contextLost = false;
  private contextLostCount = 0;

  private readonly handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.contextLostCount += 1;
    this.onContextLost?.(this.contextLostCount);
  };

  private readonly handleContextRestored = (): void => {
    this.contextLost = false;
    this.markDirty();
    this.render();
  };

  constructor(three: ThreeModule, canvas: HTMLCanvasElement, atlas: GlyphAtlas, schedule: Schedule, settings: HighwaySettings) {
    this.three = three;
    this.canvas = canvas;
    this.atlas = atlas;
    this.schedule = schedule;
    this.settings = { ...settings, layout: { ...DEFAULT_LAYOUT, ...(settings.layout ?? {}) } };

    // May throw when WebGL is unavailable: the host shows its fallback card.
    this.renderer = new three.WebGLRenderer({ canvas, antialias: true, alpha: false }) as unknown as RendererLike;
    this.renderer.setClearColor(HIGHWAY_BG, 1);

    this.scene = new three.Scene() as unknown as SceneLike;
    this.scene.background = new three.Color(HIGHWAY_BG);
    this.camera = new three.PerspectiveCamera(60, 16 / 9, 0.1, 80) as unknown as CameraLike;
    this.camera.position.set(0, 1.4, 2.2);
    this.camera.lookAt(0, 0.6, -8);

    this.colors = {
      hit: new three.Color(highlightColor()),
      items: ITEM_COLORS.map((c) => new three.Color(c)),
      red: new three.Color(BLOCK_RED),
      blue: new three.Color(BLOCK_BLUE),
      lanes: DRUM_LANES.map((l) => new three.Color(l.color)),
    };

    // Lights only matter for the Lambert cubes of the blocks skin; sprites
    // and basic materials ignore them.
    const ambient = new three.AmbientLight(0xffffff, 0.7);
    const key = new three.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 4, 3);
    this.scene.add(ambient);
    this.scene.add(key);

    this.staticGroup = new three.Group();
    this.itemGroup = new three.Group();
    this.barGroup = new three.Group();
    this.scene.add(this.staticGroup);
    this.scene.add(this.barGroup);
    this.scene.add(this.itemGroup);

    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    this.buildStatic();
    this.buildPools();
  }

  // -- public API -----------------------------------------------------------

  get isContextLost(): boolean {
    return this.contextLost;
  }

  get contextLosses(): number {
    return this.contextLostCount;
  }

  get currentSettings(): Readonly<HighwaySettings & { layout: HighwayLayout }> {
    return this.settings;
  }

  /** Pooled item objects (for diagnostics/tests). */
  get poolSize(): number {
    return this.slots.length;
  }

  /** Items currently bound to a pooled object. */
  get activeItems(): number {
    return this.slots.length - this.freeCount;
  }

  /**
   * Diagnostic view of the pooled object bound to `itemIndex` (null when the
   * item is outside the window or the pool is exhausted). Used by the tests
   * and handy in the console; not part of the render loop.
   */
  inspect(itemIndex: number): HighwayItemView | null {
    if (itemIndex < 0 || itemIndex >= this.slotOf.length) return null;
    const s = this.slotOf[itemIndex];
    if (s < 0) return null;
    const slot = this.slots[s];
    const geometry = slot.obj.geometry as (GeometryLike & { type?: string }) | undefined;
    return {
      slot: s,
      kind: slot.kind,
      visible: slot.obj.visible,
      x: slot.obj.position.x,
      y: slot.obj.position.y,
      z: slot.obj.position.z,
      colorHex: slot.material.color.getHexString(),
      opacity: slot.material.opacity,
      codepoint: slot.codepoint,
      geometryType: geometry?.type ?? '',
      rotationX: slot.obj.rotation.x,
      decalRotationZ: slot.decal ? slot.decal.rotation.z : 0,
      scaleX: slot.obj.scale.x,
      scaleY: slot.obj.scale.y,
    };
  }

  resize(box: CanvasBox): void {
    if (this.disposed) return;
    this.renderer.setPixelRatio(Math.min(2, Math.max(0.5, box.scale)));
    this.renderer.setSize(Math.max(1, box.cssWidth), Math.max(1, box.cssHeight), false);
    this.camera.aspect = Math.max(1, box.cssWidth) / Math.max(1, box.cssHeight);
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setSchedule(schedule: Schedule): void {
    if (this.disposed) return;
    this.schedule = schedule;
    this.buildPools();
    this.frame(this.lastTime);
  }

  /** Swap the glyph atlas (after rebuilding it for new codepoints). */
  setAtlas(atlas: GlyphAtlas): void {
    if (this.disposed) return;
    this.atlas = atlas;
    this.disposeGlyphTextures();
    for (const slot of this.slots) {
      if (slot.kind === 'sprite') {
        slot.codepoint = UNCONFIGURED;
        slot.itemIndex = -1;
        slot.obj.visible = false;
      }
    }
    this.resetSlotIndex();
    this.frame(this.lastTime);
  }

  setSettings(partial: Partial<HighwaySettings>): void {
    if (this.disposed) return;
    const prev = this.settings;
    const layout = partial.layout ? { ...prev.layout, ...partial.layout } : prev.layout;
    const next = { ...prev, ...partial, layout };
    this.settings = next;
    const skinChanged = next.skin !== prev.skin;
    const geometryChanged =
      skinChanged ||
      next.laneCount !== prev.laneCount ||
      next.leadInSec !== prev.leadInSec ||
      next.approachSpeed !== prev.approachSpeed ||
      layout !== prev.layout;
    if (geometryChanged) this.buildStatic();
    if (skinChanged || next.leadInSec !== prev.leadInSec || layout !== prev.layout) this.buildPools();
    this.frame(this.lastTime);
  }

  /** Position every pooled object for song time `t` and render. */
  frame(songTime: number): void {
    if (this.disposed) return;
    const t = Number.isFinite(songTime) ? songTime : 0;
    this.lastTime = t;
    if (this.contextLost) return;

    const { items } = this.schedule;
    const speed = this.settings.approachSpeed;
    const [from, to] = windowFor(this.schedule, t, this.settings.leadInSec, PAST_SEC);

    // Release slots whose item left the window.
    for (let s = 0; s < this.slots.length; s += 1) {
      const slot = this.slots[s];
      const idx = slot.itemIndex;
      if (idx >= 0 && (idx < from || idx >= to)) this.releaseSlot(s);
    }
    // Bind items entering the window, nearest to the hit line first.
    for (let i = from; i < to; i += 1) {
      if (this.slotOf[i] >= 0) continue;
      if (this.freeCount === 0) break;
      this.freeCount -= 1;
      const s = this.freeSlots[this.freeCount];
      this.bindSlot(s, items[i], i);
    }
    // Move + tint everything that is bound. With the 'hold' trail a played
    // item keeps the hit colour while it fades out, so each note changes
    // colour once (a strobe-free trail); with 'flash' it returns to its base
    // colour after the hit window.
    const hold = inkHolds();
    for (let s = 0; s < this.slots.length; s += 1) {
      const slot = this.slots[s];
      if (slot.itemIndex < 0) continue;
      const item = items[slot.itemIndex];
      const z = zForTime(item.hitTime, t, speed);
      slot.obj.position.set(item.x, this.itemY(item), z);
      const phase = itemPhase(item.hitTime, t);
      if (phase === 'hit') {
        slot.material.color.copy(this.colors.hit);
        slot.material.opacity = 1;
        if (slot.decalMaterial) slot.decalMaterial.opacity = 1;
      } else {
        slot.material.color.copy(hold && phase === 'past' ? this.colors.hit : slot.base);
        const alpha = phase === 'past' ? pastAlpha(item.hitTime, t) : 1;
        slot.material.opacity = slot.baseOpacity * alpha;
        if (slot.decalMaterial) slot.decalMaterial.opacity = alpha;
      }
    }

    // Bar lines.
    const bars = this.schedule.bars;
    const [bFrom, bTo] = barWindow(bars, t, this.settings.leadInSec, PAST_SEC);
    const barCount = Math.min(bTo - bFrom, this.bars.length);
    for (let i = 0; i < this.bars.length; i += 1) {
      const bar = this.bars[i];
      if (i < barCount) {
        bar.visible = true;
        bar.position.z = zForTime(bars[bFrom + i], t, speed);
      } else if (bar.visible) {
        bar.visible = false;
      }
    }

    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
    this.clearPools();
    this.clearStatic();
    this.disposeGlyphTextures();
    this.atlasTexture?.dispose();
    this.atlasTexture = null;
    this.arrowTexture?.dispose();
    this.dotTexture?.dispose();
    this.arrowTexture = null;
    this.dotTexture = null;
    for (const g of this.sharedGeometries) g.dispose();
    this.sharedGeometries.length = 0;
    this.boxGeometry = this.decalGeometry = this.discGeometry = this.ringGeometry = this.kickGeometry = this.barGeometry = null;
    try {
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
    } catch {
      // a renderer that never created a context has nothing to release
    }
  }

  // -- rendering ------------------------------------------------------------

  private render(): void {
    if (this.disposed || this.contextLost) return;
    this.renderer.render(this.scene, this.camera);
  }

  private markDirty(): void {
    this.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
      else m.needsUpdate = true;
    });
    for (const tex of this.glyphTextures.values()) tex.needsUpdate = true;
    if (this.atlasTexture) this.atlasTexture.needsUpdate = true;
    if (this.arrowTexture) this.arrowTexture.needsUpdate = true;
    if (this.dotTexture) this.dotTexture.needsUpdate = true;
  }

  private itemY(item: ScheduleItem): number {
    if (this.settings.skin === 'drums') {
      // Flat discs hover just above the floor; the kick bar stands on it.
      return item.y + (item.drum?.lane === 0 ? 0.03 : 0.015);
    }
    if (this.settings.skin === 'blocks') return item.y + BLOCK_SIZE / 2;
    return item.y;
  }

  // -- static geometry ------------------------------------------------------

  private clearStatic(): void {
    const children = [...this.staticGroup.children];
    for (const child of children) {
      this.staticGroup.remove(child);
      child.traverse((o) => {
        o.geometry?.dispose();
        const m = o.material;
        if (!m) return;
        if (Array.isArray(m)) for (const mm of m) mm.dispose();
        else m.dispose();
      });
    }
  }

  private buildStatic(): void {
    this.clearStatic();
    const three = this.three;
    const { skin, laneCount, layout, approachSpeed, leadInSec } = this.settings;
    const length = Math.max(2, leadInSec * approachSpeed + 1);
    const pastZ = PAST_SEC * approachSpeed + 0.5;
    const zMid = (pastZ - length) / 2;
    const zLen = pastZ + length;
    const width = highwayWidth(skin, laneCount, layout.laneSpacing);

    this.scene.fog = new three.Fog(HIGHWAY_BG, Math.max(1, length * 0.55), length + 3);

    const floorMat = (color: string, opacity: number) =>
      new three.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: three.DoubleSide });
    const lineMat = (color: string, opacity: number) => new three.LineBasicMaterial({ color, transparent: true, opacity });

    const addFloor = (x: number, w: number, color: string, opacity: number) => {
      const mesh = new three.Mesh(new three.PlaneGeometry(w, zLen), floorMat(color, opacity));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, -0.02, zMid);
      this.staticGroup.add(mesh);
    };
    const addLines = (points: number[], color: string, opacity: number) => {
      const geo = new three.BufferGeometry();
      geo.setAttribute('position', new three.Float32BufferAttribute(points, 3));
      this.staticGroup.add(new three.LineSegments(geo, lineMat(color, opacity)));
    };

    if (skin === 'notation') {
      const lanes = Math.max(1, laneCount);
      const laneW = layout.laneSpacing * 0.92;
      const half = laneW / 2;
      const frame: number[] = [];
      const rails: number[] = [];
      for (let slot = 0; slot < lanes; slot += 1) {
        const x = laneX(slot, lanes, layout.laneSpacing);
        addFloor(x, laneW, '#161b26', 0.9);
        for (let step = 0; step <= 8; step += 2) {
          const y = step * layout.stepHeight;
          frame.push(x - half, y, 0, x + half, y, 0);
          rails.push(x - half, y, pastZ, x - half, y, -length, x + half, y, pastZ, x + half, y, -length);
        }
      }
      addLines(frame, '#e4e4e7', 0.85);
      addLines(rails, '#94a3b8', 0.18);
    } else if (skin === 'blocks') {
      addFloor(0, width, '#161b26', 0.9);
      const frame: number[] = [];
      const rails: number[] = [];
      const yBottom = 0;
      const yTop = 3 * BLOCK_PITCH;
      for (let line = 0; line <= 4; line += 1) {
        const x = (line - 2) * BLOCK_PITCH;
        frame.push(x, yBottom, 0, x, yTop, 0);
        rails.push(x, 0, pastZ, x, 0, -length);
      }
      for (let layer = 0; layer <= 3; layer += 1) {
        const y = layer * BLOCK_PITCH;
        frame.push(-width / 2, y, 0, width / 2, y, 0);
      }
      addLines(frame, '#e4e4e7', 0.7);
      addLines(rails, '#94a3b8', 0.22);
    } else {
      // drums
      const padW = DRUM_PAD_SPACING * 0.9;
      const rails: number[] = [];
      for (let lane = 1; lane < DRUM_LANE_COUNT; lane += 1) {
        const x = laneX(lane - 1, DRUM_LANE_COUNT - 1, DRUM_PAD_SPACING);
        const color = DRUM_LANES[lane].color;
        addFloor(x, padW, color, 0.16);
        rails.push(x - padW / 2, 0, pastZ, x - padW / 2, 0, -length, x + padW / 2, 0, pastZ, x + padW / 2, 0, -length);
        const ring = new three.Mesh(
          new three.RingGeometry(DRUM_DISC_RADIUS * 0.85, DRUM_DISC_RADIUS * 1.1, 40),
          floorMat(color, 0.75),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, 0.005, 0);
        this.staticGroup.add(ring);
      }
      addLines(rails, '#94a3b8', 0.2);
      const kickTarget = new three.Mesh(
        new three.BoxGeometry(width + DRUM_PAD_SPACING * 0.9, 0.02, 0.1),
        floorMat(DRUM_LANES[0].color, 0.55),
      );
      kickTarget.position.set(0, 0.0, 0);
      this.staticGroup.add(kickTarget);
    }

    // Hit bar shared by every skin.
    const hitBar = new three.Mesh(
      new three.BoxGeometry(width + 0.4, 0.02, 0.06),
      new three.MeshBasicMaterial({ color: highlightColor(), transparent: true, opacity: 0.9 }),
    );
    hitBar.position.set(0, -0.005, 0);
    this.staticGroup.add(hitBar);

    // Bar-line pool geometry follows the width; rebuild the pooled planes.
    this.buildBarPool(width);
  }

  private buildBarPool(width: number): void {
    const three = this.three;
    for (const bar of this.bars) {
      this.barGroup.remove(bar);
      const m = bar.material;
      if (m && !Array.isArray(m)) m.dispose();
    }
    this.bars = [];
    this.barGeometry?.dispose();
    this.barGeometry = new three.BoxGeometry(width + 0.2, 0.01, 0.03);
    const bars = this.schedule.bars;
    const span = bars.length > 1 ? bars[bars.length - 1] - bars[0] : 1;
    const count = poolSizeFor(bars.length, span, this.settings.leadInSec, BAR_POOL_MIN, BAR_POOL_MAX);
    for (let i = 0; i < count; i += 1) {
      const mesh = new three.Mesh(
        this.barGeometry,
        new three.MeshBasicMaterial({ color: '#a1a1aa', transparent: true, opacity: 0.45, depthWrite: false }),
      );
      mesh.position.set(0, -0.01, 0);
      mesh.visible = false;
      this.barGroup.add(mesh);
      this.bars.push(mesh);
    }
  }

  // -- item pools -----------------------------------------------------------

  private clearPools(): void {
    for (const slot of this.slots) {
      this.itemGroup.remove(slot.obj);
      slot.material.dispose();
      slot.decalMaterial?.dispose();
    }
    this.slots = [];
    this.slotOf = new Int32Array(0);
    this.freeSlots = new Int32Array(0);
    this.freeCount = 0;
  }

  private resetSlotIndex(): void {
    this.slotOf = new Int32Array(this.schedule.items.length).fill(-1);
    this.freeSlots = new Int32Array(this.slots.length);
    this.freeCount = 0;
    for (let s = this.slots.length - 1; s >= 0; s -= 1) {
      const slot = this.slots[s];
      slot.itemIndex = -1;
      slot.obj.visible = false;
      this.freeSlots[this.freeCount] = s;
      this.freeCount += 1;
    }
  }

  private buildPools(): void {
    this.clearPools();
    const three = this.three;
    const { items } = this.schedule;
    const span = items.length > 1 ? items[items.length - 1].hitTime - items[0].hitTime : 1;
    const count = poolSizeFor(items.length, span, this.settings.leadInSec);
    const skin = this.settings.skin;

    if (skin === 'notation') {
      const map = this.textureFor(-1);
      for (let i = 0; i < count; i += 1) {
        const material = new three.SpriteMaterial({ map, transparent: true, depthWrite: false, color: '#ffffff' });
        const sprite = new three.Sprite(material);
        sprite.visible = false;
        this.itemGroup.add(sprite);
        this.slots.push({
          kind: 'sprite',
          obj: sprite,
          material,
          decal: null,
          decalMaterial: null,
          itemIndex: -1,
          base: new three.Color('#ffffff'),
          baseOpacity: 1,
          codepoint: UNCONFIGURED,
        });
      }
    } else if (skin === 'blocks') {
      this.boxGeometry ??= this.shared(new three.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE));
      this.decalGeometry ??= this.shared(new three.PlaneGeometry(BLOCK_SIZE * 0.82, BLOCK_SIZE * 0.82));
      this.ensureDecalTextures();
      for (let i = 0; i < count; i += 1) {
        const material = new three.MeshLambertMaterial({ color: BLOCK_RED, transparent: true, opacity: 1 });
        const cube = new three.Mesh(this.boxGeometry, material);
        const decalMaterial = new three.MeshBasicMaterial({
          color: '#ffffff',
          map: this.arrowTexture,
          transparent: true,
          depthWrite: false,
          opacity: 1,
        });
        const decal = new three.Mesh(this.decalGeometry, decalMaterial);
        decal.position.set(0, 0, BLOCK_SIZE / 2 + 0.002);
        cube.add(decal);
        cube.visible = false;
        this.itemGroup.add(cube);
        this.slots.push({
          kind: 'block',
          obj: cube,
          material,
          decal,
          decalMaterial,
          itemIndex: -1,
          base: new three.Color(BLOCK_RED),
          baseOpacity: 1,
          codepoint: -1,
        });
      }
    } else {
      this.discGeometry ??= this.shared(new three.CircleGeometry(DRUM_DISC_RADIUS, 32));
      this.ringGeometry ??= this.shared(new three.RingGeometry(DRUM_DISC_RADIUS * 0.6, DRUM_DISC_RADIUS, 32));
      const width = highwayWidth('drums', 0, 0) + DRUM_PAD_SPACING * 0.9;
      this.kickGeometry ??= this.shared(new three.BoxGeometry(width, 0.05, 0.12));
      for (let i = 0; i < count; i += 1) {
        const material = new three.MeshBasicMaterial({
          color: '#ffffff',
          transparent: true,
          opacity: 1,
          side: three.DoubleSide,
          depthWrite: false,
        });
        const mesh = new three.Mesh(this.discGeometry, material);
        mesh.visible = false;
        this.itemGroup.add(mesh);
        this.slots.push({
          kind: 'drum',
          obj: mesh,
          material,
          decal: null,
          decalMaterial: null,
          itemIndex: -1,
          base: new three.Color('#ffffff'),
          baseOpacity: 1,
          codepoint: -1,
        });
      }
    }
    this.resetSlotIndex();
  }

  private shared<G extends GeometryLike>(geometry: G): G {
    this.sharedGeometries.push(geometry);
    return geometry;
  }

  private releaseSlot(s: number): void {
    const slot = this.slots[s];
    if (slot.itemIndex >= 0) this.slotOf[slot.itemIndex] = -1;
    slot.itemIndex = -1;
    slot.obj.visible = false;
    this.freeSlots[this.freeCount] = s;
    this.freeCount += 1;
  }

  private bindSlot(s: number, item: ScheduleItem, itemIndex: number): void {
    const slot = this.slots[s];
    slot.itemIndex = itemIndex;
    this.slotOf[itemIndex] = s;
    slot.obj.visible = true;

    if (slot.kind === 'sprite') {
      const cp = this.atlas.has(item.codepoint) ? item.codepoint : -1;
      if (slot.codepoint !== cp) {
        slot.codepoint = cp;
        const tex = this.textureFor(cp);
        if (slot.material.map !== tex) {
          slot.material.map = tex;
          slot.material.needsUpdate = true;
        }
        const rect = this.atlas.rect(cp);
        const em = 8 * this.settings.layout.stepHeight; // 1 em = 4 staff spaces
        const w = ((rect.w * this.atlas.size) / rect.emPx) * em;
        const h = ((rect.h * this.atlas.size) / rect.emPx) * em;
        slot.obj.scale.set(w, h, 1);
        slot.obj.center?.set(rect.w > 0 ? rect.ax / rect.w : 0.5, rect.h > 0 ? 1 - rect.ay / rect.h : 0.5);
      }
      const colorIndex = Math.max(0, Math.min(this.colors.items.length - 1, item.color));
      slot.base.copy(this.colors.items[colorIndex]);
      slot.baseOpacity = item.color === 1 ? REST_OPACITY : 1;
      return;
    }

    if (slot.kind === 'block') {
      const block = item.block;
      slot.base.copy(block && block.color === 1 ? this.colors.blue : this.colors.red);
      slot.baseOpacity = 1;
      const cut = block ? block.cut : 8;
      if (slot.decal) slot.decal.rotation.z = cutRotation(cut);
      if (slot.decalMaterial) {
        const tex = cut === 8 ? this.dotTexture : this.arrowTexture;
        if (slot.decalMaterial.map !== tex) {
          slot.decalMaterial.map = tex;
          slot.decalMaterial.needsUpdate = true;
        }
      }
      return;
    }

    // drums
    const drum = item.drum;
    const lane = drum ? Math.max(0, Math.min(DRUM_LANE_COUNT - 1, drum.lane)) : 1;
    slot.base.copy(this.colors.lanes[lane]);
    slot.baseOpacity = 1;
    const kick = this.kickGeometry as GeometryLike;
    const disc = this.discGeometry as GeometryLike;
    const ring = this.ringGeometry as GeometryLike;
    if (lane === 0) {
      slot.obj.geometry = kick;
      slot.obj.rotation.x = 0;
    } else {
      slot.obj.geometry = drum?.open ? ring : disc;
      slot.obj.rotation.x = -Math.PI / 2;
    }
  }

  // -- textures -------------------------------------------------------------

  private ensureAtlasTexture(): TextureLike {
    if (this.atlasTexture) return this.atlasTexture;
    const three = this.three;
    const tex = new three.CanvasTexture(this.atlas.canvas) as unknown as TextureLike;
    tex.colorSpace = three.SRGBColorSpace;
    tex.minFilter = three.LinearFilter;
    tex.magFilter = three.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.atlasTexture = tex;
    return tex;
  }

  /** Texture clone windowed onto the atlas rect of `cp` (-1 = fallback). */
  private textureFor(cp: number): TextureLike {
    const key = this.atlas.has(cp) ? cp : -1;
    const cached = this.glyphTextures.get(key);
    if (cached) return cached;
    const rect = this.atlas.rect(key);
    const tex = this.ensureAtlasTexture().clone();
    // Canvas rows run top-down; three's default flipY puts v = 0 at the
    // bottom, so the offset counts from the bottom edge.
    tex.repeat.set(rect.w, rect.h);
    tex.offset.set(rect.u, 1 - rect.v - rect.h);
    tex.needsUpdate = true;
    this.glyphTextures.set(key, tex);
    return tex;
  }

  private disposeGlyphTextures(): void {
    for (const tex of this.glyphTextures.values()) tex.dispose();
    this.glyphTextures.clear();
    this.atlasTexture?.dispose();
    this.atlasTexture = null;
  }

  private ensureDecalTextures(): void {
    if (this.arrowTexture && this.dotTexture) return;
    if (typeof document === 'undefined') return;
    const three = this.three;
    const make = (draw: (ctx: CanvasRenderingContext2D, size: number) => void): TextureLike | null => {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = '#ffffff';
      draw(ctx, size);
      const tex = new three.CanvasTexture(canvas) as unknown as TextureLike;
      tex.colorSpace = three.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    };
    this.arrowTexture ??= make((ctx, size) => {
      // Chevron pointing up.
      ctx.beginPath();
      ctx.moveTo(size * 0.5, size * 0.14);
      ctx.lineTo(size * 0.86, size * 0.62);
      ctx.lineTo(size * 0.66, size * 0.62);
      ctx.lineTo(size * 0.66, size * 0.88);
      ctx.lineTo(size * 0.34, size * 0.88);
      ctx.lineTo(size * 0.34, size * 0.62);
      ctx.lineTo(size * 0.14, size * 0.62);
      ctx.closePath();
      ctx.fill();
    });
    this.dotTexture ??= make((ctx, size) => {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}
