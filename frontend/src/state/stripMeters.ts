/**
 * Per-strip meter registry — the READ side of the mixer drawer's strip meters.
 *
 * The audio-graph side lives in `state/liveMixer`: every track and bus strip
 * carries one leaf `AnalyserNode` (`TrackNodes.meter` / `BusNodes.meter`) tapped
 * off the END of that strip, and `getStripMeterNodes()` publishes them keyed by
 * strip id. This module never touches the graph. It re-reads that map on every
 * sample instead of caching nodes, so a rewire, a wholesale rebuild or a
 * disposed session needs no notification here: a replaced analyser is simply the
 * one that gets read next frame, and a strip that is gone stops being reported.
 *
 * WHERE THE TAP SITS, and why it is not `levelsStore`'s. The master meter taps
 * the post-sum master chain, which is downstream of everything — it cannot say
 * which strip is making the noise. A per-strip tap has to come off the end of
 * the strip's own chain, AFTER the plugin-delay compensation delay: a tap at the
 * panner or earlier reads a track `latency + comp` seconds early, so tracks
 * light up out of step with each other and with the master (`liveMixer`'s
 * `TrackNodes.comp` doc states the same rule from the other side). Ardour puts
 * its `PeakMeter` processor at the same place for the same reason —
 * `Route::setup_invisible_processors` inserts `_meter` immediately before or
 * after the main outs for MeterPostFader / MeterOutput
 * (`libs/ardour/route.cc:5744-5752`, with `Route::set_meter_point_unlocked` at
 * `:4618`), and `PeakMeter::run` (`libs/ardour/meter.cc:92`) only observes the
 * buffers it is handed. Ardour is GPL-2.0-or-later: both files were opened for
 * that DESIGN point only and nothing was copied from either.
 *
 * WHAT THIS MODULE IS NOT. No ballistics: hold, decay and the dB mapping belong
 * to `components/audio/levels/meterModel`'s `BarMeter`, exactly as they do for
 * the Levels panel, so a strip bar and the master bar move by the same rules.
 * No Zustand: `sampleStripLevels()` is called once per animation frame from the
 * drawer's single paint loop and returns objects it REUSES between calls, so
 * metering N strips at 60 fps allocates nothing and re-renders nothing.
 */
import { getStripMeterNodes } from './liveMixer';

/** One strip's window reading, linear (1.0 = 0 dBFS) — the same units as
 *  `levelsStore`'s `ChannelLevels` and `recordingStore`'s `LevelFrame`. */
export interface StripLevels {
  /** Largest sample magnitude in the window. */
  peak: number;
  /** Root-mean-square of the window. */
  rms: number;
}

/** The analyser surface this module reads. An `AnalyserNode` satisfies it. */
export interface StripMeterTap {
  readonly fftSize: number;
  getFloatTimeDomainData(into: Float32Array): void;
}

/** Live taps keyed by strip id. `liveMixer.getStripMeterNodes()` satisfies it. */
export type StripMeterTaps = ReadonlyMap<string, StripMeterTap>;

type TapSource = () => StripMeterTaps;

const liveTaps: TapSource = () => getStripMeterNodes();
let taps: TapSource = liveTaps;

/**
 * Point the registry at a different tap source. Production never calls this —
 * the default reads `liveMixer.getStripMeterNodes()`. The seam exists so
 * `stripMeters.test.ts` can drive the registry from a fake graph (the same shape
 * `renderJobs.configureRenderJobs` uses for its clock).
 */
export function configureStripMeters(opts: { taps?: TapSource }): void {
  if (opts.taps) taps = opts.taps;
}

/** Restore the live source. For tests, and for a session teardown. */
export function resetStripMeterSource(): void {
  taps = liveTaps;
}

// ── the registry ────────────────────────────────────────────────────────────
/** ensureStripMeters()/disposeStripMeters() refcount, so two readers can hold
 *  the registry independently and only the last release tears it down. */
let wanted = 0;
/** One analysis buffer per strip, sized from that strip's `fftSize`. */
const buffers = new Map<string, Float32Array>();
/** The reused result: one `StripLevels` per strip, rewritten in place. */
const levels = new Map<string, StripLevels>();

/**
 * Take a hold on the registry. Refcounted — pair every call with
 * `disposeStripMeters()`.
 *
 * There is no graph work to do here (the analysers exist for as long as the
 * strips do, built with them by `liveMixer`); the hold owns the per-strip
 * buffers, which are `fftSize` floats each and are dropped when the last reader
 * goes away rather than being kept alive by a closed drawer.
 */
export function ensureStripMeters(): void {
  wanted += 1;
}

/** Release one `ensureStripMeters()` hold; the buffers go with the last one. */
export function disposeStripMeters(): void {
  wanted = Math.max(0, wanted - 1);
  if (wanted > 0) return;
  buffers.clear();
  levels.clear();
}

/**
 * Read every live strip's analyser once, and return the readings keyed by strip
 * id. Call once per animation frame.
 *
 * `null` means NO READING — nothing is holding the registry, or the live mixer
 * has no strips (nothing has played yet, or the session was disposed). It does
 * not mean silence, and a caller must feed its ballistics zeros on a null so a
 * bar decays away instead of freezing at whatever it last showed.
 *
 * The returned map and the `StripLevels` inside it are REUSED between calls:
 * read the values within the frame, never hold the objects.
 */
export function sampleStripLevels(): ReadonlyMap<string, StripLevels> | null {
  if (wanted <= 0) return null;
  const live = taps();
  if (live.size === 0) return null;

  // Drop strips that went away with a rebuild, so a deleted track's last
  // reading cannot sit in the map forever pretending to be current.
  for (const id of levels.keys()) {
    if (live.has(id)) continue;
    levels.delete(id);
    buffers.delete(id);
  }

  for (const [id, tap] of live) {
    const n = tap.fftSize;
    let buf = buffers.get(id);
    if (!buf || buf.length !== n) {
      buf = new Float32Array(n);
      buffers.set(id, buf);
    }
    tap.getFloatTimeDomainData(buf);

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      const v = buf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSq += v * v;
    }

    let out = levels.get(id);
    if (!out) {
      out = { peak: 0, rms: 0 };
      levels.set(id, out);
    }
    out.peak = peak;
    out.rms = Math.sqrt(sumSq / n);
  }

  return levels;
}
