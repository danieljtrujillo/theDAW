import { create } from 'zustand';
import { ApiError } from '../lib/apiJson';
import { vstApi, type Vst3PluginInfo } from '../lib/vstClient';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

/** True when the backend refused the scan because this page may not host VSTs
 *  as it stands — a 403, or any other 4xx that says so in its own words.
 *
 *  This is not a failure. `/api/vst/scan` is gated (backend/lib/cross_site.py):
 *  it answers this machine's own UI, the desktop shell and a paired device, and
 *  a page on another machine that was never paired is *supposed* to be turned
 *  away; treating that as an error put "VST SCAN FAILED: ..." in the log and the
 *  status bar on every such launch. */
export const isDesktopOnlyRefusal = (e: unknown): boolean => {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 403) return true;
  return e.status >= 400 && e.status < 500 && /desktop shell|desktop app/i.test(e.message);
};

/** True when the refusal is the pairing gate's (its message names a paired
 *  device): pairing this device is what would make VST effects work here. */
export const refusalNeedsPairing = (reason: string | null | undefined): boolean =>
  /paired/i.test(reason ?? '');

/** What MIX tells an unpaired device, in place of the backend's words. */
export const PAIR_THIS_DEVICE_TEXT =
  'VST effects work on this device once it is paired. On the computer running theDAW, open Mobile Access and open its share link or QR code on this device.';

/** How a plugin comes to be listed, for every empty VST3 list (MIX's browser,
 *  EDIT's effect rack, EDIT's instrument slot). `installFolder` is the folder
 *  the backend's scan reads, from the scan answer's `install_folder` (backend
 *  scanner `vst3_install_folder`: `C:\Program Files\Common Files\VST3` on a
 *  standard Windows install, `/usr/lib/vst3` on Linux). A folder linked into
 *  it counts too, and a rescan finds what was installed since. Until a scan
 *  has answered, the folder goes unnamed. */
export const vst3InstallHint = (installFolder: string | null | undefined): string =>
  `Install them into ${installFolder?.trim() || 'the VST3 folder'}, or link their folder into it, then press Rescan.`;

/** What the MIX effects browser shows where the plugin tiles would be.
 *
 *  An empty list with no explanation is the browser build's worst answer: the
 *  user clicks Rescan, nothing happens, and nothing ever says why.
 *  `unavailableReason` carries the backend's own words when the scan was
 *  refused rather than failed. A pairing refusal says how to pair; any other
 *  refusal is the desktop-only one. */
export const vstBrowserEmptyText = (
  scanning: boolean,
  unavailableReason: string | null,
  installFolder: string | null = null,
): string => {
  if (scanning) return 'Scanning…';
  const reason = unavailableReason?.trim();
  if (reason && refusalNeedsPairing(reason)) return PAIR_THIS_DEVICE_TEXT;
  if (reason) return `VST hosting is desktop-only. ${reason}`;
  return `No VST3 plugins found. ${vst3InstallHint(installFolder)}`;
};

/** The quiet notice is shown once per session, not once per scan: MIX and the
 *  editor both call `scan()`, and the browser's answer will not change. */
let desktopOnlyNoticeShown = false;

/** Tests only — the notice is a process-lifetime latch by design. */
export const resetDesktopOnlyNotice = (): void => {
  desktopOnlyNoticeShown = false;
};

// Holds the scanned VST3 plugin list for the MIX effects browser. Plugins are
// added to the effect chain as 'vst3' nodes (see effectChainStore.addVst) and
// processed per-stage by studioStore via /api/vst/process-file.
interface VstState {
  plugins: Vst3PluginInfo[];
  scanning: boolean;
  scanned: boolean;
  error: string | null;
  /** Why there are no plugins *here*, in the backend's own words, when the
   *  scan was refused rather than failed. Null whenever `error` is the answer
   *  (a real failure) or the scan worked. */
  unavailableReason: string | null;
  /** The folder the backend's scan reads for installed plugins (its answer's
   *  `install_folder`), named by every empty VST3 list; null until a scan
   *  answers. */
  installFolder: string | null;
  scan: (refresh?: boolean) => Promise<void>;
}

export const useVstStore = create<VstState>()((set) => ({
  plugins: [],
  scanning: false,
  scanned: false,
  error: null,
  unavailableReason: null,
  installFolder: null,

  scan: async (refresh = false) => {
    set({ scanning: true, error: null });
    try {
      logInfo('vst', `GET /api/vst/scan refresh=${refresh}`);
      const res = await vstApi.scan(refresh);
      set({
        plugins: res.plugins,
        scanning: false,
        scanned: true,
        unavailableReason: null,
        installFolder: res.install_folder?.trim() || null,
      });
      if (refresh) {
        useStatusBarStore.getState().setText(`VST SCAN: ${res.plugins.length} plugin(s)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'VST scan failed.';
      if (isDesktopOnlyRefusal(e)) {
        // Scanned, and the answer is "none here". `scanned` is set so nothing
        // asks again in a loop, and no logError: this is the documented shape
        // of the browser build, not a fault the user can act on.
        set({ scanning: false, scanned: true, plugins: [], error: null, unavailableReason: msg });
        if (!desktopOnlyNoticeShown) {
          desktopOnlyNoticeShown = true;
          useStatusBarStore
            .getState()
            .setText(refusalNeedsPairing(msg) ? 'VST: pair this device' : 'VST: desktop app only');
        }
        return;
      }
      set({ scanning: false, error: msg, unavailableReason: null });
      useStatusBarStore.getState().setText(`VST SCAN FAILED: ${msg}`);
      logError('vst', msg);
    }
  },
}));
