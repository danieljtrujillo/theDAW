// Shared maths for the Chimera DNA visualiser.

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export const smooth = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

// Quintic smootherstep: zero velocity AND zero acceleration at both ends, so
// the human eye cannot pick out where a movement begins or ends.
export const smoother = (t: number): number => {
  const c = clamp01(t);
  return c * c * c * (c * (c * 6 - 15) + 10);
};

// Smoothstep over a window [a,b]; used to stagger phase progresses.
export const win = (p: number, a: number, b: number): number => smooth((p - a) / (b - a));

// Irregular chunk boundaries in u-space, mirroring the weave's clip slots.
export const SLOT_EDGES = [0, 0.135, 0.305, 0.45, 0.625, 0.805, 1.0];

// During the CHOP phase the backbone briefly breaks at chunk boundaries.
export const chopGap = (u: number, chop: number): boolean => {
  if (chop <= 0.01) return false;
  const gw = 0.014 * chop;
  for (let e = 1; e < SLOT_EDGES.length - 1; e++) {
    if (Math.abs(u - SLOT_EDGES[e]) < gw) return true;
  }
  return false;
};

// Evenly spaced rung positions when real beat data is unavailable; count tracks tempo.
export const defaultBeats = (bpm?: number | null): number[] => {
  const n = bpm ? Math.max(8, Math.min(40, Math.round(bpm / 4))) : 16;
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push((i + 0.5) / n);
  return a;
};

// Sample a normalised peaks envelope at fractional position u.
export const sampleEnv = (
  peaks: Float32Array | undefined | null,
  u: number,
  fallback = 0.5,
): number => {
  if (!peaks || peaks.length === 0) return fallback;
  const f = clamp01(u) * (peaks.length - 1);
  const k = Math.floor(f);
  const a = peaks[k];
  const b = peaks[Math.min(peaks.length - 1, k + 1)];
  return a + (b - a) * (f - k);
};
