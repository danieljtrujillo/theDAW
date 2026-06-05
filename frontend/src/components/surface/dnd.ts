/**
 * Drag-and-drop wire protocol for the control surface.
 *
 * Two distinct MIME types so a panel-move can never land in a widget slot and a
 * widget-move can never reorder a panel (the source of the old DesignLayout
 * scrim/nesting bugs). Every payload carries the `surfaceId` so a drag started
 * on one surface can't corrupt another's layout.
 *
 * `PANEL_MIME` keeps the same value the DJ DesignLayout used, so any in-flight
 * habits/markup stay compatible.
 */
import type { NodeId } from '../../state/surfaceLayoutStore';
import type { WidgetId } from './widgetTypes';

export const PANEL_MIME = 'application/x-thedaw-panel';
export const WIDGET_MIME = 'application/x-thedaw-widget';

/** Gap (px) between grid tracks; matches the old DesignLayout GAP / gap-1.5. */
export const GAP = 6;

export interface PanelDragPayload {
  surfaceId: string;
  panelId: NodeId;
}

export interface WidgetDragPayload {
  surfaceId: string;
  widgetId: WidgetId;
  /** Source panel, or null when dragged from the palette (unplaced). */
  fromPanelId: NodeId | null;
}

export function encode(payload: PanelDragPayload | WidgetDragPayload): string {
  return JSON.stringify(payload);
}

export function decodePanel(raw: string): PanelDragPayload | null {
  try {
    const p = JSON.parse(raw) as PanelDragPayload;
    return p && typeof p.panelId === 'string' && typeof p.surfaceId === 'string' ? p : null;
  } catch {
    return null;
  }
}

export function decodeWidget(raw: string): WidgetDragPayload | null {
  try {
    const p = JSON.parse(raw) as WidgetDragPayload;
    return p && typeof p.widgetId === 'string' && typeof p.surfaceId === 'string' ? p : null;
  } catch {
    return null;
  }
}
