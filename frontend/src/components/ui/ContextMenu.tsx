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
 * A menu whose items are the settings of one thing gives each row a `checked`
 * boolean; those rows become `menuitemradio` with `aria-checked`, and the live
 * one is tinted. Rows without it stay plain `menuitem` commands.
 *
 * Closing rules: clicking outside, pressing Escape, or right-clicking
 * anywhere else all close the menu. Items run `onSelect` then the menu
 * auto-closes — callers don't need to remember to call `onClose`.
 *
 * Keyboard: opening focuses the first enabled row, Arrow Up/Down and Home/End
 * move between rows (wrapping), Enter/Space activate the focused one (the rows
 * are real buttons), Escape closes, and closing hands focus back to whatever
 * opened the menu. A caller therefore only has to set `position` — from a
 * right-click or from Shift+F10 on its own control — to get a menu a keyboard
 * can drive.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveEditThemeVars } from '../../lib/editThemes';
import { useEditThemeStore } from '../../state/editThemeStore';

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
      /** Native tooltip on the row — the long form of what the item does.
       *  Note a DISABLED item is `pointer-events: none`, so a reason that the
       *  user must see belongs in `hint`, which is always visible. */
      title?: string;
      /**
       * Radio state, for a menu whose items are the settings of ONE thing (a
       * mode picker). DEFINED — `true` or `false` — makes the row a
       * `menuitemradio` carrying `aria-checked`, which is what tells a screen
       * reader the row is a choice among several and which one is live.
       * UNDEFINED (the default, and every existing caller) leaves it a plain
       * `menuitem`, because a command row that claims a checked state it has
       * not got is worse than one that claims nothing.
       */
      checked?: boolean;
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

/**
 * The clamp / outside-dismiss / focus-roundtrip shell shared by every
 * anchored popup that portals to `<body>` — `ContextMenu` itself and
 * `MetronomeLevelPopover` (finding 3, T25b edit B re-audit). Lifted here so
 * a fix to one caller's dismissal or focus handling is a fix to both,
 * rather than two copies free to drift.
 *
 * `focusOnOpen` must be a stable (`useCallback`-wrapped) function — it runs
 * inside an effect keyed on `position`, so a fresh identity every render
 * would re-arm the focus effect every render too.
 */
export function usePopoverShell({
  position,
  onClose,
  panelRef,
  focusOnOpen,
}: {
  position: ContextMenuPosition | null;
  onClose: () => void;
  panelRef: React.RefObject<HTMLElement | null>;
  focusOnOpen: () => HTMLElement | null | undefined;
}): ContextMenuPosition | null {
  // After mount we measure the panel and nudge its position so it stays
  // inside the viewport — anchoring to (clientX, clientY) without this
  // would overflow on right-edge / bottom-edge clicks.
  const [adjusted, setAdjusted] = useState<ContextMenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!position || !panelRef.current) {
      setAdjusted(null);
      return;
    }
    const rect = panelRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    let nx = position.x;
    let ny = position.y;
    if (nx + rect.width + pad > vw) nx = Math.max(pad, vw - rect.width - pad);
    if (ny + rect.height + pad > vh) ny = Math.max(pad, vh - rect.height - pad);
    setAdjusted({ x: nx, y: ny });
  }, [position, panelRef]);

  // Outside-click / Escape / wheel-scroll all close the panel so it never
  // lingers in a stale position after the user moved on. The wheel guard
  // mirrors the outside-click one: a hosted continuous control (a slider)
  // arms wheel-to-adjust while it's focused, and without this guard rolling
  // the wheel over the panel's OWN control both adjusts the value AND
  // dismisses the panel hosting it.
  useEffect(() => {
    if (!position) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && panelRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = (e: WheelEvent) => {
      if (panelRef.current && panelRef.current.contains(e.target as Node)) return;
      onClose();
    };
    // Defer attaching the dismiss listeners to the next macrotask. The
    // right-click that opens this panel is still mid-dispatch when React
    // flushes this effect (discrete-event synchronous flush), so attaching
    // synchronously lets that same `contextmenu`/`mousedown` bubble to
    // `window` and immediately close the panel we just opened. A macrotask
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
  }, [position, onClose, panelRef]);

  // FOCUS. A panel opened from the keyboard (Shift+F10 / the Menu key on a
  // focused control) is unusable if focus stays behind on the opener: nothing
  // is reachable but Tab, which walks straight past the panel into whatever
  // follows it in the document. So focus moves to the caller's chosen target
  // on open and back to the opener on close.
  //
  // Deferred a frame: `useLayoutEffect` above is still clamping the panel
  // into the viewport, and focusing an element parked at -9999 scrolls the
  // page to it. Restoring is CONDITIONAL — an `onSelect` that opened a modal
  // and focused it has already run by the time this cleanup does, and
  // stealing focus back from it would be worse than not restoring at all. So
  // the opener only gets focus back when nothing else took it (focus is on
  // the body, lost with the removed row, or still inside the panel).
  //
  // `requestAnimationFrame` is asked for rather than assumed: the contrast
  // suite renders this component under a Node DOM shim that has no frame
  // clock, and a panel with no frames to wait for has no clamp to wait for
  // either — the focus can just happen now.
  useEffect(() => {
    if (!position || typeof document === 'undefined') return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const framed = typeof requestAnimationFrame === 'function';
    const raf = framed ? requestAnimationFrame(() => focusOnOpen()?.focus()) : 0;
    if (!framed) focusOnOpen()?.focus();
    return () => {
      if (framed) cancelAnimationFrame(raf);
      const active = document.activeElement;
      const lost = !active || active === document.body || (!!panel && panel.contains(active));
      if (!lost) return;
      if (opener && opener !== document.body && document.contains(opener)) opener.focus();
    };
  }, [position, focusOnOpen, panelRef]);

  return adjusted;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  position,
  onClose,
  items,
  title,
  minWidth = '12rem',
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** The rendered row buttons, by item index (separators/headers leave holes). */
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The menu portals to <body>, outside the Shell's `.edit-theme-scope`, so it
  // carries its own scope: the theme's popup surface, lines and ink tiers reach
  // it the same way they reach the rest of the app. `--et-root-bg` is left off
  // because the scope wrapper paints no box, and on the custom-image theme that
  // value is the whole image as a data URL.
  const editThemeId = useEditThemeStore((s) => s.themeId);
  const editThemeImage = useEditThemeStore((s) => s.customImage);
  const editTheme = useMemo(() => {
    const { vars, light } = resolveEditThemeVars(editThemeId, editThemeImage);
    const scopeVars = Object.fromEntries(Object.entries(vars).filter(([name]) => name !== '--et-root-bg'));
    return { vars: scopeVars, light };
  }, [editThemeId, editThemeImage]);
  // Row-focus target for the shared shell's open effect — first enabled row.
  // Stable identity: it closes only over the ref, never over `items`.
  const focusFirstRow = useCallback(
    () => itemRefs.current.find((el) => el && !el.disabled) ?? null,
    [],
  );
  // Clamp into the viewport, outside-click/Escape/wheel dismiss, and the
  // open/close focus round trip — all shared with MetronomeLevelPopover via
  // `usePopoverShell` (finding 3, T25b edit B re-audit).
  const adjusted = usePopoverShell({ position, onClose, panelRef: menuRef, focusOnOpen: focusFirstRow });

  if (!position) return null;

  // A fresh row list every render, so a shortened `items` leaves no stale node
  // behind for the arrow keys to land on.
  itemRefs.current.length = items.length;

  /**
   * Arrow / Home / End move focus between the rows, wrapping — the menu
   * keyboard interface from the WAI-ARIA menu pattern. Enter and Space are NOT
   * handled here on purpose: every row is a real `<button>`, so the browser
   * already activates the focused one with both and a handler of ours would
   * fire the item twice. Escape is the window listener above, so it closes the
   * menu from anywhere, inside it or not.
   */
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const rows = itemRefs.current.filter(
      (el): el is HTMLButtonElement => !!el && !el.disabled,
    );
    if (rows.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : e.key === 'ArrowDown'
            ? (at < 0 ? 0 : (at + 1) % rows.length)
            : (at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length);
    rows[next].focus();
  };

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
    // `contents`: the scope wrapper lays out and paints nothing; it only hands
    // the theme's variables and remaps down to the menu.
    <div
      className="edit-theme-scope contents"
      data-et-light={editTheme.light ? '1' : undefined}
      style={editTheme.vars as React.CSSProperties}
    >
    <div
      ref={menuRef}
      role="menu"
      // z-10000: over the assistant orb (z 9999) in the window's bottom-left
      // corner, which a tall menu opened from a low lane reaches.
      className="fixed z-10000 overflow-y-auto bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] py-1 font-sans text-xs font-bold select-none"
      // maxWidth caps the menu so a long title/label actually truncates instead
      // of stretching the menu hundreds of px wide (which then clamps far from
      // the cursor); minWidth keeps short menus from looking cramped. maxHeight
      // keeps the edge gap above and below, so a menu taller than the window
      // scrolls inside itself.
      style={{ left: pos.x, top: pos.y, minWidth, maxWidth: 'min(22rem, 90vw)', maxHeight: 'calc(100vh - 12px)' }}
      onKeyDown={onMenuKeyDown}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // Suppress the browser's native right-click menu when the user
        // right-clicks INSIDE our menu — otherwise the OS menu paints
        // on top of our items.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Title, headers and hints are 8px, so they take the theme's secondary
          ink (--et-ink-2), which each theme holds at 4.5:1 or better on its
          popup surface. */}
      {title && (
        <div className="px-3 py-1.5 font-display text-xs font-bold uppercase tracking-wider et-ink-2 border-b border-white/5 mb-0.5 truncate">
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
              className="px-3 py-1 font-display text-xs font-bold uppercase tracking-wider et-ink-2"
            >
              {item.label}
            </div>
          );
        }
        const itemColor = item.danger
          ? 'text-red-300 hover:bg-red-500/20'
          : 'text-purple-200 hover:bg-purple-500/15';
        // The live choice of a radio group is tinted as well as marked with
        // `aria-checked`: the state has to be visible, not only announced.
        const checkedTint = item.checked ? ' bg-purple-500/10' : '';
        // A disabled row dims its icon and label only. The hint is the row's
        // stated reason ("nothing copied"), so it stays at full ink.
        return (
          <button
            key={idx}
            ref={(el) => {
              itemRefs.current[idx] = el;
            }}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            disabled={item.disabled}
            title={item.title}
            onClick={() => handleItemClick(item)}
            className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-3 disabled:pointer-events-none ${itemColor}${checkedTint}`}
          >
            <span className={`flex items-center gap-1.5 min-w-0${item.disabled ? ' opacity-40' : ''}`}>
              {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
              <span className="truncate">{item.label}</span>
            </span>
            {item.hint != null && (
              <span className="shrink-0 et-ink-2 normal-case tabular-nums">
                {item.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
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

