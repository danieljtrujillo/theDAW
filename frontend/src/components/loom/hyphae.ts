/**
 * hyphae — a fungal network that creeps out of the cells when they fire.
 *
 * Ported from Teha Faisal Bin Belaila Almheiri's "Mycorrhizal Biological
 * Market Simulator" (https://codepen.io/Teha-Faisal/pen/ogYevRO): the tip
 * walk with its outward bias, the branch rule, anastomosis (a tip that meets
 * an edge fuses into it), edges that thicken with `trunkScore` near the root,
 * and nutrient particles that travel the edges with smoothstep easing — drawn
 * as his `draw` does: fine hyphae in violet, trunk routes in gold with a
 * tight glow, tips as lime dots. His one host root is many here: every cell
 * that fires seeds tips at its own position.
 *
 * The pen's motion is all per-FRAME, which puts its tips at ~113 px/s (226 on
 * a 120 Hz display) with the heading dithered ±4.9° every frame — a shimmer,
 * not growth. Everything here is per-SECOND and roughly 35× slower, at the
 * 2–4 px/s a Physarum plasmodium actually advances:
 *
 *   - the heading has MOMENTUM (a `turn` rate that decays) instead of white
 *     noise, so a tip draws smooth meanders rather than a saw;
 *   - an edge is emitted every 3 px of real travel, not every frame, so the
 *     buffer holds half a minute of history instead of a sixth of a second;
 *   - edges fade in and out by AGE, so no edge's alpha ever depends on where
 *     it happens to sit in the array (that index-based ramp was re-shuffling
 *     every edge every frame — the single largest source of full-screen
 *     shimmer);
 *   - a particle creeps a whole CHAIN of segments rather than living and
 *     dying on one 2 px stub, so you see a bead of nutrient travel a trunk.
 */

interface Tip {
  x: number; y: number;
  angle: number;
  /** Heading rate of change, rad/s — gives the walk momentum. */
  turn: number;
  thick: number;
  age: number;
  alive: boolean;
  /** Where this tip last laid an edge. */
  sx: number; sy: number;
  /** The cell that seeded it. */
  ox: number; oy: number;
  col: string;
}
interface Edge { x1: number; y1: number; x2: number; y2: number; thick: number; ts: number; age: number; col: string }
interface Particle { x: number; y: number; dirX: number; dirY: number; speed: number; ts: number; size: number; col: string; life: number; maxLife: number }

const MAX_EDGES = 4000;
const MAX_TIPS = 60;
const MAX_PARTICLES = 90;
/** Seconds an edge persists before it dissolves. */
const EDGE_LIFE = 90;
/** Real distance a tip must travel before it lays another segment. */
const SEG_PX = 3;

export class Hyphae {
  private tips: Tip[] = [];
  private edges: Edge[] = [];
  private particles: Particle[] = [];
  fusions = 0;
  /** Slider-equivalents from the pen: soil quality drives exploration. */
  soil = 6;
  carbon = 0.5;

  /** px per SECOND (the pen's were per frame). */
  private growthSpeed(): number { return 2.6 + (1 - this.soil / 10) * 1.6; }
  /** Branches per second per tip. */
  private branchRate(): number { return 0.05 + (1 - this.soil / 10) * 0.05; }
  /** Particle spawns per second per edge. */
  private particleRate(): number { return this.carbon * 0.03; }

  /** Seed `count` tips at a cell, fanning out. */
  seed(x: number, y: number, count: number, thick: number, col: string): void {
    if (this.tips.length > MAX_TIPS) return;
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      this.tips.push({
        x: x + Math.cos(a) * 6, y: y + Math.sin(a) * 6, angle: a, turn: 0,
        thick, age: 0, alive: true, sx: x + Math.cos(a) * 6, sy: y + Math.sin(a) * 6, ox: x, oy: y, col,
      });
    }
  }

  clear(): void { this.tips = []; this.edges = []; this.particles = []; }

  private trunkScore(t: { x: number; y: number; ox: number; oy: number }, reach: number): number {
    const d = Math.hypot(t.x - t.ox, t.y - t.oy);
    return Math.max(0, 1 - d / reach);
  }

  /** `dt` is real seconds. */
  update(dt: number, W: number, H: number, speedMult = 1): void {
    const spd = this.growthSpeed() * speedMult;
    const br = this.branchRate() * speedMult;
    const reach = Math.min(W, H) * 0.32;
    for (const t of this.tips) {
      if (!t.alive) continue;
      t.age += dt;
      // Heading with MOMENTUM: a turn rate that is nudged and decays, so the
      // path meanders over ~1.2 s instead of dithering every frame.
      t.turn += (Math.random() - 0.5) * 1.2 * dt;
      t.turn *= Math.exp(-0.8 * dt);
      t.angle += t.turn * dt;
      // Bias outward from the root that seeded it — a 4 s drift the tip can
      // wander against, not a half-second snap onto the radial.
      const da = angleDelta(t.angle, Math.atan2(t.y - t.oy, t.x - t.ox));
      t.angle += da * (1 - Math.exp(-0.25 * dt));
      t.x += Math.cos(t.angle) * spd * dt;
      t.y += Math.sin(t.angle) * spd * dt;
      if (t.x < 4 || t.x > W - 4 || t.y < 8 || t.y > H - 8) { t.alive = false; continue; }
      // A tip that has wandered far enough dies back; growth stays near the colony.
      if (Math.hypot(t.x - t.ox, t.y - t.oy) > reach) { t.alive = false; continue; }
      // Lay a segment every SEG_PX of REAL travel, not once per frame.
      if (Math.hypot(t.x - t.sx, t.y - t.sy) >= SEG_PX) {
        const ts2 = this.trunkScore(t, reach);
        const edgeThick = t.thick * (0.55 + ts2 * 2.0 + this.carbon * 0.8);
        this.edges.push({ x1: t.sx, y1: t.sy, x2: t.x, y2: t.y, thick: Math.max(0.4, edgeThick), ts: ts2, age: 0, col: t.col });
        t.sx = t.x; t.sy = t.y;
      }
      // Branch
      if (this.tips.length < MAX_TIPS && Math.random() < br * dt) {
        const ba = t.angle + (Math.random() > 0.5 ? 1 : -1) * (0.28 + Math.random() * 0.44);
        this.tips.push({ x: t.x, y: t.y, angle: ba, turn: 0, thick: Math.max(0.5, t.thick * 0.72), age: 0, alive: true, sx: t.x, sy: t.y, ox: t.ox, oy: t.oy, col: t.col });
      }
      // Anastomosis: a tip that meets a strand fuses into it.
      if (Math.random() < 0.25 * dt) {
        for (let i = this.edges.length - 1; i >= Math.max(0, this.edges.length - 400); i -= 1) {
          const e = this.edges[i];
          const mx = (e.x1 + e.x2) / 2;
          const my = (e.y1 + e.y2) / 2;
          if (Math.hypot(t.x - mx, t.y - my) < 22 && Math.random() < 0.6) {
            this.edges.push({ x1: t.x, y1: t.y, x2: mx, y2: my, thick: 0.85, ts: 0.22, age: 0, col: t.col });
            this.fusions += 1; t.alive = false; break;
          }
        }
      }
    }
    this.tips = this.tips.filter((t) => t.alive);

    // Age edges; evict by AGE so an edge's look never depends on its index.
    for (const e of this.edges) e.age += dt;
    if (this.edges.length > MAX_EDGES || this.edges.some((e) => e.age > EDGE_LIFE)) {
      this.edges = this.edges.filter((e) => e.age <= EDGE_LIFE);
      if (this.edges.length > MAX_EDGES) this.edges.splice(0, this.edges.length - MAX_EDGES);
    }

    // Spawn particles on established strands.
    const rate = this.particleRate();
    for (const e of this.edges) {
      if (e.age > 1.2 && this.particles.length < MAX_PARTICLES && Math.random() < rate * (e.ts + 0.08) * dt) {
        const toRoot = Math.random() < 0.6;
        const sx = toRoot ? e.x2 : e.x1;
        const sy = toRoot ? e.y2 : e.y1;
        const ex = toRoot ? e.x1 : e.x2;
        const ey = toRoot ? e.y1 : e.y2;
        const dx = ex - sx;
        const dy = ey - sy;
        const dl = Math.hypot(dx, dy) || 1;
        this.particles.push({
          x: sx, y: sy, dirX: dx / dl, dirY: dy / dl,
          // 2–6 px/s: a bead you can watch creep along a trunk.
          speed: (2 + Math.random() * 4) * (1 + e.ts * 1.5),
          ts: e.ts, size: 1.2 + e.ts * 1.8, col: e.col, life: 0, maxLife: 6 + Math.random() * 10,
        });
      }
    }
    // A particle walks on, gently steered by nearby strands, rather than
    // living and dying on one 2 px stub.
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.dirX * p.speed * dt;
      p.y += p.dirY * p.speed * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);
  }

  /** The pen's draw pass: edges sharp, trunk glow, particles, tips. */
  draw(ctx: CanvasRenderingContext2D, light: boolean): void {
    ctx.shadowBlur = 0;
    for (const e of this.edges) {
      // Alpha depends only on wall time, so it is stable frame to frame.
      const alpha = Math.min(1, e.age * 0.35) * Math.max(0, Math.min(1, (EDGE_LIFE - e.age) / 15));
      if (alpha <= 0.01) continue;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2);
      ctx.lineWidth = Math.max(0.4, e.thick);
      if (e.ts > 0.52) ctx.strokeStyle = `rgba(232,208,72,${alpha * (0.7 + e.ts * 0.3)})`;
      else if (e.ts > 0.22) ctx.strokeStyle = `rgba(155,195,55,${alpha * 0.72})`;
      else ctx.strokeStyle = light ? `rgba(70,50,140,${alpha * 0.62})` : `rgba(88,72,160,${alpha * 0.62})`;
      ctx.stroke();
    }
    // Trunk glow — separate pass, tight blur
    ctx.shadowBlur = 4;
    for (const e of this.edges) {
      if (e.ts < 0.52) continue;
      const alpha = Math.min(1, e.age * 0.35) * Math.max(0, Math.min(1, (EDGE_LIFE - e.age) / 15));
      if (alpha <= 0.01) continue;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2);
      ctx.lineWidth = e.thick * 0.45;
      ctx.shadowColor = '#e0c840';
      ctx.strokeStyle = `rgba(232,208,72,${alpha * 0.35})`;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // Particles, fading in and out over their life so none of them pops.
    for (const p of this.particles) {
      const f = Math.min(1, p.life * 0.6) * Math.max(0, Math.min(1, (p.maxLife - p.life) / 2));
      ctx.globalAlpha = f;
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 7;
    for (const p of this.particles) {
      if (p.ts < 0.3) continue;
      const f = Math.min(1, p.life * 0.6) * Math.max(0, Math.min(1, (p.maxLife - p.life) / 2));
      ctx.shadowColor = p.col;
      ctx.globalAlpha = 0.4 * f;
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    // Growing tips, fading in over their first second.
    for (const t of this.tips) {
      const f = Math.min(1, t.age * 1.2);
      ctx.globalAlpha = f;
      ctx.fillStyle = '#d4f04a';
      ctx.beginPath(); ctx.arc(t.x, t.y, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = '#c8e840'; ctx.shadowBlur = 7;
      ctx.fillStyle = 'rgba(212,240,74,0.35)';
      ctx.beginPath(); ctx.arc(t.x, t.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  get counts(): { tips: number; edges: number; particles: number } {
    return { tips: this.tips.length, edges: this.edges.length, particles: this.particles.length };
  }
}

function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
