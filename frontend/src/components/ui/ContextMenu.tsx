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
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Anchor coords for a right-click menu. The Shell scales the DAW with CSS
 * `zoom` (`.dense-layout`); spec-compliant Chrome reports `event.clientX/Y`
 * in viewport pixels, and the menu portals to `document.body` (outside the
 * zoom), so the raw client coords already land at the cursor — no scaling.
 * (An earlier `clientX * --layout-zoom` correction over-shot the cursor on
 * current Chrome and forced a synchronous reflow per open.)
 */
export const menuAnchorFromEvent = (e: React.MouseEvent | MouseEvent): ContextMenuPosition => ({
  x: e.clientX,
  y: e.clientY,
});

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
    // Defer attaching the dismiss listeners to the next macrotask. The
    // right-click that opens this menu is still mid-dispatch when React
    // flushes this effect (discrete-event synchronous flush), so attaching
    // synchronously lets that same `contextmenu`/`mousedown` bubble to
    // `window` and immediately close the menu we just opened. A macrotask
    // boundary guarantees the opening gesture is fully over first.
    let attached = false;
    const attach = () => {
      attached = true;
      window.addEventListener('mousedown', onDown);
      window.addEventListener('contextmenu', onDown);
      window.addEventListener('keydown', onKey);
      window.addEventListener('wheel', onScroll, { passive: true });
    };
    const timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) {
        window.removeEventListener('mousedown', onDown);
        window.removeEventListener('contextmenu', onDown);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('wheel', onScroll);
      }
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
      // maxWidth caps the menu so a long title/label actually truncates instead
      // of stretching the menu hundreds of px wide (which then clamps far from
      // the cursor); minWidth keeps short menus from looking cramped.
      style={{ left: pos.x, top: pos.y, minWidth, maxWidth: 'min(22rem, 90vw)' }}
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
  // Stable handlers so memoized row lists don't re-render every parent render.
  const open = useCallback((e: React.MouseEvent | MouseEvent, payload: T) => {
    e.preventDefault();
    setState({ position: menuAnchorFromEvent(e), payload });
  }, []);
  const close = useCallback(() => setState(null), []);
  return {
    position: state?.position ?? null,
    payload: state?.payload ?? null,
    open,
    close,
  };
}

