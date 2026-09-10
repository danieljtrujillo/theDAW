/**
 * Should this WebGL surface draw a frame right now?
 *
 * theDAW keeps five three.js scenes alive at once — the assistant orb, two
 * cymatics visualizers in MAKE, the CRISPR DNA card behind the Chimera area,
 * and the boot title — and every one of them ran its `requestAnimationFrame`
 * loop forever. The panels that hold them are hidden with `display:none` when
 * another workspace is open (see AdvancedView and DAWCenterPanel, which warm-
 * mount rather than unmount so in-flight state survives), so two full scenes
 * kept rendering at 60fps behind EDIT, MIX, PERFORM, DJ and VJ, drawing on the
 * same GPU that is loading and running the diffusion model.
 *
 * `document.hidden` — which those loops already checked — only covers the
 * whole window being minimised or backgrounded. It says nothing about a panel
 * the user has navigated away from, which is the case that actually happens.
 *
 * The gate answers both, cheaply: an IntersectionObserver is push-based, so
 * the per-frame question is a boolean read, not a layout query. Never call
 * `getBoundingClientRect` from a render loop to answer this — that forces a
 * synchronous layout on every frame and costs more than the frame it skips.
 */

export interface RenderGate {
  /** True when this element is on screen and the window is not hidden. */
  visible(): boolean;
  /** True the first time it is called after visibility is regained.
   *  Loops use it to re-baseline their frame clock, so a scene resuming after
   *  five minutes off screen does not integrate a 300-second delta. */
  resumed(): boolean;
  dispose(): void;
}

/** A gate that always says yes — for environments with no IntersectionObserver
 *  (jsdom in the test scripts, an ancient webview) where refusing to draw would
 *  be worse than drawing too much. */
const ALWAYS_ON: RenderGate = {
  visible: () => true,
  resumed: () => false,
  dispose: () => {},
};

/**
 * Watch `el` and report whether its scene should draw.
 *
 * `rootMargin` is generous on purpose: a panel scrolled just past the edge is
 * about to come back, and a scene that has to rebuild its first frame at the
 * moment it appears reads as a stutter. Better to draw a little that is not
 * seen than to hitch on every return.
 */
export function createRenderGate(el: Element | null | undefined): RenderGate {
  if (
    !el ||
    typeof window === 'undefined' ||
    typeof IntersectionObserver === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return ALWAYS_ON;
  }

  // Starts true: the observer's first callback is asynchronous, and a scene
  // that is on screen must not miss its opening frames waiting for it.
  let onScreen = true;
  let wasVisible = true;
  let justResumed = false;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) onScreen = entry.isIntersecting;
    },
    { rootMargin: '200px' },
  );
  observer.observe(el);

  const onVisibilityChange = (): void => {
    // Coming back from a minimised window is a resume too — but the browser
    // pauses rAF for the whole time it is hidden, so the loop stops calling
    // visible() and `wasVisible` is never recorded as false. Guarding the
    // resume on `!wasVisible` therefore missed the one case this listener
    // exists for. Take the transition off the event itself instead: hiding
    // marks the gap, and coming back is unconditionally a resume.
    if (document.hidden) wasVisible = false;
    else justResumed = true;
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    visible(): boolean {
      const now = onScreen && !document.hidden;
      if (now && !wasVisible) justResumed = true;
      wasVisible = now;
      return now;
    },
    resumed(): boolean {
      const was = justResumed;
      justResumed = false;
      return was;
    },
    dispose(): void {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
