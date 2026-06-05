/**
 * Control-surface widget contract.
 *
 * A "widget" is one relocatable control (a knob, fader, toggle, pad, etc.) that
 * a tab registers with the generic ControlSurface. Each widget owns a `render`
 * closure that draws the live control fitted to a measured cell size — the
 * closure captures its own wiring (engine calls, store setters, deck binding),
 * so moving a widget between panels changes WHERE it renders, never WHAT it
 * does.
 *
 * The shape intentionally echoes `slideStore.VisualControl` (key/label/kind/
 * group) so the two registries read alike, and reserves `source`/`binding` for
 * a later phase where the user creates custom action-bound controls — adding
 * those is additive, not a rearchitecture.
 */
import type React from 'react';

export type WidgetId = string;

export type WidgetKind =
  | 'knob'
  | 'fader'
  | 'toggle'
  | 'pad'
  | 'crossfader'
  | 'jog'
  | 'button'
  | 'fixed';

/** Pixel size of the cell the widget is being rendered into. */
export interface WidgetSize {
  w: number;
  h: number;
}

/** Render-time hints the surface passes per cell. */
export interface WidgetRenderOpts {
  /** Mirror composite controls (reverse order + flip icon/name side). */
  mirror?: boolean;
  /** Content alignment within the cell. */
  justify?: 'start' | 'center' | 'end';
  /** True when the surface fill mode wants the control to grow to fill. */
  fill?: boolean;
}

/** Reserved for the future custom-control phase; unused for built-in widgets. */
export interface WidgetBinding {
  /** e.g. a djEngine method name, a controlSyncBus key, or a MIDI action id. */
  target?: string;
  params?: Record<string, unknown>;
}

export interface WidgetDef {
  id: WidgetId;
  /** Human label shown in the palette and (optionally) as a tooltip. */
  label: string;
  /** Palette grouping bucket (e.g. 'Mixer', 'Deck A', 'FX', 'Sampler'). */
  group: string;
  kind: WidgetKind;
  /** Hint for the footprint a widget prefers on first placement. */
  defaultSpan?: { w?: number; h?: number };
  /** Draw the live control fitted to the measured cell, honoring opts. */
  render: (size: WidgetSize, opts?: WidgetRenderOpts) => React.ReactNode;
  /** 'builtin' today; 'custom' reserved for user-created controls. */
  source?: 'builtin' | 'custom';
  /** Reserved for the custom-control phase. */
  binding?: WidgetBinding;
}

export type WidgetRegistry = Record<WidgetId, WidgetDef>;
