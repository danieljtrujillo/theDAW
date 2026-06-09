import React from 'react';
import { inferProvider, providerMeta, providerBadgeClass } from './catalogProviders';

/**
 * CatalogueProviderBadge — small pill showing which platform produced a track.
 *
 * Accepts EITHER an explicit `provider` id, OR a `{ model, source }` pair from
 * which the provider is derived (the library has no `provider` field). Pass
 * whichever is convenient at the call site. Dynamic-safe: any provider id
 * renders, known ones get their brand color.
 */
export const CatalogueProviderBadge: React.FC<{
  provider?: string;
  model?: string | null;
  source?: string | null;
  className?: string;
}> = ({ provider, model, source, className }) => {
  const id = provider ?? inferProvider({ model, source });
  const meta = providerMeta(id);
  return (
    <span
      className={`inline-flex items-center rounded border px-1 py-px text-[7px] font-mono uppercase tracking-wider leading-none ${providerBadgeClass(id)} ${className ?? ''}`}
      title={`Provider: ${meta.label}`}
    >
      {meta.label}
    </span>
  );
};
