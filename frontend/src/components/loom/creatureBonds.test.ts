/**
 * The colony's physics is tuned in REAL-WORLD units — px/s, rad/s — because
 * the complaint it answers ("everything moves too fast") is about what a
 * person sees per second, not per frame. Screenshots cannot check that: a
 * headless canvas runs at a few frames a second, so the picture advances at a
 * fraction of real time and every rate looks fine. These assertions drive the
 * integrator directly at a fixed step and measure seconds.
 */
import assert from 'node:assert/strict';
import { align, GENOMES, integrate, interact, makeCreature, type Creature } from './creatureBonds.ts';

const H = 1 / 120;
const WORLD = { viscosity: 0.18, gravity: 0.0008, cx: 0, cy: 0, dishR: 400 };

/** Run `secs` of simulation over a set of creatures, all mutually repelling. */
function run(cells: Creature[], secs: number, bonded: (a: number, b: number) => boolean = () => false): number {
  const steps = Math.round(secs / H);
  let peakSpeed = 0;
  for (let s = 0; s < steps; s += 1) {
    for (let i = 0; i < cells.length; i += 1) {
      const mates: Creature[] = [];
      for (let j = 0; j < cells.length; j += 1) {
        if (i === j) continue;
        const res = interact(cells[i], cells[j], bonded(i, j), H);
        if (bonded(i, j) && res && res.force > -0.001) mates.push(cells[j]);
      }
      align(cells[i], mates, H);
    }
    for (const c of cells) {
      integrate(c, WORLD, false, H);
      peakSpeed = Math.max(peakSpeed, Math.hypot(c.vx, c.vy));
    }
  }
  return peakSpeed;
}

const dist = (a: Creature, b: Creature) => Math.hypot(a.x - b.x, a.y - b.y);

// Two cells born on top of each other push apart — and never faster than the cap.
{
  const skin = 27 + 58;
  const a = makeCreature(0, 0, GENOMES.loop, skin);
  const b = makeCreature(6, 2, GENOMES.loop, skin);
  const peak = run([a, b], 30);
  const d = dist(a, b);
  assert.ok(peak <= 9.001, `peak speed ${peak.toFixed(2)} px/s exceeds the 9 px/s cap`);
  assert.ok(d > 120, `after 30 s they are only ${d.toFixed(0)} px apart — a colony would stay a clump`);
  assert.ok(d < 2 * skin + 40, `they overshot to ${d.toFixed(0)} px; the skin is ${2 * skin}`);
}

// Six cells born on one spot spread into a readable cluster within half a minute.
{
  const skin = 27 + 58;
  const cells = Array.from({ length: 6 }, (_, i) => makeCreature(Math.cos(i) * 4, Math.sin(i) * 4, GENOMES.loop, skin));
  run(cells, 30);
  let closest = Infinity;
  for (let i = 0; i < cells.length; i += 1) for (let j = i + 1; j < cells.length; j += 1) closest = Math.min(closest, dist(cells[i], cells[j]));
  assert.ok(closest > 90, `the tightest pair is ${closest.toFixed(0)} px apart after 30 s — still a pile`);
}

// Nothing coasts: the medium is overdamped, so a shove dies within a second.
// What is left is the deliberate drift toward the dish centre, well under 1 px/s.
{
  const c = makeCreature(200, 0, GENOMES.loop, 85);
  c.vx = 9; c.vy = 0;
  run([c], 1);
  const left = Math.hypot(c.vx, c.vy);
  assert.ok(left < 0.5, `a cell still moves at ${left.toFixed(2)} px/s a second after being shoved`);
}

// A bond settles WITHOUT overshooting: critically damped, no ringing.
{
  const skin = 27 + 58;
  const a = makeCreature(-400, 0, GENOMES.loop, skin);
  const b = makeCreature(400, 0, GENOMES.loop, skin);
  const target = GENOMES.loop.bondDist * 0.62;
  let crossings = 0;
  let prev = dist(a, b) - target;
  const steps = Math.round(40 / H);
  for (let s = 0; s < steps; s += 1) {
    interact(a, b, true, H);
    interact(b, a, true, H);
    integrate(a, WORLD, false, H);
    integrate(b, WORLD, false, H);
    const now = dist(a, b) - target;
    if (Math.sign(now) !== Math.sign(prev) && Math.abs(now) > 4) crossings += 1;
    prev = now;
  }
  assert.ok(crossings <= 1, `the bond rang through the target ${crossings} times — it should not oscillate`);
}

// The breath is 20–30 seconds, not 5, and it does not depend on the frame rate.
{
  const c = makeCreature(0, 0, GENOMES.loop, 85);
  const period = (2 * Math.PI) / c.phaseRate;
  assert.ok(period >= 20 && period <= 32, `a breath takes ${period.toFixed(1)} s`);
  // Same elapsed time, different step size => same phase.
  const a = makeCreature(0, 0, GENOMES.loop, 85);
  const b = makeCreature(0, 0, GENOMES.loop, 85);
  b.phase = a.phase; b.phaseRate = a.phaseRate;
  for (let i = 0; i < 600; i += 1) integrate(a, WORLD, false, 1 / 60);
  for (let i = 0; i < 1200; i += 1) integrate(b, WORLD, false, 1 / 120);
  assert.ok(Math.abs(a.phase - b.phase) < 1e-6, 'the clock must not depend on the step size');
}

// Ten seconds at 60 Hz and at 240 Hz land in the same place: no display runs faster.
{
  const mk = (skin: number) => [makeCreature(0, 0, GENOMES.loop, skin), makeCreature(9, 3, GENOMES.loop, skin)];
  const step = (cells: Creature[], h: number) => {
    for (let s = 0; s < Math.round(10 / h); s += 1) {
      interact(cells[0], cells[1], false, h);
      interact(cells[1], cells[0], false, h);
      for (const c of cells) integrate(c, WORLD, false, h);
    }
    return Math.hypot(cells[0].x - cells[1].x, cells[0].y - cells[1].y);
  };
  const slow = step(mk(85), 1 / 60);
  const fast = step(mk(85), 1 / 240);
  assert.ok(Math.abs(slow - fast) / slow < 0.06, `60 Hz reached ${slow.toFixed(0)} px but 240 Hz reached ${fast.toFixed(0)} px — the sim is frame-rate dependent`);
}

console.log('creatureBonds: all assertions passed');
