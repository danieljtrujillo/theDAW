/** Remote tab: drives the desktop footer transport over the control bus. Needs
 *  the desktop app open as host. Renders from the transport.* manifest entries. */
import { Play, Pause, Square } from 'lucide-react';
import { Scroller } from '../ui/Scroller';
import { useControlStore } from '../net/controlClient';
import type { ControlValue } from '../net/controlClient';

const AREA = 'transport';

function num(v: ControlValue | undefined, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}
function bool(v: ControlValue | undefined): boolean {
  return v === true;
}

export function MobileTransport() {
  const status = useControlStore((s) => s.status);
  const values = useControlStore((s) => s.values);
  const setControl = useControlStore((s) => s.setControl);
  const retry = useControlStore((s) => s.retry);
  const hasTransport = useControlStore((s) => s.entries.some((e) => e.area === AREA));

  if (status !== 'paired') {
    return (
      <div className="m-state">
        <h2>
          {status === 'rejected'
            ? 'Pairing needed'
            : status === 'offline'
              ? 'Desktop offline'
              : 'Connecting…'}
        </h2>
        <p>
          {status === 'rejected'
            ? 'This host requires a pairing code. Rescan the QR from the desktop, or open the URL with ?pair=<code>.'
            : 'Open theDAW on your computer and keep it on this network. The remote drives its player.'}
        </p>
        {status !== 'connecting' ? (
          <button type="button" className="m-btn" onClick={() => retry()}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  if (!hasTransport) {
    return (
      <div className="m-state">
        <h2>No transport</h2>
        <p>Connected, but the desktop published no transport controls yet.</p>
      </div>
    );
  }

  const playing = bool(values[`${AREA}.playpause`]);
  const looping = bool(values[`${AREA}.loop`]);
  const seek = num(values[`${AREA}.seek`]);
  const volume = num(values[`${AREA}.volume`], 1);

  return (
    <Scroller>
      <div className="m-remote">
        <div className="m-transport-main">
          <button
            type="button"
            className={`m-btn${playing ? ' is-on' : ''}`}
            onClick={() => setControl(`${AREA}.playpause`, !playing)}
          >
            {playing ? <Pause size={20} /> : <Play size={20} />}
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className="m-btn m-btn-icon"
            aria-label="Stop"
            onClick={() => setControl(`${AREA}.stop`, true)}
          >
            <Square size={18} />
          </button>
        </div>

        <label className="m-field">
          <span className="m-field-label">
            <span>Seek</span>
            <span>{Math.round(seek * 100)}%</span>
          </span>
          <input
            id="m-transport-seek"
            name="transport-seek"
            className="m-range"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={seek}
            onChange={(e) => setControl(`${AREA}.seek`, Number(e.target.value))}
          />
        </label>

        <label className="m-field">
          <span className="m-field-label">
            <span>Volume</span>
            <span>{Math.round(volume * 100)}%</span>
          </span>
          <input
            id="m-transport-volume"
            name="transport-volume"
            className="m-range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setControl(`${AREA}.volume`, Number(e.target.value))}
          />
        </label>

        <div className="m-toggle-row">
          <button
            type="button"
            className={`m-btn${looping ? ' is-on' : ''}`}
            aria-pressed={looping}
            onClick={() => setControl(`${AREA}.loop`, !looping)}
          >
            Loop
          </button>
        </div>
      </div>
    </Scroller>
  );
}
