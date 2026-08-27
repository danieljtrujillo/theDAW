// Types for the verbatim SwayCommand surface port (surface.js).
export interface SurfaceIo {
  knobs: number[]; // 8, 0..1
  pads: number[]; // 16, velocity 0..1 (decayed by the caller)
  xy: { x: number; y: number }; // 0..1
  gestures: { pulse: number; press: number; sway: number }; // 0..1
  level: number; // master audio level 0..1
  intensity: number; // visual intensity 0..1
  beat: number; // beat flash 0..1
  palette: { r: number; g: number; b: number }[]; // LED gradient stops (0..1 rgb)
}

export interface SurfaceHandle {
  el: SVGSVGElement;
  update(io: SurfaceIo, monitor: string[]): void;
  refresh(labels: (string | null)[], buttonLit?: boolean[] | null): void;
  setStatus(text: string): void;
  select(target: string | null): void;
  setArmed(armed: boolean): void;
}

export const PAD_CELLS: { x: number; y: number }[];
export function createSurface(
  container: HTMLElement,
  opts: { onSelect?: (ctl: string) => void },
): SurfaceHandle;
