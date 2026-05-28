/**
 * Shared right-click context menu primitive (plan step 3d).
 *
 * Replaces the rolled-their-own fixed-positioned divs that LibraryView
 * and WaveformEditor previously each carried. New surfaces (graph
 * nodes, track headers, etc.) hook into this same primitive so the
 * visual feel and keyboard behavior are identical across the app.
 *
 * Usage — declarative form:
 *   <ContextMenu
 *     position={ctxPos}
 *     onClose={() => setCtxPos(null)}
 *     title="Track · Bassline"
 *     items={[
 *       { type: 'item', label: 'Play', icon: <Play className="w-3 h-3" />, hint: 'Space', onSelect: doPlay },
 *       { type: 'separator' },
 *       { type: 'item', label: 'Delete', danger: true, onSelect: doDelete },
 *     ]}
 *   />
 *
 * Closing rules: clicking outside, pressing Escape, or right-clicking
 * anywhere else all close the menu. Items run `onSelect` then the menu
 * auto-closes — callers don't need to remember to call `onClose`.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The Shell applies CSS `zoom: 0.85` (or 0.95 / 1.1 depending on viewport
 * width) via `.dense-layout` so the DAW fits more on screen. Chrome
 * reports `event.clientX/Y` from clicks INSIDE that scaled element in
 * UNSCALED layout pixels, but our menu portals to `document.body` which
 * is NOT inside the zoom — so painting `position: fixed; left:
 * clientX` lands the menu off to the right of the cursor (drift
 * increases linearly with X). We scale the saved coords by the live
 * `--layout-zoom` to put the menu where the user actually clicked.
 */
const getLayoutZoom = (): number => {
  if (typeof document === 'undefined') return 1;
  const host = document.querySelector('.dense-layout');
  if (!host) return 1;
  const raw = getComputedStyle(host).getPropertyValue('--layout-zoom').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

export type ContextMenuItem =
  | {
      type: 'item';
      icon?: React.ReactNode;
      label: React.ReactNode;
      /** Right-aligned hint badge (hotkey, count, etc.) */
      hint?: React.ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: 'separator' }
  | { type: 'header'; label: React.ReactNode };

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuProps {
  /** Anchor point in viewport coords. `null` keeps the menu unmounted. */
  position: ContextMenuPosition | null;
  onClose: () => void;
  items: ContextMenuItem[];
  /** Optional title row above the items (auto-truncates). */
  title?: React.ReactNode;
  /** Override min-width; defaults to 12rem. */
  minWidth?: string;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  position,
  onClose,
  items,
  title,
  minWidth = '12rem',
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // After mount we measure the menu and nudge its position so it stays
  // inside the viewport — anchoring to (clientX, clientY) without this
  // would overflow on right-edge / bottom-edge clicks.
  const [adjusted, setAdjusted] = useState<ContextMenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!position || !menuRef.current) {
      setAdjusted(null);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    let nx = position.x;
    let ny = position.y;
    if (nx + rect.width + pad > vw) nx = Math.max(pad, vw - rect.width - pad);
    if (ny + rect.height + pad > vh) ny = Math.max(pad, vh - rect.height - pad);
    setAdjusted({ x: nx, y: ny });
  }, [position]);

  // Outside-click / Escape / wheel-scroll all close the menu so it
  // never lingers in a stale position after the user moved on.
  useEffect(() => {
    if (!position) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = () => onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('contextmenu', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onScroll, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('contextmenu', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onScroll);
    };
  }, [position, onClose]);

  if (!position) return null;

  const handleItemClick = (item: Extract<ContextMenuItem, { type: 'item' }>) => {
    if (item.disabled) return;
    // Close first so callbacks that switch tabs / open modals can do
    // so without the stale menu hanging over the new surface.
    onClose();
    item.onSelect();
  };

  // While we're measuring (first paint), render off-screen so the user
  // never sees the un-adjusted flash. After useLayoutEffect runs we
  // swap in the adjusted coords.
  const pos = adjusted ?? { x: -9999, y: -9999 };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-200 bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] py-1 text-[10px] font-mono select-none"
      style={{ left: pos.x, top: pos.y, minWidth }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // Suppress the browser's native right-click menu when the user
        // right-clicks INSIDE our menu — otherwise the OS menu paints
        // on top of our items.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {title && (
        <div className="px-3 py-1.5 text-[8px] uppercase tracking-widest text-zinc-600 border-b border-white/5 mb-0.5 truncate">
          {title}
        </div>
      )}
      {items.map((item, idx) => {
        if (item.type === 'separator') {
          return <div key={idx} className="my-1 border-t border-white/5" />;
        }
        if (item.type === 'header') {
          return (
            <div
              key={idx}
              className="px-3 py-1 text-[8px] uppercase tracking-widest text-zinc-600"
            >
              {item.label}
            </div>
          );
        }
        const itemColor = item.danger
          ? 'text-red-300 hover:bg-red-500/20'
          : 'text-purple-200 hover:bg-purple-500/15';
        return (
          <button
            key={idx}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => handleItemClick(item)}
            className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-3 disabled:opacity-40 disabled:pointer-events-none ${itemColor}`}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
              <span className="truncate">{item.label}</span>
            </span>
            {item.hint != null && (
              <span className="shrink-0 text-zinc-600 text-[8px] normal-case">
                {item.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
};

/**
 * State helper for the common pattern: a single ContextMenu instance
 * per parent component, opened by right-clicking on a specific row
 * with that row's data passed through as `payload`.
 *
 * The payload is generic so callers get typed access to the row they
 * right-clicked without re-finding it.
 */
export function useContextMenu<T = unknown>(): {
  position: ContextMenuPosition | null;
  payload: T | null;
  open: (e: React.MouseEvent | MouseEvent, payload: T) => void;
  close: () => void;
} {
  const [state, setState] = useState<{
    position: ContextMenuPosition;
    payload: T;
  } | null>(null);
  return {
    position: state?.position ?? null,
    payload: state?.payload ?? null,
    open: (e, payload) => {
      e.preventDefault();
      // Scale by --layout-zoom (see getLayoutZoom above) so the menu
      // anchors to the cursor under the zoom-scaled Shell.
      const z = getLayoutZoom();
      setState({
        position: { x: e.clientX * z, y: e.clientY * z },
        payload,
      });
    },
    close: () => setState(null),
  };
}
