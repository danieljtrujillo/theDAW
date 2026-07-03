/**
 * LIVE (master output FX) bindable targets — the always-available, sound-only
 * surface for VST-Foundry demo mode. Every target drives one parameter of the
 * liveMasterFx chain on the player's live-FX insert, so a Foundry control
 * bound to one of these audibly shapes whatever the footer transport is
 * playing, from any tab — the bind-test loop for building VST UIs.
 *
 * Strictly non-destructive: nothing here touches files, clips, the MIX chain,
 * or render settings — monitoring path only. Same BindableTarget shape as
 * DJ/MAKE/PROCESS, so the routing engine and XR source drive them with no
 * per-control wiring.
 */
import type { BindableTarget } from '../components/surface/widgetTypes';
import { setLiveFxParam, type LiveFxKey } from '../lib/liveMasterFx';

const G = 'Live Audio (Master)';

const num = (key: LiveFxKey) => (v: number | boolean) => setLiveFxParam(key, Number(v));
const bool = (key: LiveFxKey) => (v: number | boolean) => setLiveFxParam(key, Boolean(v));

export const LIVE_FX_TARGETS: BindableTarget[] = [
  { id: 'live.volume', label: 'Output Volume', group: G, kind: 'fader', min: 0, max: 150, step: 1, unit: '%', invoke: num('volume') },
  { id: 'live.mute', label: 'Mute', group: G, kind: 'toggle', invoke: bool('mute') },
  { id: 'live.pan', label: 'Pan', group: G, kind: 'knob', min: -100, max: 100, step: 1, unit: '%', invoke: num('pan') },
  // Cutoffs are % of a log sweep (see liveMasterFx) so knob travel is
  // perceptually even; 100 % LP / 0 % HP = fully open.
  { id: 'live.lpCutoff', label: 'Low-Pass Cutoff', group: G, kind: 'knob', min: 0, max: 100, step: 1, unit: '%', invoke: num('lpCutoff') },
  { id: 'live.hpCutoff', label: 'High-Pass Cutoff', group: G, kind: 'knob', min: 0, max: 100, step: 1, unit: '%', invoke: num('hpCutoff') },
  { id: 'live.resonance', label: 'Filter Resonance', group: G, kind: 'knob', min: 0, max: 100, step: 1, unit: '%', invoke: num('resonance') },
  { id: 'live.eqLow', label: 'EQ Low', group: G, kind: 'knob', min: -15, max: 15, step: 0.5, unit: 'dB', invoke: num('eqLow') },
  { id: 'live.eqMid', label: 'EQ Mid', group: G, kind: 'knob', min: -15, max: 15, step: 0.5, unit: 'dB', invoke: num('eqMid') },
  { id: 'live.eqHigh', label: 'EQ High', group: G, kind: 'knob', min: -15, max: 15, step: 0.5, unit: 'dB', invoke: num('eqHigh') },
  { id: 'live.drive', label: 'Drive', group: G, kind: 'knob', min: 0, max: 100, step: 1, unit: '%', invoke: num('drive') },
  { id: 'live.delayMix', label: 'Echo Mix', group: G, kind: 'knob', min: 0, max: 100, step: 1, unit: '%', invoke: num('delayMix') },
  { id: 'live.delayTime', label: 'Echo Time', group: G, kind: 'knob', min: 30, max: 1000, step: 5, unit: 'ms', invoke: num('delayTime') },
  { id: 'live.delayFeedback', label: 'Echo Feedback', group: G, kind: 'knob', min: 0, max: 90, step: 1, unit: '%', invoke: num('delayFeedback') },
  { id: 'live.bypass', label: 'FX Bypass', group: G, kind: 'toggle', invoke: bool('bypass') },
];
