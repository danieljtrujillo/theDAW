/**
 * The "no plugin windows" switch.
 *
 * A plugin's editor is a NATIVE window on the desktop of whoever is sitting at
 * the machine. Automated browser tests drive the real app, so they set this key
 * and the app then never asks anything to open one.
 *
 * It is enforced at the two lowest places a window can be requested from — the
 * live host's `open_editor` op (`VstBridgeClient.openEditor`) and the offline
 * sidecar's POST (`vstApi.openEditor`) — and nowhere above them. Everything the
 * user's click sets in motion therefore still runs for real under test (starting
 * the live session, waiting for it, choosing live over offline); only the final
 * "put a window on the screen" message is withheld, and each withheld request
 * logs one line so a test can tell WHICH editor the app tried to open.
 *
 * Off unless someone sets the key.
 */
export const NO_EDITOR_WINDOWS_KEY = 'thedaw.vst.noEditorWindows';

export function editorWindowsSuppressed(): boolean {
  try {
    return globalThis.localStorage?.getItem(NO_EDITOR_WINDOWS_KEY) === '1';
  } catch {
    return false; // storage unavailable: the app behaves normally
  }
}

/** The line a withheld LIVE editor request logs (`console.info`). */
export const LIVE_EDITOR_SUPPRESSED_LOG = '[vstLive] open_editor withheld: plugin windows are switched off (test mode)';
/** The line a withheld OFFLINE editor request logs (`console.info`). */
export const OFFLINE_EDITOR_SUPPRESSED_LOG = '[vst] offline editor withheld: plugin windows are switched off (test mode)';
