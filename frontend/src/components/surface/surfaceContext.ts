/** Shared context for the control surface, in its own module so the component
 *  files (ControlSurface ↔ SurfaceContainer ↔ SurfacePanel) form an acyclic
 *  import graph. */
import React, { useContext } from 'react';
import type { SurfaceStoreApi } from '../../state/surfaceLayoutStore';
import type { WidgetRegistry } from './widgetTypes';

export interface SurfaceCtx {
  surfaceId: string;
  store: SurfaceStoreApi;
  registry: WidgetRegistry;
}

export const SurfaceContext = React.createContext<SurfaceCtx | null>(null);

export function useSurface(): SurfaceCtx {
  const ctx = useContext(SurfaceContext);
  if (!ctx) throw new Error('useSurface must be used inside <ControlSurface>');
  return ctx;
}
