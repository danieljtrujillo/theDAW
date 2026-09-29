/**
 * bounceWalksMix — whether a bounce plays through the mix: the routing graph,
 * its buses and sends, and the per-track latency compensation.
 *
 * The master scope does. So does a clip selection printed with its inserts
 * (`includeFx`): live, a selected clip plays through its track's chain, the
 * buses the graph sends that track through, and the master chain, and a print
 * of it that skipped the buses would drop every insert on them. A track stem
 * never does (it is the track's own audio, re-summed by whatever plays it),
 * and a selection with no inserts is the per-clip mix straight to the master
 * (renderCore `perClipMix`).
 *
 * One function, so that renderCore (which builds the graph), insertPrint
 * (which prints the buses in it) and the chunk-safety gate (which judges the
 * racks it builds) cannot disagree. Dependency-free on purpose: the render
 * queue's store imports it, and that store is on the first-paint path.
 */
import type { BounceRequest } from '../renderCore';

export const bounceWalksMix = (req: Pick<BounceRequest, 'scope' | 'includeFx'>): boolean =>
  req.scope.kind === 'master' || (req.scope.kind === 'selection' && req.includeFx);
