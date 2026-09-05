/**
 * Continuous, width AND height aware shell scale.
 *
 * The DAW is designed against a fixed logical canvas (DESIGN_W x DESIGN_SHELL_H
 * CSS px for the Shell, plus the unzoomed 56px (h-14) PlayerFooter beneath it). The
 * Shell renders under CSS `zoom` so that canvas always fits the real window:
 *
 *   zoom = clamp(MIN, min(innerWidth / DESIGN_W, (innerHeight - FOOTER_H) / DESIGN_SHELL_H), MAX)
 *
 * It replaces the three width-only media-query tiers (0.85 / 0.95 / 1.1) that
 * used to live in index.css. Those tiers had no height term (a 1920x900
 * window got the 1.1 tier and lost ~90 logical px of shell height), had a
 * cliff at 1440 px (a 1439 px window laid out 1693 logical px wide, a 1440 px
 * one only 1516) and left 1366x768 laptops with a 809 px tall shell for panels
 * that need ~820. The continuous formula keeps the design's minimum logical
 * size fitting at every window size.
 *
 * DESIGN_W / DESIGN_SHELL_H were measured with frontend/_audit_layout.mjs run
 * at ZOOM=1: the header (logo + 12 workspace tabs + Mobile/Docs/menu) is clean
 * from 1300 px, and the old tiers targeted 1516-1745 logical px, so 1600 keeps
 * today's density; the MAKE rail, the MIX effect library and the DJ decks stop
 * clipping at a ~820 px tall shell (a 900 px window at zoom 1).
 *
 * Published as the `--layout-zoom` custom property + inline `zoom` on the
 * `.dense-layout` root (Shell.tsx), so every existing consumer of
 * `var(--layout-zoom)` / computed `zoom` (canvasScale.effectiveZoom, the
 * LineageModal counter-zoom, the dock height calc) keeps working unchanged.
 */
import { useEffect, useState } from 'react';

export const DESIGN_W = 1600;
export const DESIGN_SHELL_H = 820;
/** PlayerFooter height (h-20) — fixed, outside the zoomed subtree. */
export const FOOTER_H = 56;
export const LAYOUT_ZOOM_MIN = 0.6;
export const LAYOUT_ZOOM_MAX = 1.1;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pure formula; exported for tests and for the audit script. */
export function computeLayoutZoom(innerWidth: number, innerHeight: number): number {
  if (!Number.isFinite(innerWidth) || !Number.isFinite(innerHeight) || innerWidth <= 0 || innerHeight <= 0) return 1;
  const byWidth = innerWidth / DESIGN_W;
  const byHeight = Math.max(0, innerHeight - FOOTER_H) / DESIGN_SHELL_H;
  // Two decimals: stable across sub-pixel resize jitter, no layout thrash.
  return clamp(Math.round(Math.min(byWidth, byHeight) * 100) / 100, LAYOUT_ZOOM_MIN, LAYOUT_ZOOM_MAX);
}

export function currentLayoutZoom(): number {
  if (typeof window === 'undefined') return 1;
  return computeLayoutZoom(window.innerWidth, window.innerHeight);
}

/** The live shell zoom, recomputed on every window resize. */
export function useLayoutZoom(): number {
  const [zoom, setZoom] = useState<number>(() => currentLayoutZoom());
  useEffect(() => {
    const update = () => setZoom(currentLayoutZoom());
    update();
    window.addEventListener('resize', update);
    // Some hosts (packaged app, DevTools docking) resize the visual viewport
    // without a window resize event.
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return zoom;
}
