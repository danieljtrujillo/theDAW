/**
 * Live IO for the ported SwayCommand deck: decodes the global midiBus into the
 * exact `io` shape surface.js animates (knobs / pads / xy / gestures), using
 * the same factory layout SwayCommand ships (swaymap.js). One module-level
 * singleton — the deck is drawn per frame from here, no React state churn.
 *
 * Pads accept the chromatic 24..39 range AND the factory Theory-Engine note
 * grid, on any channel (firmware variance), mirroring SwayCommand's decode.
 */
import { subscribeToMidi } from '../../../state/midiBus';
import type { SurfaceIo } from './surface';

export const DECK_FACTORY: {
  knobs: number[];
  xy: { x: number; y: number };
  gestures: { pulse: number; press: number; sway: number };
  pads: { chromaticBase: number; factoryNotes: number[] };
} = {
  knobs: [20, 21, 22, 23, 24, 25, 26, 27],
  xy: { x: 50, y: 38 },
  gestures: { pulse: 35, press: 36, sway: 37 },
  pads: {
    chromaticBase: 24,
    factoryNotes: [47, 49, 50, 52, 54, 55, 57, 59, 61, 62, 64, 66, 67, 69, 71, 73],
  },
};

/** Control id (surface.js grammar) -> the CC it rides in the factory layout. */
export function ctlToCc(ctl: string): number | null {
  if (ctl.startsWith('knob:')) return DECK_FACTORY.knobs[Number(ctl.slice(5))] ?? null;
  if (ctl === 'xy:x') return DECK_FACTORY.xy.x;
  if (ctl === 'xy:y') return DECK_FACTORY.xy.y;
  if (ctl === 'gesture:pulse') return DECK_FACTORY.gestures.pulse;
  if (ctl === 'gesture:press') return DECK_FACTORY.gestures.press;
  if (ctl === 'gesture:sway') return DECK_FACTORY.gestures.sway;
  return null;
}

/** Pad index -> the note number its scene binding should match (chromatic map,
 *  which is what Audima's own Ableton packs use). */
export function padToNote(pad: number): number {
  return DECK_FACTORY.pads.chromaticBase + pad;
}

const io: SurfaceIo = {
  knobs: new Array(8).fill(0),
  pads: new Array(16).fill(0),
  xy: { x: 0.5, y: 0.5 },
  gestures: { pulse: 0, press: 0, sway: 0 },
  level: 0,
  intensity: 0.6,
  beat: 0,
  palette: [
    { r: 0.18, g: 0.88, b: 0.99 },
    { r: 0.35, g: 0.55, b: 1.0 },
    { r: 0.65, g: 0.35, b: 1.0 },
    { r: 1.0, g: 0.18, b: 0.58 },
    { r: 1.0, g: 0.45, b: 0.25 },
  ],
};

/** Monitor line (the deck's OLED): the last decoded event. */
export const deckMonitor: string[] = [''];

let started = false;
let lastCcSeen = 0;

export function getDeckIo(): SurfaceIo {
  // Pad velocity decay + gentle level fade happen on read (the rAF driver
  // calls this every frame) so no interval runs while the deck is hidden.
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  for (let i = 0; i < 16; i++) io.pads[i] = Math.max(0, io.pads[i] - dt * 2.2);
  io.beat = Math.max(0, io.beat - dt * 3);
  io.level = Math.max(0, io.level - dt * 1.5);
  return io;
}
let lastFrame = performance.now();

function padIndexFromNote(note: number): number {
  const c = note - DECK_FACTORY.pads.chromaticBase;
  if (c >= 0 && c < 16) return c;
  return DECK_FACTORY.pads.factoryNotes.indexOf(note);
}

export function startDeckState(): void {
  if (started) return;
  started = true;
  subscribeToMidi((msg) => {
    const [status, d1, d2] = msg.data;
    if (typeof status !== 'number') return;
    const cmd = status & 0xf0;
    const ch = (status & 0x0f) + 1;
    if (cmd === 0xb0) {
      const cc = d1 ?? 0;
      const v = (d2 ?? 0) / 127;
      const k = DECK_FACTORY.knobs.indexOf(cc);
      if (k >= 0) io.knobs[k] = v;
      else if (cc === DECK_FACTORY.xy.x) io.xy.x = v;
      else if (cc === DECK_FACTORY.xy.y) io.xy.y = v;
      else if (cc === DECK_FACTORY.gestures.pulse) io.gestures.pulse = v;
      else if (cc === DECK_FACTORY.gestures.press) io.gestures.press = v;
      else if (cc === DECK_FACTORY.gestures.sway) io.gestures.sway = v;
      io.level = Math.min(1, io.level + 0.08);
      const t = performance.now();
      if (t - lastCcSeen > 90) {
        lastCcSeen = t;
        deckMonitor[0] = `CC${cc}=${d2 ?? 0} ch${ch}`;
      }
      return;
    }
    if (cmd === 0x90 && (d2 ?? 0) > 0) {
      const p = padIndexFromNote(d1 ?? 0);
      if (p >= 0) {
        io.pads[p] = Math.max(io.pads[p], (d2 ?? 0) / 127);
        io.beat = 1;
        deckMonitor[0] = `PAD ${p} vel ${d2}`;
      }
    }
  });
}
