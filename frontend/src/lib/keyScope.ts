/**
 * Ownership arbitration for global keyboard shortcuts.
 *
 * Several surfaces are mounted at once and each registers its own `window`
 * keydown listener — the EDIT timeline in the center panel and the piano roll /
 * step sequencer in the global bottom dock, for instance. Both bound Delete, so
 * a single keypress removed a selected clip AND a selected note.
 *
 * A panel opts in by putting `data-keyscope="<name>"` on its root. The owner of
 * an ambiguous key is then the panel under the pointer, falling back to the one
 * containing focus — the rule most DAWs use, and the one that matches what a
 * user is looking at when they press the key.
 *
 * Scopes are expected to be siblings, not nested; with nesting, `:hover` matches
 * the whole ancestor chain and the outermost would win.
 */
export function activeKeyScope(): string | null {
  if (typeof document === 'undefined') return null;
  // Pointer first: hovering a panel is the strongest statement of intent.
  const hovered = document.querySelectorAll('[data-keyscope]:hover');
  if (hovered.length > 0) {
    return hovered[hovered.length - 1].getAttribute('data-keyscope');
  }
  const active = document.activeElement;
  const owner = active instanceof Element ? active.closest('[data-keyscope]') : null;
  return owner?.getAttribute('data-keyscope') ?? null;
}

/**
 * True when `scope` should handle an ambiguous global key.
 *
 * `fallback` decides who wins when nothing is hovered or focused — set it on the
 * primary surface (the EDIT timeline) so behaviour there is unchanged when the
 * user has not touched a panel yet.
 */
export function ownsKey(scope: string, opts: { fallback?: boolean } = {}): boolean {
  const active = activeKeyScope();
  if (active === null) return opts.fallback ?? false;
  return active === scope;
}
