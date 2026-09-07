/**
 * ColonyCanvas — the living picture of a LOOM colony (lib/colony.ts).
 *
 * Nothing here is a rigid circle. The pieces, each ported from a pen whose
 * code lives in the sibling module (see their headers for the sources):
 *
 *   gooeyOrb.ts        loops and colonies ARE the liquid gooey orb: a
 *                      raymarched blob with swirling liquid inside, drawn per
 *                      cell into a WebGL2 atlas and composited here. A loop is
 *                      a solid orb in its stem's colours that swells and
 *                      brightens when it fires; a colony is a glass bubble
 *                      with its cells inside. Gates, mods and rules take their
 *                      outline from the same lobed field.
 *   creatureBonds.ts   the physics: cells are creatures with a muscle phase,
 *                      bonds that breathe and pass their phase down the chain.
 *                      Seconds-based, honey-viscous, speed-capped at ~1 px/s.
 *   tendril.ts         every connection is a Verlet rope grown between the two
 *                      membranes: it sags, swings, goes taut and creeps, and
 *                      both its ends are buried INSIDE the cells they join.
 *   hyphae.ts          when a loop fires it seeds hyphal tips that grow,
 *                      branch and fuse into a fungal network with nutrient
 *                      particles running its trunks.
 *   hexFloor.ts        the dish floor is a hex lattice; a fire crystallizes
 *                      outward across it in the cell's hue.
 *   lifeStack.ts       a Life rule shows its actual grid, and its generations
 *                      stacked up behind it as lit cubes.
 *
 * Nothing moves fast. The physics runs on a fixed 1/120 s step out of a ref
 * (so it is identical on a 60, 120 or 240 Hz display, and survives the effect
 * remounting on every click); a cell creeps at about a pixel a second; a
 * breath takes half a minute; the hex floor crystallizes outward at ~25 px/s
 * instead of 1800; the mycelium advances 3 px/s instead of 113. The camera
 * chases a low-passed target over seconds, so no cell twitch is ever
 * multiplied into a whole-screen shake.
 *
 * A cell's size, light and sound follow its VITALITY (the
 * growth bookkeeping in the store): it divides off its parent at nothing and
 * ripens over a few bars; a withering cell is eaten from the inside — a hole
 * opens in it — before it goes. A colony's membrane grows around the cell it
 * enveloped. The orbs move on the CLOCK, not the wall: one lobe cycle per
 * loop length, lobes by the loop's grain, swirl by the shard's energy, the
 * second colour by the shard's key, so the picture is the music. Wires are
 * tendrils: translucent strands that wobble with the muscle phase, no solid
 * line anywhere but text and the few indicators that must be crisp.
 *
 * Coordinates: the Shell scales the DAW with CSS `zoom`, so `clientWidth`
 * (local px) and `getBoundingClientRect()` / `event.clientX` (viewport px)
 * disagree by that factor. Everything here draws in LOCAL css px via
 * lib/canvasScale, and every pointer event is divided by the same zoom — at
 * the 1.1 zoom a 1920-wide window gets, skipping that put the hit test ~80 px
 * off the picture.
 *
 * Mouse only: click the lone spore to begin; drag a cell to move it; drag
 * from a cell's NUB (the dot on its right) — or from anywhere on it with WIRE
 * on — to another cell to wire them; click a wire to inspect it; right-click
 * for cells and wires; wheel to zoom; double-click a colony to dive, Escape
 * or SURFACE to come back. The toolbar's + buttons add cells into the dish
 * you are looking at.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getEngineCtx } from '../../state/playerStore';
import { colonyResolvedFor, colonyVitality, colonyWithering, subscribeColonyEvents, useLoomStore, type ColonyKind, type NodePos } from '../../state/loomStore';
import { beatClock } from '../../lib/beatClock';
import { camelotCode } from '../../lib/loomKey';
import { canWire, groupStarts, meterText, ruleTile, symbolIndex, type ColonyEdge, type ColonyGraph, type ColonyNode } from '../../lib/colony';
import { GEN_GLYPH, genCell, generationOf, lifeGrid } from '../../lib/loomGen';
import { serializeQuery } from '../../lib/loomScore';
import type { ColonyEvent } from '../../lib/colonyEngine';
import { DEFAULT_SEED } from '../../lib/loomEngine';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { cellColor, hexToRgb, KIND_COLOR, membraneColor, onLight, rgba, ROLE_COLOR, SELECT, SELECT_HALO, SPARK, WIRE_DRAFT } from '../../lib/loomPalette';
import { effectiveZoom, fitCanvas, scaleContextToBox } from '../../lib/canvasScale';
import { blobPath, blobRadius, ORB_BASE, OrbAtlas, type OrbParams, type OrbRegion } from './gooeyOrb';
import { align, GENOMES, integrate, interact, makeCreature, type Creature } from './creatureBonds';
import { drawRibbon, easeAngle, GROW_SEC, makeRope, ropeAt, ropeDistance, stepRope, type Rope } from './tendril';
import { Hyphae } from './hyphae';
import { HexFloor } from './hexFloor';
import { drawLifeGrid, drawLifeStack } from './lifeStack';

interface Body {
  key: string;
  node: ColonyNode;
  graph: ColonyGraph;
  path: string[];
  depth: number;
  pos: NodePos; // colony-local
  creature: Creature;
  radius: number;
  parent: string | null;
  /** performance.now() the cell appeared. */
  born: number;
  /** Last fire, for the orb's swell. */
  fired: number;
  /** 0..1 this frame (newborn or withering → 0, ripe → 1). */
  vit: number;
  /** Eaten from the inside. */
  withering: boolean;
}

interface Pulse { key: string; at: number; ttl: number; kind: 'fire' | 'trigger' | 'bar' | 'end' }
interface Spark { from: string; to: string; at: number; dur: number }
interface StepMark { key: string; step: number; symbol: number | null; at: number }
interface Ghost { key: string; node: ColonyNode; x: number; y: number; k: number; at: number; color: string }
interface EdgeHit { parent: string | null; edge: ColonyEdge; fromKey: string; toKey: string }
interface MenuPayload { key: string | null; edge: EdgeHit | null; world: NodePos; parent: string | null }
type Region = OrbRegion & { body: Body; size: number };

/** How much smaller a nested dish's cells are. Too small and a colony that
 *  envelops half the score becomes an unreadable pellet. */
const SCALE_PER_DEPTH = 0.55;
const COLONY_RADIUS_BASE = 150;
const BIRTH_MS = 700;
const DEATH_MS = 650;
const RADIUS: Record<ColonyNode['kind'], number> = { loop: 27, rule: 23, gate: 16, mod: 16, colony: COLONY_RADIUS_BASE };
/** The orb's silhouette is ~0.48 of its region: region = diameter / 0.48. */
const ORB_REGION = 4.3;
const ORB_MAX_PX = 288;

const easeOut = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
/** Fixed physics step. Everything that moves advances on this, never per frame. */
const PHYS_H = 1 / 120;
const PHYS_MAX_SUB = 6;

export const ColonyCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const applied = useLoomStore((s) => s.colonyApplied);
  const positions = useLoomStore((s) => s.colonyPositions);
  const selected = useLoomStore((s) => s.colonySelected);
  const selectedEdge = useLoomStore((s) => s.colonySelectedEdge);
  const focus = useLoomStore((s) => s.colonyFocus);
  const running = useLoomStore((s) => s.running);
  const seed = useLoomStore((s) => s.colonyApplied.seed ?? DEFAULT_SEED);
  const form = useLoomStore((s) => s.colonyApplied.form);
  const select = useLoomStore((s) => s.selectColony);
  const selectEdge = useLoomStore((s) => s.selectColonyEdge);
  const setFocus = useLoomStore((s) => s.setColonyFocus);
  const setPosition = useLoomStore((s) => s.setColonyPosition);
  const addEdge = useLoomStore((s) => s.addColonyEdge);
  const addNode = useLoomStore((s) => s.addColonyNode);
  const removeNode = useLoomStore((s) => s.removeColonyNode);
  const duplicateNode = useLoomStore((s) => s.duplicateColonyNode);
  const removeEdge = useLoomStore((s) => s.removeColonyEdge);
  const growNow = useLoomStore((s) => s.growNow);
  const [wireMode, setWireMode] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const menu = useContextMenu<MenuPayload>();

  const bodies = useRef<Map<string, Body>>(new Map());
  const ghosts = useRef<Ghost[]>([]);
  const pulses = useRef<Pulse[]>([]);
  const sparks = useRef<Spark[]>([]);
  const steps = useRef<Map<string, StepMark>>(new Map());
  const laps = useRef<Map<string, number>>(new Map());
  const pending = useRef<ColonyEvent[]>([]);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ key: string; dx: number; dy: number; moved: boolean } | null>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const wire = useRef<{ fromKey: string; x: number; y: number } | null>(null);
  const hover = useRef<string | null>(null);
  const focusRef = useRef<string | null>(null);
  const wireModeRef = useRef(false);
  /** The hex floor lives on its own layer that fades by destination-in. */
  const floorCanvas = useRef<HTMLCanvasElement | null>(null);
  const floor = useRef<HexFloor | null>(null);
  const hyphae = useRef<Hyphae | null>(null);
  const atlas = useRef<OrbAtlas | null>(null);
  const ink = useRef<string>('255,255,255');
  /** The shell's cumulative CSS zoom, refreshed every frame. */
  const zoomRef = useRef(1);
  /** One Verlet strand per wire, keyed parent|from|to. Lives in a ref because
   *  the frame effect is torn down on every selection change. */
  const ropes = useRef<Map<string, Rope>>(new Map());
  /** This frame's strands in screen px, for hit testing and the inspector. */
  const ropeScreens = useRef<Map<string, { pts: { x: number; y: number }[]; live: number; parent: string | null; edge: ColonyEdge }>>(new Map());
  /** Fixed-step accumulator and wall clock, likewise outliving the effect. */
  const physAcc = useRef(0);
  const lastT = useRef(performance.now());
  /** The camera chases this, and this chases the focused cell — two slow
   *  filters, so physics jitter never reaches the viewport. */
  const camTarget = useRef({ x: 0, y: 0, k: 1 });
  const selRef = useRef<string | null>(null);
  const selEdgeRef = useRef<typeof selectedEdge>(null);
  const first = useRef(true);
  selRef.current = selected;
  selEdgeRef.current = selectedEdge;
  focusRef.current = focus;
  wireModeRef.current = wireMode;

  /* ── bodies from the score: births bloom, deaths shrivel ───────────── */
  useEffect(() => {
    const now = performance.now();
    const next = new Map<string, Body>();
    const walk = (g: ColonyGraph, path: string[], depth: number, parent: string | null) => {
      const n = g.nodes.length || 1;
      g.nodes.forEach((node, i) => {
        const key = [...path, node.id].join('/');
        const prev = bodies.current.get(key);
        const ring = (node.kind === 'colony' ? 120 : 80) + n * 6;
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const saved = positions[key];
        const pos = prev?.pos ?? saved ?? { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
        const radius = node.kind === 'colony' ? COLONY_RADIUS_BASE + node.graph.nodes.length * 26 : RADIUS[node.kind];
        // Personal space is sized for the label, not the body: two cells 110 px
        // apart still have their names on top of each other.
        const creature = prev?.creature ?? makeCreature(pos.x, pos.y, GENOMES[node.kind], radius + 58);
        creature.skin = radius + 58;
        next.set(key, { key, node, graph: g, path, depth, pos, creature, radius, parent, born: prev?.born ?? (first.current ? now - BIRTH_MS : now), fired: prev?.fired ?? -1e9, vit: prev?.vit ?? 0, withering: false });
        if (node.kind === 'colony') walk(node.graph, [...path, node.id], depth + 1, key);
      });
    };
    walk(applied.root, [], 0, null);
    // Whoever is gone leaves a ghost where it stood.
    for (const b of bodies.current.values()) {
      if (next.has(b.key)) continue;
      const w = worldOfIn(bodies.current, b);
      const light = canvasRef.current?.closest('[data-et-light]') != null;
      ghosts.current.push({ key: b.key, node: b.node, x: w.x, y: w.y, k: w.k, at: now, color: cellColor(b.node.kind, b.node.kind === 'loop' ? b.node.query.role : undefined, light) });
    }
    bodies.current = next;
    first.current = false;
  }, [applied, positions]);

  /* ── events from the engine ────────────────────────────────────────── */
  useEffect(() => subscribeColonyEvents((e) => { pending.current.push(e); }), []);
  useEffect(() => { if (!running) { pulses.current = []; sparks.current = []; steps.current.clear(); laps.current.clear(); } }, [running]);

  /* ── world transforms ──────────────────────────────────────────────── */
  const worldOf = useCallback((b: Body) => worldOfIn(bodies.current, b), []);

  /* ── the frame ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const cs = getComputedStyle(canvas);
    ink.current = cs.getPropertyValue('--et-ink').trim() || '255,255,255';
    if (!floorCanvas.current) floorCanvas.current = document.createElement('canvas');
    if (!floor.current) floor.current = new HexFloor();
    if (!hyphae.current) hyphae.current = new Hyphae();
    if (!atlas.current) atlas.current = new OrbAtlas();
    const floorEl = floorCanvas.current;
    const floorCtx = floorEl.getContext('2d');
    const hex = floor.current;
    const fungus = hyphae.current;
    const orbs = atlas.current;
    let raf = 0;
    lastT.current = performance.now();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - lastT.current) / 1000);
      lastT.current = now;
      // One unit = one LOCAL css px; the backing store covers zoom * dpr of them.
      const box = fitCanvas(canvas, canvas, { maxDpr: 2 });
      const W = box.cssWidth;
      const H = box.cssHeight;
      zoomRef.current = box.zoom;
      if (floorEl.width !== box.deviceWidth || floorEl.height !== box.deviceHeight) {
        floorEl.width = box.deviceWidth;
        floorEl.height = box.deviceHeight;
        hex.build(W, H);
      }
      scaleContextToBox(ctx2d, box);
      const isLight = canvas.closest('[data-et-light]') != null;
      const bg = isLight ? '248,246,242' : '7,5,10';
      const bgHex = isLight ? '#f8f6f2' : '#07050a';
      const audioNow = getEngineCtx().currentTime;
      const t = now / 1000;
      const v = view.current;
      const toScreen = (wx: number, wy: number) => ({ x: W / 2 + (wx - v.x) * v.k, y: H / 2 + (wy - v.y) * v.k });
      // The clock the orbs move on: bars (fractional) while playing; a slow drift when not.
      const isRunning = useLoomStore.getState().running;
      const ph = beatClock.phase(audioNow);
      const bars = isRunning ? ph.bar + ph.barFrac : t * 0.05;
      const beatSec = beatClock.beatSec();
      for (const b of bodies.current.values()) { b.vit = colonyVitality(b.key); b.withering = colonyWithering(b.key); }

      // Due events become pulses / sparks / step marks — and light the floor, seed the fungus.
      const still: ColonyEvent[] = [];
      for (const e of pending.current) {
        if (e.at > audioNow + 0.02) { still.push(e); continue; }
        const key = e.path.join('/');
        if (e.kind === 'fire') {
          pulses.current.push({ key, at: now, ttl: 2600, kind: 'fire' });
          const b = bodies.current.get(key);
          if (b) {
            b.fired = now;
            const w = worldOf(b);
            const p = toScreen(w.x, w.y);
            const col = cellColor(b.node.kind, b.node.kind === 'loop' ? b.node.query.role : undefined, isLight);
            hex.ignite(p.x, p.y, hueOf(col), 0.45 + 0.35 * b.vit);
            if (!reduced) fungus.seed(w.x, w.y, 2, 1.6, col);
          }
        } else if (e.kind === 'trigger' && e.edge) {
          // A spark crawls its strand over a beat and a half, not a fifth of a second.
          sparks.current.push({ from: [...e.path.slice(0, -1), e.edge.from].join('/'), to: key, at: now, dur: Math.max(900, beatSec * 1500) });
          pulses.current.push({ key, at: now, ttl: 1400, kind: 'trigger' });
        } else if (e.kind === 'end') pulses.current.push({ key, at: now, ttl: 1600, kind: 'end' });
        else if (e.kind === 'step') steps.current.set(key, { key, step: e.step ?? 0, symbol: e.symbol ?? null, at: now });
        else if (e.kind === 'bar') { laps.current.set(key, e.lap ?? 0); pulses.current.push({ key: key || '@root', at: now, ttl: Math.max(1800, beatSec * 4000), kind: 'bar' }); }
      }
      pending.current = still;
      pulses.current = pulses.current.filter((p) => now - p.at < p.ttl);
      sparks.current = sparks.current.filter((s) => now - s.at < s.dur);
      ghosts.current = ghosts.current.filter((g) => now - g.at < DEATH_MS);

      // Physics: creatures with a muscle phase, wires as breathing bonds — per colony, in local space.
      const list = [...bodies.current.values()];
      const byParent = new Map<string | null, Body[]>();
      for (const b of list) { const arr = byParent.get(b.parent) ?? []; arr.push(b); byParent.set(b.parent, arr); }
      // A fixed step, so the colony crawls at the same speed on any display.
      physAcc.current = Math.min(physAcc.current + dt, PHYS_H * PHYS_MAX_SUB);
      const physSteps = reduced && !drag.current ? 0 : Math.floor(physAcc.current / PHYS_H);
      physAcc.current -= physSteps * PHYS_H;
      for (let sN = 0; sN < physSteps; sN += 1) {
        for (const [parent, group] of byParent) {
          const graph = parent ? (bodies.current.get(parent)?.node as { graph?: ColonyGraph })?.graph : applied.root;
          const dishR = parent ? (bodies.current.get(parent)?.radius ?? 100) / SCALE_PER_DEPTH * 0.78 : Math.min(W, H) * 0.44;
          const bonds = new Set<string>();
          for (const e of graph?.edges ?? []) { bonds.add(`${e.from}|${e.to}`); bonds.add(`${e.to}|${e.from}`); }
          for (const a of group) { a.creature.links = 0; a.creature.x = a.pos.x; a.creature.y = a.pos.y; }
          for (const a of group) {
            const mates: Creature[] = [];
            for (const b of group) {
              if (a === b) continue;
              const bonded = bonds.has(`${a.node.id}|${b.node.id}`);
              const res = interact(a.creature, b.creature, bonded, PHYS_H);
              if (bonded && res && res.force > -0.001) mates.push(b.creature);
            }
            align(a.creature, mates, PHYS_H);
          }
          for (const a of group) {
            const held = drag.current?.key === a.key;
            integrate(a.creature, { viscosity: 0.18, gravity: a.node.kind === 'colony' ? 0.0015 : 0.0008, cx: 0, cy: 0, dishR }, held, PHYS_H);
            if (!held) { a.pos.x = a.creature.x; a.pos.y = a.creature.y; }
          }
        }
      }

      // Camera: the focused colony fills the dish.
      const target = focusRef.current ? bodies.current.get(focusRef.current) : null;
      if (target) {
        const w = worldOf(target);
        const camK = Math.min(W, H) / (target.radius * 2.6) / (w.k || 1);
        // Filter the TARGET first (2 s), then chase it (1.7 s / 2.5 s). Two
        // cascaded filters mean no cell twitch ever reaches the viewport.
        const kt = 1 - Math.exp(-0.5 * dt);
        camTarget.current.x += (w.x - camTarget.current.x) * kt;
        camTarget.current.y += (w.y - camTarget.current.y) * kt;
        camTarget.current.k += (camK - camTarget.current.k) * kt;
        const ax = 1 - Math.exp(-0.6 * dt);
        const ak = 1 - Math.exp(-0.4 * dt);
        v.x += (camTarget.current.x - v.x) * ax;
        v.y += (camTarget.current.y - v.y) * ax;
        v.k += (camTarget.current.k - v.k) * ak;
      } else {
        camTarget.current = { x: v.x, y: v.y, k: v.k };
      }

      // Background: the dish, cleared clean, then the crystallizing hex floor.
      ctx2d.fillStyle = `rgb(${bg})`;
      ctx2d.fillRect(0, 0, W, H);
      if (floorCtx) {
        scaleContextToBox(floorCtx, box);
        hex.tick(floorCtx);
        ctx2d.globalAlpha = isLight ? 0.4 : 0.55;
        ctx2d.drawImage(floorEl, 0, 0, W, H);
        ctx2d.globalAlpha = 1;
      }

      // The fungal network, in world space under the cells.
      // Real seconds now, and a quarter-speed creep on top.
      if (!reduced) fungus.update(dt, W / v.k + Math.abs(v.x) * 2 + 400, H / v.k + Math.abs(v.y) * 2 + 400, 0.25);
      ctx2d.save();
      ctx2d.translate(W / 2 - v.x * v.k, H / 2 - v.y * v.k);
      ctx2d.scale(v.k, v.k);
      fungus.draw(ctx2d, isLight);
      ctx2d.restore();

      // Root bar pulse: a soft ring breathing out from the centre.
      const rootBar = pulses.current.find((x) => x.key === '@root' && x.kind === 'bar');
      if (rootBar) {
        const tt = (now - rootBar.at) / rootBar.ttl;
        const c = toScreen(0, 0);
        ctx2d.beginPath();
        ctx2d.arc(c.x, c.y, (40 + tt * Math.min(W, H) * 0.5) * v.k, 0, Math.PI * 2);
        ctx2d.strokeStyle = `rgba(${ink.current},${(1 - tt) * 0.18})`;
        ctx2d.lineWidth = 2;
        ctx2d.stroke();
      }

      const ordered = list.slice().sort((a, b) => a.depth - b.depth);
      // A cell is as big as it is alive: it divides off at nothing and ripens over bars.
      const bornScale = (b: Body) => 0.12 + 0.88 * easeOut(b.vit);

      // Orbs: loops and colonies, one WebGL region each, this frame.
      const regions: Region[] = [];
      for (const b of ordered) {
        if (b.node.kind !== 'loop' && b.node.kind !== 'colony') continue;
        const w = worldOf(b);
        const r = b.radius * w.k * v.k * bornScale(b);
        if (r < 3) continue;
        const p = toScreen(w.x, w.y);
        const size = r * ORB_REGION;
        if (p.x + size < 0 || p.y + size < 0 || p.x - size > W || p.y - size > H) continue;
        const px = Math.min(ORB_MAX_PX, Math.max(24, Math.round(size * Math.min(box.scale, 1.5))));
        const beats = b.node.kind === 'loop' ? b.node.beats : b.node.graph.meter.num * 4 / b.node.graph.meter.den;
        // One lobe cycle per loop length; a colony breathes with its own bar.
        const cycles = b.node.kind === 'loop' ? (bars * 4) / Math.max(0.5, beats) : bars * (b.node.graph.tempo || 1);
        regions.push({ x: 0, y: 0, w: px, h: px, params: orbParamsFor(b, now, isLight, bgHex, selRef.current === b.key, hover.current === b.key, beatSec), time: cycles, body: b, size });
      }
      const placed = (orbs.ok && regions.length ? orbs.draw(regions) : []) as Region[];
      // A cell's rim model depends on whether it actually got an atlas region
      // this frame — it can lose one by scrolling off or filling the atlas.
      const orbBodies = new Set<Body>(placed.map((r) => r.body));
      const drawOrb = (b: Body): boolean => {
        const reg = placed.find((r) => r.body === b);
        if (!reg) return false;
        const w = worldOf(b);
        const p = toScreen(w.x, w.y);
        ctx2d.drawImage(orbs.canvas, reg.x, reg.y, reg.w, reg.h, p.x - reg.size / 2, p.y - reg.size / 2, reg.size, reg.size);
        return true;
      };

      // Colonies: glass bubbles first, deepest last.
      for (const b of ordered) {
        if (b.node.kind !== 'colony') continue;
        const w = worldOf(b);
        const p = toScreen(w.x, w.y);
        const r = b.radius * w.k * v.k * bornScale(b);
        const lap = laps.current.get(b.key) ?? 0;
        const col = membraneColor(hash(b.key), isLight);
        const isSel = selRef.current === b.key;
        if (!drawOrb(b)) {
          ctx2d.beginPath();
          blobPath(ctx2d, p.x, p.y, r, t, 'round', hash(b.key) % 7, 0.18);
          ctx2d.fillStyle = rgba(col, 0.12);
          ctx2d.fill();
          ctx2d.strokeStyle = rgba(col, 0.7);
          ctx2d.lineWidth = 2;
          ctx2d.stroke();
        }
        if (isSel) {
          ctx2d.beginPath();
          blobPath(ctx2d, p.x, p.y, r * 1.02, t, 'round', hash(b.key) % 7, 0.18);
          ctx2d.strokeStyle = SELECT_HALO;
          ctx2d.lineWidth = 2.5;
          ctx2d.setLineDash([7, 6]);
          ctx2d.stroke();
          ctx2d.setLineDash([]);
        }
        // Meter ring: group boundaries as ticks, riding the lobed rim.
        const g = b.node.graph;
        const starts = groupStarts(g.meter, g.meter.num);
        for (let i = 0; i < g.meter.num; i += 1) {
          const ang = (i / g.meter.num) * Math.PI * 2 - Math.PI / 2;
          const rr = r * blobRadius(ang, t, { deform: 0.18, z: hash(b.key) % 7, frequency: 1.6 });
          const big = starts.includes(i);
          ctx2d.beginPath();
          ctx2d.moveTo(p.x + Math.cos(ang) * (rr - (big ? 12 : 6)), p.y + Math.sin(ang) * (rr - (big ? 12 : 6)));
          ctx2d.lineTo(p.x + Math.cos(ang) * rr, p.y + Math.sin(ang) * rr);
          ctx2d.strokeStyle = rgba(col, big ? 0.95 : 0.5);
          ctx2d.lineWidth = big ? 2.5 : 1.2;
          ctx2d.stroke();
        }
        if (r > 24 && b.vit > 0.3) label(ctx2d, `${b.node.id} · ${meterText(g.meter)}${g.tempo !== 1 ? ` ×${g.tempo}` : ''} · bar ${lap + 1}`, p.x, p.y - r - 10, Math.max(11, Math.min(15, 13 * Math.min(1.2, v.k))), col, bg, 'center', true);
        if (b.vit > 0.5) drawNub(ctx2d, p.x + r + 10, p.y, hover.current === b.key || isSel, col, bg);
      }

      // Tendrils: one Verlet strand per wire, simulated in the dish's own
      // local space (never screen space, or panning would whip them all).
      const graphs: { graph: ColonyGraph; parentKey: string | null }[] = [{ graph: applied.root, parentKey: null }];
      for (const b of ordered) if (b.node.kind === 'colony') graphs.push({ graph: b.node.graph, parentKey: b.key });
      const seenRopes = new Set<string>();
      ropeScreens.current.clear();
      for (const { graph, parentKey } of graphs) {
        for (const e of graph.edges) {
          const a = bodies.current.get(parentKey ? `${parentKey}/${e.from}` : e.from);
          const c = bodies.current.get(parentKey ? `${parentKey}/${e.to}` : e.to);
          if (!a || !c) continue;
          const rkey = `${parentKey ?? ''}|${e.from}|${e.to}`;
          seenRopes.add(rkey);
          const self = a === c;
          const col = cellColor(a.node.kind, a.node.kind === 'loop' ? a.node.query.role : undefined, isLight);
          const colTo = cellColor(c.node.kind, c.node.kind === 'loop' ? c.node.query.role : undefined, isLight);
          const isSel = !!(selEdgeRef.current && selEdgeRef.current.parent === parentKey && selEdgeRef.current.from === e.from && selEdgeRef.current.to === e.to);
          const alive = sparks.current.some((sp) => sp.from === a.key && sp.to === c.key);

          let rope = ropes.current.get(rkey);
          // Anchor angles: eased around each membrane, aimed at the strand's
          // own next point, so the root slides as the strand swings.
          const guessA = rope ? rope.pts[1] : { x: c.pos.x, y: c.pos.y };
          const guessB = rope ? rope.pts[Math.max(1, rope.live - 1)] : { x: a.pos.x, y: a.pos.y };
          const thA = easeAngle(rope?.thA ?? null, self ? { x: a.pos.x + 40, y: a.pos.y - 40 } : guessA, a.pos, dt);
          const thB = easeAngle(rope?.thB ?? null, self ? { x: c.pos.x - 40, y: c.pos.y - 40 } : guessB, c.pos, dt);
          const rimA = rimRadius(a, thA, t, orbBodies.has(a)) * (orbBodies.has(a) ? 0.90 : 0.94);
          const rimB = rimRadius(c, thB, t, orbBodies.has(c)) * (orbBodies.has(c) ? 0.90 : 0.94);
          const A = { x: a.pos.x + Math.cos(thA) * rimA, y: a.pos.y + Math.sin(thA) * rimA };
          const B = { x: c.pos.x + Math.cos(thB) * rimB, y: c.pos.y + Math.sin(thB) * rimB };
          if (!rope) {
            rope = makeRope(A.x, A.y, B.x, B.y, 12, hash(rkey) % 2 ? 1 : -1, now, self);
            ropes.current.set(rkey, rope);
          }
          rope.thA = thA;
          rope.thB = thB;
          // Bow sideways rather than down: a dish has no "down".
          let bx = -(B.y - A.y);
          let by = B.x - A.x;
          const bl = Math.hypot(bx, by) || 1;
          bx = (bx / bl) * rope.bow * 14;
          by = (by / bl) * rope.bow * 14;
          if (!reduced || drag.current) {
            stepRope(rope, dt, A, B, { bowX: bx, bowY: by, nAx: Math.cos(thA), nAy: Math.sin(thA), phase: a.creature.phase }, Math.random());
          }

          // Local -> screen, once, for drawing and hit testing alike.
          const wa = worldOf(a);
          const pts: { x: number; y: number }[] = [];
          for (const q of rope.pts) {
            const wx = wa.x + (q.x - a.pos.x) * wa.k;
            const wy = wa.y + (q.y - a.pos.y) * wa.k;
            pts.push(toScreen(wx, wy));
          }
          ropeScreens.current.set(rkey, { pts, live: rope.live, parent: parentKey, edge: e });

          const life = Math.min(a.vit, c.vit);
          const k2 = wa.k * v.k;
          drawRibbon(ctx2d, pts, rope.live, {
            colA: rgba(isSel ? SELECT_HALO : col, 1),
            colB: rgba(isSel ? SELECT_HALO : colTo, 1),
            alpha: (isSel ? 0.75 : alive ? 0.62 : 0.42) * (0.3 + 0.7 * life),
            mid: (3.4 + (alive ? 1.6 : 0)) * Math.max(0.5, Math.min(1.6, k2)),
            flareA: rimA * 0.42 * k2,
            flareB: rimB * 0.42 * k2,
            fused: rope.grow >= 1 ? 1 : 0,
            core: isSel ? rgba(SELECT, 0.9) : null,
          });

          // The fusion bloom: a one-off flash where the tip finally reaches.
          const sinceFuse = rope.grow >= 1 ? (now - rope.born) / 1000 - GROW_SEC : -1;
          if (sinceFuse >= 0 && sinceFuse < 1.2) {
            const f = 1 - sinceFuse / 1.2;
            const q = pts[rope.live];
            if (q) {
              const gr = ctx2d.createRadialGradient(q.x, q.y, 0, q.x, q.y, 18 * f + 6);
              gr.addColorStop(0, rgba(SPARK, 0.75 * f));
              gr.addColorStop(1, rgba(col, 0));
              ctx2d.fillStyle = gr;
              ctx2d.beginPath();
              ctx2d.arc(q.x, q.y, 18 * f + 6, 0, Math.PI * 2);
              ctx2d.fill();
            }
          }

          // A bead of charge creeping the strand, on its own arc length.
          for (const sp of sparks.current) {
            if (sp.from !== a.key || sp.to !== c.key) continue;
            const tt = Math.max(0, Math.min(1, (now - sp.at) / sp.dur));
            const q = ropeAt(pts, rope.live, tt);
            const gg = ctx2d.createRadialGradient(q.x, q.y, 0, q.x, q.y, 10);
            gg.addColorStop(0, rgba(SPARK, 0.9));
            gg.addColorStop(0.45, rgba(col, 0.45));
            gg.addColorStop(1, rgba(col, 0));
            ctx2d.fillStyle = gg;
            ctx2d.beginPath();
            ctx2d.arc(q.x, q.y, 10, 0, Math.PI * 2);
            ctx2d.fill();
          }
          if (e.on != null) {
            const m = ropeAt(pts, rope.live, 0.5);
            label(ctx2d, `on ${e.on}`, m.x, m.y - 9, 11, col, bg, 'center', true);
          }
        }
      }
      // Strands whose wire is gone go with it.
      for (const k of [...ropes.current.keys()]) if (!seenRopes.has(k)) ropes.current.delete(k);

      // Wire being dragged.
      if (wire.current) {
        const a = bodies.current.get(wire.current.fromKey);
        if (a) {
          const wa = worldOf(a);
          const pa = toScreen(wa.x, wa.y);
          const wx = wire.current.x;
          const wy = wire.current.y;
          const mx = (pa.x + wx) / 2 + (wy - pa.y) * 0.16;
          const my = (pa.y + wy) / 2 - (wx - pa.x) * 0.16;
          const feel: { x: number; y: number }[] = [];
          for (let i = 0; i <= 14; i += 1) {
            const u = i / 14;
            feel.push({ x: (1 - u) * (1 - u) * pa.x + 2 * (1 - u) * u * mx + u * u * wx, y: (1 - u) * (1 - u) * pa.y + 2 * (1 - u) * u * my + u * u * wy });
          }
          drawRibbon(ctx2d, feel, 14, { colA: rgba(WIRE_DRAFT, 1), colB: rgba(WIRE_DRAFT, 1), alpha: 0.5, mid: 2.4, flareA: a.radius * 0.4, flareB: 0, fused: 0, core: null });
          const tgt = hover.current ? bodies.current.get(hover.current) : null;
          const ok = tgt && tgt.key !== a.key && tgt.parent === a.parent && canWire(a.node, tgt.node);
          const self = tgt && tgt.key === a.key && canWire(a.node, tgt.node);
          ctx2d.beginPath();
          ctx2d.arc(wire.current.x, wire.current.y, 6, 0, Math.PI * 2);
          ctx2d.fillStyle = ok || self ? WIRE_DRAFT : tgt ? '#ff5d8f' : rgba(WIRE_DRAFT, 0.5);
          ctx2d.fill();
        }
      }

      // Cells.
      for (const b of ordered) {
        if (b.node.kind === 'colony') continue;
        const w = worldOf(b);
        const p = toScreen(w.x, w.y);
        const k = w.k * v.k;
        const r = b.radius * k * bornScale(b);
        if (r < 2) continue;
        const n = b.node;
        const col = cellColor(n.kind, n.kind === 'loop' ? n.query.role : undefined, isLight);
        const fire = pulses.current.find((x) => x.key === b.key && x.kind === 'fire');
        const trig = pulses.current.find((x) => x.key === b.key && x.kind === 'trigger');
        const ended = pulses.current.find((x) => x.key === b.key && x.kind === 'end');
        const isSel = selRef.current === b.key;
        const isHover = hover.current === b.key;
        const young = b.vit < 1 && !b.withering;
        const z = hash(b.key) % 7;
        const breathe = 1 + Math.sin(b.creature.phase) * b.creature.genome.muscle * 0.08;
        if (fire) {
          const tt = (now - fire.at) / fire.ttl;
          ctx2d.beginPath();
          blobPath(ctx2d, p.x, p.y, r * (1 + tt * 1.8), t, 'round', z, 0.3);
          ctx2d.strokeStyle = rgba(col, (1 - tt) * 0.9);
          ctx2d.lineWidth = 2.5 * (1 - tt) + 0.5;
          ctx2d.stroke();
        }
        if (young) {
          // A newborn glows faintly while it ripens; the glow fades as it fills out.
          ctx2d.beginPath();
          blobPath(ctx2d, p.x, p.y, r * (1.3 + (1 - b.vit) * 1.2), t, 'round', z, 0.4);
          ctx2d.fillStyle = rgba(WIRE_DRAFT, (1 - b.vit) * 0.18);
          ctx2d.fill();
        }
        if (n.kind === 'loop') {
          // The liquid gooey orb, or a lobed blob if WebGL2 is unavailable.
          if (!drawOrb(b)) {
            ctx2d.beginPath();
            blobPath(ctx2d, p.x, p.y, r * breathe, t, 'round', z, 0.36);
            const grad = ctx2d.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.1, p.x, p.y, r);
            grad.addColorStop(0, rgba(col, trig || fire ? 0.95 : 0.7));
            grad.addColorStop(1, rgba(col, 0.3));
            ctx2d.fillStyle = grad;
            ctx2d.fill();
            ctx2d.strokeStyle = rgba(col, 1);
            ctx2d.lineWidth = 1.8;
            ctx2d.stroke();
          }
          if (isSel || isHover) {
            ctx2d.beginPath();
            blobPath(ctx2d, p.x, p.y, r * 1.18, t, 'round', z, 0.3);
            ctx2d.strokeStyle = isSel ? SELECT_HALO : rgba(col, 0.7);
            ctx2d.lineWidth = isSel ? 2 : 1.2;
            ctx2d.stroke();
          }
          if (ended) {
            const tt = (now - ended.at) / ended.ttl;
            ctx2d.beginPath();
            blobPath(ctx2d, p.x, p.y, r * (1.5 - tt * 0.6), t, 'round', z, 0.3);
            ctx2d.strokeStyle = rgba(col, (1 - tt) * 0.7);
            ctx2d.lineWidth = 1.5;
            ctx2d.setLineDash([3, 3]);
            ctx2d.stroke();
            ctx2d.setLineDash([]);
          }
        } else {
          // Rules, gates, mods: lobed outlines from the orb's field.
          const shape = n.kind === 'gate' ? 'diamond' : n.kind === 'mod' ? 'hex' : 'round';
          ctx2d.beginPath();
          blobPath(ctx2d, p.x, p.y, r * breathe, t, shape, z, n.kind === 'rule' ? 0.22 : 0.3);
          const grad = ctx2d.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.1, p.x, p.y, r);
          grad.addColorStop(0, rgba(col, trig || fire ? 0.95 : 0.6));
          grad.addColorStop(1, rgba(col, trig ? 0.6 : 0.22));
          ctx2d.fillStyle = grad;
          ctx2d.fill();
          ctx2d.lineWidth = isSel ? 3 : isHover ? 2.5 : 1.8;
          ctx2d.strokeStyle = isSel ? SELECT : rgba(col, 1);
          ctx2d.stroke();
          if (isSel) {
            ctx2d.beginPath();
            blobPath(ctx2d, p.x, p.y, r * 1.2, t, shape, z, 0.2);
            ctx2d.strokeStyle = rgba(SELECT_HALO, 0.8);
            ctx2d.lineWidth = 1.5;
            ctx2d.stroke();
          }
        }
        if (n.kind === 'rule') {
          const mark = steps.current.get(b.key);
          const lap = laps.current.get(b.parent ?? '') ?? 0;
          const tile = ruleTile(n);
          const live = mark && now - mark.at < 200 ? mark.step : -1;
          if (n.gen === 'life' && r >= 14) {
            // The Life grid itself, and its generations stacked behind it.
            const gen = generationOf(form, lap);
            const gens: boolean[][][] = [];
            for (let g = Math.max(0, gen - 4); g <= gen; g += 1) gens.push(lifeGrid(tile, seed, g));
            const grid = gens[gens.length - 1];
            const cols = grid[0]?.length ?? 1;
            const unit = Math.max(1.2, (r * 1.1) / Math.max(cols, grid.length));
            ctx2d.save();
            ctx2d.globalAlpha = 0.85;
            drawLifeStack(ctx2d, gens.slice(0, -1), p.x - (cols * unit * 0.87 - grid.length * unit * 0.87) / 2, p.y + r * 0.1, unit, hexToRgb(col));
            ctx2d.restore();
            const gw = r * 1.3; const gh = (gw / cols) * grid.length;
            drawLifeGrid(ctx2d, grid, p.x - gw / 2, p.y - gh / 2, gw, gh, 'triangle', col, live);
          } else {
            // Steps around the rim; the live one lit; symbols coloured.
            const gs = groupStarts(b.graph.meter, n.steps);
            for (let i = 0; i < n.steps; i += 1) {
              const ang = (i / n.steps) * Math.PI * 2 - Math.PI / 2;
              const rr = r * 1.4 * blobRadius(ang, t, { deform: 0.22, z, frequency: 1.6 });
              const cx = p.x + Math.cos(ang) * rr;
              const cy = p.y + Math.sin(ang) * rr;
              const sym = symbolIndex(genCell(tile, i, lap, seed, form, hash(b.key), 0)?.query ?? null);
              const lit = live === i;
              ctx2d.beginPath();
              ctx2d.arc(cx, cy, (lit ? 3.6 : sym != null ? 2.6 : 1.4) * Math.min(1.5, k + 0.5), 0, Math.PI * 2);
              ctx2d.fillStyle = lit ? SPARK : sym != null ? symbolColor(sym, isLight) : `rgba(${ink.current},${gs.includes(i) ? 0.7 : 0.3})`;
              ctx2d.fill();
            }
          }
        }
        if (b.withering) {
          // Consumed from the inside: a hole opens as the cell withers.
          const hole = r * (1 - b.vit) * 0.95;
          if (hole > 1) {
            ctx2d.beginPath();
            blobPath(ctx2d, p.x, p.y, hole, t, 'round', z + 3, 0.45);
            ctx2d.fillStyle = `rgba(${bg},0.92)`;
            ctx2d.fill();
            ctx2d.strokeStyle = rgba(col, 0.35);
            ctx2d.lineWidth = 1;
            ctx2d.stroke();
          }
        }
        if (r >= 7 && b.vit > 0.5) drawNub(ctx2d, p.x + r + 9, p.y, isHover || isSel, col, bg);
        if (r >= 7 && b.vit > 0.25) {
          const glyph = n.kind === 'rule' ? GEN_GLYPH[n.gen] : n.kind === 'loop' ? (n.query.role ?? 'mix').slice(0, 2).toUpperCase() : n.kind === 'gate' ? (n.pct != null ? '?' : '!') : n.mode === 'abs' ? '=' : '+';
          if (!(n.kind === 'rule' && n.gen === 'life' && r >= 14)) label(ctx2d, glyph, p.x, p.y + 0.5, Math.max(9, Math.min(18, r * (n.kind === 'loop' ? 0.62 : 0.95))), isLight ? '#111111' : '#ffffff', isLight ? '248,246,242' : '7,5,10', 'center', false, 'middle');
          // Nested cells are drawn at half scale but their names are not, so a
          // colony's contents would be a wall of overlapping text. Only the
          // dish you are actually looking at spells its cells out.
          if (k > 0.85 || isHover || isSel) {
            // The full line only for the cell you are pointing at or editing;
            // everything else just wears its name, or the dish is unreadable.
            const detail = isHover || isSel;
            const sub = !detail ? n.id
              : n.kind === 'loop' ? `${n.id} · ${n.beats}b${n.hold ? ' hold' : ''}${n.space !== 'fixed' ? ` · ${n.space}` : ''}`
              : n.kind === 'rule' ? `${n.id} · ${n.gen} ${n.steps}`
              : n.kind === 'gate' ? `${n.id} · ${n.pct != null ? `${n.pct}%` : `${(n.laps ?? []).join(',')}/${n.period}`}`
              : n.id;
            ctx2d.globalAlpha = detail ? 1 : 0.72;
            label(ctx2d, sub, p.x, p.y + r * 1.15 + 15, Math.max(11, Math.min(14, 12.5 * Math.min(1.2, k))), col, bg, 'center', true);
            ctx2d.globalAlpha = 1;
          }
        }
      }

      // The lone spore: breathe, and say so.
      if (!isRunning && list.length === 1) {
        const b = list[0];
        const w = worldOf(b);
        const p = toScreen(w.x, w.y);
        const r = b.radius * w.k * v.k;
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
        ctx2d.beginPath();
        blobPath(ctx2d, p.x, p.y, r * (1.6 + pulse * 0.5), t, 'round', 5, 0.3);
        ctx2d.strokeStyle = rgba(WIRE_DRAFT, 0.15 + pulse * 0.25);
        ctx2d.lineWidth = 2;
        ctx2d.stroke();
        label(ctx2d, 'click the spore to begin', p.x, p.y + r * 1.15 + 34, 13, `rgba(${ink.current},${0.6 + pulse * 0.4})`, bg, 'center', true);
      }

      // Ghosts of the dead.
      for (const g of ghosts.current) {
        const tt = (now - g.at) / DEATH_MS;
        const p = toScreen(g.x, g.y);
        const r = RADIUS[g.node.kind] * g.k * v.k * (1 - tt);
        if (r < 1) continue;
        ctx2d.beginPath();
        blobPath(ctx2d, p.x, p.y, r, t, 'round', hash(g.key) % 7, 0.5);
        ctx2d.strokeStyle = rgba(g.color, (1 - tt) * 0.8);
        ctx2d.lineWidth = 1.5;
        ctx2d.setLineDash([2, 3]);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
        if (tt < 0.6) label(ctx2d, '×', p.x, p.y, 14, g.color, bg, 'center', false, 'middle');
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [applied, seed, form, worldOf]);

  useEffect(() => () => { atlas.current?.dispose(); atlas.current = null; }, []);

  /* ── pointer ───────────────────────────────────────────────────────── */

  /**
   * A pointer event in the canvas's own LOCAL css px — the space the frame
   * draws in. `clientX` and `getBoundingClientRect()` are viewport px, i.e.
   * local * the shell's CSS zoom, so both the origin and the offset have to
   * come back through it (WaveformEditor and ChordStripCanvas do the same).
   */
  const toLocal = useCallback((e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const zoom = zoomRef.current || effectiveZoom(el) || 1;
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }, []);
  const screenOf = useCallback((b: Body) => {
    const canvas = canvasRef.current!;
    // clientWidth is already LOCAL css px, the same space the frame draws in.
    const W = canvas.clientWidth; const H = canvas.clientHeight;
    const v = view.current;
    const w = worldOf(b);
    return { x: W / 2 + (w.x - v.x) * v.k, y: H / 2 + (w.y - v.y) * v.k, r: b.radius * w.k * v.k, k: w.k * v.k };
  }, [worldOf]);

  const hit = useCallback((sx: number, sy: number): Body | null => {
    if (!canvasRef.current) return null;
    let best: Body | null = null;
    let bestD = Infinity;
    for (const b of bodies.current.values()) {
      const s = screenOf(b);
      const d = Math.hypot(s.x - sx, s.y - sy);
      // Cells win over the colony they sit in.
      const score = b.node.kind === 'colony' ? d + 1000 : d;
      if (d <= s.r + 4 && score < bestD) { best = b; bestD = score; }
    }
    return best;
  }, [screenOf]);

  const hitNub = useCallback((sx: number, sy: number): Body | null => {
    for (const b of bodies.current.values()) {
      const s = screenOf(b);
      const nx = s.x + s.r + (b.node.kind === 'colony' ? 10 : 9);
      if (Math.hypot(nx - sx, s.y - sy) <= 8) return b;
    }
    return null;
  }, [screenOf]);

  /** Against the strand actually on screen — exact, and cheaper than sampling a curve. */
  const hitEdge = useCallback((sx: number, sy: number): EdgeHit | null => {
    let best: EdgeHit | null = null;
    let bestD = 11;
    for (const [key, r] of ropeScreens.current) {
      const d = ropeDistance(r.pts, r.live, sx, sy);
      if (d < bestD) {
        const from = r.edge.from;
        const to = r.edge.to;
        const a = bodies.current.get(r.parent ? `${r.parent}/${from}` : from);
        const c = bodies.current.get(r.parent ? `${r.parent}/${to}` : to);
        if (a && c) { bestD = d; best = { parent: r.parent, edge: r.edge, fromKey: a.key, toKey: c.key }; }
      }
      void key;
    }
    return best;
  }, []);

  const finishWire = useCallback((target: Body | null) => {
    const w = wire.current;
    wire.current = null;
    if (!w || !target) return;
    const a = bodies.current.get(w.fromKey);
    if (!a) return;
    if (target.parent !== a.parent) { setNote('Wires stay inside one dish — dive into the colony to wire its cells.'); return; }
    if (!canWire(a.node, target.node)) { setNote(target.node.kind === 'rule' ? 'Nothing can point at a rule: rules are the pacemakers.' : 'Only a loop can wire to itself (that is a repeat).'); return; }
    const parent = a.parent;
    if (addEdge(parent, a.node.id, target.node.id)) setNote(a.node.kind === 'loop' ? (a === target ? `${a.node.id} repeats when it ends.` : `${target.node.id} plays when ${a.node.id} ends.`) : `${a.node.id} triggers ${target.node.id}.`);
  }, [addEdge]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
    const { x: sx, y: sy } = toLocal(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const nub = hitNub(sx, sy);
    const b = nub ?? hit(sx, sy);
    if (b && (nub || wireModeRef.current || e.shiftKey)) {
      select(b.key);
      wire.current = { fromKey: b.key, x: sx, y: sy };
      return;
    }
    if (b) {
      select(b.key);
      // The lone spore starts the colony when you click it.
      const st = useLoomStore.getState();
      if (!st.running && bodies.current.size === 1) st.play();
      drag.current = { key: b.key, dx: sx, dy: sy, moved: false };
      return;
    }
    const edge = hitEdge(sx, sy);
    if (edge) { selectEdge({ parent: edge.parent, from: edge.edge.from, to: edge.edge.to }); return; }
    pan.current = { x: sx, y: sy, vx: view.current.x, vy: view.current.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x: sx, y: sy } = toLocal(e);
    const over = hit(sx, sy);
    const overKey = over?.key ?? null;
    if (hover.current !== overKey) { hover.current = overKey; setHoverKey(overKey); }
    if (wire.current) { wire.current.x = sx; wire.current.y = sy; return; }
    if (drag.current) {
      const b = bodies.current.get(drag.current.key);
      if (!b) return;
      // Move in the body's parent-local space: screen delta / (parent scale × view scale).
      let k = 1;
      let cur: Body | undefined = b.parent ? bodies.current.get(b.parent) : undefined;
      while (cur) { if (cur.node.kind === 'colony') k *= SCALE_PER_DEPTH; cur = cur.parent ? bodies.current.get(cur.parent) : undefined; }
      const scale = k * view.current.k;
      b.pos.x += (sx - drag.current.dx) / scale;
      b.pos.y += (sy - drag.current.dy) / scale;
      b.creature.x = b.pos.x; b.creature.y = b.pos.y;
      b.creature.vx = 0; b.creature.vy = 0;
      drag.current.dx = sx; drag.current.dy = sy;
      drag.current.moved = true;
    } else if (pan.current && !focusRef.current) {
      view.current.x = pan.current.vx - (sx - pan.current.x) / view.current.k;
      view.current.y = pan.current.vy - (sy - pan.current.y) / view.current.k;
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (wire.current) {
      const up = toLocal(e);
      finishWire(hit(up.x, up.y));
    }
    if (drag.current) {
      const b = bodies.current.get(drag.current.key);
      if (b && drag.current.moved) setPosition(b.key, { x: Math.round(b.pos.x), y: Math.round(b.pos.y) });
    }
    drag.current = null;
    pan.current = null;
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const dc = toLocal(e);
    const b = hit(dc.x, dc.y);
    if (b?.node.kind === 'colony') setFocus(b.key);
    else if (!b) setFocus(null);
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (focusRef.current) return;
    view.current.k = Math.max(0.3, Math.min(4, view.current.k * (e.deltaY < 0 ? 1.1 : 0.9)));
  };
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x: sx, y: sy } = toLocal(e);
    const b = hit(sx, sy);
    const edge = b ? null : hitEdge(sx, sy);
    const W = e.currentTarget.clientWidth; const H = e.currentTarget.clientHeight;
    const v = view.current;
    // Where the click landed, in the focused dish's local space.
    let world: NodePos = { x: (sx - W / 2) / v.k + v.x, y: (sy - H / 2) / v.k + v.y };
    const parent = focusRef.current;
    if (parent) {
      const pb = bodies.current.get(parent);
      if (pb) { const w = worldOf(pb); world = { x: (world.x - w.x) / w.k, y: (world.y - w.y) / w.k }; }
    }
    if (b) select(b.key); else if (edge) selectEdge({ parent: edge.parent, from: edge.edge.from, to: edge.edge.to });
    menu.open(e, { key: b?.key ?? null, edge, world: { x: Math.round(world.x), y: Math.round(world.y) }, parent });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (wire.current) wire.current = null; else if (wireMode) setWireMode(false); else setFocus(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setFocus, wireMode]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);

  const menuItems = useCallback((p: MenuPayload): ContextMenuItem[] => {
    const b = p.key ? bodies.current.get(p.key) : null;
    if (b) {
      const n = b.node;
      return [
        { type: 'header', label: `${n.kind} · ${n.id}` },
        { type: 'item', label: 'Wire from here', hint: 'drag', onSelect: () => { setWireMode(true); select(b.key); setNote(`WIRE is on: drag from ${n.id} onto another cell (Esc to stop).`); } },
        { type: 'item', label: 'Bud a child', hint: 'grow', onSelect: () => growNow(b.key) },
        { type: 'item', label: 'Duplicate', onSelect: () => { duplicateNode(b.key); } },
        ...(n.kind === 'colony' ? [{ type: 'item' as const, label: 'Dive in', hint: 'dbl-click', onSelect: () => setFocus(b.key) }] : []),
        { type: 'separator' },
        { type: 'item', label: 'Delete cell', danger: true, onSelect: () => removeNode(b.key) },
      ];
    }
    if (p.edge) {
      const e = p.edge;
      return [
        { type: 'header', label: `wire · ${e.edge.from} → ${e.edge.to}` },
        { type: 'item', label: 'Delete wire', danger: true, onSelect: () => removeEdge(e.parent, e.edge.from, e.edge.to) },
      ];
    }
    const add = (kind: ColonyKind) => () => { addNode(p.parent, kind, p.world); };
    return [
      { type: 'header', label: p.parent ? `add to ${p.parent}` : 'add a cell here' },
      { type: 'item', label: 'Loop', hint: 'plays a stem', onSelect: add('loop') },
      { type: 'item', label: 'Rule', hint: 'pacemaker', onSelect: add('rule') },
      { type: 'item', label: 'Gate', hint: 'chance / laps', onSelect: add('gate') },
      { type: 'item', label: 'Mod', hint: 'colours what passes', onSelect: add('mod') },
      { type: 'item', label: 'Colony', hint: 'a dish inside', onSelect: add('colony') },
      { type: 'separator' },
      { type: 'item', label: 'Grow one step', onSelect: () => growNow() },
      ...(p.parent ? [{ type: 'item' as const, label: 'Surface', hint: 'Esc', onSelect: () => setFocus(null) }] : []),
    ];
  }, [addNode, duplicateNode, growNow, removeEdge, removeNode, select, setFocus]);

  const sel = selected ? bodies.current.get(selected) : null;
  const selResolved = sel?.node.kind === 'loop' ? colonyResolvedFor(sel.node.query) : null;
  const hoverBody = hoverKey ? bodies.current.get(hoverKey) : null;
  const cursor = wire.current || wireMode ? 'cursor-crosshair' : hoverBody ? 'cursor-grab active:cursor-grabbing' : 'cursor-move';
  const toolBtn = 'rounded-md border border-white/25 bg-black/60 px-2.5 py-1 text-xs font-mono font-semibold uppercase tracking-wider et-ink hover:bg-white/10 transition-colors disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className={`w-full h-full block touch-none ${cursor}`}
        role="img"
        aria-label={`Colony of ${bodies.current.size} cells. Drag cells to move them, drag from a cell's nub to wire it, right-click to add cells, wheel to zoom, double-click a colony to dive in, Escape to surface.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      />

      {/* Toolbar: the + buttons add into the dish you are looking at. */}
      <div className="absolute left-2 top-2 flex flex-wrap items-center gap-1" role="toolbar" aria-label="Colony tools">
        {(['loop', 'rule', 'gate', 'mod', 'colony'] as ColonyKind[]).map((kind) => (
          <button key={kind} type="button" onClick={() => addNode(focus, kind)} className={toolBtn} title={`Add a ${kind}${focus ? ` inside ${focus}` : ''}`} style={{ borderColor: rgba(KIND_COLOR[kind], 0.7) }}>
            <span style={{ color: KIND_COLOR[kind] }}>+</span> {kind}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/25" aria-hidden="true" />
        <button type="button" onClick={() => setWireMode((w) => !w)} aria-pressed={wireMode} className={`${toolBtn} ${wireMode ? 'bg-emerald-400/25 border-emerald-300' : ''}`} title="Wire: drag from any cell onto another (or drag from a cell's nub any time)">
          ⟿ wire
        </button>
        <button type="button" onClick={() => growNow(selected ?? undefined)} className={toolBtn} title={selected ? `Bud a child off ${selected}` : 'Grow the colony one step'}>
          ✚ {selected ? 'bud' : 'grow'}
        </button>
        {focus && (
          <button type="button" onClick={() => setFocus(null)} className={`${toolBtn} border-sky-300/70`} title="Back to the root dish (Esc)">
            ↑ surface{focus ? ` · in ${focus}` : ''}
          </button>
        )}
      </div>

      {/* Caption: what is selected, in ink that reads (left-32 clears the assistant orb). */}
      <div className="pointer-events-none absolute left-32 bottom-2 max-w-[65%] rounded-md bg-black/60 px-2.5 py-1.5 text-xs font-mono font-semibold et-ink leading-snug" aria-live="polite">
        {note
          ? note
          : sel
            ? `${sel.key} · ${sel.node.kind}${sel.node.kind === 'loop' ? ` ${serializeQuery(sel.node.query)}${selResolved ? ` → ${selResolved.stem_name} #${selResolved.bar_index}` : ' → (resolving)'}` : ''}`
            : selectedEdge
              ? `wire ${selectedEdge.from} → ${selectedEdge.to}${selectedEdge.parent ? ` in ${selectedEdge.parent}` : ''}`
              : 'drag a cell to move · drag its nub to wire · right-click to add · double-click a colony to dive'}
      </div>

      {menu.position && menu.payload && (
        <ContextMenu position={menu.position} onClose={menu.close} items={menuItems(menu.payload)} minWidth="11rem" />
      )}
    </div>
  );
};

/* ── orb params per cell ─────────────────────────────────────────────────── */

/** Hue of a key on the circle of fifths (Camelot number × 30°), for harmony colour. */
function keyHue(key: string, scale: string): number | null {
  const code = camelotCode(key, scale);
  const n = parseInt(code, 10);
  return Number.isFinite(n) ? ((n - 1) / 12) * 360 : null;
}

/**
 * A loop's orb: its stem's colour, its second colour from the KEY of the
 * shard it resolved to (circle of fifths → hue), lobes by its length (short
 * loops ripple, long drones roll), swirl by the shard's energy, a swell that
 * lasts the loop's length after a fire, and everything dimmed by vitality.
 * The orb's clock is passed in as `time` (cycles of the loop), so morphSpeed
 * 1 = one lobe cycle per loop. A colony is a glass bubble in its membrane
 * colour that grows with its vitality.
 */
function orbParamsFor(b: Body, now: number, light: boolean, bgHex: string, selected: boolean, hovered: boolean, beatSec: number): OrbParams {
  const z = hash(b.key);
  const vit = b.vit;
  if (b.node.kind === 'colony') {
    const col = membraneColor(z, light);
    const partner = shiftHue(col, 40);
    return {
      ...ORB_BASE, radius: 0.42, deform: 0.12 + 0.06 * vit, frequency: 1.4, morphSpeed: 1, rotSpeed: 0.02, specular: 1.6, shininess: 220,
      glowStrength: (selected ? 1.0 : 0.6) * (0.3 + 0.7 * vit), colorBlue: col, colorMagenta: partner, glowA: col, glowB: partner,
      liquidSpeed: 0.25, liquidScale: 1.6, liquidBright: 0.22 * vit, filament: 0.4, core: 0, background: bgHex, blend: light ? 1 : 0,
      // Glass: almost no body, so the cells inside and the dish show through the membrane.
      body: light ? 0.1 : 0.06, seed: (z % 1000) / 7,
    };
  }
  const node = b.node.kind === 'loop' ? b.node : null;
  const role = node?.query.role ?? 'mix';
  const col = light ? onLight(ROLE_COLOR[role] ?? ROLE_COLOR.mix, 0.25) : ROLE_COLOR[role] ?? ROLE_COLOR.mix;
  const row = node ? colonyResolvedFor(node.query) : null;
  const hue = row?.key ? keyHue(row.key, row.scale) : null;
  const partner = hue != null ? `hsl(${Math.round(hue)},85%,${light ? 40 : 62}%)` : shiftHue(col, 48);
  const beats = node?.beats ?? 4;
  const lengthSec = Math.max(0.25, beats * beatSec);
  const sinceFire = (now - b.fired) / 1000;
  const swell = Math.max(0, 1 - sinceFire / lengthSec);
  const energy = row?.energy ?? 0.4;
  const held = node?.hold ?? false;
  const phase = Math.sin(b.creature.phase) * b.creature.genome.muscle;
  // Chladni-like: more lobes for shorter loops, fewer for drones.
  const lobes = beats <= 1 ? 3.0 : beats <= 2 ? 2.6 : beats <= 4 ? 2.2 : beats <= 8 ? 1.8 : 1.4;
  const hollow = b.withering ? 1 - vit : 0;
  return {
    ...ORB_BASE,
    radius: 0.33 + swell * 0.05 + phase * 0.015,
    deform: 0.22 + swell * 0.18 + (held ? 0.04 : 0),
    frequency: lobes,
    morphSpeed: 1,
    rotSpeed: 0.03,
    specular: 1.0 * (0.4 + 0.6 * vit),
    shininess: 140,
    glowStrength: ((selected ? 1.1 : hovered ? 0.9 : 0.55) + swell * 0.5) * (0.2 + 0.8 * vit),
    colorBlue: col,
    colorMagenta: partner,
    glowA: selected ? '#ffffff' : col,
    glowB: partner,
    liquidSpeed: 0.08 + energy * 0.3 + swell * 0.25,
    liquidScale: 1.8 + energy * 0.8,
    liquidBright: (0.7 + swell * 0.9 + energy * 0.3) * vit,
    filament: (1.1 + swell) * (0.3 + 0.7 * vit),
    core: (0.25 + swell * 0.4) * vit,
    background: bgHex,
    blend: light ? 1 : 0,
    body: 1 - hollow * 0.85,
    seed: (z % 1000) / 7,
  };
}

function shiftHue(hex: string, deg: number): string {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0; let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h = (h + deg / 360 + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (tt: number) => { let x = tt; if (x < 0) x += 1; if (x > 1) x -= 1; if (x < 1 / 6) return p + (q - p) * 6 * x; if (x < 1 / 2) return q; if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6; return p; };
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to(f(h + 1 / 3))}${to(f(h))}${to(f(h - 1 / 3))}`;
}

function hueOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h * 360;
}

/* ── geometry ─────────────────────────────────────────────────────────── */

/**
 * The rim of a cell at an angle, in DISH-LOCAL units. Two different rims exist
 * and confusing them floats the strand off the membrane: an orb-drawn cell is
 * the raymarched silhouette (near round), everything else is the lobed
 * `blobPath` outline. `drewOrb` must be re-read every frame — a cell can lose
 * its orb when it scrolls offscreen or the atlas is full.
 */
function rimRadius(b: Body, theta: number, t: number, drewOrb: boolean): number {
  const r = b.radius * (0.12 + 0.88 * easeOut(b.vit)) * (1 + Math.sin(b.creature.phase) * b.creature.genome.muscle * 0.08);
  if (drewOrb) return r * 1.02;
  const z = hash(b.key) % 7;
  const deform = b.node.kind === 'rule' ? 0.22 : b.node.kind === 'colony' ? 0.18 : 0.30;
  let base = 1;
  if (b.node.kind === 'gate') base = 1 / (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)));
  else if (b.node.kind === 'mod') {
    const a = ((theta % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6;
    base = Math.cos(Math.PI / 6) / Math.cos(a);
  }
  return r * base * blobRadius(theta, t, { deform, z, frequency: 1.6 });
}

/**
 * Where a body sits, and the scale IT is drawn at. The chain's running scale
 * shrinks as it passes through each colony, so a body's own size must be read
 * BEFORE its own colony factor is folded in — otherwise every colony renders
 * at 0.55 of its true radius (and its hit target with it), which is what made
 * an enveloping colony a pellet with its cells spilling out of it.
 */
function worldOfIn(map: Map<string, Body>, b: Body): { x: number; y: number; k: number } {
  let k = 1;
  let selfK = 1;
  let x = 0;
  let y = 0;
  const chain: Body[] = [];
  let cur: Body | undefined = b;
  while (cur) { chain.unshift(cur); cur = cur.parent ? map.get(cur.parent) : undefined; }
  for (const c of chain) {
    x += c.pos.x * k;
    y += c.pos.y * k;
    selfK = k;
    if (c.node.kind === 'colony') k *= SCALE_PER_DEPTH;
  }
  return { x, y, k: chain.length ? selfK : 1 };
}

/** Text with a halo of the background so it reads over anything. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, bgRgb: string, align: CanvasTextAlign, bold: boolean, baseline: CanvasTextBaseline = 'alphabetic'): void {
  ctx.font = `${bold ? '800 ' : '700 '}${size}px ui-monospace, "Cascadia Mono", Menlo, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(${bgRgb},0.92)`;
  ctx.lineWidth = Math.max(3, size * 0.32);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textBaseline = 'alphabetic';
}

function drawNub(ctx: CanvasRenderingContext2D, x: number, y: number, lit: boolean, color: string, bgRgb: string): void {
  ctx.beginPath();
  ctx.arc(x, y, lit ? 5 : 3.5, 0, Math.PI * 2);
  ctx.fillStyle = lit ? color : rgba(color, 0.55);
  ctx.strokeStyle = `rgba(${bgRgb},0.9)`;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
}

function symbolColor(sym: number, light: boolean): string {
  const ring = ['#5cf0ff', '#ff4fd8', '#ffd166', '#7ef0a0', '#c3a6ff', '#ff7a45'];
  const c = ring[sym % ring.length];
  return light ? onLight(c) : c;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
