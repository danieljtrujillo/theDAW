// ChimeraDnaScene — ONE WebGL scene for the whole Chimera CRISPR visualiser,
// porting the reference polyphonic-splice choreography: every track is a flat
// waveform lane at rest, twists into a DNA helix on CREATE, then its CHUNKS
// (irregular slots) lift out of the lane, travel up into the shared output (the
// CRISPR tab-head panel), stack as polyphony voices, and FUSE into one strand
// whose colour is the gradient of the contributing voices. Unselected source
// material vaporises into particles, exactly like the reference.
//
// Layout comes from MEASURING the DOM: each control row carries a
// `data-crispr-lane` anchor and the top panel a `data-crispr-output` anchor.
// Everything renders in a single scene drawn in TWO non-overlapping scissor
// passes — the centre column below the output panel, and the output panel rect —
// so travelling chunks stay visible on their whole flight while nothing can
// spill into the side control panels.
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { laneColor, mixRgb, type Rgb } from './dna/dnaPalette';
import { chopGap, sampleEnv, smooth, smoother, win, SLOT_EDGES } from './dna/dnaMath';
import { ensurePeaks, getPeaks } from './dna/dnaPeaks';
import { registerDnaDraw, type DnaPhase } from './dna/dnaTicker';

const BEAD_CAP = 8000;
const RUNG_CAP = 8000;
const CHUNKS = SLOT_EDGES.length - 1;
const MAX_POLY = 3;

const hash = (n: number): number => {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
};

const slotOf = (u: number): number => {
  let s = 0;
  while (s < CHUNKS - 1 && u >= SLOT_EDGES[s + 1]) s++;
  return s;
};

const slotSub = (u: number, s: number): number =>
  (u - SLOT_EDGES[s]) / (SLOT_EDGES[s + 1] - SLOT_EDGES[s]);

// ---- weave plan (ports SELECTED/CONTRIB from the reference) ----------------
// Each lane contributes a scattered, distinct set of slots; each output slot is
// fed by 1..MAX_POLY lanes (the polyphony voices, stack order = voice index).
interface WeavePlan {
  contrib: number[][]; // contrib[slot] = lane indices (voice order)
  voiceOf: Int8Array; // voiceOf[lane * CHUNKS + slot] = voice index or -1
}
const planCache = new Map<number, WeavePlan>();
function weavePlan(laneCount: number): WeavePlan {
  const cached = planCache.get(laneCount);
  if (cached) return cached;
  const contrib: number[][] = Array.from({ length: CHUNKS }, () => []);
  for (let s = 0; s < CHUNKS; s++) {
    const ranked = Array.from({ length: laneCount }, (_, l) => l)
      .map((l) => ({ l, r: hash(l * 7.31 + s * 13.77 + 5) }))
      .sort((a, b) => a.r - b.r);
    const want = 1 + Math.floor(hash(s * 3.7 + laneCount * 1.3) * Math.min(MAX_POLY, laneCount));
    contrib[s] = ranked.slice(0, Math.max(1, want)).map((e) => e.l);
  }
  // every lane must contribute somewhere
  for (let l = 0; l < laneCount; l++) {
    if (!contrib.some((c) => c.includes(l))) {
      const s = l % CHUNKS;
      if (contrib[s].length >= MAX_POLY) contrib[s].pop();
      contrib[s].push(l);
    }
  }
  const voiceOf = new Int8Array(laneCount * CHUNKS).fill(-1);
  for (let s = 0; s < CHUNKS; s++) contrib[s].forEach((l, v) => { voiceOf[l * CHUNKS + s] = v; });
  const plan = { contrib, voiceOf };
  planCache.set(laneCount, plan);
  return plan;
}

let discTex: THREE.Texture | null = null;
function getDisc(): THREE.Texture {
  if (!discTex) {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d')!;
    // hard disc, NO glow — only a 1px anti-alias edge, so nothing obscures
    // neighbouring beat lines
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.92, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    discTex = new THREE.CanvasTexture(c);
  }
  return discTex;
}

interface Band {
  x0: number;
  x1: number;
  cy: number;
  h: number;
}

interface OutGeom {
  band: Band;
  x0: number;
  span: number;
  amp0: number;
  k: number;
  rb: number;
  spin: number;
}

// a real CRISPR chunk placement (from the mashup), with its polyphony voices
interface RealPlacement {
  lane: number;
  o0: number;
  o1: number;
  w0: number;
  w1: number;
  voice: number;
  poly: number;
  lanes: number[];
}

interface RealLane {
  plc: RealPlacement[];
  stretchedDur: number;
  mixDur: number;
}

export const ChimeraDnaScene: React.FC = () => {
  const clips = useGenerateParamsStore((s) => s.chimera.clips);
  const lastMeta = useGenerateParamsStore((s) => s.chimera.lastMeta);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef({ clips, lastMeta });
  dataRef.current = { clips, lastMeta };

  useEffect(() => {
    clips.forEach((c) => ensurePeaks(c.id, c.blob));
  }, [clips]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false; // manual clear + two scissored passes per frame
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
    camera.position.set(0, 0, 1000);

    const quad = new THREE.PlaneGeometry(1, 1);
    const c0 = new THREE.Color(0, 0, 0);
    const scene = new THREE.Scene();
    // NORMAL blending + real depth, exactly like the reference (its materials
    // use NormalBlending + depthWrite): stacked chunks OCCLUDE instead of
    // adding up to overexposure. Beads carry a z from their helix angle so the
    // front strand passes in front of rungs and the back strand, like the 3D
    // original. alphaTest clips the AA skirt so depth writes stay clean.
    const beads = new THREE.InstancedMesh(
      quad,
      new THREE.MeshBasicMaterial({ map: getDisc(), transparent: true, alphaTest: 0.45, depthWrite: true, depthTest: true }),
      BEAD_CAP,
    );
    // rungs are PLAIN SOLID quads (no texture): the full quad width paints, so
    // a 1.5px rung is a true 1.5px line — every beat visibly present
    const rungs = new THREE.InstancedMesh(
      quad,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: true, depthTest: true }),
      RUNG_CAP,
    );
    beads.frustumCulled = false;
    rungs.frustumCulled = false;
    for (let i = 0; i < BEAD_CAP; i++) beads.setColorAt(i, c0);
    for (let i = 0; i < RUNG_CAP; i++) rungs.setColorAt(i, c0);
    // dark backdrop per lane band, drawn UNDER the strands so the thin beat
    // lines pop against near-black instead of the card surface
    const lanesBg = new THREE.InstancedMesh(
      quad,
      new THREE.MeshBasicMaterial({ color: 0x05060a, depthWrite: false, depthTest: false }),
      32,
    );
    lanesBg.frustumCulled = false;
    lanesBg.renderOrder = -1;
    scene.add(lanesBg, beads, rungs);

    const dummy = new THREE.Object3D();
    const cB = new THREE.Color();
    const cG = new THREE.Color();
    const cW = new THREE.Color(1, 1, 1);
    // hologram tint: every colour leans toward pale ice-light, so the palette
    // reads as projected light instead of saturated neon
    const cHolo = new THREE.Color(205 / 255, 232 / 255, 1);
    const HOLO = 0.3;
    // backdrop colour — fading elements melt INTO this (per-instance alpha is
    // unavailable on InstancedMesh, and size-only fades go sub-pixel, which
    // the antialiaser renders as BLACK specks over the dark backdrop)
    const cBg = new THREE.Color(0x05060a);
    const t0Map = new Map<string, number>();
    // last measured band per clip — keeps every strand alive (and the fused
    // output forming) when the stack unmounts, e.g. on the Compare tab
    const bandCache = new Map<string, Band>();
    let genT0 = -1; // time CREATE was pressed → instant twist, no progress wait
    let W = 0;
    let H = 0;
    let beadCur = 0;
    let rungCur = 0;

    const resize = (): void => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      // RENDERED size (getBoundingClientRect), never clientWidth: an ancestor CSS
      // transform scales the layout, so layout px and rendered px differ.
      const rect = wrap.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      renderer.setSize(W, H, false);
      camera.left = -W / 2;
      camera.right = W / 2;
      camera.top = H / 2;
      camera.bottom = -H / 2;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const pushBead = (x: number, y: number, z: number, size: number, col: THREE.Color): void => {
      if (beadCur >= BEAD_CAP || size <= 0.01) return;
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(size, size, 1);
      dummy.updateMatrix();
      beads.setMatrixAt(beadCur, dummy.matrix);
      beads.setColorAt(beadCur, col);
      beadCur++;
    };
    const pushRung = (x: number, y: number, thick: number, len: number, rot: number, col: THREE.Color): void => {
      if (rungCur >= RUNG_CAP || len <= 0.5) return;
      dummy.position.set(x, y, 0); // rungs sit between the front/back strands
      dummy.rotation.set(0, 0, rot);
      dummy.scale.set(thick, len, 1);
      dummy.updateMatrix();
      rungs.setMatrixAt(rungCur, dummy.matrix);
      rungs.setColorAt(rungCur, col);
      rungCur++;
    };

    const rectToBand = (r: DOMRect, wr: DOMRect): Band => {
      const relLeft = r.left - wr.left;
      const relTop = r.top - wr.top;
      return {
        x0: relLeft - W / 2,
        x1: relLeft + r.width - W / 2,
        cy: H / 2 - (relTop + r.height / 2),
        h: r.height,
      };
    };

    // gradient of polyphony: colour sweep across a slot's contributing voices
    // (no allocations — this runs per bead per frame during the fuse)
    const finalColor = (plan: WeavePlan, laneCount: number, slot: number, uSub: number, out: THREE.Color): THREE.Color => {
      const all = plan.contrib[slot];
      let n = 0;
      for (let i = 0; i < all.length; i++) if (all[i] < laneCount) n++;
      if (n <= 1) {
        const c = laneColor(all[0] ?? 0);
        return out.setRGB(c.r / 255, c.g / 255, c.b / 255);
      }
      const seg = uSub * (n - 1);
      let k = Math.floor(seg);
      if (k > n - 2) k = n - 2;
      if (k < 0) k = 0;
      const c: Rgb = mixRgb(laneColor(all[k]), laneColor(all[k + 1]), seg - k);
      return out.setRGB(c.r / 255, c.g / 255, c.b / 255);
    };

    // gradient across an explicit contributor list (real CRISPR placements)
    const contribColor = (lanesArr: number[], sub: number, out: THREE.Color): THREE.Color => {
      if (lanesArr.length <= 1) {
        const c = laneColor(lanesArr[0] ?? 0);
        return out.setRGB(c.r / 255, c.g / 255, c.b / 255);
      }
      const seg = Math.min(1, Math.max(0, sub)) * (lanesArr.length - 1);
      let k = Math.floor(seg);
      if (k > lanesArr.length - 2) k = lanesArr.length - 2;
      if (k < 0) k = 0;
      const c: Rgb = mixRgb(laneColor(lanesArr[k]), laneColor(lanesArr[k + 1]), seg - k);
      return out.setRGB(c.r / 255, c.g / 255, c.b / 255);
    };

    const renderLane = (
      band: Band,
      out: OutGeom | null,
      plan: WeavePlan,
      laneCount: number,
      real: RealLane | null,
      clipId: string,
      laneIndex: number,
      beatsNorm: number[] | null,
      bpm: number | null,
      isBase: boolean,
      t: number,
      ph: DnaPhase,
      gen: boolean,
    ): void => {
      // tighter interior padding: the strand fills more of the lane box
      const amp0 = band.h * 0.36;
      const rb = Math.max(2.5, Math.min(11, band.h * 0.042));
      const margin = rb * 0.7 + 1;
      const lx0 = band.x0 + margin;
      const span = band.x1 - margin - lx0;
      if (span < 8) return;
      // FIXED coil count across the whole strand (reference proportions):
      // ~2.5 gentle twists total regardless of lane width
      const k = (Math.PI * 2 * 2.5) / span;
      const spacing = rb * 1.7;
      const nUsed = Math.max(8, Math.min(420, Math.round(span / spacing)));
      const peaks = getPeaks(clipId);

      if (!t0Map.has(clipId)) t0Map.set(clipId, t);
      const assembleT = t - (t0Map.get(clipId) ?? t);

      // per-lane OFF-TIME phases (reference LANE_PHASE): each lane runs the
      // same choreography slightly ahead/behind its neighbours, so phase
      // boundaries never read as one synchronized jump
      const lanePhase = (hash(laneIndex * 17.31 + 3) - 0.5) * 0.06;
      const pp = ph.p; // whole-run choreography clock (chunks self-schedule on it)
      const pL = Math.max(0, pp - lanePhase);
      const phAnalyze = win(pL, 0.015, 0.22);
      const phChop = win(pL, 0.16, 0.5); // ladder gaps open gradually mid-run

      // twist starts the MOMENT CREATE is pressed (time-driven), so the
      // waveforms wind into DNA immediately instead of waiting on progress
      const twist = !gen ? 0 : ph.complete ? 1 : smooth(Math.max(pp / 0.12, genT0 >= 0 ? (t - genT0) / 1.4 : 0));
      // slow fluid spin, desynchronised per lane (rate AND phase differ)
      const spin = (t * (0.26 + 0.12 * hash(laneIndex * 3.1 + 7)) + laneIndex * 1.7) * twist;
      const col = laneColor(laneIndex);
      // analysis sweep: eased one-way pass per lane (direction alternates),
      // intensity ramps in/out — no positional wrap-jumps (reference style)
      const scanA = phAnalyze;
      const scanU = laneIndex % 2 === 0 ? scanA : 1 - scanA;
      const scanGain = Math.sin(scanA * Math.PI);
      // Larson-scanner sweep: a soft glow patrols every strand continuously,
      // desynchronised per lane (always alive, idle or generating)
      const lt = (t * 0.18 + laneIndex * 0.27) % 2;
      const larsonU = lt < 1 ? lt : 2 - lt;

      // shared per-node math: lane-local position + (for selected chunks) the
      // lift → travel → fuse interpolation onto the output strand
      const place = (
        u: number,
        i: number,
        salt: number,
      ): {
        cx: number;
        cyc: number;
        offMag: number;
        za: number;
        aIn: number;
        w: number;
        thetaRot: number;
        sel: boolean;
        voice: number;
        poly: number;
        tph: number;
        vap: number;
        rbN: number;
        slot: number;
        fuseLanes: number[] | null;
        fuseSub: number;
        fuseAmt: number;
      } | null => {
        const slot = slotOf(u);
        // chunk membership: REAL CRISPR placements when the mashup ran, else
        // the deterministic preview plan
        let sel: boolean;
        let voice = -1;
        let poly = 1;
        let uOut = u;
        let fuseLanes: number[] | null = null;
        let fuseSub = 0;
        if (gen && real && real.plc.length && real.stretchedDur > 0 && real.mixDur > 0) {
          const tau = u * real.stretchedDur;
          let pl: RealPlacement | null = null;
          for (const q of real.plc) {
            if (tau >= q.w0 && tau <= q.w1) { pl = q; break; }
          }
          sel = !!pl;
          if (pl) {
            voice = pl.voice;
            poly = pl.poly;
            uOut = (pl.o0 + (tau - pl.w0)) / real.mixDur;
            fuseLanes = pl.lanes;
            fuseSub = pl.o1 > pl.o0 ? (tau - pl.w0) / (pl.o1 - pl.o0) : 0;
          }
        } else {
          voice = plan.voiceOf[laneIndex * CHUNKS + slot] ?? -1;
          sel = voice >= 0;
          poly = plan.contrib[slot].length;
        }

        const r1 = hash(i * 1.7 + laneIndex * 3.1 + 1 + salt);
        const r2 = hash(i * 2.3 + laneIndex * 1.9 + 2 + salt);
        const r3 = hash(i * 3.9 + laneIndex * 5.7 + 3 + salt);
        const r4 = hash(i * 5.1 + laneIndex * 2.4 + 4 + salt);
        const aIn = smooth((assembleT - (0.1 + u * 1.3 + r1 * 0.8)) / (0.55 + r2 * 0.6));
        if (aIn <= 0.02) return null;
        const w = 1 - aIn;
        const thetaRot = ((r1 - 0.5) * Math.PI * 3 + (r2 - 0.5) * Math.PI * 2) * w;

        const x = lx0 + u * span;
        const env = sampleEnv(peaks, u, 0.5);
        // organic helix: per-node phase wobble, irregular radius and a slow
        // breathing cycle (reference's per-node irregularity), never uniform
        const theta = x * k + spin + (r4 - 0.5) * 0.35;
        const organic = (0.9 + 0.2 * hash(i * 6.7 + laneIndex * 2.9))
          * (1 + 0.045 * Math.sin(t * 0.7 + u * 5 + laneIndex * 1.3));
        const ampWave = amp0 * (0.12 + 0.95 * env);
        const ampHelix = amp0 * (0.5 + 0.9 * env) * organic;
        let offMag = (1 - twist) * ampWave + twist * ampHelix * Math.sin(theta);
        let za = (Math.cos(theta) * twist + 1) / 2;

        // organic idle sway while seated (reference: gated by EXTRACTION, not
        // twist) — the helix keeps breathing right up until its chunks lift
        const swayGate = aIn * (1 - phChop);
        const swayY = swayGate * band.h * 0.04 * Math.sin(x * 0.05 + t * 1.3 + laneIndex * 1.7 + r1 * 6.28);

        let cx = x + (r3 - 0.5) * span * 0.5 * w;
        let cyc = band.cy + swayY + (r4 - 0.5) * band.h * 2.4 * w;
        let rbN = rb;
        let tph = 0;
        let vap = 0;
        let fuseAmt = 0;

        if (gen && sel) {
          // WHOLE-RUN self-scheduling: every chunk departs at its own moment —
          // the earliest soon after CREATE, the latest just before the very
          // end — and flies its own long arc, so landings stagger continuously
          // across the entire generation. One unbroken flow: no rush, no
          // hover, no plop, no collective moves. Quintic ease everywhere.
          const depart = 0.08 + 0.58 * hash(laneIndex * 4.7 + slot * 5.1 + 5);
          const flight = 0.07 + 0.09 * hash(laneIndex * 3.3 + slot * 8.1 + 11);
          const lph = smoother((pp - (depart - 0.07)) / 0.07); // lift leads its departure
          cyc += band.h * 0.5 * lph * (0.7 + 0.7 * hash(laneIndex * 5.3 + slot * 7.9 + 7));
          tph = smoother((pp - depart) / flight);
          // each chunk fuses into the master strand as IT lands — there is no
          // global fuse event
          fuseAmt = smoother((pp - depart - flight) / 0.08);
          if (out && tph > 0) {
            const xT = out.x0 + uOut * out.span;
            const thetaT = xT * out.k + out.spin;
            const ampT = out.amp0 * (0.5 + 0.9 * env);
            const offT = ampT * Math.sin(thetaT);
            const zaT = (Math.cos(thetaT) + 1) / 2;
            // y arrives early, x slides late → the flight stays inside the
            // visible region (centre column, then the full-width panel)
            const ty = 1 - (1 - tph) * (1 - tph);
            const tx = tph * tph;
            // voices fan out in flight and fold together as this chunk blends in
            const vOff = (voice - (poly - 1) / 2) * out.band.h * 0.22 * tph * (1 - fuseAmt);
            const arc = Math.sin(tph * Math.PI);
            cx = cx + (xT - cx) * tx;
            cyc = cyc + (out.band.cy + vOff - cyc) * ty + arc * (r3 - 0.5) * 26;
            offMag = offMag + (offT - offMag) * tph;
            za = za + (zaT - za) * tph;
            rbN = rb + (out.rb - rb) * tph;
          }
        } else if (gen && !sel) {
          // unused material drifts off on its own long schedule too: shrink to
          // a particle, wander, then gone (reference vaporize curve)
          const dv = 0.15 + 0.55 * hash(laneIndex * 9.7 + slot * 2.9 + 13);
          vap = smoother((pp - dv) / 0.3);
          if (vap >= 0.999) return null;
          const vth = r2 * Math.PI * 2;
          cx += Math.cos(vth) * vap * 30 * (0.5 + r3);
          cyc += (Math.sin(vth) * 0.6 + 0.5) * vap * 28 + Math.sin(t * 3 + i) * vap * 3;
        }

        return { cx, cyc, offMag, za, aIn, w, thetaRot, sel, voice, poly, tph, vap, rbN, slot, fuseLanes, fuseSub, fuseAmt };
      };

      // ---- backbone beads ----
      for (let i = 0; i < nUsed; i++) {
        const u = i / (nUsed - 1);
        if (chopGap(u, phChop) && !(gen && pp > 0.14)) continue;
        const p = place(u, i, 0);
        if (!p) continue;
        const jitter = 0.8 + 0.35 * hash(i * 12.9898 + laneIndex * 7.13);
        const du = Math.abs(u - scanU);
        const scanBoost = scanGain * Math.exp(-(du * du) / (2 * 0.04 * 0.04));
        const dl = u - larsonU;
        const larson = Math.exp(-(dl * dl) / (2 * 0.035 * 0.035)) * 0.34;
        const cr = Math.cos(p.thetaRot);
        const sr = Math.sin(p.thetaRot);
        const isCanon = p.voice === 0;
        for (let s = 0; s < 2; s++) {
          const sign = s === 0 ? 1 : -1;
          const so = sign * p.offMag;
          const ox = -so * sr;
          const oy = so * cr;
          const za = (sign * (p.za * 2 - 1) + 1) / 2;
          // small beads; reference shrink-to-particle when vaporising
          let size = p.rbN * 0.95 * (0.55 + 0.65 * za) * jitter * p.aIn;
          if (p.vap > 0) size *= (0.35 + 0.65 * (1 - p.vap)) * (1 - smoother(p.vap));
          if (gen && p.sel && !isCanon) size *= 1 - p.fuseAmt; // this voice folds in as its chunk lands
          // colour: own lane → (canonical voice) gradient of polyphony at fuse
          cB.setRGB(col.r / 255, col.g / 255, col.b / 255);
          if (gen && p.sel && isCanon && p.fuseAmt > 0) {
            if (p.fuseLanes) contribColor(p.fuseLanes, p.fuseSub, cG);
            else finalColor(plan, laneCount, p.slot, slotSub(u, p.slot), cG);
            cB.lerp(cG, p.fuseAmt);
          }
          cB.lerp(cHolo, HOLO); // hologram tint — projected light, not neon
          // NEVER darken toward black (normal blending paints it): depth shade
          // stays in a bright band; all fades happen via SIZE, not colour
          cB.multiplyScalar(0.82 + 0.26 * za);
          if (isBase && !gen) cB.lerp(cW, 0.12 + 0.12 * Math.sin(t * 4));
          if (scanBoost > 0.01) cB.lerp(cW, Math.min(0.7, scanBoost));
          if (larson > 0.01) cB.lerp(cW, larson);
          if (p.w > 0.001) cB.lerp(cW, Math.min(0.32, p.w * 0.35));
          // sub-2px beads melt into the backdrop colour (LAST, so it wins) —
          // size-only fades go sub-pixel and rasterise as black specks
          if (size < 2) cB.lerp(cBg, 1 - size / 2);
          // depth from the helix angle: the front strand passes in FRONT of
          // rungs (z 0) and the back strand behind, like the 3D reference
          pushBead(p.cx + ox, p.cyc + oy, sign * (p.za * 2 - 1) * 8 + 0.5, size, cB);
        }
      }

      // ---- rungs: one per beat, travelling with their chunk ----
      const beats = beatsNorm && beatsNorm.length
        ? beatsNorm
        : (() => {
            const n = bpm ? Math.max(8, Math.min(64, Math.round(bpm / 3))) : 16;
            const a: number[] = [];
            for (let i = 0; i < n; i++) a.push((i + 0.5) / n);
            return a;
          })();
      // EVERY beat gets its line: thickness adapts to the beat density so a
      // 300-beat grid renders as distinct thin lines instead of a smear
      const perBeatPx = span / Math.max(1, beats.length);
      // ≥1px floor: a sub-pixel solid quad over the dark backdrop antialiases
      // into a BLACK hairline — never let the base thickness dip below it
      const rungThick = Math.max(1, Math.min(rb * 1.05, perBeatPx * 0.55));
      for (let j = 0; j < beats.length && j < 2000; j++) {
        const u = Math.min(1, Math.max(0, beats[j]));
        // rungs NEVER disappear at chop boundaries — a beat line only goes
        // when its chunk is discarded (vaporised out of the chimera)
        const p = place(u, j, 17);
        if (!p) continue;
        if (p.vap > 0.985) continue; // fully dissolved
        const vapFade = 1 - smoother(p.vap / 0.85);
        const du = Math.abs(u - scanU);
        const scanBoost = scanGain * Math.exp(-(du * du) / (2 * 0.04 * 0.04));
        const dl = u - larsonU;
        const larson = Math.exp(-(dl * dl) / (2 * 0.035 * 0.035)) * 0.34;
        // gentle shimmer (reference pace) instead of fast flicker
        const glow = 0.78 + 0.22 * Math.sin(t * 1.2 - u * 5);
        const isCanon = p.voice === 0;
        // fade = assemble × vaporise × voice-fold-in. It drives LENGTH (the
        // rung retracts) while thickness keeps a ≥1px floor, and the last
        // visible stretch melts into the backdrop colour — a fading rung
        // reads as a bright line dissolving, never a black hairline
        const fade = p.aIn * vapFade * (gen && p.sel && !isCanon ? 1 - p.fuseAmt : 1);
        if (fade <= 0.04) continue;
        cB.setRGB(col.r / 255, col.g / 255, col.b / 255);
        if (gen && p.sel && isCanon && p.fuseAmt > 0) {
          if (p.fuseLanes) contribColor(p.fuseLanes, p.fuseSub, cG);
          else finalColor(plan, laneCount, p.slot, slotSub(u, p.slot), cG);
          cB.lerp(cG, p.fuseAmt);
        }
        cB.lerp(cHolo, HOLO); // hologram tint
        cB.multiplyScalar(0.82 + 0.2 * glow);
        if (scanBoost > 0.01) cB.lerp(cW, Math.min(0.6, scanBoost));
        if (larson > 0.01) cB.lerp(cW, larson);
        if (fade < 0.5) cB.lerp(cBg, 1 - fade * 2); // melt (LAST, so it wins)
        // length floor: at helix crossings the strand gap pinches, but the
        // beat line itself must stay visible (min ~28% of the lane amplitude)
        const minLen = amp0 * 0.55;
        const len = Math.max(minLen, 2 * Math.abs(p.offMag)) * fade;
        const thick = Math.max(1, rungThick * (0.4 + 0.6 * fade));
        pushRung(p.cx, p.cyc, thick, len, p.thetaRot, cB);
        // a tiny ball capping BOTH ends of every rung (no rung without its
        // balls): endpoints = centre ± half-length rotated by the rung's tilt
        const exr = -Math.sin(p.thetaRot) * (len / 2);
        const eyr = Math.cos(p.thetaRot) * (len / 2);
        const endSize = Math.max(1.4, rungThick * 1.7) * (0.5 + 0.5 * fade);
        cB.lerp(cW, 0.12 * Math.min(1, fade * 2)); // brighten caps only while solid
        pushBead(p.cx + exr, p.cyc + eyr, 0.8, endSize, cB);
        pushBead(p.cx - exr, p.cyc - eyr, 0.8, endSize, cB);
      }
    };

    const draw = (t: number, ph: DnaPhase): void => {
      if (W <= 2 || H <= 2) return;
      beadCur = 0;
      rungCur = 0;
      const wr = wrap.getBoundingClientRect();
      const { clips: cs, lastMeta: lm } = dataRef.current;

      // Post-mashup beats: per_clip.beats are PRE-stretch seconds — scale by the
      // stretch ratio first. After beat-matching every lane's rungs land on the
      // shared target-BPM grid (uniform spacing), instead of the sporadic
      // pre-stretch positions. With CRISPR placements the lane shows the WHOLE
      // stretched clip; otherwise it shows the mashup window.
      const beatsByLabel = new Map<string, number[]>();
      if (lm) {
        for (const pc of lm.per_clip) {
          const ratio = pc.stretch_ratio || 1;
          const hasPlc = !!(pc.placements && pc.placements.length);
          const b0 = hasPlc ? 0 : pc.window_start_sec;
          const b1 = hasPlc ? pc.stretched_duration_sec : pc.window_end_sec;
          if (b1 > b0) {
            const sp = b1 - b0;
            beatsByLabel.set(
              pc.label,
              pc.beats.map((b) => (b * ratio - b0) / sp).filter((u) => u >= 0 && u <= 1),
            );
          }
        }
      }

      // REAL CRISPR chunks: enrich each placement with its polyphony voices
      // (which lanes share its output slot, and this lane's voice index)
      const mixDur = lm?.duration_sec ?? 0;
      const pcByLabel = new Map(lm ? lm.per_clip.map((pc) => [pc.label, pc] as const) : []);
      const rawAll: RealPlacement[] = [];

      const outEl = document.querySelector('[data-crispr-output]') as HTMLElement | null;
      const outBand = outEl ? rectToBand(outEl.getBoundingClientRect(), wr) : null;
      let out: OutGeom | null = null;
      if (outBand) {
        // small beads, tight padding, gentle coil — matches the lane styling
        const rbO = Math.max(2.5, Math.min(11, outBand.h * 0.042));
        const marginO = rbO * 0.7 + 1;
        const ox0 = outBand.x0 + marginO;
        const ospan = outBand.x1 - marginO - ox0;
        out = {
          band: outBand,
          x0: ox0,
          span: Math.max(1, ospan),
          amp0: outBand.h * 0.3,
          // master strand: ~2 gentle coils total across its full width
          k: (Math.PI * 2 * 2) / Math.max(1, ospan),
          rb: rbO,
          spin: t * 0.32,
        };
      }

      // lanes come from the CLIPS (not just mounted anchors) so the strands
      // survive the Chimera↔Compare tab switch via the band cache
      const laneEls = Array.from(document.querySelectorAll('[data-crispr-lane]')) as HTMLElement[];
      const elByClip = new Map<string, HTMLElement>();
      for (const el of laneEls) elByClip.set(el.getAttribute('data-clip-id') ?? '', el);
      const lanes = cs.map((clip, laneIndex) => ({ clip, clipId: clip.id, laneIndex }));

      for (const ln of lanes) {
        const pc = pcByLabel.get(ln.clip.label);
        if (pc?.placements?.length) {
          for (const p of pc.placements) {
            rawAll.push({
              lane: ln.laneIndex,
              o0: p.output_start_sec,
              o1: p.output_end_sec,
              w0: p.window_start_sec,
              w1: p.window_end_sec,
              voice: 0,
              poly: 1,
              lanes: [],
            });
          }
        }
      }
      for (const p of rawAll) {
        const c = (p.o0 + p.o1) / 2;
        const over = rawAll.filter((q) => q.o0 <= c && c < q.o1).sort((a, b) => a.lane - b.lane);
        p.poly = Math.max(1, over.length);
        p.voice = Math.max(0, over.indexOf(p));
        p.lanes = over.map((q) => q.lane);
      }

      const plan = weavePlan(Math.max(1, lanes.length));
      const gen = ph.generating || ph.complete;
      if (ph.generating && genT0 < 0) genT0 = t;
      if (!gen) genT0 = -1;
      let bgCur = 0;
      // dark backdrop behind the master strand (scene quad, like the lanes)
      if (outBand) {
        dummy.position.set((outBand.x0 + outBand.x1) / 2, outBand.cy, -50);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(outBand.x1 - outBand.x0, outBand.h, 1);
        dummy.updateMatrix();
        lanesBg.setMatrixAt(bgCur, dummy.matrix);
        bgCur++;
      }
      for (const ln of lanes) {
        const el = elByClip.get(ln.clipId);
        let band: Band | null = null;
        if (el) {
          band = rectToBand(el.getBoundingClientRect(), wr);
          bandCache.set(ln.clipId, band);
        } else {
          band = bandCache.get(ln.clipId) ?? null;
        }
        if (!band) continue;
        if (bgCur < 32) {
          dummy.position.set((band.x0 + band.x1) / 2, band.cy, 0);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(band.x1 - band.x0, band.h, 1);
          dummy.updateMatrix();
          lanesBg.setMatrixAt(bgCur, dummy.matrix);
          bgCur++;
        }
        // beat-matched mashup grid FIRST (uniform, shared across lanes), then
        // the immediate per-clip analysis, then the BPM fallback in renderLane
        let beatsNorm: number[] | null = null;
        const clip = ln.clip;
        if (clip) beatsNorm = beatsByLabel.get(clip.label) ?? null;
        if (!beatsNorm && clip?.beats && clip.beats.length && clip.durationSec && clip.durationSec > 0) {
          const dur = clip.durationSec;
          beatsNorm = clip.beats.map((b) => b / dur).filter((u) => u >= 0 && u <= 1);
        }
        const pc = clip ? pcByLabel.get(clip.label) : undefined;
        const plc = rawAll.filter((e) => e.lane === ln.laneIndex);
        const real: RealLane | null = pc && plc.length
          ? { plc, stretchedDur: pc.stretched_duration_sec, mixDur }
          : null;
        renderLane(band, out, plan, lanes.length, real, ln.clipId, ln.laneIndex, beatsNorm, clip?.detectedBpm ?? null, !!clip?.isBase, t, ph, gen);
      }

      beads.count = beadCur;
      rungs.count = rungCur;
      lanesBg.count = bgCur;
      beads.instanceMatrix.needsUpdate = true;
      if (beads.instanceColor) beads.instanceColor.needsUpdate = true;
      rungs.instanceMatrix.needsUpdate = true;
      if (rungs.instanceColor) rungs.instanceColor.needsUpdate = true;
      lanesBg.instanceMatrix.needsUpdate = true;

      // two NON-OVERLAPPING scissor passes of the same scene: centre column
      // below the output panel + the output panel itself. Their union is the
      // allowed region; chunks crossing the boundary stay continuous.
      const dpr = renderer.getPixelRatio();
      const centerEl = document.querySelector('[data-chimera-anchor="init-audio"]') as HTMLElement | null;
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.setScissorTest(true);
      let panelBottomGL = H; // GL y of the output panel's bottom edge
      if (outEl) {
        const or = outEl.getBoundingClientRect();
        panelBottomGL = H - (or.top - wr.top + or.height);
      }
      if (centerEl) {
        const cr = centerEl.getBoundingClientRect();
        const left = cr.left - wr.left;
        renderer.setScissor(left * dpr, 0, cr.width * dpr, Math.max(0, panelBottomGL) * dpr);
      } else {
        renderer.setScissor(0, 0, W * dpr, Math.max(0, panelBottomGL) * dpr);
      }
      renderer.render(scene, camera);
      if (outEl) {
        const or = outEl.getBoundingClientRect();
        const left = or.left - wr.left;
        renderer.setScissor(left * dpr, panelBottomGL * dpr, or.width * dpr, or.height * dpr);
        renderer.render(scene, camera);
      }
      renderer.setScissorTest(false);
    };

    const unreg = registerDnaDraw(draw);
    return () => {
      unreg();
      ro.disconnect();
      quad.dispose();
      (beads.material as THREE.Material).dispose();
      (rungs.material as THREE.Material).dispose();
      (lanesBg.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
};
