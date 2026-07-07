/** Shared gate for remote tabs (Transport, DJ, …). Shows a connection state
 *  card until the control bus is paired, then renders its children. */
import type { ReactNode } from 'react';
import { useControlStore } from '../net/controlClient';

export function RemoteGate({ children }: { children: ReactNode }) {
  const status = useControlStore((s) => s.status);
  const retry = useControlStore((s) => s.retry);

  if (status === 'paired') return <>{children}</>;

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
          : 'Open theDAW on your computer and keep it on this network. The remote drives its live rig.'}
      </p>
      {status !== 'connecting' ? (
        <button type="button" className="m-btn" onClick={() => retry()}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
