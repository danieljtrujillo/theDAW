// Lane colours for the Chimera DNA visualiser. Matches the palette from the
// original DNA-splice prototype so each track strand reads as a distinct voice.
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = [0x00e5ff, 0xff2d78, 0xffd23f, 0x65ff8a, 0xb06cff];

export const LANE_RGB: Rgb[] = HEX.map((h) => ({
  r: (h >> 16) & 255,
  g: (h >> 8) & 255,
  b: h & 255,
}));

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };

export const laneColor = (i: number): Rgb => {
  const n = LANE_RGB.length;
  return LANE_RGB[((i % n) + n) % n];
};

export const rgba = (c: Rgb, a: number): string =>
  `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;

export const rgbCss = (c: Rgb): string => `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`;

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});
