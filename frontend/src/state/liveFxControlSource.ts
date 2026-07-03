/**
 * LIVE (master FX) control source for the XR control bus. Mirrors
 * processControlSource: publishes LIVE_FX_TARGETS as manifest entries and
 * routes an inbound control-set to the target's wired `invoke`. Two extras
 * tuned for the VST-Foundry bind-test loop:
 *   - entries carry `value` (the chain's current param state) so a freshly
 *     bound Foundry display element seeds immediately, and
 *   - every applied move is mirrored back out as `control-changed`, so a
 *     Meter / Waveform LISTEN-bound to the same target animates while a knob
 *     drives it — the "did my control work?" feedback loop.
 * Targets + FX lib are imported lazily so they stay out of app boot.
 */
import type { XrControlSource, XrManifestEntry, XrControlValue } from './xrControlClient';
import { publishControlChanged } from './xrControlClient';
import type { BindableTarget } from '../components/surface/widgetTypes';

interface LiveFxModules {
  targets: BindableTarget[];
  getValue: (key: string) => number | boolean | undefined;
}

let cache: LiveFxModules | null = null;

async function load(): Promise<LiveFxModules> {
  if (!cache) {
    const [targetsMod, fxMod] = await Promise.all([
      import('./liveFxTargets'),
      import('../lib/liveMasterFx'),
    ]);
    cache = { targets: targetsMod.LIVE_FX_TARGETS, getValue: fxMod.getLiveFxValue };
  }
  return cache;
}

function toKind(k: BindableTarget['kind']): string {
  if (k === 'pad') return 'button';
  if (k === 'crossfader') return 'fader';
  return k;
}

export const liveFxControlSource: XrControlSource = {
  area: 'live',

  async buildEntries(): Promise<XrManifestEntry[]> {
    const { targets, getValue } = await load();
    return targets.map((t) => ({
      id: t.id,
      area: 'live',
      group: t.group,
      label: t.label,
      kind: toKind(t.kind),
      min: t.min,
      max: t.max,
      step: t.step,
      unit: t.unit,
      value: getValue(t.id.split('.')[1] ?? ''),
    }));
  },

  async apply(id: string, value: XrControlValue): Promise<boolean> {
    const t = (await load()).targets.find((x) => x.id === id);
    if (!t) return false;
    const applied: XrControlValue = t.kind === 'toggle' ? Boolean(value) : Number(value);
    t.invoke(applied);
    // Mirror the move so LISTEN-bound displays (and XR widgets) follow it.
    publishControlChanged(id, applied);
    return true;
  },
};
