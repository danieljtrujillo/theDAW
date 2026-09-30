/**
 * The EDIT timeline's mouse-wheel conventions, pure and DOM-free. One wheel
 * event in, one action out. Every wheel site of the EDIT tab (the lane
 * scroller, the track header column) resolves its events here, and the wheel
 * profile table in Timeline preferences is generated from the same bindings,
 * so the tab and its help never disagree.
 *
 *   Wheel                  vertical scroll (through the lanes)
 *   Shift + wheel          horizontal scroll (along time)
 *   Ctrl + wheel           horizontal zoom (time); Cmd + wheel on macOS
 *   Alt + wheel            vertical zoom (track height)
 *
 * Two combinations the table leaves open: Ctrl + Shift + wheel zooms time in
 * fine steps and Ctrl + Alt + wheel scrolls the lanes.
 *
 * Trackpads: a two-finger horizontal swipe with nothing held (|deltaX| >
 * |deltaY|) scrolls along time. A pinch reaches Chromium as Ctrl + wheel, so
 * it zooms time. Some browsers turn Shift + wheel into a horizontal delta
 * themselves; that still scrolls along time by the delta they report.
 *
 * Meta (the Cmd key) counts as Ctrl only on macOS. On Windows and Linux it is
 * the OS key and is ignored, so Win + wheel behaves like a plain wheel.
 *
 * Units: `amount` is the normalised wheel delta in CSS px, positive for wheel
 * down or swipe right. deltaMode 1 (lines) is scaled by 16 px, deltaMode 2
 * (pages) by `pageHeightPx`; unknown modes are treated as pixels.
 */

export type EditWheelKind = 'scroll-y' | 'scroll-x' | 'zoom-x' | 'zoom-y';

export interface EditWheelAction {
  kind: EditWheelKind;
  /** Normalised wheel delta in px (see the module comment). Scroll kinds
   *  apply it as a scroll offset; zoom kinds turn it into a zoom step. */
  amount: number;
  /** zoom-x only: fine steps (Ctrl + Shift + wheel). */
  fine: boolean;
}

/** The subset of a WheelEvent the resolver reads, plus the host platform. */
export interface EditWheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** `navigator.userAgentData.platform` ("macOS", "Windows"),
   *  `navigator.platform` ("MacIntel", "Win32") or Node's `process.platform`
   *  ("darwin", "win32"). {@link hostPlatform} when absent. */
  platform?: string;
}

/** Modifier combinations, in the order the preferences table lists them. */
export type WheelGestureKey = 'plain' | 'ctrl' | 'shift' | 'alt' | 'ctrlShift' | 'ctrlAlt';

/** What one gesture does: an action kind, fine time zoom, or nothing. */
export type EditWheelBinding = EditWheelKind | 'zoom-x-fine' | 'none';

/** The EDIT conventions, gesture by gesture. */
export const EDIT_WHEEL_BINDINGS: Readonly<Record<WheelGestureKey, EditWheelBinding>> = Object.freeze({
  plain: 'scroll-y',
  ctrl: 'zoom-x',
  shift: 'scroll-x',
  alt: 'zoom-y',
  ctrlShift: 'zoom-x-fine',
  ctrlAlt: 'scroll-y',
});

/** One line of deltaMode 1, in px. */
export const WHEEL_LINE_HEIGHT_PX = 16;
/** The page height used for deltaMode 2 when the caller measures none. */
export const DEFAULT_WHEEL_PAGE_HEIGHT_PX = 800;

function finite(n: number, name: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
  return n;
}

/** True for every spelling of an Apple platform: "darwin", "macOS",
 *  "MacIntel", "iPhone", "iPad". Case-insensitive; blank is false. */
export function isMacPlatform(platform: string): boolean {
  return /^(darwin|mac|iphone|ipad|ipod)/i.test(platform.trim());
}

/** The platform this code runs on, from the browser's navigator or Node's
 *  process; an empty string when neither says. */
export function hostPlatform(): string {
  const g = globalThis as {
    navigator?: { userAgentData?: { platform?: string }; platform?: string };
    process?: { platform?: string };
  };
  const ua = g.navigator?.userAgentData?.platform;
  if (typeof ua === 'string' && ua) return ua;
  const nav = g.navigator?.platform;
  if (typeof nav === 'string' && nav) return nav;
  const proc = g.process?.platform;
  return typeof proc === 'string' ? proc : '';
}

/** True when the zoom modifier is held: Ctrl anywhere, Cmd on macOS. */
export function zoomModifierHeld(e: { ctrlKey: boolean; metaKey: boolean }, platform: string): boolean {
  return e.ctrlKey || (e.metaKey && isMacPlatform(platform));
}

/**
 * Which gesture row a wheel event belongs to. Resolution order: Ctrl + Shift,
 * Ctrl + Alt, Ctrl, Alt, Shift, plain; Shift + Alt with no Ctrl is Alt.
 */
export function wheelGestureKey(
  e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  platform: string,
): WheelGestureKey {
  const ctrl = zoomModifierHeld(e, platform);
  if (ctrl && e.shiftKey) return 'ctrlShift';
  if (ctrl && e.altKey) return 'ctrlAlt';
  if (ctrl) return 'ctrl';
  if (e.altKey) return 'alt';
  if (e.shiftKey) return 'shift';
  return 'plain';
}

/**
 * Wheel deltas in px: deltaMode 0 (pixels) as-is, 1 (lines) x16,
 * 2 (pages) x `pageHeightPx`. Unknown modes are treated as pixels.
 */
export function normalizeWheelDelta(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  pageHeightPx: number,
): { dx: number; dy: number } {
  finite(e.deltaX, 'deltaX');
  finite(e.deltaY, 'deltaY');
  finite(pageHeightPx, 'pageHeightPx');
  const scale = e.deltaMode === 1 ? WHEEL_LINE_HEIGHT_PX : e.deltaMode === 2 ? pageHeightPx : 1;
  return { dx: e.deltaX * scale, dy: e.deltaY * scale };
}

/**
 * Resolve one wheel event into the action the EDIT tab performs, or null when
 * nothing should happen (zero delta, or a gesture bound to nothing), in which
 * case the caller leaves the event to the browser.
 *
 * The gesture's delta is deltaY, or deltaX when |deltaX| > |deltaY|. With
 * nothing held and a dominant deltaX (a trackpad swipe) the result is
 * scroll-x whatever `bindings` says for plain; every other gesture follows
 * `bindings` (the EDIT conventions unless a wheel profile hands in its own).
 */
export function resolveEditWheel(
  e: EditWheelInput,
  opts?: { pageHeightPx?: number; bindings?: Readonly<Record<WheelGestureKey, EditWheelBinding>> },
): EditWheelAction | null {
  const pageHeightPx = opts?.pageHeightPx ?? DEFAULT_WHEEL_PAGE_HEIGHT_PX;
  const bindings = opts?.bindings ?? EDIT_WHEEL_BINDINGS;
  const { dx, dy } = normalizeWheelDelta(e, pageHeightPx);
  const key = wheelGestureKey(e, e.platform ?? hostPlatform());
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const binding: EditWheelBinding = key === 'plain' && horizontal ? 'scroll-x' : bindings[key];
  const amount = horizontal ? dx : dy;
  if (binding === 'none' || amount === 0) return null;
  if (binding === 'zoom-x-fine') return { kind: 'zoom-x', amount, fine: true };
  return { kind: binding, amount, fine: false };
}
