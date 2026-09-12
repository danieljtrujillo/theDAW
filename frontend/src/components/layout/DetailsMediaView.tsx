/**
 * The merged DETAILS tab body: the selected library item's details and, beside
 * it, a list to pick the next item from. `detailsPane` (bottomPanelStore)
 * chooses the layout — SPLIT shows both side by side, DETAILS or MEDIA fills
 * the panel with one of them. The library's "Open details" actions land on
 * DETAILS.
 *
 * The SPLIT column on the right is the FULL LIBRARY by default
 * (DetailsLibraryPane): clicking a row selects it and the details pane on the
 * left inspects it, which is the pair the user asked for. The media bucket —
 * loose files that are not library entries — is still that column's other
 * choice, through the LIBRARY / MEDIA switch above it, and still fills the
 * whole tab from the tab row's MEDIA button. Nothing about the bucket was
 * removed; it just no longer owns the column by default.
 */
import React from 'react';
import { FolderOpen, Library } from 'lucide-react';
import { DetailsView } from './DetailsView';
import { DetailsLibraryPane } from './DetailsLibraryPane';
import { MediaBucketView } from './MediaBucketView';
import { useBottomPanelStore } from '../../state/bottomPanelStore';

/** LIBRARY / MEDIA switch for the SPLIT layout's right-hand column. */
const RightPaneSwitch: React.FC = () => {
  const right = useBottomPanelStore((s) => s.detailsSplitRight);
  const setRight = useBottomPanelStore((s) => s.setDetailsSplitRight);
  const btn =
    'flex-1 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.18em] transition-colors inline-flex items-center justify-center gap-1';
  const on = 'bg-emerald-500/15 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.5)]';
  const off = 'text-zinc-500 hover:text-zinc-200';
  return (
    <div
      className="flex items-center px-1.5 py-1 border-b border-white/5 bg-black/50 shrink-0"
      role="group"
      aria-label="Right column content"
    >
      <div className="flex w-full rounded-md border border-white/10 overflow-hidden">
        <button
          type="button"
          onClick={() => setRight('library')}
          aria-pressed={right === 'library'}
          className={`${btn} ${right === 'library' ? on : off}`}
          title="Browse the whole library here and inspect the selected track on the left"
        >
          <Library className="w-3 h-3" aria-hidden="true" /> Library
        </button>
        <button
          type="button"
          onClick={() => setRight('media')}
          aria-pressed={right === 'media'}
          className={`${btn} ${right === 'media' ? on : off}`}
          title="The media bucket: loose audio / MIDI / image files, not library entries"
        >
          <FolderOpen className="w-3 h-3" aria-hidden="true" /> Media
        </button>
      </div>
    </div>
  );
};

export const DetailsMediaView: React.FC = () => {
  const pane = useBottomPanelStore((s) => s.detailsPane);
  const right = useBottomPanelStore((s) => s.detailsSplitRight);
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
      <div className="w-96 max-w-[45%] min-w-64 min-h-0 shrink-0 flex flex-col bg-[#0a080f]">
        <RightPaneSwitch />
        <div className="flex-1 min-h-0 relative">
          <div className="absolute inset-0">
            {right === 'media' ? <MediaBucketView /> : <DetailsLibraryPane />}
          </div>
        </div>
      </div>
    </div>
  );
};
