/**
 * OrbDripTrail — the assistant orb's drip/particle trail.
 *
 * Emits while the assistant is thinking (steady ferrofluid drips falling off
 * the orb) and while the orb is dragged (droplets left along the path). Built
 * for fast lightweight performance: one viewport-fixed 2D canvas, a fixed
 * particle pool (zero allocations after init), a rAF loop that runs ONLY while
 * particles are alive or being emitted, and a hidden canvas when idle.
 * Particles fade out over roughly a second.
 */
import React, { useEffect, useRef } from 'react';
import { useAssistantActivityStore } from '../../state/assistantActivityStore';

interface OrbDripTrailProps {
  /** Orb top-left position (the orb's hit box), viewport coordinates. */
  position: { x: number; y: number };
  /** Orb hit-box size in px; must match GantasmoOrb's bounds. */
  orbBox?: number;
}

interface Drip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  r: number;
}

const POOL_SIZE = 96;
const GRAVITY = 90; // px/s^2, gentle drip fall
const THINK_RATE = 18; // drips per second while thinking

const OrbDripTrail: React.FC<OrbDripTrailProps> = ({ position, orbBox = 80 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const posRef = useRef(position);
  const prevPosRef = useRef(position);
  const poolRef = useRef<Drip[]>([]);
  const aliveRef = useRef(0);
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  const emitAccRef = useRef(0);
  const prevTimeRef = useRef(0);
  const thinking = useAssistantActivityStore((s) => s.thinking);
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;

  if (poolRef.current.length === 0) {
    for (let i = 0; i < POOL_SIZE; i++) {
      poolRef.current.push({ x: 0, y: 0, vx: 0, vy: 0, age: 1, life: 1, r: 1 });
    }
  }

  const spawn = (x: number, y: number, vx: number, vy: number) => {
    const pool = poolRef.current;
    for (let i = 0; i < POOL_SIZE; i++) {
      const p = pool[i];
      if (p.age >= p.life) {
        p.x = x;
        p.y = y;
        p.vx = vx;
        p.vy = vy;
        p.age = 0;
        p.life = 0.7 + Math.random() * 0.5;
        p.r = 1.2 + Math.random() * 1.6;
        aliveRef.current += 1;
        return;
      }
    }
  };

  const ensureLoop = () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.display = 'block';
    prevTimeRef.current = performance.now();

    const tick = () => {
      const cnv = canvasRef.current;
      const ctx = cnv?.getContext('2d');
      if (!cnv || !ctx) {
        runningRef.current = false;
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.05, (now - prevTimeRef.current) / 1000);
      prevTimeRef.current = now;

      // Steady drips off the orb's lower rim while thinking.
      if (thinkingRef.current) {
        emitAccRef.current += dt * THINK_RATE;
        while (emitAccRef.current >= 1) {
          emitAccRef.current -= 1;
          const cx = posRef.current.x + orbBox / 2 + (Math.random() - 0.5) * 26;
          const cy = posRef.current.y + orbBox / 2 + 18 + Math.random() * 8;
          spawn(cx, cy, (Math.random() - 0.5) * 14, 12 + Math.random() * 30);
        }
      }

      ctx.clearRect(0, 0, cnv.width, cnv.height);
      ctx.globalCompositeOperation = 'lighter';
      let alive = 0;
      const pool = poolRef.current;
      for (let i = 0; i < POOL_SIZE; i++) {
        const p = pool[i];
        if (p.age >= p.life) continue;
        p.age += dt;
        if (p.age >= p.life) continue;
        p.vy += GRAVITY * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        alive += 1;
        const k = 1 - p.age / p.life;
        ctx.fillStyle = `rgba(168, 85, 247, ${(0.55 * k).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.6 + 0.4 * k), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      aliveRef.current = alive;

      if (alive > 0 || thinkingRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        runningRef.current = false;
        cnv.style.display = 'none';
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // Drag trail: droplets along the movement segment whenever the orb moves.
  useEffect(() => {
    const prev = prevPosRef.current;
    posRef.current = position;
    const dx = position.x - prev.x;
    const dy = position.y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 3) {
      const steps = Math.min(6, Math.max(1, Math.floor(dist / 8)));
      for (let i = 0; i < steps; i++) {
        const f = i / steps;
        spawn(
          prev.x + dx * f + orbBox / 2 + (Math.random() - 0.5) * 10,
          prev.y + dy * f + orbBox / 2 + (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
          6 + Math.random() * 18,
        );
      }
      ensureLoop();
    }
    prevPosRef.current = position;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position]);

  useEffect(() => {
    if (thinking) ensureLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thinking]);

  // Canvas sizing (DPR 1 on purpose: soft fading blobs gain nothing from a
  // retina buffer and the cleared area stays 4x smaller).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    size();
    window.addEventListener('resize', size);
    return () => {
      window.removeEventListener('resize', size);
      cancelAnimationFrame(rafRef.current);
      runningRef.current = false;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 9998,
        display: 'none',
      }}
    />
  );
};

export default OrbDripTrail;
