/**
 * Every target the automation panel's "Add lane" picker can offer.
 *
 * Built from the SAME target shapes the assistant's `editor_add_automation_lane`
 * tool resolves (`AUTOMATION_KINDS` in `state/editorTools.ts`): a volume and a
 * pan target per track, plus one target per numeric param on every FX chain
 * entry — track racks and the master rack alike. Before this picker existed,
 * `addAutomationLane` (editorStore.ts) was reachable only from that assistant
 * tool surface; a user who wanted a lane for a parameter they had not ridden
 * under WRITE had no way in.
 *
 * A target that already has a lane is left out — `addAutomationLane` is
 * idempotent and would just hand its id back, but offering it again in the
 * picker would read as "add a second one".
 *
 * Pure and DOM-free so it is unit-testable without mounting WaveformEditor.
 */
import type { AutomationLane, AutomationTarget, EditorBus, EditorTrack } from '../../state/editorStore';
import { automationTargetKey, midiCcTarget } from '../../state/editorStore';
import { PART_CONTROLLERS } from '../../lib/rollTracks';
import type { ChainEntry } from '../../state/effectChainStore';
import { getRackEffect } from '../../lib/rackEffects';
import { visibleVstParams, vstParamKey, type VstParamView } from '../../state/vstParamStore';

export interface AddLaneOption {
  key: string;
  label: string;
  target: AutomationTarget;
}

// Both callers below only ever reach these two helpers after `getRackEffect`
// has already resolved for `entry` (the loops `continue` past an entry whose
// effect id has no rack descriptor before calling either), so the `?? paramKey`
// and `?? entry.label ?? entry.effect` fallbacks are currently unreachable
// through this module's public API. Left in as deliberate defensive
// future-proofing for a caller that resolves `fxParamLabel`/`fxEffectLabel`
// outside that guard.
const fxParamLabel = (entry: ChainEntry, paramKey: string): string =>
  getRackEffect(entry.effect)?.params.find((p) => p.key === paramKey)?.label ?? paramKey;

const fxEffectLabel = (entry: ChainEntry): string => getRackEffect(entry.effect)?.label ?? entry.label ?? entry.effect;

/**
 * `midiTrackIds` names the tracks that play MIDI (a piano-roll clip on them);
 * each of those, and every track with an instrument or a drum kit of its own,
 * also offers one controller lane per controller a roll part keeps
 * (trackMidiCc: modulation, volume, pan, expression, pedal, brightness,
 * reverb send), sent on every channel the track's MIDI plays on.
 */
export function buildAddAutomationLaneOptions(
  tracks: readonly EditorTrack[],
  masterFxChain: readonly ChainEntry[],
  automationLanes: readonly AutomationLane[],
  midiTrackIds: ReadonlySet<string> = new Set(),
  buses: readonly EditorBus[] = [],
): AddLaneOption[] {
  const hasLane = (target: AutomationTarget) =>
    automationLanes.some((l) => automationTargetKey(l.target) === automationTargetKey(target));

  const opts: AddLaneOption[] = [];

  for (const t of tracks) {
    const volTarget: AutomationTarget = { kind: 'trackVolume', trackId: t.id };
    if (!hasLane(volTarget)) opts.push({ key: automationTargetKey(volTarget), label: `${t.name} · Volume`, target: volTarget });

    const panTarget: AutomationTarget = { kind: 'trackPan', trackId: t.id };
    if (!hasLane(panTarget)) opts.push({ key: automationTargetKey(panTarget), label: `${t.name} · Pan`, target: panTarget });

    if (midiTrackIds.has(t.id) || t.instrumentProgram !== undefined || t.isPercussion === true) {
      for (const c of PART_CONTROLLERS) {
        const ccTarget = midiCcTarget(t.id, c.controller);
        if (!hasLane(ccTarget)) opts.push({ key: automationTargetKey(ccTarget), label: `${t.name} · MIDI CC ${c.controller} ${c.name}`, target: ccTarget });
      }
    }

    for (const entry of t.fxChain ?? []) {
      for (const paramKey of Object.keys(entry.params ?? {})) {
        if (!getRackEffect(entry.effect)?.params.some((p) => p.key === paramKey)) continue;
        const fxTargetOpt: AutomationTarget = { kind: 'trackFx', trackId: t.id, entryId: entry.id, paramKey };
        if (!hasLane(fxTargetOpt)) {
          opts.push({ key: automationTargetKey(fxTargetOpt), label: `${t.name} · ${fxEffectLabel(entry)} ${fxParamLabel(entry, paramKey)}`, target: fxTargetOpt });
        }
      }
    }
  }

  // A bus rack's effects, the way a track's are offered. A busFx lane names the
  // bus in `trackId`, the routing node id.
  for (const b of buses) {
    for (const entry of b.fxChain) {
      for (const paramKey of Object.keys(entry.params ?? {})) {
        if (!getRackEffect(entry.effect)?.params.some((p) => p.key === paramKey)) continue;
        const fxTargetOpt: AutomationTarget = { kind: 'busFx', trackId: b.id, entryId: entry.id, paramKey };
        if (!hasLane(fxTargetOpt)) {
          opts.push({ key: automationTargetKey(fxTargetOpt), label: `${b.name} · ${fxEffectLabel(entry)} ${fxParamLabel(entry, paramKey)}`, target: fxTargetOpt });
        }
      }
    }
  }

  for (const entry of masterFxChain) {
    for (const paramKey of Object.keys(entry.params ?? {})) {
      if (!getRackEffect(entry.effect)?.params.some((p) => p.key === paramKey)) continue;
      const fxTargetOpt: AutomationTarget = { kind: 'masterFx', entryId: entry.id, paramKey };
      if (!hasLane(fxTargetOpt)) {
        opts.push({ key: automationTargetKey(fxTargetOpt), label: `Master · ${fxEffectLabel(entry)} ${fxParamLabel(entry, paramKey)}`, target: fxTargetOpt });
      }
    }
  }

  return opts;
}

/* ── Hosted plugins ─────────────────────────────────────────────────────────
   A VST3 insert's parameters are not a rack descriptor's: they are whatever the
   plugin declares, listed by its live host (state/vstParamStore), and there can
   be hundreds. So the picker asks in two steps, the insert and then one of ITS
   parameters, instead of folding every plugin's list into the one select above. */

/** One hosted VST3 insert a lane can ride: a track's, a bus's or the master's. */
export interface VstInsertOption {
  /** Unique across the project: the entry id. */
  key: string;
  /** "Owner · Plugin", as the lane list names its lanes. */
  label: string;
  entryId: string;
  /** The lane's kind and owner; the parameter's key completes it. */
  kind: 'trackFx' | 'busFx' | 'masterFx';
  /** The track or bus id; absent for the master. */
  ownerId?: string;
}

/** Every VST3 insert in the project, in mixer order: tracks, then buses, then
 *  the master chain. `name` is the plugin's name as its FX row shows it. */
export function buildVstAutomationInserts(
  tracks: readonly EditorTrack[],
  buses: readonly EditorBus[],
  masterVstChain: readonly ChainEntry[],
  name: (entry: ChainEntry) => string,
): VstInsertOption[] {
  const out: VstInsertOption[] = [];
  for (const t of tracks) {
    for (const e of t.fxChain ?? []) {
      if (e.effect !== 'vst3' || !e.vst) continue;
      out.push({ key: e.id, label: `${t.name} · ${name(e)}`, entryId: e.id, kind: 'trackFx', ownerId: t.id });
    }
  }
  for (const b of buses) {
    for (const e of b.fxChain) {
      if (e.effect !== 'vst3' || !e.vst) continue;
      out.push({ key: e.id, label: `${b.name} · ${name(e)}`, entryId: e.id, kind: 'busFx', ownerId: b.id });
    }
  }
  for (const e of masterVstChain) {
    if (!e.vst) continue;
    out.push({ key: e.id, label: `Master · ${name(e)}`, entryId: e.id, kind: 'masterFx' });
  }
  return out;
}

/** The lane target for parameter `index` of `insert`. */
export const vstParamLaneTarget = (insert: VstInsertOption, index: number): AutomationTarget => ({
  kind: insert.kind,
  ...(insert.kind === 'masterFx' ? {} : { trackId: insert.ownerId }),
  entryId: insert.entryId,
  paramKey: vstParamKey(index),
});

/** One parameter of a plugin a lane can be added for. */
export interface VstParamLaneOption {
  index: number;
  label: string;
  target: AutomationTarget;
}

/**
 * The parameters of `insert` a lane can be added for: the ones the plugin shows
 * (not its own book-keeping), that it lets a host automate and that it does not
 * only report (a meter), less those that already have a lane.
 */
export function buildVstParamLaneOptions(
  insert: VstInsertOption,
  params: readonly VstParamView[],
  automationLanes: readonly AutomationLane[],
): VstParamLaneOption[] {
  const taken = new Set(automationLanes.map((l) => automationTargetKey(l.target)));
  const out: VstParamLaneOption[] = [];
  for (const p of visibleVstParams([...params])) {
    if (!p.automatable || p.readOnly) continue;
    const target = vstParamLaneTarget(insert, p.index);
    if (taken.has(automationTargetKey(target))) continue;
    out.push({ index: p.index, label: p.name || `Parameter ${p.index + 1}`, target });
  }
  return out;
}
