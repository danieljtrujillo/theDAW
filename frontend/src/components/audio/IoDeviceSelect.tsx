/**
 * The one device picker.
 *
 * Every place that used to roll its own `<select>` of `enumerateDevices()`
 * results renders this instead, so they share one option vocabulary ("Default
 * (Scarlett 2i2)" vs "System default" vs a named device), one story for the
 * pre-permission state, and one visible answer when the saved device is gone.
 * Before this there were three pickers with three different first-option
 * labels, two of which invented names like "Input 4f2a1b" out of a device id.
 *
 * Accessibility (CLAUDE.md rule 3): a native <select> with a stable `id`, a
 * matching `name`, and a real <label htmlFor> — visible or sr-only, never
 * absent. The warning chips are plain text next to it, not a title-only hint.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { registerSinkElement } from '../../lib/audioSink';
import {
  FOLLOW_GLOBAL,
  type DeviceRef,
  type LiveDevice,
  type Resolved,
} from '../../lib/ioResolve';
import { overrideSelectValue } from '../../lib/ioResolve';
import {
  deviceRefFromId,
  liveDevices,
  resolveGlobal,
  setGlobalDevice,
  setSurfaceOverrideFromSelect,
  surfaceOverride,
  useIoDevicesStore,
  useResolvedGlobal,
  useResolvedSurface,
  type IoSlot,
} from '../../state/ioDevicesStore';
import { GLOBAL_SLOT_FOR_KIND, surfaceById, type SurfaceId } from '../../state/ioSurfaces';
import { SELECT } from '../layout/settings/shared';

interface Option {
  value: string;
  text: string;
}


/** The shared presentational half: label + select + the honest status chips. */
const DeviceSelect: React.FC<{
  id: string;
  label: string;
  title?: string;
  value: string;
  options: Option[];
  onPick: (value: string) => void;
  disabled?: boolean;
  /** Shown instead of the list when the platform cannot route at all. */
  unsupported?: string;
  /** Blank labels: the list is not trustworthy yet, so say why. */
  labelsKnown: boolean;
  missing?: DeviceRef;
  showLabel?: boolean;
  labelClassName?: string;
  className?: string;
}> = ({
  id,
  label,
  title,
  value,
  options,
  onPick,
  disabled,
  unsupported,
  labelsKnown,
  missing,
  showLabel,
  labelClassName = 'text-[11px] font-mono uppercase tracking-wider text-zinc-400 shrink-0',
  className = '',
}) => (
  <>
    <label htmlFor={id} className={showLabel ? labelClassName : 'sr-only'}>
      {label}
    </label>
    <select
      id={id}
      name={id}
      value={value}
      onChange={(e) => onPick(e.target.value)}
      aria-label={label}
      title={unsupported || title || label}
      disabled={disabled || !!unsupported}
      className={`${SELECT} ${className}`}
      style={{ colorScheme: 'dark' }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.text}
        </option>
      ))}
    </select>
    {unsupported && <span className="text-[11px] font-mono text-amber-300/80">{unsupported}</span>}
    {!unsupported && missing && (
      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-300">
        <AlertTriangle className="w-3 h-3 shrink-0" />
        not connected — using the system default
      </span>
    )}
    {!unsupported && !labelsKnown && (
      <span className="text-[11px] font-mono text-zinc-500">
        device names appear once something opens the mic
      </span>
    )}
  </>
);

/** Live devices that are safe to name. A blank label is never invented into one. */
const namedDevices = (live: LiveDevice[]): LiveDevice[] => live.filter((d) => d.label !== '');

/**
 * Keep the current value selectable even when the device is not in the list —
 * otherwise a saved choice renders as a blank box and looks lost.
 *
 * The wording distinguishes the two ways that happens: a device we KNOW is
 * absent says so, while one we simply cannot see yet (no permission, so every
 * label is blank) is named without any claim about it.
 */
const withCurrent = (
  options: Option[],
  value: string,
  saved: DeviceRef | undefined,
  known: 'missing' | 'unverified',
): Option[] => {
  if (!value || options.some((o) => o.value === value)) return options;
  const name = saved?.label || 'Saved device';
  return [...options, { value, text: known === 'missing' ? `${name} (not connected)` : name }];
};

/* ── per-surface override ─────────────────────────────────────────────────── */

export const IoSurfaceSelect: React.FC<{
  surface: SurfaceId;
  /** DOM id; also used as the `name`. */
  id?: string;
  /** Accessible name; visible when `showLabel`. */
  label?: string;
  showLabel?: boolean;
  labelClassName?: string;
  className?: string;
}> = ({ surface, id, label, showLabel, labelClassName, className }) => {
  const def = surfaceById(surface);
  const kind = def?.kind ?? 'audioIn';
  const resolved: Resolved = useResolvedSurface(surface);
  const live = useIoDevicesStore((s) => (kind === 'audioIn' ? s.audioIn : s.audioOut));
  const labelsKnown = useIoDevicesStore((s) => s.labelsKnown);
  const globalResolved = resolveGlobal(GLOBAL_SLOT_FOR_KIND[kind]);
  const override = surfaceOverride(surface);

  const globalName = globalResolved.label || 'system default';
  const options = withCurrent(
    [
      { value: FOLLOW_GLOBAL, text: `Default (${globalName})` },
      { value: '', text: 'System default' },
      ...namedDevices(live).map((d) => ({ value: d.id, text: d.label })),
    ],
    overrideSelectValue(override),
    override,
    resolved.source === 'missing' ? 'missing' : 'unverified',
  );

  const domId = id ?? `io-surface-${surface}`;
  return (
    <DeviceSelect
      id={domId}
      label={label ?? `${def?.label ?? surface} device`}
      title={def?.hint}
      value={overrideSelectValue(override)}
      options={options}
      onPick={(v) => void setSurfaceOverrideFromSelect(surface, v)}
      labelsKnown={labelsKnown}
      missing={resolved.source === 'missing' ? resolved.missing : undefined}
      showLabel={showLabel}
      labelClassName={labelClassName}
      className={className}
    />
  );
};

/* ── a global slot ───────────────────────────────────────────────────────── */

export const IoGlobalSelect: React.FC<{
  slot: IoSlot;
  id?: string;
  label: string;
  showLabel?: boolean;
  labelClassName?: string;
  className?: string;
  /** Set when the runtime cannot route this slot at all; disables the list. */
  unsupported?: string;
}> = ({ slot, id, label, showLabel, labelClassName, className, unsupported }) => {
  const resolved = useResolvedGlobal(slot);
  const kind = slot === 'audio_input' ? 'audioIn' : slot === 'midi_output' ? 'midiOut' : slot === 'visual_display' ? 'display' : 'audioOut';
  const live = useIoDevicesStore((s) =>
    kind === 'audioIn' ? s.audioIn : kind === 'midiOut' ? s.midiOut : kind === 'display' ? s.display : s.audioOut,
  );
  const labelsKnown = useIoDevicesStore((s) =>
    kind === 'audioIn' || kind === 'audioOut' ? s.labelsKnown : true,
  );
  // A device that is gone still shows as the chosen one — the setting is kept
  // so re-plugging it restores it, and a select that silently jumped back to
  // "System default" would hide that.
  const saved: DeviceRef | undefined =
    resolved.missing ?? (resolved.deviceId ? { id: resolved.deviceId, label: resolved.label } : undefined);
  const current = saved?.id ?? '';

  const firstOption =
    slot === 'midi_output' ? "Don't send MIDI" : slot === 'visual_display' ? 'Same window' : 'System default';
  const options = withCurrent(
    [
      { value: '', text: firstOption },
      ...namedDevices(live).map((d) => ({ value: d.id, text: d.label })),
    ],
    current,
    saved,
    resolved.source === 'missing' ? 'missing' : 'unverified',
  );

  return (
    <DeviceSelect
      id={id ?? `io-global-${slot}`}
      label={label}
      value={current}
      options={options}
      onPick={(v) => void setGlobalDevice(slot, deviceRefFromId(slot, v))}
      unsupported={unsupported}
      labelsKnown={labelsKnown}
      missing={resolved.source === 'missing' ? resolved.missing : undefined}
      showLabel={showLabel}
      labelClassName={labelClassName}
      className={className}
    />
  );
};

/**
 * An <audio> element that follows a surface's OUTPUT setting.
 *
 * These elements sit outside the shared Web Audio graph, so
 * AudioContext.setSinkId does not move them; they register with the element
 * registry instead and get re-pointed whenever the setting changes.
 */
export const SurfaceAudio: React.FC<
  React.AudioHTMLAttributes<HTMLAudioElement> & { surface: SurfaceId }
> = ({ surface, ...rest }) => {
  const ref = React.useRef<HTMLAudioElement | null>(null);
  React.useEffect(() => registerSinkElement(surface, ref.current), [surface]);
  return <audio ref={ref} {...rest} />;
};

/** Non-hook read for a component that only needs the id (effect deps). */
export const currentDeviceIds = (kind: 'audioIn' | 'audioOut'): LiveDevice[] => liveDevices(kind);
