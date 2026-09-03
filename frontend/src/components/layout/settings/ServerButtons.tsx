/** Backend restart / shutdown controls for the Settings header. */
import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Power, PowerOff, RefreshCw } from 'lucide-react';

/** Restarts the backend by hitting POST /api/admin/restart and then polling
 *  /api/health until the new process answers. */
export const RestartServerButton: React.FC<{ compact?: boolean; iconOnly?: boolean }> = ({ compact = false, iconOnly = false }) => {
  type Status = 'idle' | 'restarting' | 'success' | 'error';
  const [status, setStatus] = useState<Status>('idle');
  const [detail, setDetail] = useState<string>('');

  const handle = async () => {
    if (status === 'restarting') return;
    setStatus('restarting');
    setDetail('Sending restart signal…');
    try {
      const r = await fetch('/api/admin/restart', { method: 'POST' });
      if (r.status === 412) {
        const body = await r.json().catch(() => ({ detail: '' }));
        setStatus('error');
        setDetail(body.detail || 'Supervisor not detected. Launch via theDAW.bat to enable restart.');
        setTimeout(() => { setStatus('idle'); setDetail(''); }, 10_000);
        return;
      }
      if (!r.ok) throw new Error(`restart endpoint returned ${r.status}`);
      setDetail('Waiting for backend to come back…');
      const deadline = Date.now() + 90_000;
      await new Promise((res) => setTimeout(res, 1500));
      while (Date.now() < deadline) {
        try {
          const h = await fetch('/api/health', { cache: 'no-store' });
          if (h.ok) {
            setStatus('success');
            setDetail('Backend restarted.');
            setTimeout(() => { setStatus('idle'); setDetail(''); }, 4000);
            return;
          }
        } catch {
          // expected during the offline window
        }
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        setDetail(`Waiting for backend to come back… ${remaining}s left`);
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error("backend didn't respond within 90s — it may still be loading; try refreshing the page");
    } catch (e) {
      setStatus('error');
      setDetail(e instanceof Error ? e.message : 'restart failed');
      setTimeout(() => { setStatus('idle'); setDetail(''); }, 10_000);
    }
  };

  const baseCls = iconOnly
    ? 'flex items-center justify-center p-1 rounded border transition-colors'
    : compact
    ? 'flex items-center justify-center gap-1 px-2 py-1 rounded border text-[11px] font-black uppercase tracking-widest transition-colors'
    : 'flex items-center justify-center gap-2 flex-1 px-3 py-2 rounded border text-xs font-black uppercase tracking-widest transition-colors';
  const stateCls: Record<Status, string> = {
    idle: 'border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 hover:border-purple-400/60',
    restarting: 'border-amber-500/40 bg-amber-500/10 text-amber-200 cursor-wait',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 cursor-default',
    error: 'border-rose-500/40 bg-rose-500/10 text-rose-200 cursor-default',
  };

  const icon =
    status === 'restarting' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
    : status === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" />
    : status === 'error' ? <AlertCircle className="w-3.5 h-3.5" />
    : <Power className="w-3.5 h-3.5" />;

  const label =
    status === 'restarting' ? 'Restarting…'
    : status === 'success' ? 'Back online'
    : status === 'error' ? 'Restart failed'
    : 'Restart';

  return (
    <button type="button" onClick={handle} disabled={status === 'restarting'} className={`${baseCls} ${stateCls[status]}`} title={detail || `${label} the backend`} aria-label={label}>
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
};

/** Cleanly stops the theDAW backend (rc=0). */
export const ShutdownServerButton: React.FC<{ compact?: boolean; iconOnly?: boolean }> = ({ compact = false, iconOnly = false }) => {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const handle = async () => {
    if (pending || done) return;
    const electron = (window as unknown as {
      electronAPI?: { isElectron?: boolean; quitApp?: () => Promise<void> };
    }).electronAPI;
    const isDesktop = !!electron?.isElectron;
    const ok = window.confirm(
      isDesktop
        ? 'Shut down theDAW?\n\nThis closes the window and stops the backend.'
        : 'Shut down the theDAW backend?\n\nThe browser will lose its connection. Relaunch via theDAW.bat to bring it back.',
    );
    if (!ok) return;
    setPending(true);
    try {
      if (isDesktop && electron?.quitApp) {
        // Closes the window AND kills the backend (main's before-quit handler).
        await electron.quitApp();
      } else {
        await fetch('/api/admin/shutdown', { method: 'POST' });
      }
      setDone(true);
    } catch {
      setDone(true);
    } finally {
      setPending(false);
    }
  };

  const baseCls = iconOnly
    ? 'flex items-center justify-center p-1 rounded border transition-colors'
    : compact
    ? 'flex items-center justify-center gap-1 px-2 py-1 rounded border text-[11px] font-black uppercase tracking-widest transition-colors'
    : 'flex items-center justify-center gap-2 flex-1 px-3 py-2 rounded border text-xs font-black uppercase tracking-widest transition-colors';
  const cls = done
    ? 'border-rose-500/50 bg-rose-500/15 text-rose-200 cursor-default'
    : pending
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 cursor-wait'
    : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:border-rose-400/60';

  const icon = done ? <PowerOff className="w-3.5 h-3.5" /> : pending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <PowerOff className="w-3.5 h-3.5" />;
  const label = done ? 'Offline' : pending ? 'Shutting down…' : 'Shutdown';

  return (
    <button type="button" onClick={handle} disabled={pending || done} className={`${baseCls} ${cls}`} title="Stop the backend entirely (supervisor exits, no respawn)." aria-label={label}>
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
};
