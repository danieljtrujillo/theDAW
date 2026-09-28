import React from 'react';
import { providerDisplay, type ProviderFields } from '../../lib/providerLabel';
import { providerBadgeClass } from '../../catalog/catalogProviders';

/**
 * ProviderBadge — THE provider pill. One badge for the whole app: library
 * rows, the catalogue list and grid, the inspector header, the lineage tree.
 *
 * It draws the entry's one provider (`inferProvider`: the slug the backend
 * detected in the file's own metadata, else the model/source derivation), so
 * no call site has to choose between a detected badge and a derived one.
 *
 * Renders nothing only when there is no entry at all — a row always has a
 * provider, even if that provider is "Stable Audio" because theDAW made it.
 *
 * Accessibility: this is a non-interactive label, so it carries `role="img"`
 * plus an `aria-label` ("Source: Suno (AI)"). A bare <span aria-label> is NOT
 * exposed by assistive tech; the role is what makes the name count. It is not
 * a control and must never be wrapped in a <label>.
 */
export const ProviderBadge: React.FC<{
  /** Any entry-shaped object: the four provider wire fields and/or model/source. */
  entry: ProviderFields | null | undefined;
  className?: string;
}> = ({ entry, className }) => {
  const info = providerDisplay(entry);
  if (!info) return null;
  return (
    <span
      role="img"
      aria-label={info.accessibleName}
      title={info.accessibleName}
      data-provider={info.slug}
      className={`inline-flex items-center rounded border px-1 py-px text-xs font-bold uppercase tracking-wider leading-none ${providerBadgeClass(info.slug)} ${className ?? ''}`}
    >
      {info.text}
    </span>
  );
};
