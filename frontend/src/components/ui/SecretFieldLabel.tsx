/**
 * SecretFieldLabel — the label every secret input wears.
 *
 * One rule, app-wide: wherever a key, token or password is typed, the thing
 * that says so carries lucide's KeyRound. Not a padlock, not a cloud, not a
 * brand mark — a key, so a field you have never seen before still reads as
 * "paste your key here" at a glance. This component exists so that rule
 * survives the next secret field somebody adds: import it, and the glyph and
 * the `htmlFor` both come for free.
 *
 * It also closes the other half of the same mistake. Three of the app's secret
 * inputs shipped with a `name` and nothing else — no id, no label, no
 * aria-label — which is a CLAUDE.md HARD RULE 3 violation and leaves the field
 * anonymous to a screen reader. `htmlFor` is required here, so a field labelled
 * through this component is always associated with its control.
 *
 * What this is NOT for:
 *   - the reveal toggle inside the field — that is Eye / EyeOff, a different
 *     affordance, and it must stay distinct from the key;
 *   - destructive controls ("Clear", "forget this key") — those are Trash2;
 *   - MUSICAL key (DJView's key-lock / master tempo) or keyboard keys. KeyRound
 *     is used there too and means something else entirely; leave those alone.
 *
 * Layout is the caller's: the base is `inline-flex items-center gap-1` and
 * everything else arrives through `className`, so this drops into a one-row
 * compact field (HfTokenField) and a stacked one without a fight. A label that
 * needs a spread-out row (icon + name on the left, state word on the right,
 * as in TourView) keeps its own markup and renders KeyRound itself — the glyph
 * is the convention, this component is just the easy way to get it right.
 */
import React from 'react';
import { KeyRound } from 'lucide-react';

/** The app's key glyph, at the size every existing secret field uses. */
export const SECRET_ICON_CLASS = 'w-3 h-3 shrink-0 text-zinc-400';

interface Props {
  /** id of the input/textarea this labels. Required — see HARD RULE 3. */
  htmlFor: string;
  children: React.ReactNode;
  /** Extra classes for the label row (type scale, colour, shrink, width…). */
  className?: string;
  title?: string;
  /** Override the glyph's classes when the host surface is not zinc-on-dark. */
  iconClassName?: string;
}

export const SecretFieldLabel: React.FC<Props> = ({
  htmlFor,
  children,
  className,
  title,
  iconClassName,
}) => (
  <label htmlFor={htmlFor} title={title} className={`inline-flex items-center gap-1 ${className ?? ''}`}>
    <KeyRound className={iconClassName ?? SECRET_ICON_CLASS} aria-hidden="true" />
    {children}
  </label>
);

export default SecretFieldLabel;
