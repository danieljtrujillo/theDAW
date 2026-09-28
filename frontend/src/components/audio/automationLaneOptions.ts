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
import type { AutomationLane, AutomationTarget, EditorTrack } from '../../state/editorStore';
import { automationTargetKey, midiCcTarget } from '../../state/editorStore';
import { PART_CONTROLLERS } from '../../lib/rollTracks';
import type { ChainEntry } from '../../state/effectChainStore';
import { getRackEffect } from '../../lib/rackEffects';

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
