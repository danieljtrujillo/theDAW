import React, { useState, type ReactNode } from 'react';
import {
  USER_OFFSET_MAX_MS,
  USER_OFFSET_MIN_MS,
  usePlayAlongStore,
} from '../../../../state/playAlongStore';
import { CALIBRATOR_ID, LatencyCalibrator } from './LatencyCalibrator';
import { LookControls } from './LookControls';

/** Ambient "a host already owns the play key" flag. The SING split view mounts
 *  the whole SCORE tab beside its own lyrics, so it turns this on for that
 *  subtree rather than threading a prop through the call sites it doesn't own
 *  — and only while SING's play key is actually on screen. ScoreView reads it
 *  to drop the play key and the OTHER TRACK badge from its header. */
export const PlayAlongTransportCompact = React.createContext(false);

export interface PlayAlongTransportProps {
  /** Mode-specific controls (zoom cluster, key/tempo readout, …) rendered first. */
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

/** The footer every play-along view shares: the view's own controls, the look
 *  preferences, and the visual latency offset with its tap calibrator. Play /
 *  pause and the OTHER TRACK badge are not here: they sit at the left end of
 *  the Score header (ScoreView), the spot every surface's play key takes, so
 *  one key serves PAGE, STRIP, CHORDS and HIGHWAY alike. The OFFSET/CALIBRATE
 *  pair is this app's only UI for playAlongStore.userOffsetMs (the per-device
 *  visual latency every play-along clock subtracts, the lyrics' included), so
 *  it stays in the SING split too. Same chrome as the PAGE footer. */
export const PlayAlongTransport: React.FC<PlayAlongTransportProps> = ({
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

  return (
    <div className="shrink-0 h-8 border-t border-white/10 bg-[#0a080f] flex items-center gap-2 px-2 text-xs font-bold text-zinc-300">
      {children}
      <span className="ml-auto">
        <LookControls />
      </span>
      {showLatency && (
        <div className="relative flex items-center gap-1">
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
            className="w-16 form-select text-xs font-bold px-1 py-0.5 tabular-nums"
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
