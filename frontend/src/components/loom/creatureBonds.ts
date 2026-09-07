/**
 * creatureBonds — the colony's physics: cells are creatures with a muscle
 * phase, and wires are bonds that breathe.
 *
 * Ported from sschepis' "Entropic Life VIII – Evolutionary Ecosystem"
 * (https://codepen.io/sschepis/pen/GgqZKoV): a particle's genome
 * (mass, muscle, lag, bondDist, stiffness, align, repulsion), `integrate`
 * (viscous drag by mass, a soft gravity toward a centre, the phase clock —
 * the metabolism is left out, cells here live and die by the score), and the
 * pair interaction: skin repulsion at contact, else a spring to a target
 * distance that pulses with the muscle phase, alignment, and phase sync with
 * a lag along the direction of travel so pulses propagate down a chain. The
 * genome per cell KIND is chosen so pacemakers sit heavy and still (Builder),
 * loops swim (Swimmer), gates and mods dart (Darter), colonies drift (Mimic).
 *
 * Everything here is in SECONDS, not frames. The pen integrates in per-frame
 * units, which made the whole colony run at double speed on a 120 Hz display
 * and left the springs ringing at ~2 Hz — read as jitter. Here:
 *
 *   - the medium is honey (overdamped: a cell reaches its terminal speed at
 *     once and coasts nowhere) and every creature is capped at 9 px/s, so
 *     crossing the dish takes about a minute;
 *   - the bond spring is critically damped (ζ = 1), so a bond settles without
 *     a single overshoot instead of ringing thirty times;
 *   - the breath is 20–30 seconds, not 5, and phase sync can never move the
 *     phase faster than it free-runs, so no cell can snap;
 *   - the dish edge is a soft inward pressure over the outer 12%, not a wall
 *     that made anything resting against it buzz at the frame rate.
 */

export interface Genome { name: string; mass: number; muscle: number; lag: number; bondDist: number; stiffness: number; align: number; repulsion: number }

export const GENOMES: Record<'rule' | 'loop' | 'gate' | 'mod' | 'colony', Genome> = {
  // stiffness is now 1/s², repulsion px/s², align 1/s — all seconds-based.
  // In this overdamped medium a steady speed is force/(viscosity*60), so
  // repulsion 0.10 separates two touching cells at ~8 px/s and a bond at
  // stiffness 2 closes a 30 px gap at ~6 px/s. Slow, but it does resolve.
  rule: { name: 'Builder', mass: 3.0, muscle: 0.05, lag: 0.0, bondDist: 250, stiffness: 2.5, align: 0.0, repulsion: 0.10 },
  loop: { name: 'Swimmer', mass: 1.0, muscle: 0.22, lag: 0.35, bondDist: 270, stiffness: 2.0, align: 0.02, repulsion: 0.10 },
  gate: { name: 'Darter', mass: 0.5, muscle: 0.35, lag: 0.5, bondDist: 210, stiffness: 1.2, align: 0.004, repulsion: 0.14 },
  mod: { name: 'Darter', mass: 0.5, muscle: 0.35, lag: 0.5, bondDist: 210, stiffness: 1.2, align: 0.004, repulsion: 0.14 },
  colony: { name: 'Mimic', mass: 2.5, muscle: 0.08, lag: 0.1, bondDist: 330, stiffness: 2.0, align: 0.015, repulsion: 0.11 },
};

/** Nothing on screen ever exceeds this, in px/s: a cell takes about a minute
 *  to cross the dish. Slower than this and a crowded colony can never
 *  separate — eighteen cells stay welded in one clump forever. */
const SPEED_CAP = 9;

export interface Creature {
  x: number; y: number; vx: number; vy: number;
  genome: Genome;
  mass: number;
  /** Radians; one breath is ~20–30 s. */
  phase: number;
  /** Radians per SECOND. */
  phaseRate: number;
  links: number;
  /** Extra radius the skin repulsion respects (a big colony needs room). */
  skin: number;
}

export function makeCreature(x: number, y: number, genome: Genome, skin = 20): Creature {
  return {
    x, y,
    // A bud oozes off its parent; it is not ejected.
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    genome: { ...genome },
    mass: genome.mass,
    phase: Math.random() * Math.PI * 2,
    phaseRate: 0.20 + Math.random() * 0.10,
    links: 0,
    skin,
  };
}

export interface World { viscosity: number; gravity: number; cx: number; cy: number; dishR: number }

/** Physics: drag, soft gravity, a soft dish edge, the biology clock. `dt` is seconds. */
export function integrate(p: Creature, world: World, held: boolean, dt: number): void {
  // Frame-independent drag: the same tuning at 60, 120 or 240 Hz.
  const damp = Math.exp(-(world.viscosity / (p.mass || 1)) * 60 * dt);
  p.vx *= damp;
  p.vy *= damp;

  // Physics: Soft Gravity — a true px/s² acceleration, gentle enough that
  // recentring takes half a minute.
  if (world.gravity > 0) {
    const dx = world.cx - p.x;
    const dy = world.cy - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) {
      const a = (world.gravity * 3600 * dt) / (p.mass || 1);
      p.vx += (dx / d) * a;
      p.vy += (dy / d) * a;
    }
  }

  // Physics: Bounds — the dish repels over its outer rim rather than walling.
  const rx = p.x - world.cx;
  const ry = p.y - world.cy;
  const r = Math.hypot(rx, ry);
  if (r > 1e-6) {
    const edge = world.dishR * 0.88;
    if (r > edge) {
      const push = ((r - edge) / Math.max(1, world.dishR - edge)) * 0.5 * dt * 60;
      p.vx -= (rx / r) * push;
      p.vy -= (ry / r) * push;
    }
    // Only a hard stop well past the rim, and it barely bounces.
    if (r > world.dishR * 1.05) {
      const k = (world.dishR * 1.05) / r;
      p.x = world.cx + rx * k;
      p.y = world.cy + ry * k;
      const dot = (p.vx * rx + p.vy * ry) / r;
      p.vx -= (rx / r) * dot * 1.15;
      p.vy -= (ry / r) * dot * 1.15;
    }
  }

  const sp = Math.hypot(p.vx, p.vy);
  if (sp > SPEED_CAP) { p.vx *= SPEED_CAP / sp; p.vy *= SPEED_CAP / sp; }
  if (!held) { p.x += p.vx * dt; p.y += p.vy * dt; }

  // Biology: Clock — one breath every 20–30 s.
  p.phase += p.phaseRate * dt;
  if (p.phase > Math.PI * 2) p.phase -= Math.PI * 2;
}

export interface BondResult { force: number; nx: number; ny: number; dist: number }

/**
 * One pair, from p's side: skin repulsion or the breathing bond. `bonded` says
 * whether a wire joins them (only bonded pairs spring; everyone repels).
 * Returns the bond force so the caller can draw the strain.
 */
export function interact(p: Creature, n: Creature, bonded: boolean, dt: number): BondResult | null {
  const dx = n.x - p.x;
  const dy = n.y - p.y;
  const d2 = dx * dx + dy * dy;
  const g1 = p.genome;
  const maxDist = Math.max(g1.bondDist, n.genome.bondDist);
  if (d2 === 0) return null;
  const dist = Math.sqrt(d2);
  const nx = dx / dist;
  const ny = dy / dist;
  const skin = p.skin + n.skin;
  if (dist < skin) {
    const avgRepel = Math.max(g1.repulsion, n.genome.repulsion);
    // Squared profile: contact is a slow shove, never a snap.
    const shove = Math.pow(1 - dist / skin, 2) * avgRepel * 3600 * dt / (p.mass || 1);
    p.vx -= nx * shove;
    p.vy -= ny * shove;
    return { force: -shove, nx, ny, dist };
  }
  if (!bonded || dist > maxDist * 1.6) return null;
  const avgStiff = (g1.stiffness + n.genome.stiffness) / 2;
  const avgMusc = (g1.muscle + n.genome.muscle) / 2;
  const activity = Math.sin(p.phase) * avgMusc;
  // A slow peristaltic squeeze, not a pump: a few px over a 25 s breath.
  const target = maxDist * (0.62 + activity * 0.06);
  // Critically damped (ζ = 1): it settles with no overshoot and never rings.
  const c = 2 * Math.sqrt(avgStiff);
  const relVel = (p.vx - n.vx) * nx + (p.vy - n.vy) * ny;
  const force = (dist - target) * avgStiff - relVel * c;
  const a = (force * dt) / (p.mass || 1);
  p.vx += nx * a;
  p.vy += ny * a;
  if (Math.abs(force) > 0.01) p.links += 1;
  // Phase Sync (Wave): the pulse still travels down a chain, but it takes
  // ten seconds to do it, and the step can never outrun the free clock.
  const avgLag = (g1.lag + n.genome.lag) / 2;
  if (avgLag > 0) {
    const dot = p.vx * nx + p.vy * ny;
    const lagDir = dot > 0 ? -avgLag : avgLag;
    const targetPhase = n.phase + lagDir;
    let pDiff = targetPhase - p.phase;
    if (pDiff > Math.PI) pDiff -= Math.PI * 2;
    if (pDiff < -Math.PI) pDiff += Math.PI * 2;
    const pull = pDiff * (1 - Math.exp(-0.3 * dt));
    const lim = p.phaseRate * dt;
    p.phase += Math.max(-lim, Math.min(lim, pull));
  }
  return { force, nx, ny, dist };
}

/** Alignment: drift toward the average velocity of bonded neighbours, slowly. */
export function align(p: Creature, neighbours: Creature[], dt: number): void {
  if (p.genome.align <= 0 || neighbours.length === 0) return;
  let ax = 0;
  let ay = 0;
  for (const n of neighbours) { ax += n.vx; ay += n.vy; }
  ax /= neighbours.length;
  ay /= neighbours.length;
  // ~1 s time constant: a shared current, not a snap into formation.
  const k = 1 - Math.exp(-p.genome.align * 60 * dt);
  p.vx += (ax - p.vx) * k;
  p.vy += (ay - p.vy) * k;
}
