/**
 * The merged DETAILS tab body: the selected library item's details and the
 * media bucket in one place. `detailsPane` (bottomPanelStore) chooses the
 * layout — SPLIT shows both side by side, DETAILS or MEDIA fills the panel
 * with one of them. The library's "Open details" actions land on DETAILS.
 */
import React from 'react';
import { DetailsView } from './DetailsView';
import { MediaBucketView } from './MediaBucketView';
import { useBottomPanelStore } from '../../state/bottomPanelStore';

export const DetailsMediaView: React.FC = () => {
  const pane = useBottomPanelStore((s) => s.detailsPane);
  if (pane === 'details') return <DetailsView />;
  if (pane === 'media') return <MediaBucketView />;
  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 min-w-0 min-h-0 relative">
        <div className="absolute inset-0">
          <DetailsView />
        </div>
      </div>
      <div className="w-px bg-white/10 shrink-0" aria-hidden="true" />
      <div className="w-96 max-w-[45%] min-w-64 min-h-0 relative shrink-0">
        <div className="absolute inset-0">
          <MediaBucketView />
        </div>
      </div>
    </div>
  );
};
