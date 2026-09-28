/**
 * hallIrs — the concert-hall impulse responses EDIT's Reverb device can play.
 *
 * The files live under `public/irs/` (see `public/irs/ATTRIBUTION.txt` for the
 * source and its CC BY 4.0 licence, and `scripts/build_hall_irs.py` for how
 * they were made): the Detmold Konzerthaus heard from two audience seats, each
 * with one response per stage position of an eight-source loudspeaker
 * orchestra, plus the whole stage at once.
 *
 * A Reverb entry names its response with two numeric params, because a rack
 * effect's params are numbers: `hall` (0 is the synthesized room, 1.. a seat
 * below) and `position` (0 is the whole stage, 1-8 the sources S1-S8).
 *
 * Loading is fetch + `decodeAudioData` on the context that will play the
 * response, so it arrives at that context's sample rate, which a
 * ConvolverNode requires. The fetched bytes are kept per file and the decoded
 * buffer per file and sample rate, so a second Reverb, a rebuilt chain or an
 * offline bounce at the same rate reuses the first decode. `cachedHallIr`
 * answers synchronously for the Reverb factory; `ensureHallIrsForChains`
 * is what an offline bounce awaits before it builds its racks.
 */
import type { ChainEntry } from '../state/effectChainStore';
import { logWarn } from '../state/logStore';

/** The `hall` param value of the synthesized room: no file. */
export const HALL_SYNTHETIC = 0;
/** The `position` param value of the whole stage. */
export const POSITION_WHOLE_STAGE = 0;

export interface HallIrHall {
  /** The `hall` param value. */
  value: number;
  label: string;
  /** Folder under /irs/. */
  dir: string;
}

export type StageRow = 'front' | 'back' | 'all';

export interface HallIrPosition {
  /** The `position` param value. */
  value: number;
  label: string;
  /** File name under the hall's folder, without `.flac`. */
  file: string;
  /** Metres from the stage centre line, seen from the audience (negative is left). */
  xM: number;
  row: StageRow;
}

export const HALL_IR_HALLS: readonly HallIrHall[] = Object.freeze([
  { value: 1, label: 'Detmold Konzerthaus, front stalls', dir: 'detmold-konzerthaus/seat-211' },
  { value: 2, label: 'Detmold Konzerthaus, rear stalls', dir: 'detmold-konzerthaus/seat-372' },
]);

/**
 * The stage positions, seen from the audience: the loudspeaker orchestra's
 * front row S1-S4 at -4, -2, 2 and 4 m, the row 2 m behind it S5-S8 at -3, -1,
 * 1 and 3 m (DetmoldKH_POSITIONS_Dense.png in the source archive).
 */
export const HALL_IR_POSITIONS: readonly HallIrPosition[] = Object.freeze([
  { value: 0, label: 'Whole stage', file: 'stage', xM: 0, row: 'all' },
  { value: 1, label: 'Front far left', file: 's1', xM: -4, row: 'front' },
  { value: 2, label: 'Front left', file: 's2', xM: -2, row: 'front' },
  { value: 3, label: 'Front right', file: 's3', xM: 2, row: 'front' },
  { value: 4, label: 'Front far right', file: 's4', xM: 4, row: 'front' },
  { value: 5, label: 'Back far left', file: 's5', xM: -3, row: 'back' },
  { value: 6, label: 'Back left', file: 's6', xM: -1, row: 'back' },
  { value: 7, label: 'Back right', file: 's7', xM: 1, row: 'back' },
  { value: 8, label: 'Back far right', file: 's8', xM: 3, row: 'back' },
]);

/** The Reverb's `hall` select, option i having value i. */
export const HALL_OPTION_LABELS: readonly string[] = Object.freeze(['Synthetic room', ...HALL_IR_HALLS.map((h) => h.label)]);
/** The Reverb's `position` select, option i having value i. */
export const POSITION_OPTION_LABELS: readonly string[] = Object.freeze(HALL_IR_POSITIONS.map((p) => p.label));

const whole = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

/** The hall a `hall` param value names, or undefined for the synthesized room (and anything unknown). */
export const hallIrHall = (hall: number | undefined): HallIrHall | undefined =>
  HALL_IR_HALLS.find((h) => h.value === whole(hall));

/** The position a `position` param value names; the whole stage for anything unknown. */
export const hallIrPosition = (position: number | undefined): HallIrPosition =>
  HALL_IR_POSITIONS.find((p) => p.value === whole(position)) ?? HALL_IR_POSITIONS[0];

/** The URL of the response `hall` and `position` name, or null for the synthesized room. */
export function hallIrUrl(hall: number | undefined, position: number | undefined): string | null {
  const h = hallIrHall(hall);
  if (!h) return null;
  return `/irs/${h.dir}/${hallIrPosition(position).file}.flac`;
}

/** "Detmold Konzerthaus, front stalls · Back left", or "Synthetic room". */
export function hallIrLabel(hall: number | undefined, position: number | undefined): string {
  const h = hallIrHall(hall);
  return h ? `${h.label} · ${hallIrPosition(position).label}` : HALL_OPTION_LABELS[0];
}

/* ── loading ────────────────────────────────────────────────────────────── */

/** Fetch a file's bytes. The app's is `fetch`; tests pass their own. */
export type HallIrFetch = (url: string) => Promise<ArrayBuffer>;

/** The one context method a load needs, so a test can stand in for it. */
export type HallIrDecodeContext = Pick<BaseAudioContext, 'sampleRate' | 'decodeAudioData'>;

const defaultFetch: HallIrFetch = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
};

let fetchBytes: HallIrFetch = defaultFetch;
const bytesByUrl = new Map<string, Promise<ArrayBuffer>>();
const decoded = new Map<string, AudioBuffer>();
const pending = new Map<string, Promise<AudioBuffer | null>>();

const cacheKey = (url: string, sampleRate: number): string => `${url}@${sampleRate}`;

/** The decoded response at `url` for a context at `sampleRate`, when one is loaded. */
export const cachedHallIr = (url: string, sampleRate: number): AudioBuffer | undefined =>
  decoded.get(cacheKey(url, sampleRate));

/**
 * Load the response at `url` for `ctx`: its bytes (fetched once), decoded by
 * `ctx.decodeAudioData` at the context's rate (once per rate). Resolves null
 * when the file cannot be fetched or decoded, after one LOG warning, and the
 * next call tries again.
 */
export function loadHallIr(ctx: HallIrDecodeContext, url: string): Promise<AudioBuffer | null> {
  const key = cacheKey(url, ctx.sampleRate);
  const done = decoded.get(key);
  if (done) return Promise.resolve(done);
  const running = pending.get(key);
  if (running) return running;
  const load = (async () => {
    try {
      let bytes = bytesByUrl.get(url);
      if (!bytes) {
        bytes = fetchBytes(url);
        bytesByUrl.set(url, bytes);
      }
      // decodeAudioData detaches the buffer it is handed, so it gets a copy.
      const buf = await ctx.decodeAudioData((await bytes).slice(0));
      decoded.set(key, buf);
      return buf;
    } catch (e) {
      bytesByUrl.delete(url);
      logWarn('reverb', `Could not load the hall response ${url} (${e instanceof Error ? e.message : String(e)}); the Reverb plays its synthesized room`);
      return null;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, load);
  return load;
}

/** The hall responses the enabled Reverb entries of `chains` play, by URL. */
export function hallIrUrlsInChains(chains: ReadonlyArray<readonly ChainEntry[] | undefined>): string[] {
  const urls = new Set<string>();
  for (const chain of chains) {
    for (const e of chain ?? []) {
      if (e.effect !== 'reverb' || !e.enabled) continue;
      const url = hallIrUrl(e.params?.hall, e.params?.position);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

/**
 * Load every hall response the enabled Reverb entries of `chains` play, for
 * `ctx`. An offline bounce awaits this before it builds its racks, so each
 * Reverb finds its response decoded and renders with it from the first sample.
 * A response that fails to load is left out (the Reverb plays its synthesized
 * room, with the LOG line `loadHallIr` writes).
 */
export async function ensureHallIrsForChains(
  ctx: HallIrDecodeContext,
  chains: ReadonlyArray<readonly ChainEntry[] | undefined>,
): Promise<void> {
  await Promise.all(hallIrUrlsInChains(chains).map((url) => loadHallIr(ctx, url)));
}

/** Test seam: replace the fetcher (null restores `fetch`) and forget every load. */
export function resetHallIrCacheForTests(fetcher: HallIrFetch | null = null): void {
  fetchBytes = fetcher ?? defaultFetch;
  bytesByUrl.clear();
  decoded.clear();
  pending.clear();
}
