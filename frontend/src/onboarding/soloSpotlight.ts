/**
 * One registry entry, dressed as a tour step.
 *
 * "Show me where X is" wants everything the tour overlay already does — switch
 * to the right workspace, open the panel the control lives in, poll for a
 * lazily mounted target, place a card that never covers what it points at — and
 * none of what makes the tour a tour. So it borrows the engine rather than
 * growing a second overlay that would drift from the first.
 *
 * A step built here is deliberately terminal: no next, no progress, and no exit
 * path through skip()/finish(), because both of those set `seen` and lighting
 * up one control must never suppress a genuine first run.
 */
import { featureById } from './featureRegistry';
import { centerTabFor, revealFeature } from './featureReveal';
import type { TourStep } from './tourSteps';

/**
 * A one-off spotlight step for a feature id, or null when there is nothing to
 * point at — a feature with no `locate` has no single on-screen home, and a
 * null here degrades to nothing rather than to a blank centred card.
 */
export function spotlightStepFor(featureId: string): TourStep | null {
  const entry = featureById(featureId);
  if (!entry?.locate) return null;
  return {
    id: `solo-${entry.id}`,
    title: entry.name,
    body: entry.what,
    tip: entry.how.length ? entry.how.join(' · ') : undefined,
    targetSelector: entry.locate.selector,
    targetMode: entry.locate.mode,
    tab: centerTabFor(entry),
    prepare: () => {
      revealFeature(entry);
    },
    primaryLabel: 'Got it',
  };
}
