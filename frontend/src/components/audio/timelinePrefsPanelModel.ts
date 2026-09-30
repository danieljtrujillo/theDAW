/**
 * Labels, option lists and pure helpers for TimelinePrefsPanel (F05 wheel
 * profile + zoom speeds, F06 click profile, F08 grid style). No React, no DOM,
 * no store access: the panel reads the store and hands values in here.
 *
 * Units: opacities are alpha in [0, 1]; preview line positions are fractions
 * of one bar in [0, 1]; line widths are local CSS px; zoom speeds are the
 * dimensionless wheel-zoom exponent factors the store keeps.
 */
import { WHEEL_PROFILES, type WheelAction, type WheelProfile, type WheelProfileId } from '../../lib/timeline/viewport';
import type { ClickProfile, GridPreset, GridStyle } from '../../state/timelinePrefsStore';

function finite(n: number, name: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
  return n;
}

// --- Mouse wheel -------------------------------------------------------------

/** What each wheel action does, in the words the panel shows. */
export const WHEEL_ACTION_TEXT: Readonly<Record<WheelAction, string>> = Object.freeze({
  'zoom-time': 'Zoom in and out of time',
  'zoom-time-fine': 'Zoom time in small steps',
  'resize-lanes': 'Make lanes taller or shorter',
  'pan-time': 'Scroll left and right',
  'pan-lanes': 'Scroll up and down through lanes',
  none: 'Nothing',
});

/** Modifier combinations of a WheelProfile, in table order. */
export type WheelGestureKey = Exclude<keyof WheelProfile, 'id' | 'label'>;

export const WHEEL_GESTURES: ReadonlyArray<{ key: WheelGestureKey; gesture: string }> = Object.freeze([
  { key: 'plain', gesture: 'Wheel' },
  { key: 'ctrl', gesture: 'Ctrl + wheel' },
  { key: 'shift', gesture: 'Shift + wheel' },
  { key: 'alt', gesture: 'Alt + wheel' },
  { key: 'ctrlShift', gesture: 'Ctrl + Shift + wheel' },
  { key: 'ctrlAlt', gesture: 'Ctrl + Alt + wheel' },
] as const);

const WHEEL_PROFILE_DESCRIPTIONS: Readonly<Record<WheelProfileId, string>> = Object.freeze({
  thedaw: 'The wheel zooms; hold Ctrl for finer zoom steps.',
  reaper: 'The bindings REAPER ships with; Ctrl + wheel resizes lanes.',
});

export const WHEEL_PROFILE_OPTIONS: ReadonlyArray<{ id: WheelProfileId; label: string; description: string }> =
  Object.freeze(
    (['thedaw', 'reaper'] as const).map((id) => ({
      id,
      label: WHEEL_PROFILES[id].label,
      description: WHEEL_PROFILE_DESCRIPTIONS[id],
    })),
  );

/**
 * One row per modifier combination: the gesture and what it does under
 * `profile`, generated from WHEEL_PROFILES. RangeError for an unknown id.
 */
export function describeWheelProfile(profile: WheelProfileId): Array<{ gesture: string; action: string }> {
  if (!Object.prototype.hasOwnProperty.call(WHEEL_PROFILES, profile)) {
    throw new RangeError(`unknown wheel profile: ${String(profile)}`);
  }
  const p = WHEEL_PROFILES[profile];
  return WHEEL_GESTURES.map(({ key, gesture }) => ({ gesture, action: WHEEL_ACTION_TEXT[p[key]] }));
}

// --- Click behavior ------------------------------------------------------------

export const CLICK_PROFILE_OPTIONS: ReadonlyArray<{ id: ClickProfile; label: string; description: string }> =
  Object.freeze([
    {
      id: 'default',
      label: 'Default',
      description: 'While playing, a clip click moves only the edit cursor; empty lanes and the ruler move the playhead.',
    },
    {
      id: 'clip-seeks',
      label: 'Clip clicks also seek',
      description: 'A clip click moves the playhead too, even while playing.',
    },
    {
      id: 'ruler-only',
      label: 'Only the ruler seeks',
      description: 'Only ruler clicks move the playhead; lane and clip clicks move just the edit cursor.',
    },
  ]);

// --- Grid --------------------------------------------------------------------------

type NamedGridPreset = Exclude<GridPreset, 'custom'>;

export const GRID_PRESET_OPTIONS: ReadonlyArray<{ id: NamedGridPreset; label: string }> = Object.freeze([
  { id: 'subtle', label: 'Subtle' },
  { id: 'normal', label: 'Normal' },
  { id: 'high-contrast', label: 'High contrast' },
]);

/** Display name of a preset, including 'custom' (set by any advanced change). */
export function gridPresetLabel(preset: GridPreset): string {
  if (preset === 'custom') return 'Custom';
  return GRID_PRESET_OPTIONS.find((o) => o.id === preset)?.label ?? 'Custom';
}

export type GridOpacityKey = 'barOpacity' | 'beatOpacity' | 'subdivOpacity' | 'laneDividerOpacity';

/** The advanced opacity sliders: store key, DOM id/name, and label. */
export const GRID_OPACITY_FIELDS: ReadonlyArray<{ key: GridOpacityKey; id: string; label: string }> = Object.freeze([
  { key: 'barOpacity', id: 'timeline-grid-bar-opacity', label: 'Bar lines' },
  { key: 'beatOpacity', id: 'timeline-grid-beat-opacity', label: 'Beat lines' },
  { key: 'subdivOpacity', id: 'timeline-grid-subdiv-opacity', label: 'Subdivision lines' },
  { key: 'laneDividerOpacity', id: 'timeline-grid-lane-opacity', label: 'Lane dividers' },
]);

/** An alpha in [0, 1] as a whole percent string ("25%"). */
export function opacityPercent(alpha: number): string {
  finite(alpha, 'alpha');
  return `${Math.round(alpha * 100)}%`;
}

/**
 * Where `value` sits in [min, max] as a whole percent 0..100 (clamped), for
 * showing a zoom speed without its raw exponent factor.
 */
export function speedPercent(value: number, min: number, max: number): number {
  finite(value, 'value');
  finite(min, 'min');
  finite(max, 'max');
  if (max <= min) throw new RangeError('max must be greater than min');
  const t = (value - min) / (max - min);
  return Math.round(Math.max(0, Math.min(1, t)) * 100);
}

export interface GridPreviewLine {
  kind: 'bar' | 'beat' | 'subdiv';
  /** Position as a fraction of one bar, [0, 1]. */
  at: number;
  /** Alpha, [0, 1]. */
  opacity: number;
  /** Line width in local CSS px. */
  widthPx: number;
}

/**
 * The vertical lines of a one-bar preview strip under `style`, left to right:
 * bar lines at 0 and 1, beat lines between, subdivision lines between those.
 * Empty when the grid is hidden. Counts must be positive integers.
 */
export function gridPreviewLines(style: GridStyle, beatsPerBar: number, subdivPerBeat: number): GridPreviewLine[] {
  finite(beatsPerBar, 'beatsPerBar');
  finite(subdivPerBeat, 'subdivPerBeat');
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) throw new RangeError('beatsPerBar must be a positive integer');
  if (!Number.isInteger(subdivPerBeat) || subdivPerBeat < 1) {
    throw new RangeError('subdivPerBeat must be a positive integer');
  }
  if (!style.visible) return [];
  const steps = beatsPerBar * subdivPerBeat;
  const lines: GridPreviewLine[] = [];
  for (let i = 0; i <= steps; i++) {
    const at = i / steps;
    if (i === 0 || i === steps) {
      lines.push({ kind: 'bar', at, opacity: style.barOpacity, widthPx: style.barWidthPx });
    } else if (i % subdivPerBeat === 0) {
      lines.push({ kind: 'beat', at, opacity: style.beatOpacity, widthPx: 1 });
    } else {
      lines.push({ kind: 'subdiv', at, opacity: style.subdivOpacity, widthPx: 1 });
    }
  }
  return lines;
}
