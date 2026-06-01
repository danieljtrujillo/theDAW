/**
 * Track-control color ramp — the smooth 0..100 blend shared by the SLIDE
 * tab's faders and knobs (cyan → blue → green → lime → orange → red).
 *
 * Ported from the standalone /sliders template. Blending happens in
 * linear-light space so midpoints stay bright instead of the muddy dip you
 * get lerping raw sRGB. Pure functions — no DOM, safe to unit test.
 */

export type RGB = [number, number, number];

const STOPS: Array<[number, RGB]> = [
  [0.0, [0, 229, 255]], // cyan
  [0.2, [0, 150, 255]], // blue
  [0.42, [0, 230, 118]], // green
  [0.62, [198, 224, 0]], // lime
  [0.82, [255, 150, 0]], // orange
  [1.0, [255, 31, 75]], // red / pink
];

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** smoothstep on [0,1] */
export const smoothstep = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

const srgbToLin = (v: number): number => {
  const n = v / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
};
const linToSrgb = (v: number): number => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp(s * 255, 0, 255);
};

const LIN_STOPS: Array<[number, RGB]> = STOPS.map(([p, c]) => [
  p,
  [srgbToLin(c[0]), srgbToLin(c[1]), srgbToLin(c[2])],
]);

/** Color at normalized position t∈[0,1], blended in linear-light space. */
export function colorAt(t: number): RGB {
  const u = clamp(t, 0, 1);
  for (let i = 0; i < LIN_STOPS.length - 1; i++) {
    const [p0, c0] = LIN_STOPS[i];
    const [p1, c1] = LIN_STOPS[i + 1];
    if (u >= p0 && u <= p1) {
      const n = (u - p0) / (p1 - p0 || 1);
      return [
        linToSrgb(lerp(c0[0], c1[0], n)),
        linToSrgb(lerp(c0[1], c1[1], n)),
        linToSrgb(lerp(c0[2], c1[2], n)),
      ];
    }
  }
  return [...STOPS[STOPS.length - 1][1]];
}

/** amt>0 lightens toward white, amt<0 darkens toward black. */
export function shade(c: RGB, amt: number): RGB {
  const target = amt >= 0 ? 255 : 0;
  const a = Math.abs(amt);
  return [lerp(c[0], target, a), lerp(c[1], target, a), lerp(c[2], target, a)];
}

export const rgb = (c: RGB): string =>
  `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
export const rgba = (c: RGB, a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/**
 * The five `--accent*` CSS custom properties a fader/knob reads. Returned as
 * a style object so a component can spread it onto its root element.
 */
export function accentVars(t: number): Record<string, string> {
  const base = colorAt(t);
  return {
    '--accent': rgb(base),
    '--accent-bright': rgb(shade(base, 0.42)),
    '--accent-deep': rgb(shade(base, -0.28)),
    '--accent-glow': rgba(base, 0.55),
    '--accent-faint': rgba(base, 0.16),
  };
}

/** Deterministic default value (20..89) from a control's name — keeps the
 *  surface looking populated without Math.random, and stable across reloads. */
export function seededValue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return 20 + (Math.abs(h) % 70);
}
