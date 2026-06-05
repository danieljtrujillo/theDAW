/**
 * Entry point for a control surface. Resolves (and caches, per surfaceId) the
 * persisted layout store, provides it + the widget registry through context,
 * and renders the container tree plus the Design-Mode palette and toolbar.
 *
 * A tab uses it like:
 *   <ControlSurface surfaceId="dj" registry={djRegistry} defaultLayout={defaultDjLayout} />
 * The registry is built inside the tab (closures keep their live wiring), and
 * the default layout reproduces the tab's shipped arrangement so nothing moves
 * until the user enters Design Mode and drags.
 */
import React, { useEffect, useMemo } from 'react';
import { SurfaceContext } from './surfaceContext';
import { SurfaceNode } from './SurfaceContainer';
import { PaletteDrawer } from './PaletteDrawer';
import { SurfaceToolbar } from './SurfaceToolbar';
import { createLayoutStore } from '../../state/surfaceLayoutStore';
import type { SurfaceLayout, SurfaceStoreApi } from '../../state/surfaceLayoutStore';
import type { WidgetRegistry } from './widgetTypes';

// One persisted store instance per surface id, reused across (re)mounts + HMR.
const storeCache = new Map<string, SurfaceStoreApi>();
function getStore(surfaceId: string, defaultLayout: SurfaceLayout): SurfaceStoreApi {
  let s = storeCache.get(surfaceId);
  if (!s) {
    s = createLayoutStore(surfaceId, defaultLayout);
    storeCache.set(surfaceId, s);
  }
  return s;
}

export const ControlSurface: React.FC<{
  surfaceId: string;
  registry: WidgetRegistry;
  defaultLayout: SurfaceLayout;
  className?: string;
  /** A stale localStorage key to clear once (migration cleanup). */
  legacyKeyToClear?: string;
}> = ({ surfaceId, registry, defaultLayout, className, legacyKeyToClear }) => {
  const store = getStore(surfaceId, defaultLayout);
  const ctx = useMemo(() => ({ surfaceId, store, registry }), [surfaceId, store, registry]);
  const root = store((s) => s.layout.root);
  const design = store((s) => s.designMode);

  useEffect(() => {
    if (!legacyKeyToClear) return;
    try {
      localStorage.removeItem(legacyKeyToClear);
    } catch {
      /* ignore */
    }
  }, [legacyKeyToClear]);

  // Standard editing hotkeys, active only in Design Mode and never while typing
  // in a field: Ctrl/Cmd+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, Ctrl+S save as
  // default, Esc exit.
  useEffect(() => {
    if (!design) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.getState().redo();
        else store.getState().undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        store.getState().redo();
      } else if (mod && k === 's') {
        e.preventDefault();
        store.getState().saveAsDefault();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        store.getState().setDesignMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [design, store]);

  return (
    <SurfaceContext.Provider value={ctx}>
      <div className={`relative h-full w-full min-h-0 ${className ?? ''}`}>
        <div className="absolute inset-0">
          <SurfaceNode nodeId={root} />
        </div>
        {design && <PaletteDrawer />}
        <SurfaceToolbar />
      </div>
    </SurfaceContext.Provider>
  );
};
