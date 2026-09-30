/**
 * Pure, DOM-free decision logic for the pinned MASTER row in the track list.
 *
 * This row is a VIEW over the master bus that already exists in `editorStore` /
 * `routingGraph` / `liveMixer` — it creates no second sum, no second gain node,
 * and no second FX chain. Everything here reads values the caller already has
 * (chain arrays, automation lanes, a sampled dB reading, a volume percent) and
 * turns them into the label/count/list/percent the row renders. No React, no
 * Zustand, no audio nodes, and no new metering: `meterFillPercent` only maps an
 * already-converted dBFS number onto a fill percentage. `stripMeters.sampleStripLevels()`
 * reports LINEAR peak/rms (1.0 = 0 dBFS; silence is `0`, not `-Infinity`) — a
 * caller must convert with `linearToDb()` (`lib/assistantTools/toolTypes.ts`,
 * or `samplePeakDb()` in `lib/assistantTools/samplePeak.ts`) before calling
 * `meterFillPercent`.
 *
 * The master row is never a track-operation target: `isMasterRowId` /
 * `excludeMasterRow` encode the rule that reorder, marquee track hits, delete,
 * folder ops and clip drops must all skip it.
 */
import { MASTER_ID } from '../../state/routingGraph';

/** Display label for the pinned row. */
export const MASTER_ROW_LABEL = 'MASTER';

/** The master row's id. Re-exports `routingGraph.MASTER_ID` — the row is a view
 *  over the one master the routing graph already has, not a second identity. */
export const MASTER_ROW_ID = MASTER_ID;

/**
 * Total entries across the master's two FX chains (Web-Audio rack + hosted
 * VST3 chain). `undefined`/`null` chains (nothing loaded yet) count as empty.
 */
export function masterFxCount(
  fx: readonly { id: string }[] | undefined,
  vst: readonly { id: string }[] | undefined,
): number {
  return (fx?.length ?? 0) + (vst?.length ?? 0);
}

/** Accessible label for the master FX rack toggle button, singular/plural aware. */
export function masterFxButtonLabel(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    throw new RangeError('count must be a finite, non-negative number');
  }
  if (count === 0) return 'Master FX, no effects';
  if (count === 1) return 'Master FX, 1 effect';
  return `Master FX, ${count} effects`;
}

/**
 * The subset of automation lanes that belong to the master (target kind
 * `'masterFx'`), in their original order. `undefined` (no lanes yet) is `[]`.
 */
export function masterAutomationLanes<L extends { target: { kind: string } }>(
  lanes: readonly L[] | undefined,
): L[] {
  if (!lanes) return [];
  return lanes.filter((lane) => lane.target.kind === 'masterFx');
}

/**
 * Display text for one master automation sub-lane. A lane has no name of its
 * own — only its target — so this mirrors the (unexported) `laneName` in
 * `AutomationLane.tsx` for the `'masterFx'` case, scoped to master since
 * `masterAutomationLanes` has already filtered to that kind.
 */
export function masterLaneLabel(target: { paramKey?: string }): string {
  return `master effect ${target.paramKey ?? 'parameter'}`;
}

/**
 * Meter fill percent for an already-converted dBFS reading: 0 at or below
 * `floorDb`, 100 at 0 dBFS, linear in dB in between, clamped to [0, 100] and
 * rounded to one decimal. `stripMeters.sampleStripLevels()` reports LINEAR
 * peak/rms, not dBFS — convert with `linearToDb()` first. A non-finite `db`
 * — including the `-Infinity` that `linearToDb()`/`samplePeakDb()` return for
 * silence — is 0, not an error: a meter with nothing to show renders empty,
 * it does not throw. `floorDb` has no such leniency: it is the dB floor the
 * fill is measured against, so a non-finite or non-negative value can never
 * produce a meaningful fill and throws `RangeError` instead of silently
 * dividing by zero or a positive span.
 */
export function meterFillPercent(db: number, floorDb = -60): number {
  if (!Number.isFinite(floorDb) || floorDb >= 0) {
    throw new RangeError('floorDb must be a finite, negative number');
  }
  if (!Number.isFinite(db)) return 0;
  const pct = ((db - floorDb) / (0 - floorDb)) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.round(clamped * 10) / 10;
}

/**
 * Accessible label for the master volume control. `volume0to100` is clamped
 * and rounded to a whole percent before formatting, so a fractional or
 * out-of-range value from the fader never reaches the screen reader.
 */
export function masterVolumeAria(volume0to100: number, muted: boolean): string {
  const pct = Math.round(Math.max(0, Math.min(100, volume0to100)));
  return muted ? `Master volume ${pct} percent, muted` : `Master volume ${pct} percent`;
}

/** Whether `id` is the pinned master row's id. */
export function isMasterRowId(id: string): boolean {
  return id === MASTER_ROW_ID;
}

/**
 * Drop the master row from a list of id-bearing entries, keeping the order of
 * everything else. Reorder, marquee track hits, delete, folder ops and clip
 * drops all filter their targets through this so the master row can never be
 * one of them.
 */
export function excludeMasterRow<T extends { id: string }>(ids: readonly T[]): T[] {
  return ids.filter((entry) => !isMasterRowId(entry.id));
}
