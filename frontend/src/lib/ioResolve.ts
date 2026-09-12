/**
 * Device resolution — the pure half of the global input/output menu.
 *
 * A saved device choice cannot be a bare `deviceId` string. Browser device ids
 * are salted per origin and rotate whenever site data is cleared, and this app
 * runs on two origins for the same user (the Vite browser build on :5173 and
 * the desktop app on app://, switched with Settings → launch mode). So every
 * slot persists a `DeviceRef` — the id AND the label the device had when it was
 * chosen — and this module turns that ref plus the live device list back into
 * something to hand the browser:
 *
 *   1. exact id match          → use it
 *   2. exact label match       → use it, and hand back a `rewrite` so the store
 *                                can re-persist the ref with the new id
 *   3. labels not known yet    → pass the saved id through unjudged; before the
 *                                first getUserMedia every label is '' and NO
 *                                conclusion about "gone" is available
 *   4. nothing matched         → the system default, `source: 'missing'`, and
 *                                the caller raises ONE visible notice. Never a
 *                                silent substitution, and the saved ref is kept
 *                                so re-plugging the device restores it.
 *
 * No DOM, no zustand, no side effects — every branch above is pinned in
 * ioResolve.test.ts.
 */

/** Every device family the menu can target. */
export type IoKind = 'audioOut' | 'audioIn' | 'midiIn' | 'midiOut' | 'display';

/** A persisted device choice. Empty id AND empty label = "system default". */
export interface DeviceRef {
  id: string;
  label: string;
}

/** One device as the platform reports it right now. */
export interface LiveDevice {
  id: string;
  label: string;
}

/** The stored value for "no choice made — use whatever the OS picks". */
export const SYSTEM_DEFAULT: DeviceRef = { id: '', label: '' };

/**
 * Per-surface select sentinel for "follow the global slot". It cannot be '' —
 * '' already means "the OS default" everywhere in this codebase (the DJ cue
 * select, the SING mic select, the MIDI tab's mic select all use it), so
 * reusing it here would make "follow global" and "ignore global" the same
 * option. A surface that follows the global simply has no `overrides` entry.
 */
export const FOLLOW_GLOBAL = '@global';

export type ResolveSource =
  /** Nothing was chosen. */
  | 'system'
  /** The saved id is in the live list. */
  | 'exact'
  /** The id rotated but a live device carries the saved label. */
  | 'label'
  /** Labels are still blank (pre-permission) — the id is passed through unjudged. */
  | 'unknown'
  /** The chosen device is not present. Fall back + tell the user. */
  | 'missing';

/** Where the winning ref came from, for the "Default (…)" copy in the UI. */
export type ResolveOrigin = 'none' | 'global' | 'override';

export interface Resolved {
  /** What to hand the browser. '' = let the OS decide. */
  deviceId: string;
  /** Human name for the resolved device, '' when it is the OS default. */
  label: string;
  source: ResolveSource;
  origin: ResolveOrigin;
  /** Set when `source === 'label'`: re-persist the ref as this. */
  rewrite?: DeviceRef;
  /** Set when `source === 'missing'`: what the user had chosen. */
  missing?: DeviceRef;
}

/** True when the ref carries no choice at all. */
export const isSystemDefault = (ref: DeviceRef | null | undefined): boolean =>
  !ref || (!ref.id && !ref.label);

/**
 * Are the reported labels usable yet?
 *
 * `enumerateDevices()` returns entries with EMPTY labels until a
 * `getUserMedia` has resolved once, and Chrome reports a single blank
 * placeholder per kind before that. A list in that state proves nothing about
 * whether a saved device is still plugged in, and it must never be rendered as
 * a dropdown of blanks.
 */
export const labelsAreKnown = (live: readonly LiveDevice[]): boolean =>
  live.length > 0 && live.some((d) => d.label !== '');

/** Dedupe key for the "that device is gone" notice: one per kind + id. */
export const missingNoticeId = (kind: IoKind, ref: DeviceRef): string =>
  `io:missing:${kind}:${ref.id || ref.label}`;

const clean = (ref: DeviceRef | null | undefined): DeviceRef => ({
  id: ref?.id ?? '',
  label: ref?.label ?? '',
});

/**
 * Resolve ONE ref against the live list. `labelsKnown` defaults to reading the
 * list itself; pass it explicitly when the caller already tracks permission
 * state (MIDI ports, for instance, always carry names).
 */
export function resolveRef(
  ref: DeviceRef | null | undefined,
  live: readonly LiveDevice[],
  labelsKnown: boolean = labelsAreKnown(live),
): Omit<Resolved, 'origin'> {
  const want = clean(ref);
  if (isSystemDefault(want)) return { deviceId: '', label: '', source: 'system' };

  const byId = want.id ? live.find((d) => d.id === want.id) : undefined;
  if (byId) {
    // Prefer the live label: a device renamed at the OS level should show its
    // current name, not the one frozen into the setting.
    return { deviceId: byId.id, label: byId.label || want.label, source: 'exact' };
  }

  if (want.label && labelsKnown) {
    const byLabel = live.find((d) => d.label === want.label);
    if (byLabel) {
      return {
        deviceId: byLabel.id,
        label: byLabel.label,
        source: 'label',
        rewrite: { id: byLabel.id, label: byLabel.label },
      };
    }
  }

  // Cannot conclude "gone" from a list we have not been allowed to read. Hand
  // the saved id through: the call sites use a SOFT `deviceId` constraint, so a
  // stale id degrades to the OS default instead of throwing OverconstrainedError.
  if (!labelsKnown) {
    return { deviceId: want.id, label: want.label, source: 'unknown' };
  }

  return { deviceId: '', label: '', source: 'missing', missing: want };
}

export interface SlotInput {
  /**
   * The surface's own override. `undefined` (or a missing key) = follow the
   * global slot; `{id:'',label:''}` = the OS default, deliberately ignoring the
   * global.
   */
  override?: DeviceRef | null;
  /** The global slot for this kind. */
  global?: DeviceRef | null;
  live: readonly LiveDevice[];
  labelsKnown?: boolean;
}

/**
 * Full precedence: per-surface override > global slot > system default.
 *
 * `origin` says which one won, so a UI can render "Default (Scarlett 2i2)" and
 * a notice can name the surface that lost its device.
 */
export function resolveSlot(input: SlotInput): Resolved {
  const { live, override, global } = input;
  const labelsKnown = input.labelsKnown ?? labelsAreKnown(live);

  if (override !== undefined && override !== null) {
    return { ...resolveRef(override, live, labelsKnown), origin: 'override' };
  }
  if (!isSystemDefault(global)) {
    return { ...resolveRef(global, live, labelsKnown), origin: 'global' };
  }
  return { deviceId: '', label: '', source: 'system', origin: 'none' };
}

/** The `<select>` value for a surface row: FOLLOW_GLOBAL, '' or a device id. */
export const overrideSelectValue = (override: DeviceRef | null | undefined): string =>
  override === undefined || override === null ? FOLLOW_GLOBAL : override.id;

/**
 * Turn a `<select>` value back into the override to store. `null` means "delete
 * the entry" (follow the global again).
 */
export function overrideFromSelect(
  value: string,
  live: readonly LiveDevice[],
): DeviceRef | null {
  if (value === FOLLOW_GLOBAL) return null;
  if (value === '') return { ...SYSTEM_DEFAULT };
  const hit = live.find((d) => d.id === value);
  return { id: value, label: hit?.label ?? '' };
}
