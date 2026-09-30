// The live-VST status a chain row shows: LIVE + latency, STARTING, error with a
// retry, render-only, and a dropout count. One component so every list that
// holds hosted plugins says the same thing — the Mix rack (FxRack) had this and
// the Edit view's FX list did not, so a plugin could be processing audio in
// Edit with nothing on screen saying so, and a dead host had no retry there.

import React from 'react';
import { RotateCw } from 'lucide-react';
import { liveVstStatus } from '../../lib/sabSupport';
import { vstSessions } from '../../lib/vstLive/sessionRegistry';
import type { ChainEntry } from '../../state/effectChainStore';
import { useVstLiveStore } from '../../state/vstLiveStore';
import { vstLiveBadge } from './FxRack';

interface VstLiveRowBadgeProps {
  entry: ChainEntry;
  /** The plugin's display name, for the retry button's accessible name. */
  label: string;
  /** Override the retry the error state offers. Absent, the row reconnects the entry's session. */
  onRetry?: (entry: ChainEntry) => void;
}

export const VstLiveRowBadge: React.FC<VstLiveRowBadgeProps> = ({ entry, label, onRetry }) => {
  // This row's state only: a status change on another plugin must not re-render this one.
  const live = useVstLiveStore((s) => s.entries[entry.id]);
  const host = liveVstStatus(useVstLiveStore((s) => s.host));
  if (entry.effect !== 'vst3') return null;
  const badge = vstLiveBadge(live, host);
  const xruns = live?.xruns ?? 0;
  return (
    <>
      {/* A plain span has the implicit role `generic`, where aria-label is prohibited: the full
          sentence for assistive tech is the sr-only sibling; `title` carries it for the mouse. */}
      <span
        title={badge.title}
        className={`shrink-0 rounded-sm border px-1 py-px font-sans text-[10px] font-bold uppercase tracking-wide ${badge.tone}`}
      >
        {badge.text}
      </span>
      <span className="sr-only">{badge.label}</span>
      {xruns > 0 && (
        <span
          title={`${xruns} audio block${xruns === 1 ? '' : 's'} arrived too late to play and were dropped — the plugin is not keeping up`}
          className="shrink-0 rounded-sm border border-amber-400/30 bg-amber-400/10 px-1 py-px font-mono text-[10px] font-bold text-amber-300/80"
        >
          {xruns} xrun
        </span>
      )}
      {live?.status === 'error' && (
        <button
          type="button"
          onClick={() => (onRetry ? onRetry(entry) : vstSessions.retry(entry.id))}
          aria-label={`Retry the live plugin host for ${label}`}
          title={`Retry: ${live.reason ?? 'the plugin host stopped'}`}
          className="p-0.5 rounded text-red-300 hover:text-red-200 hover:bg-red-500/10 shrink-0"
        >
          <RotateCw className="w-3 h-3" />
        </button>
      )}
    </>
  );
};
