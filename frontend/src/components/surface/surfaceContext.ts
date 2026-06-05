/** Shared context for the control surface, in its own module so the component
 *  files (ControlSurface ↔ SurfaceContainer ↔ SurfacePanel) form an acyclic
 *  import graph. */
import React, { useContext } from 'react';
import type { SurfaceStoreApi, NodeId } from '../../state/surfaceLayoutStore';
import type { WidgetRegistry, BindableTarget, WidgetId } from './widgetTypes';

/** What a right-click targeted, for the shared surface context menu. */
export type SurfaceMenuTarget =
  | { kind: 'widget'; nodeId: NodeId; widgetId: WidgetId }
  | { kind: 'panel'; nodeId: NodeId }
  | { kind: 'container'; nodeId: NodeId };

export interface SurfaceCtx {
  surfaceId: string;
  store: SurfaceStoreApi;
  registry: WidgetRegistry;
  /** Backend endpoints a custom control can bind to (tab-supplied, may be empty). */
  targets: BindableTarget[];
  /** Open the shared right-click menu for a node/widget (design mode). */
  openMenu: (e: React.MouseEvent, target: SurfaceMenuTarget) => void;
}

export const SurfaceContext = React.createContext<SurfaceCtx | null>(null);

export function useSurface(): SurfaceCtx {
  const ctx = useContext(SurfaceContext);
  if (!ctx) throw new Error('useSurface must be used inside <ControlSurface>');
  return ctx;
}
