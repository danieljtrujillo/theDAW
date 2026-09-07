/**
 * ColonyCanvas — the living picture of a LOOM colony (lib/colony.ts).
 *
 * Not squares. Cells float in a dish: loops are round cells with a membrane
 * that blooms when they fire, rules are rings of steps with the live step lit
 * (a Life rule shows its own little colony of dots), gates are diamonds, mods
 * are hexagons, and a colony is a translucent body holding its own cells at a
 * smaller scale — zoom in and it is a whole dish again, which is the fractal.
 * Triggers travel the tendrils as sparks. Underneath, a slime-mould field of
 * agents senses recent fires and crawls toward them, leaving trails.
 *
 * Layout is a small force simulation (springs on edges, repulsion inside a
 * colony, a pull toward the colony's centre); positions persist per node
 * path. Drag a cell, wheel to zoom, click to inspect, double-click a colony
 * to dive in, Escape to surface.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { getEngineCtx } from '../../state/playerStore';
import { colonyResolvedFor, subscribeColonyEvents, useLoomStore, type NodePos } from '../../state/loomStore';
import { groupStarts, meterText, ruleTile, symbolIndex, type ColonyGraph, type ColonyNode } from '../../lib/colony';
import { GEN_GLYPH, genCell } from '../../lib/loomGen';
import { serializeQuery } from '../../lib/loomScore';
import type { ColonyEvent } from '../../lib/colonyEngine';
import { DEFAULT_SEED } from '../../lib/loomEngine';

const ROLE_HUE: Record<string, number> = { kick: 32, snare: 40, hihat: 48, cymbals: 52, toms: 28, drums: 36, bass: 275, vocals: 340, guitar: 150, piano: 195, other: 175, mix: 0 };

interface Body {
  key: string;
  node: ColonyNode;
  graph: ColonyGraph;
  path: string[];
  depth: number;
  pos: NodePos; // colony-local
  vel: NodePos;
  radius: number;
  /** World transform of the colony this body lives in. */
  parent: string | null;
}

interface Pulse { key: string; at: number; ttl: number; kind: 'fire' | 'trigger' | 'bar' }
interface Spark { from: string; to: string; at: number; dur: number }
interface StepMark { key: string; step: number; symbol: number | null; at: number }

const SCALE_PER_DEPTH = 0.42;
const COLONY_RADIUS_BASE = 150;

export const ColonyCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const applied = useLoomStore((s) => s.colonyApplied);
  const positions = useLoomStore((s) => s.colonyPositions);
  const selected = useLoomStore((s) => s.colonySelected);
  const running = useLoomStore((s) => s.running);
  const seed = useLoomStore((s) => s.colonyApplied.seed ?? DEFAULT_SEED);
  const form = useLoomStore((s) => s.colonyApplied.form);
  const select = useLoomStore((s) => s.selectColony);
  const setPosition = useLoomStore((s) => s.setColonyPosition);

  const bodies = useRef<Map<string, Body>>(new Map());
  const pulses = useRef<Pulse[]>([]);
  const sparks = useRef<Spark[]>([]);
  const steps = useRef<Map<string, StepMark>>(new Map());
  const laps = useRef<Map<string, number>>(new Map());
  const pending = useRef<ColonyEvent[]>([]);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ key: string; dx: number; dy: number } | null>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const focus = useRef<string | null>(null);
  const mould = useRef<{ x: number; y: number; a: number }[]>([]);
  const field = useRef<Float32Array | null>(null);
  const fieldW = 96;
  const fieldH = 60;
  const ink = useRef<string>('255,255,255');

  /* ── bodies from the score ─────────────────────────────────────────── */
  useEffect(() => {
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
        const radius = node.kind === 'colony' ? COLONY_RADIUS_BASE * Math.pow(0.7, 0) + node.graph.nodes.length * 6 : node.kind === 'loop' ? 22 : node.kind === 'rule' ? 20 : 13;
        next.set(key, { key, node, graph: g, path, depth, pos, vel: prev?.vel ?? { x: 0, y: 0 }, radius, parent });
        if (node.kind === 'colony') walk(node.graph, [...path, node.id], depth + 1, key);
      });
    };
    walk(applied.root, [], 0, null);
    bodies.current = next;
  }, [applied, positions]);

  /* ── events from the engine ────────────────────────────────────────── */
  useEffect(() => subscribeColonyEvents((e) => { pending.current.push(e); }), []);
  useEffect(() => { if (!running) { pulses.current = []; sparks.current = []; steps.current.clear(); } }, [running]);

  /* ── world transforms ──────────────────────────────────────────────── */
  const worldOf = useCallback((b: Body): { x: number; y: number; k: number } => {
    let k = 1;
    let x = 0;
    let y = 0;
    const chain: Body[] = [];
    let cur: Body | undefined = b;
    while (cur) { chain.unshift(cur); cur = cur.parent ? bodies.current.get(cur.parent) : undefined; }
    for (const c of chain) { x += c.pos.x * k; y += c.pos.y * k; if (c.node.kind === 'colony') k *= SCALE_PER_DEPTH; }
    return { x, y, k: chain.length ? k : 1 };
  }, []);

  /* ── the frame ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const cs = getComputedStyle(canvas);
    ink.current = cs.getPropertyValue('--et-ink').trim() || '255,255,255';
    const isLight = canvas.closest('[data-et-light]') != null;
    if (!field.current) field.current = new Float32Array(fieldW * fieldH);
    if (mould.current.length === 0) {
      for (let i = 0; i < 260; i += 1) mould.current.push({ x: Math.random(), y: Math.random(), a: Math.random() * Math.PI * 2 });
    }
    let raf = 0;
    let last = performance.now();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      const audioNow = getEngineCtx().currentTime;

      // Due events become pulses / sparks / step marks.
      const still: ColonyEvent[] = [];
      for (const e of pending.current) {
        if (e.at > audioNow + 0.02) { still.push(e); continue; }
        const key = e.path.join('/');
        if (e.kind === 'fire') { pulses.current.push({ key, at: now, ttl: 700, kind: 'fire' }); deposit(key, 1); }
        else if (e.kind === 'trigger' && e.edge) { sparks.current.push({ from: [...e.path.slice(0, -1), e.edge.from].join('/'), to: key, at: now, dur: 220 }); pulses.current.push({ key, at: now, ttl: 260, kind: 'trigger' }); }
        else if (e.kind === 'step') steps.current.set(key, { key, step: e.step ?? 0, symbol: e.symbol ?? null, at: now });
        else if (e.kind === 'bar') { laps.current.set(key, e.lap ?? 0); pulses.current.push({ key: key || '@root', at: now, ttl: 500, kind: 'bar' }); }
      }
      pending.current = still;
      pulses.current = pulses.current.filter((p) => now - p.at < p.ttl);
      sparks.current = sparks.current.filter((s) => now - s.at < s.dur);

      // Physics: springs, repulsion, centre pull — per colony, in local space.
      const list = [...bodies.current.values()];
      const byParent = new Map<string | null, Body[]>();
      for (const b of list) { const arr = byParent.get(b.parent) ?? []; arr.push(b); byParent.set(b.parent, arr); }
      if (!reduced || drag.current) {
        for (const [parent, group] of byParent) {
          const graph = parent ? (bodies.current.get(parent)?.node as { graph?: ColonyGraph })?.graph : applied.root;
          const dishR = parent ? (bodies.current.get(parent)?.radius ?? 100) / SCALE_PER_DEPTH * 0.55 : Math.min(W, H) * 0.42;
          for (const a of group) {
            let fx = -a.pos.x * 0.35;
            let fy = -a.pos.y * 0.35;
            for (const b of group) {
              if (a === b) continue;
              const dx = a.pos.x - b.pos.x;
              const dy = a.pos.y - b.pos.y;
              const d2 = dx * dx + dy * dy + 40;
              const min = (a.radius + b.radius) * 1.6;
              const rep = (min * min * 6) / d2;
              fx += (dx / Math.sqrt(d2)) * rep;
              fy += (dy / Math.sqrt(d2)) * rep;
            }
            const r = Math.hypot(a.pos.x, a.pos.y);
            if (r > dishR) { fx -= (a.pos.x / r) * (r - dishR) * 2; fy -= (a.pos.y / r) * (r - dishR) * 2; }
            a.vel.x = (a.vel.x + fx * dt * 4) * 0.86;
            a.vel.y = (a.vel.y + fy * dt * 4) * 0.86;
          }
          if (graph) {
            for (const e of graph.edges) {
              const a = group.find((b) => b.node.id === e.from);
              const b = group.find((x) => x.node.id === e.to);
              if (!a || !b) continue;
              const dx = b.pos.x - a.pos.x;
              const dy = b.pos.y - a.pos.y;
              const d = Math.hypot(dx, dy) || 1;
              const rest = a.radius + b.radius + 90;
              const f = (d - rest) * 0.9 * dt;
              a.vel.x += (dx / d) * f; a.vel.y += (dy / d) * f;
              b.vel.x -= (dx / d) * f; b.vel.y -= (dy / d) * f;
            }
          }
          for (const a of group) {
            if (drag.current?.key === a.key) continue;
            a.pos.x += a.vel.x;
            a.pos.y += a.vel.y;
          }
        }
      }

      // Camera: the focused colony fills the dish.
      const target = focus.current ? bodies.current.get(focus.current) : null;
      let camX = 0; let camY = 0; let camK = 1;
      if (target) {
        const w = worldOf(target);
        camK = Math.min(W, H) / (target.radius * 2.6) / (w.k / SCALE_PER_DEPTH || 1);
        camX = w.x; camY = w.y;
      }
      const v = view.current;
      v.k += (camK * (target ? 1 : 1) - v.k) * 0.08;
      v.x += (camX - v.x) * 0.1;
      v.y += (camY - v.y) * 0.1;
      const toScreen = (wx: number, wy: number) => ({ x: W / 2 + (wx - v.x) * v.k, y: H / 2 + (wy - v.y) * v.k });

      // Background: the dish, with trails fading.
      ctx2d.fillStyle = isLight ? 'rgba(248,246,242,0.32)' : 'rgba(7,5,10,0.28)';
      ctx2d.fillRect(0, 0, W, H);

      // Slime mould agents: sense the attractant field, turn, move, deposit.
      const f = field.current!;
      for (let i = 0; i < f.length; i += 1) f[i] *= 0.985;
      const sense = (x: number, y: number) => {
        const cx = Math.max(0, Math.min(fieldW - 1, Math.floor(x * fieldW)));
        const cy = Math.max(0, Math.min(fieldH - 1, Math.floor(y * fieldH)));
        return f[cy * fieldW + cx];
      };
      ctx2d.fillStyle = isLight ? `rgba(${ink.current},0.22)` : `rgba(${ink.current},0.16)`;
      if (!reduced) {
        for (const m of mould.current) {
          const ahead = sense(m.x + Math.cos(m.a) * 0.03, m.y + Math.sin(m.a) * 0.03);
          const left = sense(m.x + Math.cos(m.a - 0.6) * 0.03, m.y + Math.sin(m.a - 0.6) * 0.03);
          const right = sense(m.x + Math.cos(m.a + 0.6) * 0.03, m.y + Math.sin(m.a + 0.6) * 0.03);
          if (left > ahead && left > right) m.a -= 0.25; else if (right > ahead && right > left) m.a += 0.25; else m.a += (Math.random() - 0.5) * 0.3;
          m.x += Math.cos(m.a) * 0.0022; m.y += Math.sin(m.a) * 0.0022;
          if (m.x < 0 || m.x > 1 || m.y < 0 || m.y > 1) { m.x = Math.random(); m.y = Math.random(); }
          const idx = Math.floor(m.y * fieldH) * fieldW + Math.floor(m.x * fieldW);
          if (idx >= 0 && idx < f.length) f[idx] += 0.02;
          ctx2d.fillRect(m.x * W, m.y * H, 1.2, 1.2);
        }
      }

      // Draw colonies (bodies first, deepest last), then edges, then cells.
      const ordered = list.slice().sort((a, b) => a.depth - b.depth);
      for (const b of ordered) {
        if (b.node.kind !== 'colony') continue;
        const w = worldOf(b);
        const p = toScreen(w.x, w.y);
        const r = b.radius * w.k * v.k;
        const lap = laps.current.get(b.key) ?? 0;
        const bar = pulses.current.find((x) => x.key === b.key && x.kind === 'bar');
        const breathe = bar ? 1 + 0.05 * (1 - (now - bar.at) / bar.ttl) : 1;
        ctx2d.beginPath();
        ctx2d.arc(p.x, p.y, r * breathe, 0, Math.PI * 2);
        ctx2d.fillStyle = `hsla(${(hash(b.key) % 360)},60%,${isLight ? 60 : 50}%,0.10)`;
        ctx2d.fill();
        ctx2d.lineWidth = 1.5;
        ctx2d.strokeStyle = `hsla(${(hash(b.key) % 360)},70%,${isLight ? 35 : 70}%,${selected === b.key ? 0.9 : 0.45})`;
        ctx2d.setLineDash([6, 5]);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
        // Meter ring: group boundaries as ticks.
        const g = b.node.graph;
        const starts = groupStarts(g.meter, g.meter.num);
        for (let i = 0; i < g.meter.num; i += 1) {
          const ang = (i / g.meter.num) * Math.PI * 2 - Math.PI / 2;
          const big = starts.includes(i);
          ctx2d.beginPath();
          ctx2d.moveTo(p.x + Math.cos(ang) * (r - (big ? 10 : 5)), p.y + Math.sin(ang) * (r - (big ? 10 : 5)));
          ctx2d.lineTo(p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r);
          ctx2d.strokeStyle = `rgba(${ink.current},${big ? 0.8 : 0.35})`;
          ctx2d.lineWidth = big ? 2 : 1;
          ctx2d.stroke();
        }
        ctx2d.fillStyle = `rgba(${ink.current},0.85)`;
        ctx2d.font = `${Math.max(9, 11 * Math.min(1, v.k))}px ui-monospace, monospace`;
        ctx2d.textAlign = 'center';
        ctx2d.fillText(`${b.node.id} · ${meterText(g.meter)}${g.tempo !== 1 ? ` ×${g.tempo}` : ''} · lap ${lap + 1}`, p.x, p.y - r - 6);
      }
      // Edges.
      for (const b of ordered) {
        const g = b.node.kind === 'colony' ? b.node.graph : null;
        const graph = g ?? (b.parent === null && b === ordered[0] ? applied.root : null);
        if (!graph) continue;
        drawEdges(graph, b.node.kind === 'colony' ? b.key : null);
      }
      if (ordered.length === 0 || !ordered.some((b) => b.parent === null && b.node.kind === 'colony')) drawEdges(applied.root, null);
      function drawEdges(graph: ColonyGraph, parentKey: string | null) {
        for (const e of graph.edges) {
          const a = bodies.current.get(parentKey ? `${parentKey}/${e.from}` : e.from);
          const c = bodies.current.get(parentKey ? `${parentKey}/${e.to}` : e.to);
          if (!a || !c) continue;
          const wa = worldOf(a); const wc = worldOf(c);
          const pa = toScreen(wa.x, wa.y); const pc = toScreen(wc.x, wc.y);
          const mx = (pa.x + pc.x) / 2 + (pc.y - pa.y) * 0.15;
          const my = (pa.y + pc.y) / 2 - (pc.x - pa.x) * 0.15;
          ctx2d.beginPath();
          ctx2d.moveTo(pa.x, pa.y);
          ctx2d.quadraticCurveTo(mx, my, pc.x, pc.y);
          ctx2d.strokeStyle = `rgba(${ink.current},0.28)`;
          ctx2d.lineWidth = 1.2;
          ctx2d.stroke();
          if (e.on != null) {
            ctx2d.fillStyle = `rgba(${ink.current},0.7)`;
            ctx2d.font = '9px ui-monospace, monospace';
            ctx2d.fillText(`on ${e.on}`, mx, my - 4);
          }
          for (const s of sparks.current) {
            if (s.from !== a.key || s.to !== c.key) continue;
            const t = (now - s.at) / s.dur;
            const x = (1 - t) * (1 - t) * pa.x + 2 * (1 - t) * t * mx + t * t * pc.x;
            const y = (1 - t) * (1 - t) * pa.y + 2 * (1 - t) * t * my + t * t * pc.y;
            ctx2d.beginPath();
            ctx2d.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx2d.fillStyle = 'rgba(251,191,36,0.95)';
            ctx2d.fill();
          }
        }
      }
      // Cells.
      for (const b of ordered) {
        if (b.node.kind === 'colony') continue;
        const w = worldOf(b);
        const p = toScreen(w.x, w.y);
        const k = w.k * v.k;
        const r = b.radius * k;
        if (r < 2) continue;
        const fire = pulses.current.find((x) => x.key === b.key && x.kind === 'fire');
        const trig = pulses.current.find((x) => x.key === b.key && x.kind === 'trigger');
        const n = b.node;
        const hue = n.kind === 'loop' ? ROLE_HUE[n.query.role ?? 'mix'] ?? 200 : n.kind === 'rule' ? 265 : n.kind === 'gate' ? 150 : 200;
        const sat = n.kind === 'loop' && (n.query.role ?? 'mix') === 'mix' ? 0 : 70;
        if (fire) {
          const t = (now - fire.at) / fire.ttl;
          ctx2d.beginPath();
          ctx2d.arc(p.x, p.y, r * (1 + t * 1.6), 0, Math.PI * 2);
          ctx2d.strokeStyle = `hsla(${hue},${sat}%,65%,${(1 - t) * 0.8})`;
          ctx2d.lineWidth = 2 * (1 - t) + 0.5;
          ctx2d.stroke();
        }
        ctx2d.beginPath();
        if (n.kind === 'gate') diamond(ctx2d, p.x, p.y, r);
        else if (n.kind === 'mod') polygon(ctx2d, p.x, p.y, r, 6);
        else ctx2d.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx2d.fillStyle = `hsla(${hue},${sat}%,${isLight ? 62 : 45}%,${trig ? 0.75 : fire ? 0.6 : 0.35})`;
        ctx2d.fill();
        ctx2d.lineWidth = selected === b.key ? 2.5 : 1.5;
        ctx2d.strokeStyle = selected === b.key ? 'rgba(56,189,248,0.95)' : `hsla(${hue},${sat}%,${isLight ? 30 : 75}%,0.9)`;
        ctx2d.stroke();
        if (n.kind === 'loop') {
          // Membrane.
          ctx2d.beginPath();
          ctx2d.arc(p.x, p.y, r * 0.78, 0, Math.PI * 2);
          ctx2d.strokeStyle = `hsla(${hue},${sat}%,${isLight ? 30 : 80}%,0.35)`;
          ctx2d.lineWidth = 1;
          ctx2d.stroke();
        }
        if (n.kind === 'rule') {
          // Steps around the ring; the live one lit; Life shows its symbols.
          const mark = steps.current.get(b.key);
          const lap = laps.current.get(b.parent ?? '') ?? 0;
          const tile = ruleTile(n);
          const gs = groupStarts(b.graph.meter, n.steps);
          for (let i = 0; i < n.steps; i += 1) {
            const ang = (i / n.steps) * Math.PI * 2 - Math.PI / 2;
            const cx = p.x + Math.cos(ang) * r * 1.35;
            const cy = p.y + Math.sin(ang) * r * 1.35;
            const sym = symbolIndex(genCell(tile, i, lap, seed, form, hash(b.key), 0)?.query ?? null);
            const live = mark && mark.step === i && now - mark.at < 200;
            ctx2d.beginPath();
            ctx2d.arc(cx, cy, live ? 3.2 * Math.min(1.5, k + 0.5) : (sym != null ? 2.2 : 1.2) * Math.min(1.5, k + 0.5), 0, Math.PI * 2);
            ctx2d.fillStyle = live ? 'rgba(251,191,36,1)' : sym != null ? `hsla(${(265 + sym * 47) % 360},80%,${isLight ? 40 : 70}%,0.95)` : `rgba(${ink.current},${gs.includes(i) ? 0.55 : 0.25})`;
            ctx2d.fill();
          }
        }
        // Glyph.
        if (r >= 7) {
          ctx2d.fillStyle = `rgba(${ink.current},0.95)`;
          ctx2d.font = `${n.kind === 'rule' ? 'bold ' : ''}${Math.max(8, Math.min(16, r * 0.8))}px ui-monospace, monospace`;
          ctx2d.textAlign = 'center';
          ctx2d.textBaseline = 'middle';
          const glyph = n.kind === 'rule' ? GEN_GLYPH[n.gen] : n.kind === 'loop' ? (n.query.role ?? 'm')[0] : n.kind === 'gate' ? (n.pct != null ? '?' : '!') : n.mode === 'abs' ? '=' : '+';
          ctx2d.fillText(glyph, p.x, p.y + 0.5);
          if (k > 0.6) {
            ctx2d.font = `${Math.max(8, 10 * Math.min(1, k))}px ui-monospace, monospace`;
            ctx2d.textBaseline = 'alphabetic';
            ctx2d.fillStyle = `rgba(${ink.current},0.75)`;
            const sub = n.kind === 'loop' ? `${n.id} · ${n.beats}b${n.hold ? ' hold' : ''}` : n.kind === 'rule' ? `${n.id} · ${n.gen} ${n.steps}` : n.id;
            ctx2d.fillText(sub, p.x, p.y + r + 12);
          }
        }
      }

      raf = requestAnimationFrame(frame);
    };

    const deposit = (key: string, amount: number) => {
      const b = bodies.current.get(key);
      if (!b || !field.current) return;
      const w = worldOf(b);
      const W = canvas.clientWidth; const H = canvas.clientHeight;
      const v = view.current;
      const sx = (W / 2 + (w.x - v.x) * v.k) / W;
      const sy = (H / 2 + (w.y - v.y) * v.k) / H;
      const cx = Math.floor(sx * fieldW); const cy = Math.floor(sy * fieldH);
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const x = cx + dx; const y = cy + dy;
        if (x < 0 || y < 0 || x >= fieldW || y >= fieldH) continue;
        field.current[y * fieldW + x] += amount / (1 + Math.abs(dx) + Math.abs(dy));
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [applied, seed, form, selected, worldOf]);

  /* ── pointer ───────────────────────────────────────────────────────── */
  const hit = useCallback((sx: number, sy: number): Body | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const W = canvas.clientWidth; const H = canvas.clientHeight;
    const v = view.current;
    let best: Body | null = null;
    let bestD = Infinity;
    for (const b of bodies.current.values()) {
      const w = worldOf(b);
      const px = W / 2 + (w.x - v.x) * v.k;
      const py = H / 2 + (w.y - v.y) * v.k;
      const r = b.radius * w.k * v.k;
      const d = Math.hypot(px - sx, py - sy);
      // Cells win over the colony they sit in.
      const score = b.node.kind === 'colony' ? d + 1000 : d;
      if (d <= r + 4 && score < bestD) { best = b; bestD = score; }
    }
    return best;
  }, [worldOf]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left; const sy = e.clientY - rect.top;
    const b = hit(sx, sy);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (b) {
      select(b.key);
      drag.current = { key: b.key, dx: sx, dy: sy };
    } else {
      pan.current = { x: sx, y: sy, vx: view.current.x, vy: view.current.y };
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left; const sy = e.clientY - rect.top;
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
      b.vel.x = 0; b.vel.y = 0;
      drag.current.dx = sx; drag.current.dy = sy;
    } else if (pan.current && !focus.current) {
      view.current.x = pan.current.vx - (sx - pan.current.x) / view.current.k;
      view.current.y = pan.current.vy - (sy - pan.current.y) / view.current.k;
    }
  };
  const onPointerUp = () => {
    if (drag.current) {
      const b = bodies.current.get(drag.current.key);
      if (b) setPosition(b.key, { x: Math.round(b.pos.x), y: Math.round(b.pos.y) });
    }
    drag.current = null;
    pan.current = null;
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const b = hit(e.clientX - rect.left, e.clientY - rect.top);
    if (b?.node.kind === 'colony') focus.current = b.key;
    else if (!b) focus.current = null;
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (focus.current) return;
    view.current.k = Math.max(0.3, Math.min(4, view.current.k * (e.deltaY < 0 ? 1.1 : 0.9)));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') focus.current = null; };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sel = selected ? bodies.current.get(selected) : null;
  const selResolved = sel?.node.kind === 'loop' ? colonyResolvedFor(sel.node.query) : null;

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="w-full h-full block cursor-grab active:cursor-grabbing touch-none"
        role="img"
        aria-label={`Colony of ${bodies.current.size} cells. Drag cells, wheel to zoom, double-click a colony to dive in, Escape to surface.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
      <div className="pointer-events-none absolute left-3 bottom-2 text-[10px] font-mono et-ink-3">
        {sel ? `${sel.key} · ${sel.node.kind}${sel.node.kind === 'loop' ? ` ${serializeQuery(sel.node.query)}${selResolved ? ` → ${selResolved.stem_name} #${selResolved.bar_index}` : ' → (resolving)'}` : ''}` : 'drag cells · wheel zoom · double-click a colony to dive · Esc to surface'}
      </div>
    </div>
  );
};

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
}

function polygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, n: number) {
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}
