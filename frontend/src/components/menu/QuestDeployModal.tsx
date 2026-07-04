import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Headset, Loader2, RefreshCw, Rocket, Smartphone, X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Types + defensive JSON helpers (quest backend responses)            */
/* ------------------------------------------------------------------ */

interface QuestDevice {
  serial: string;
  state: string;
  model: string;
  product: string;
  isQuest: boolean;
  ready: boolean;
}

interface QuestStatus {
  adbAvailable: boolean;
  adbPath: string | null;
  adbSource: string;
  adbVersion: string | null;
  devices: QuestDevice[];
  questConnected: boolean;
  defaultPackage: string | null;
  lastApkPath: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const asBool = (v: unknown): boolean => v === true;

const normalizeStatus = (raw: unknown): QuestStatus => {
  const j = asRecord(raw);
  const cfg = asRecord(j.config);
  const devicesRaw = Array.isArray(j.devices) ? j.devices : [];
  const devices = devicesRaw.map((d): QuestDevice => {
    const r = asRecord(d);
    return {
      serial: asStr(r.serial) ?? '',
      state: asStr(r.state) ?? 'unknown',
      model: asStr(r.model) ?? asStr(r.serial) ?? 'device',
      product: asStr(r.product) ?? '',
      isQuest: asBool(r.is_quest),
      ready: asBool(r.ready),
    };
  });
  return {
    adbAvailable: asBool(j.adb_available),
    adbPath: asStr(j.adb_path),
    adbSource: asStr(j.adb_source) ?? 'none',
    adbVersion: asStr(j.adb_version),
    devices,
    questConnected: asBool(j.quest_connected),
    defaultPackage: asStr(cfg.default_package),
    lastApkPath: asStr(cfg.last_apk_path),
  };
};

const errText = async (res: Response): Promise<string> => {
  try {
    const j = asRecord(await res.clone().json());
    const d = j.detail ?? j.error;
    if (typeof d === 'string' && d) return d;
  } catch {
    /* not json */
  }
  return `Request failed (HTTP ${res.status})`;
};

/* ------------------------------------------------------------------ */
/* Shared styling (mirrors BackupModal / UpdateModal)                  */
/* ------------------------------------------------------------------ */

const BTN =
  'flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60';
const BTN_PURPLE = `${BTN} border-purple-500/30 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20`;
const BTN_GHOST = `${BTN} border-white/10 bg-white/3 text-zinc-300 hover:bg-white/8`;
const INPUT_CLS =
  'flex-1 min-w-0 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-purple-500/50';
const LABEL_CLS = 'text-[9px] font-mono uppercase tracking-wider text-zinc-300';
const ERR_CLS = 'text-[9px] font-mono text-red-400 break-all';

const SectionDivider: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-200">{label}</span>
    <div className="flex-1 h-px bg-white/10" />
  </div>
);

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

/**
 * Deploy a prebuilt APK to a connected Meta Quest over adb: detect the headset,
 * install the package, and optionally launch it. Deploy-only — it does not
 * build the APK. Talks to the /api/quest module, which resolves adb from the
 * SDK / Unity / Meta locations or a path the user configures here.
 */
export const QuestDeployModal: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const [status, setStatus] = useState<QuestStatus | null>(null);
  const [scanning, setScanning] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [apkPath, setApkPath] = useState('');
  const [pkg, setPkg] = useState('');
  const [launch, setLaunch] = useState(true);
  const [serial, setSerial] = useState('');

  const [adbPathInput, setAdbPathInput] = useState('');
  const [savingAdb, setSavingAdb] = useState(false);
  const [adbError, setAdbError] = useState<string | null>(null);

  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState<string | null>(null);
  const [deployOk, setDeployOk] = useState<boolean | null>(null);

  const refreshStatus = useCallback(async () => {
    setScanning(true);
    setStatusError(null);
    try {
      const res = await fetch('/api/quest/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(await errText(res));
      const s = normalizeStatus(await res.json());
      setStatus(s);
      // Seed the form from remembered config / the connected device.
      setApkPath((prev) => prev || s.lastApkPath || '');
      setPkg((prev) => prev || s.defaultPackage || '');
      setSerial((prev) => {
        if (prev && s.devices.some((d) => d.serial === prev)) return prev;
        const best = s.devices.find((d) => d.isQuest && d.ready) ?? s.devices[0];
        return best ? best.serial : '';
      });
    } catch (e) {
      setStatus(null);
      setStatusError(e instanceof Error ? e.message : 'Could not query adb.');
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setDeployLog(null);
    setDeployOk(null);
    setAdbError(null);
    void refreshStatus();
  }, [open, refreshStatus]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const chooseApk = async () => {
    try {
      const res = await fetch('/api/quest/pick-apk');
      if (!res.ok) return;
      const path = asStr(asRecord(await res.json()).path);
      if (path) setApkPath(path);
    } catch {
      /* picker unavailable — the user can paste a path */
    }
  };

  const saveAdbPath = async () => {
    const candidate = adbPathInput.trim();
    if (!candidate) return;
    setSavingAdb(true);
    setAdbError(null);
    try {
      const res = await fetch('/api/quest/set-adb-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: candidate }),
      });
      if (!res.ok) throw new Error(await errText(res));
      await refreshStatus();
      setAdbPathInput('');
    } catch (e) {
      setAdbError(e instanceof Error ? e.message : 'Could not set the adb path.');
    } finally {
      setSavingAdb(false);
    }
  };

  const deploy = async () => {
    setDeploying(true);
    setDeployLog(null);
    setDeployOk(null);
    try {
      const res = await fetch('/api/quest/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apk_path: apkPath.trim(),
          serial: serial || undefined,
          package: pkg.trim() || undefined,
          launch,
        }),
      });
      if (!res.ok) throw new Error(await errText(res));
      const j = asRecord(await res.json());
      const installed = asBool(j.installed);
      const launched = asBool(j.launched);
      const installLog = asStr(j.install_log) ?? '';
      const launchLog = asStr(j.launch_log);
      setDeployOk(asBool(j.ok));
      setDeployLog(
        [
          installed ? 'Installed OK.' : 'Install failed.',
          installLog,
          pkg.trim() ? (launched ? 'Launched on headset.' : 'Launch not confirmed.') : '',
          launchLog ?? '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (e) {
      setDeployOk(false);
      setDeployLog(e instanceof Error ? e.message : 'Deploy failed.');
    } finally {
      setDeploying(false);
    }
  };

  if (!open) return null;

  const adbOk = status?.adbAvailable === true;
  const canDeploy = adbOk && apkPath.trim().length > 0 && !deploying;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-120 max-w-[92vw] max-h-[82vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5 shrink-0">
          <Headset className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">
            Deploy to Quest
          </span>
          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={scanning}
            className={`${BTN_GHOST} ml-auto shrink-0`}
          >
            {scanning ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3 text-purple-300" />
            )}
            Rescan
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Quest deploy dialog"
            className="p-1 rounded border border-transparent text-zinc-400 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 min-h-0">
          {/* ---------------- Device / adb status ---------------- */}
          <SectionDivider label="Headset" />

          {statusError && <span className={ERR_CLS}>{statusError}</span>}

          {status && !adbOk && (
            <div className="flex flex-col gap-1.5 rounded border border-amber-500/30 bg-amber-500/5 p-2.5">
              <span className="text-[10px] font-semibold text-amber-100">adb was not found</span>
              <span className="text-[9px] font-mono leading-snug text-zinc-400">
                Install Android platform-tools or the Meta Quest Developer Hub, or point theDAW at an
                existing adb below.
              </span>
              <label htmlFor="quest-adb-path" className={LABEL_CLS}>
                Path to adb
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  id="quest-adb-path"
                  name="quest-adb-path"
                  value={adbPathInput}
                  onChange={(e) => setAdbPathInput(e.target.value)}
                  placeholder="C:\...\platform-tools\adb.exe"
                  className={INPUT_CLS}
                />
                <button
                  type="button"
                  onClick={() => void saveAdbPath()}
                  disabled={savingAdb || !adbPathInput.trim()}
                  className={`${BTN_PURPLE} shrink-0`}
                >
                  {savingAdb ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Save
                </button>
              </div>
              {adbError && <span className={ERR_CLS}>{adbError}</span>}
            </div>
          )}

          {adbOk && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] font-mono text-zinc-500 truncate" title={status?.adbPath ?? ''}>
                adb: {status?.adbVersion ?? 'ready'} ({status?.adbSource})
              </span>
              {status && status.devices.length === 0 && (
                <span className="text-[10px] text-amber-200">
                  No device detected. Connect the Quest over USB, put it in developer mode, and accept
                  the "Allow USB debugging" prompt in the headset, then Rescan.
                </span>
              )}
              {status && status.devices.length > 0 && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="quest-device" className={LABEL_CLS}>
                    Target device
                  </label>
                  <select
                    id="quest-device"
                    name="quest-device"
                    value={serial}
                    onChange={(e) => setSerial(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 outline-none focus:border-purple-500/50"
                  >
                    {status.devices.map((d) => (
                      <option key={d.serial} value={d.serial}>
                        {d.model}
                        {d.isQuest ? ' (Quest)' : ''} — {d.serial}
                        {d.ready ? '' : ` [${d.state}]`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* ---------------- APK + deploy ---------------- */}
          <SectionDivider label="APK" />

          <div className="flex flex-col gap-1">
            <label htmlFor="quest-apk" className={LABEL_CLS}>
              APK file
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                id="quest-apk"
                name="quest-apk"
                value={apkPath}
                onChange={(e) => setApkPath(e.target.value)}
                placeholder="Path to the built .apk"
                className={INPUT_CLS}
              />
              <button type="button" onClick={() => void chooseApk()} className={`${BTN_GHOST} shrink-0`}>
                <Smartphone className="w-3 h-3 text-purple-300" />
                Choose APK
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="quest-package" className={LABEL_CLS}>
              Package name (optional, to launch after install)
            </label>
            <input
              type="text"
              id="quest-package"
              name="quest-package"
              value={pkg}
              onChange={(e) => setPkg(e.target.value)}
              placeholder="com.YourCompany.theDAWXR"
              className={INPUT_CLS}
            />
          </div>

          <label
            htmlFor="quest-launch"
            className="flex items-center gap-1.5 text-[10px] text-zinc-300 cursor-pointer"
          >
            <input
              type="checkbox"
              id="quest-launch"
              name="quest-launch"
              checked={launch}
              onChange={(e) => setLaunch(e.target.checked)}
              className="w-3 h-3 accent-purple-500"
            />
            Launch on the headset after installing (needs the package name)
          </label>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void deploy()} disabled={!canDeploy} className={BTN_PURPLE}>
              {deploying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
              Deploy
            </button>
            {deployOk === true && (
              <span className="text-[9px] font-mono text-emerald-300">deploy complete</span>
            )}
          </div>

          {deployLog && (
            <pre
              className={`text-[9px] font-mono leading-snug whitespace-pre-wrap break-all max-h-32 overflow-y-auto rounded bg-black/40 border border-white/10 p-2 ${
                deployOk === false ? 'text-red-300' : 'text-zinc-400'
              }`}
            >
              {deployLog}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
