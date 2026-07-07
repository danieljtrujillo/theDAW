/** theDAW companion root (phone). Standalone Library + a transport remote that
 *  rides the control bus. No cinematic, no MIDI/XR/sway boot — just the shell. */
import { useEffect, useState } from 'react';
import { Library, SlidersHorizontal } from 'lucide-react';
import { MobileScreen } from './ui/MobileScreen';
import { TabBar, type TabDef } from './ui/TabBar';
import { MobileLibrary } from './tabs/MobileLibrary';
import { MobileTransport } from './tabs/MobileTransport';
import { useControlStore } from './net/controlClient';

const TABS: TabDef[] = [
  { id: 'library', label: 'Library', icon: <Library size={20} /> },
  { id: 'remote', label: 'Remote', icon: <SlidersHorizontal size={20} /> },
];

function statusClass(status: string): string {
  if (status === 'paired') return 'm-dot is-ok';
  if (status === 'rejected') return 'm-dot is-bad';
  if (status === 'offline') return 'm-dot is-warn';
  return 'm-dot';
}

function statusLabel(status: string): string {
  if (status === 'paired') return 'linked';
  if (status === 'rejected') return 'locked';
  if (status === 'offline') return 'offline';
  return 'connecting';
}

export function MobileApp() {
  const [tab, setTab] = useState('library');
  const status = useControlStore((s) => s.status);
  const connect = useControlStore((s) => s.connect);
  const disconnect = useControlStore((s) => s.disconnect);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return (
    <MobileScreen
      header={
        <>
          <span className="m-brand">
            theDAW<small>companion</small>
          </span>
          <span className={statusClass(status)}>{statusLabel(status)}</span>
        </>
      }
      tabBar={<TabBar tabs={TABS} active={tab} onSelect={setTab} />}
    >
      {tab === 'library' ? <MobileLibrary /> : <MobileTransport />}
    </MobileScreen>
  );
}
