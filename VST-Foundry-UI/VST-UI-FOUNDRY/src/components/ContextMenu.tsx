import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GripHorizontal } from 'lucide-react';

export interface ContextMenuAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  iconOnly?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
  children?: React.ReactNode;
}

// Keep the whole menu this far from any viewport edge when clamping.
const VIEWPORT_MARGIN = 8;

export default function ContextMenu({ x, y, actions, onClose, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const [position, setPosition] = useState({ x, y });
  const [isDragging, setIsDragging] = useState(false);
  const [opacity, setOpacity] = useState(0);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const dragStartMouse = useRef({ x: 0, y: 0 });
  // Menu size captured at drag start so every drag frame can clamp the position
  // without re-measuring layout on each mousemove.
  const dragSize = useRef({ w: 0, h: 0 });

  // Ref mirror of the drag flag so the stable `clampToViewport` callback can read
  // the live value without being recreated (and re-subscribing observers) on
  // every drag toggle.
  const isDraggingRef = useRef(false);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // Re-anchor + hide-then-reveal whenever the menu is (re)opened at a new origin.
  useEffect(() => {
    setPosition({ x, y });
    setOpacity(0);
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // If we're dragging, don't close
      if (isDragging) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartMouse.current.x;
      const dy = e.clientY - dragStartMouse.current.y;
      // HARD BOUND: dragging can never push any edge of the menu off-screen.
      // Clamp to [margin, viewport - size - margin] on both axes (the upper
      // bound is floored at the margin for the tiny-viewport case).
      const maxX = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - dragSize.current.w - VIEWPORT_MARGIN,
      );
      const maxY = Math.max(
        VIEWPORT_MARGIN,
        window.innerHeight - dragSize.current.h - VIEWPORT_MARGIN,
      );
      setPosition({
        x: Math.min(Math.max(dragStartPos.current.x + dx, VIEWPORT_MARGIN), maxX),
        y: Math.min(Math.max(dragStartPos.current.y + dy, VIEWPORT_MARGIN), maxY),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onClose, isDragging]);

  // Clamp the menu fully inside the viewport based on its *current* rendered
  // size. Stable identity + functional update + no-op bail lets it be called
  // safely from both the reveal effect and a ResizeObserver without looping.
  // Never fights an active drag.
  const clampToViewport = useCallback(() => {
    if (isDraggingRef.current) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition((prev) => {
      let nx = prev.x;
      let ny = prev.y;
      // Shift left/up when the panel would overrun the right/bottom edge...
      if (nx + rect.width > window.innerWidth - VIEWPORT_MARGIN) {
        nx = window.innerWidth - rect.width - VIEWPORT_MARGIN;
      }
      if (ny + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
        ny = window.innerHeight - rect.height - VIEWPORT_MARGIN;
      }
      // ...then floor at the top/left so the whole panel stays on-screen even
      // when it's near a corner or nearly as large as the viewport.
      if (nx < VIEWPORT_MARGIN) nx = VIEWPORT_MARGIN;
      if (ny < VIEWPORT_MARGIN) ny = VIEWPORT_MARGIN;
      if (nx === prev.x && ny === prev.y) return prev;
      return { x: nx, y: ny };
    });
  }, []);

  // Initial clamp + reveal once the menu has laid out at a new origin.
  useEffect(() => {
    if (opacity === 0) {
      clampToViewport();
      setOpacity(1);
    }
  }, [opacity, clampToViewport]);

  // Re-clamp whenever the panel's rendered size changes — switching tabs,
  // expanding the glow section, or mounting the RAW editor all resize the
  // popover, and a taller/wider panel must be pulled back on-screen instead of
  // running off the bottom/right edge.
  useEffect(() => {
    const el = menuRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => clampToViewport());
    ro.observe(el);
    return () => ro.disconnect();
  }, [clampToViewport]);

  // Re-clamp on window resize so the menu can't be stranded off the new bounds.
  useEffect(() => {
    const onResize = () => clampToViewport();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampToViewport]);

  const handleDragStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDragging(true);
    dragStartPos.current = { x: position.x, y: position.y };
    dragStartMouse.current = { x: e.clientX, y: e.clientY };
    const rect = menuRef.current?.getBoundingClientRect();
    dragSize.current = { w: rect?.width ?? 0, h: rect?.height ?? 0 };
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        opacity: opacity,
        // HARD BOUND: the menu can never exceed the viewport. If the content
        // (child panel + action list) is taller/wider than the screen, the menu
        // shrinks to fit and scrolls internally instead of clipping off-edge.
        maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
        maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
      }}
      className="z-9999 bg-app-surface border border-app-border rounded-lg shadow-2xl py-1 w-fit min-w-80 flex flex-col overflow-y-auto overflow-x-hidden"
      onMouseDown={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
    >
      <div
        className="w-full flex justify-center py-1 cursor-grab active:cursor-grabbing text-app-muted hover:text-white"
        onMouseDown={handleDragStart}
      >
        <GripHorizontal className="w-4 h-4" />
      </div>

      {children}

      {/* List Actions */}
      {actions.filter(a => !a.iconOnly).map((action) => {
        if (action.divider) {
          return <div key={`div-${action.label}`} className="h-px bg-app-border my-1" />;
        }
        return (
          <button
            key={action.label}
            onClick={() => {
              if (action.disabled) return;
              action.onClick();
              onClose();
            }}
            disabled={action.disabled}
            className={`w-full flex items-center justify-between px-3 py-1.5 text-sm transition-colors
              ${action.disabled ? 'opacity-50 cursor-not-allowed text-app-muted' : 'hover:bg-app-base'}
              ${action.danger && !action.disabled ? 'text-red-400 hover:text-red-300' : 'text-app-main'}
            `}
          >
            <span className="flex items-center gap-2">
              {action.icon}
              {action.label}
            </span>
            {action.shortcut && (
              <span className="text-xs text-app-muted">{action.shortcut}</span>
            )}
          </button>
        );
      })}

      {/* Icon-only Actions Toolbar */}
      {actions.some(a => a.iconOnly) && (
        <div className="flex flex-wrap items-center justify-center gap-1 p-1 mt-1 border-t border-app-border bg-app-base/50 rounded-b-lg">
          {actions.filter(a => a.iconOnly).map((action) => (
            <button
              key={action.label}
              onClick={() => {
                if (action.disabled) return;
                action.onClick();
                onClose();
              }}
              disabled={action.disabled}
              title={action.label}
              className={`p-1.5 rounded transition-colors
                ${action.disabled ? 'opacity-50 cursor-not-allowed text-app-muted' : 'hover:bg-app-surface hover:text-white'}
                ${action.danger && !action.disabled ? 'text-red-400 hover:bg-red-900/30' : 'text-app-main'}
              `}
            >
              {action.icon}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
