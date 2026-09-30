import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Info, X } from 'lucide-react';

/* ─── Hover tooltip (granular params) ────────────────────────────── */

// Must match the AnimatePresence `transition={{ duration: 0.12 }}` below —
// the portal stays mounted for exactly this long after `show` goes false, so
// it is present for the full exit transition and no longer than that.
const EXIT_TRANSITION_MS = 120;

export function HoverTip({
  text,
  children,
  focusable = false,
  focusLabel,
}: {
  text: string;
  children: React.ReactNode;
  // T20 re-audit item 4: `tabIndex={0}` used to be unconditional, adding a
  // second, nameless tab stop at every call site — almost all of which wrap
  // an already-focusable element (a <button>), where React's bubbling
  // focus/blur already reaches this wrapper's onFocus/onBlur for free (see
  // Tooltip.infotip.test.tsx's focusin/focusout bubbling assertion), so the
  // wrapper never needed to be a tab stop of its own for those. Opt in only
  // for a non-interactive anchor (a bare span/div with no focusable
  // descendant) that needs keyboard reach to the tip; `focusLabel` is
  // required in that case so the extra tab stop isn't nameless either.
  focusable?: boolean;
  focusLabel?: string;
}) {
  const [show, setShow] = useState(false);
  // Whether the portal is mounted at all. Distinct from `show`: while hidden
  // AND never shown, this stays false so an un-hovered HoverTip (theDAW has
  // ~40 call sites, 2 per catalogue row) adds nothing to document.body.
  // It flips true the instant `show` does, and flips back false only after
  // the exit transition has had time to finish — not the instant `show`
  // goes false — so the tip doesn't pop out of existence mid-fade.
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // Stable id so the anchor's aria-describedby always points at THIS tip's
  // DOM node, not just "a tooltip somewhere" — required now that the portal
  // (below) removes the only implicit DOM relationship (parent/child)
  // between the anchor and its tip content.
  const tipId = useId();
  // T20 re-audit item 7: was a hardcoded `tipH = 80` estimate, so a tip that
  // wrapped past 80px (the panel is `transform: translate(-50%, -100%)`
  // against its REAL height) landed offset. Seeded with that same estimate
  // for the very first open (before anything has been measured), then
  // corrected below via a layout effect once the portal has actually
  // rendered — so later opens/repositions use the true rendered height.
  const [tipH, setTipH] = useState(80);

  const reposition = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const tipW = 260;
    let x = rect.left + rect.width / 2;
    let y = rect.top - 8;

    // keep on screen
    if (x - tipW / 2 < 8) x = tipW / 2 + 8;
    if (x + tipW / 2 > window.innerWidth - 8) x = window.innerWidth - tipW / 2 - 8;
    if (y - tipH < 8) y = rect.bottom + 8 + tipH; // flip below

    setPos({ x, y });
  }, [tipH]);

  const hide = useCallback(() => setShow(false), []);

  // Measure the tip's real rendered height once the portal has painted, and
  // correct the flip decision above against it instead of the seed estimate.
  useLayoutEffect(() => {
    if (!show || !mounted || !tipRef.current) return;
    const measured = tipRef.current.getBoundingClientRect().height;
    if (measured > 0 && measured !== tipH) setTipH(measured);
  }, [show, mounted, tipH]);

  // Re-run reposition once a real measurement replaces the seed estimate,
  // so an already-open tip snaps to the corrected position.
  useEffect(() => {
    if (show) reposition();
  }, [tipH, show, reposition]);

  // Mount the portal the instant `show` becomes true; unmount it only after
  // the exit transition has had time to play out. If `show` flips back to
  // true before that timer fires (a quick re-hover), the cleanup below
  // cancels the pending unmount, so a flicker of re-hovering never tears the
  // portal down and back up.
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), EXIT_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [show]);

  // The tip is portalled to document.body (below), so it escapes its
  // anchor's DOM subtree entirely — nothing removes it automatically when
  // the anchor stops being relevant. Close it explicitly in every case that
  // can leave a stale tip floating on screen:
  useEffect(() => {
    if (!show) return;
    window.addEventListener('blur', hide);
    // capture: true — `scroll` does not bubble, so a listener on `window` in
    // the bubble phase never sees a nested scrollable container (a library
    // list, a modal body, a drawer) scrolling. The capture phase always
    // trickles through every ancestor on the way to the target regardless of
    // `bubbles`, so this still fires for those.
    window.addEventListener('scroll', hide, true);
    document.addEventListener('pointerdown', hide, true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    // The anchor can stop being laid out without unmounting: theDAW keeps
    // warmed center tabs mounted and flips an ancestor's `style.display` to
    // 'none' on tab switch instead (DAWCenterPanel.tsx), which fires neither
    // a ResizeObserver nor an IntersectionObserver callback. Poll instead.
    // getClientRects() (rather than walking `.style.display` up the
    // ancestor chain) also catches an ancestor hidden via a CSS CLASS
    // (`display: none` in a stylesheet, not inline style) — the previous
    // walk only ever saw `node.style.display`, so a class-hidden ancestor
    // left the tip floating over whatever tab took its place.
    const isLaidOut = () => {
      if (!ref.current || !document.body.contains(ref.current)) return false;
      return ref.current.getClientRects().length > 0;
    };
    const timer = window.setInterval(() => {
      if (!isLaidOut()) hide();
    }, 200);
    return () => {
      window.removeEventListener('blur', hide);
      window.removeEventListener('scroll', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', onKeyDown);
      window.clearInterval(timer);
    };
  }, [show, hide]);

  // T20 re-audit item 3: aria-describedby on the wrapper span is invisible
  // to assistive tech — the wrapper has no role/tabIndex in the default
  // (non-`focusable`) path, so a generic <span> exposes nothing there. Put
  // the id on the focusable child instead when there is exactly one valid
  // element child to clone; fall back to the wrapper for a text node,
  // fragment, multiple children, or the `focusable` anchor case (where the
  // wrapper itself is the intended tab stop). Merge with any
  // aria-describedby the child already carries instead of clobbering it.
  const singleElementChild =
    !focusable && React.isValidElement(children) && React.Children.count(children) === 1
      ? (children as React.ReactElement<{ 'aria-describedby'?: string }>)
      : null;
  const describedByValue = show ? tipId : undefined;
  const renderedChildren = singleElementChild
    ? React.cloneElement(singleElementChild, {
        'aria-describedby':
          [singleElementChild.props['aria-describedby'], describedByValue].filter(Boolean).join(' ') ||
          undefined,
      })
    : children;

  return (
    <span
      ref={ref}
      className="inline-flex min-w-0"
      {...(focusable ? { tabIndex: 0, role: 'group', 'aria-label': focusLabel } : {})}
      aria-describedby={singleElementChild ? undefined : describedByValue}
      onMouseEnter={() => { reposition(); setShow(true); }}
      onMouseLeave={() => setShow(false)}
      onFocus={() => { reposition(); setShow(true); }}
      onBlur={() => setShow(false)}
    >
      {renderedChildren}
      {/* Portalled to document.body: `position: fixed` alone still gets clipped
          by any ancestor that establishes a new containing block (a CSS
          `transform`, `filter`, `perspective`, `contain`, or `overflow: hidden`
          — several of which theDAW's own mixer strips, panels and drawers use),
          so a tip rendered inline in the DOM tree could be invisible or cut off
          under those ancestors. Escaping to body guarantees it never is. */}
      {typeof document !== 'undefined' && mounted && createPortal(
        // data-hover-tip-open mirrors `show` directly (not the AnimatePresence
        // child's mount state, which lags behind by the exit transition) — a
        // stable, animation-independent hook for anything that needs to know
        // instantly whether the tip is meant to be open, tests included.
        <div data-hover-tip-open={show}>
          <AnimatePresence>
            {show && (
              <motion.div
                ref={tipRef}
                role="tooltip"
                id={tipId}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.12 }}
                className="fixed z-9999 pointer-events-none"
                style={{
                  left: pos.x,
                  top: pos.y,
                  transform: 'translate(-50%, -100%)',
                }}
              >
                <div className="max-w-65 px-3 py-2 rounded-lg bg-zinc-900/95 border border-purple-500/20 shadow-2xl shadow-purple-900/20 backdrop-blur-sm">
                  <p className="text-[10px] leading-relaxed text-zinc-300">{text}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </span>
  );
}

/* ─── Click-to-pin tooltip (sections / concepts) ─────────────────── */

// Must match the panel's own `transition={{ duration: 0.15 }}` below — see
// EXIT_TRANSITION_MS above for why this needs to match exactly.
const INFO_PANEL_EXIT_TRANSITION_MS = 150;

export function InfoTip({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Portal mount lifecycle, same pattern as HoverTip's `mounted`: flips true
  // the instant `open` does, flips back false only after the exit
  // transition has had time to play out.
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // T20 re-audit item 5: `y` was never clamped against the viewport bottom,
  // so a panel opened in the lower third of the screen rendered past the
  // edge with no way to reach it (unlike an `absolute` child, which could at
  // least be scrolled to). Seeded with the panel's known worst-case height
  // (header ~36px + `max-h-70` body 280px + padding) for the very first
  // open, then corrected via a layout effect below once the real rendered
  // height is known — same measure-don't-guess approach as HoverTip's tipH.
  const [panelH, setPanelH] = useState(324);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), INFO_PANEL_EXIT_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Anchors the panel to the icon's on-screen position (left edge, just
  // below), then keeps it inside the viewport — the panel is now portalled
  // to document.body (below) so it is no longer clipped by a scrollable
  // ancestor, but it also no longer inherits the icon's position for free,
  // so this has to be computed explicitly.
  const reposition = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const panelW = 340; // matches the panel's own maxWidth
    let x = rect.left;
    let y = rect.bottom + 6; // matches the original `mt-1.5` offset
    if (x + panelW > window.innerWidth - 8) x = Math.max(8, window.innerWidth - panelW - 8);
    // T20 re-audit item 5: mirror HoverTip's flip — if the panel would run
    // past the viewport bottom, place it above the anchor instead.
    if (y + panelH > window.innerHeight - 8) y = Math.max(8, rect.top - panelH - 6);
    setPos({ x, y });
  }, [panelH]);

  // Measure the panel's real rendered height once the portal has painted,
  // and correct the flip decision above against it instead of the seed
  // estimate.
  useLayoutEffect(() => {
    if (!open || !mounted || !panelRef.current) return;
    // T20 re-audit item 1: getBoundingClientRect() returns the TRANSFORMED
    // box while Motion's `initial={{ scale: 0.95 }}` is still applied,
    // converging on ~0.95x the true height with no further render scheduled
    // once Motion reaches `scale: 1` (deps are [open, mounted, panelH]).
    // offsetHeight is the untransformed layout height, so it is correct
    // regardless of the in-flight scale transition.
    const measured = panelRef.current.offsetHeight;
    if (measured > 0 && measured !== panelH) setPanelH(measured);
  }, [open, mounted, panelH]);

  // Re-run reposition once a real measurement replaces the seed estimate,
  // so an already-open panel snaps to the corrected position.
  useEffect(() => {
    if (open) reposition();
  }, [panelH, open, reposition]);

  // T20 re-audit item 3: only `mousedown` and `keydown` were registered, so
  // the panel — `fixed` at coordinates frozen at open time — was stranded by
  // any scroll or resize until the next outside click. HoverTip already
  // handles this with a capture-phase `scroll` listener; InfoTip did not get
  // the same treatment.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portalled to document.body (below), so it is no longer
      // a DOM descendant of `ref` — without also checking `panelRef`, every
      // click inside the panel itself (the close button aside, which stops
      // propagation) would be treated as "outside" and close it immediately.
      if (ref.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const lines = body.split('\n');

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); if (!open) reposition(); setOpen(!open); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="p-0 border-0 bg-transparent cursor-pointer flex items-center justify-center"
        aria-label={`Info: ${title}`}
      >
        <Info
          className={`w-3 h-3 transition-all duration-200 ${
            open
              ? 'text-purple-400 drop-shadow-[0_0_6px_rgba(139,92,246,0.6)]'
              : hovered
                ? 'text-purple-400/80 drop-shadow-[0_0_4px_rgba(139,92,246,0.4)]'
                : 'text-zinc-600'
          }`}
        />
      </button>
      {/* Portalled to document.body for the same reason as HoverTip above:
          any scrollable/clipping ancestor (CatalogueInspector's
          `overflow-y-auto` list, a settings section's scroll container, …)
          would otherwise cut the panel off instead of letting it float over
          the page. */}
      {typeof document !== 'undefined' && mounted && createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, scale: 0.95, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="fixed z-9999"
              style={{ left: pos.x, top: pos.y, minWidth: '280px', maxWidth: '340px' }}
            >
              <div className="rounded-lg bg-zinc-900/95 border border-purple-500/25 shadow-2xl shadow-purple-900/30 backdrop-blur-sm overflow-hidden">
                {/* header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-purple-500/8 border-b border-purple-500/15">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300">{title}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setOpen(false); }}
                    className="p-0.5 rounded hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                {/* body */}
                <div className="px-3 py-2.5 max-h-70 overflow-y-auto">
                  {lines.map((line, i) => {
                    if (line.trim() === '') return <div key={i} className="h-1.5" />;
                    if (line.startsWith('•')) {
                      return (
                        <div key={i} className="flex gap-1.5 mb-0.5">
                          <span className="text-purple-400 text-[10px] leading-relaxed shrink-0">•</span>
                          <span className="text-[10px] leading-relaxed text-zinc-300">{line.slice(1).trim()}</span>
                        </div>
                      );
                    }
                    return (
                      <p key={i} className="text-[10px] leading-relaxed text-zinc-300 mb-0.5">{line}</p>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

