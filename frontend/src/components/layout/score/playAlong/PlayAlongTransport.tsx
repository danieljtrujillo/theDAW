import React, { useState, type ReactNode } from 'react';
import { Pause, Play } from 'lucide-react';
import type { LibraryEntry } from '../../../../state/libraryEntry';
import {
  USER_OFFSET_MAX_MS,
  USER_OFFSET_MIN_MS,
  usePlayAlongStore,
} from '../../../../state/playAlongStore';
import { CALIBRATOR_ID, LatencyCalibrator } from './LatencyCalibrator';

export interface PlayAlongTransportProps {
  entry: LibraryEntry | null;
  isSameTrack: boolean;
  isPlaying: boolean;
  otherTrackLoaded: boolean;
  onTransport: () => void | Promise<void>;
  /** Mode-specific controls (zoom cluster, skin, …) rendered after the badge. */
  children?: ReactNode;
  /** Show the OFFSET ms field (and CALIBRATE). Default true. */
  showLatency?: boolean;
  /** Override: when given, CALIBRATE calls this instead of opening the
   *  built-in calibrator, and `calibratorOpen` drives aria-expanded. Views
   *  that pass nothing get the calibrator mounted right here. */
  onCalibrate?: () => void;
  /** Whether an externally managed calibrator dialog is open. */
  calibratorOpen?: boolean;
}

/** The footer every play-along view shares: play/pause for THIS entry, the
 *  OTHER TRACK badge when the engine holds something else, the view's own
 *  controls, and the visual latency offset with its tap calibrator. Same
 *  chrome as the PAGE footer. */
export const PlayAlongTransport: React.FC<PlayAlongTransportProps> = ({
  entry,
  isSameTrack,
  isPlaying,
  otherTrackLoaded,
  onTransport,
  children,
  showLatency = true,
  onCalibrate,
  calibratorOpen = false,
}) => {
  const userOffsetMs = usePlayAlongStore((s) => s.userOffsetMs);
  const setUserOffsetMs = usePlayAlongStore((s) => s.setUserOffsetMs);
  const [ownCalibratorOpen, setOwnCalibratorOpen] = useState(false);

  const externallyManaged = typeof onCalibrate === 'function';
  const calibratorIsOpen = externallyManaged ? calibratorOpen : ownCalibratorOpen;
  const toggleCalibrator = () => {
    if (externallyManaged) onCalibrate();
    else setOwnCalibratorOpen((v) => !v);
  };

  const transportLabel = !entry
    ? 'No track selected'
    : isSameTrack
      ? (isPlaying ? `Pause ${entry.title}` : `Play ${entry.title}`)
      : `Play ${entry.title}`;

  return (
    <div className="shrink-0 h-8 border-t border-white/10 bg-[#0a080f] flex items-center gap-2 px-2 text-[10px] font-mono text-zinc-300">
      <button
        type="button"
        onClick={() => void onTransport()}
        disabled={!entry}
        className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
        title={transportLabel}
        aria-label={transportLabel}
      >
        {isSameTrack && isPlaying
          ? <Pause className="w-3.5 h-3.5" />
          : <Play className="w-3.5 h-3.5 text-emerald-300" />}
      </button>
      {otherTrackLoaded && (
        <span
          className="text-amber-300/90"
          title="The player is holding a different track, so this view is parked. Press play here to load this track."
        >
          OTHER TRACK
        </span>
      )}
      {children}
      {showLatency && (
        <div className="ml-auto relative flex items-center gap-1">
          <label htmlFor="score-latency-ms" className="text-zinc-500 select-none" title="Visual offset: positive shows the visuals later">
            OFFSET ms
          </label>
          <input
            id="score-latency-ms"
            name="score-latency-ms"
            type="number"
            min={USER_OFFSET_MIN_MS}
            max={USER_OFFSET_MAX_MS}
            step={5}
            value={userOffsetMs}
            onChange={(e) => setUserOffsetMs(Number(e.target.value) || 0)}
            className="w-14 form-select text-[10px] px-1 py-0.5 tabular-nums"
          />
          <button
            type="button"
            onClick={toggleCalibrator}
            className={`px-1.5 py-0.5 rounded hover:bg-white/10 ${calibratorIsOpen ? 'text-emerald-200' : ''}`}
            title="Measure this device's visual latency by tapping along to clicks"
            aria-haspopup="dialog"
            aria-expanded={calibratorIsOpen}
            aria-controls={CALIBRATOR_ID}
          >
            CALIBRATE
          </button>
          {!externallyManaged && (
            <LatencyCalibrator open={ownCalibratorOpen} onClose={() => setOwnCalibratorOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
};

export default PlayAlongTransport;
