/** One row of the virtualized venue list (step 4). A flex of SIBLING controls
 *  (focus button + contact links + add-to-route button), never links nested in
 *  one big button. Arrow keys move focus between rows; hover and selection are
 *  mirrored on the map markers through hoverId / selectedId. */
import React from 'react';
import type { RowComponentProps } from 'react-window';
import { Check, Plus } from 'lucide-react';
import type { TourVenue } from '../../lib/tourClient';
import { ContactLinks } from './ContactLinks';

export type VenueRowProps = {
  venues: TourVenue[];
  selectedId: string;
  hoverId: string;
  routeIds: Set<string>;
  onFocus: (v: TourVenue) => void;
  onHover: (id: string) => void;
  onToggleRoute: (v: TourVenue) => void;
};

// Arrow keys walk the rendered rows: react-window keeps them in index order,
// so the DOM sibling is the neighbouring venue.
const focusSibling = (e: React.KeyboardEvent<HTMLElement>, dir: 1 | -1) => {
  const row = (e.currentTarget as HTMLElement).closest('[data-venue-row]');
  const next = dir === 1 ? row?.nextElementSibling : row?.previousElementSibling;
  const btn = next?.querySelector<HTMLButtonElement>('button[data-venue-focus]');
  if (btn) {
    e.preventDefault();
    btn.focus();
  }
};

export function VenueRow({
  index, style, venues, selectedId, hoverId, routeIds, onFocus, onHover, onToggleRoute,
}: RowComponentProps<VenueRowProps>) {
  const v = venues[index];
  if (!v) return null;
  const active = v.id === selectedId;
  const hovered = v.id === hoverId;
  const inRoute = routeIds.has(v.id);
  return (
    <div style={style} data-venue-row className="px-0.5">
      <div
        onMouseEnter={() => onHover(v.id)}
        onMouseLeave={() => onHover('')}
        className={`flex h-11 w-full items-center gap-2 rounded-md border px-2 transition-colors ${
          active
            ? 'border-lime-500/40 bg-lime-500/10'
            : hovered
              ? 'border-white/15 bg-white/6'
              : 'border-transparent hover:border-white/10 hover:bg-white/5'
        }`}
      >
        <button
          type="button"
          data-venue-focus
          aria-current={active ? 'true' : undefined}
          onClick={() => onFocus(v)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') focusSibling(e, 1);
            else if (e.key === 'ArrowUp') focusSibling(e, -1);
          }}
          className="min-w-0 flex-1 rounded text-left focus-visible:outline focus-visible:outline-lime-400/70"
        >
          <span className="block truncate text-[12px] text-zinc-100">{v.name}</span>
          <span className="block truncate text-[10px] text-zinc-500">
            {v.category.replace(/_/g, ' ')}
            {v.address ? ` · ${v.address}` : v.city ? ` · ${v.city}` : ''}
          </span>
        </button>
        <ContactLinks v={v} max={3} />
        <button
          type="button"
          onClick={() => onToggleRoute(v)}
          aria-pressed={inRoute}
          aria-label={inRoute ? `Remove ${v.name} from route` : `Add ${v.name} to route`}
          className={`flex h-6 shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-[11px] font-semibold transition-colors ${
            inRoute
              ? 'border-lime-400/60 bg-lime-400/20 text-lime-100'
              : 'border-white/15 bg-white/5 text-zinc-300 hover:border-lime-500/50 hover:text-lime-200'
          }`}
        >
          {inRoute ? <Check className="h-3 w-3" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
          {inRoute ? 'Added' : 'Add'}
        </button>
      </div>
    </div>
  );
}
