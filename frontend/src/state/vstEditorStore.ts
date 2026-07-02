/**
 * vstEditorStore - the ONE embedded native VST3 editor session, app-wide.
 *
 * The backend sidecar hosts a single editor window, so this store owns which
 * chain entry it is open for and which center tab opened it. open() replicates
 * MIX's original handleEditVst flow: dismiss any other embed, launch the real
 * native editor (embedded in Electron, floating in a plain browser), then poll
 * for the captured raw_state and hand it to the caller's sink so the dialed-in
 * sound lands on the right chain (MIX chain, EDIT track chain, or EDIT master
 * VST chain). Leaving the tab that opened the embed closes it, so the native
 * window never keeps floating over an unrelated workspace.
 */
import { create } from 'zustand';
import { useAppUiStore, type CenterTab } from './appUiStore';
import { useStatusBarStore } from './statusBarStore';
import { vstApi, getNativeWindowHandle } from '../lib/vstClient';
import type { ChainEntry } from './effectChainStore';

interface VstEditorState {
  /** Chain-entry id the editor session is open for; null = no session. */
  entryId: string | null;
  pluginPath: string | null;
  pluginName: string | null;
  /** Load failure for the current session, shown by VstEmbedHost instead of a
   *  forever "loading...". */
  error: string | null;
  /** The center tab that opened the embed; leaving it closes the session. */
  ownerTab: CenterTab | null;
  /** Open (or re-open) a VST entry's native GUI. sinkRawState receives the
   *  captured base64 plugin state once the editor commits it. */
  open: (entry: ChainEntry, sinkRawState: (entryId: string, rawState: string) => void) => void;
  close: () => void;
}

/** A launched editor session whose final raw_state has not been captured yet. */
interface SessionRecord {
  gen: number;
  entryId: string;
  pluginPath: string;
  sink: (entryId: string, rawState: string) => void;
}

// Monotonically increasing session generation. Every open() bumps it and each
// poll loop captures the value it started under; a poll whose generation is no
// longer current exits WITHOUT sinking, because the backend keys its result
// file by plugin_path only and the next open() resets that file to 'launching',
// so a stale poll could otherwise attribute one session's raw_state to another
// session's entry. close() deliberately does NOT bump the generation: the
// current session's poll loop must keep running after close so the state the
// sidecar writes when the native window closes still lands on the owning entry.
let sessionGen = 0;

// The most recently launched editor session whose result is still outstanding.
// Kept module-level (not in zustand state) because close() clears the visible
// session record while its poll loop keeps running; the NEXT open() drains this
// record before its own open-editor POST resets the path-keyed result file.
let uncaptured: SessionRecord | null = null;

/** True for statuses after which the sidecar will not write the result file
 *  again ('none' means no session or file exists for the path at all). */
const isTerminalStatus = (s: string) => s === 'ok' || s === 'error' || s === 'none';

/**
 * Close a previous session's native editor and wait briefly for its sidecar to
 * write the final state, sinking a captured 'ok' raw_state into the OLD entry.
 * The backend keys the editor result file by plugin_path only, so this must
 * complete BEFORE the next open-editor POST resets that file; otherwise the old
 * sidecar's late write would be attributed to the new session (and the new
 * session's own capture lost). Returns the captured raw_state so a reopen of
 * the same entry can seed the editor with it, or null when the old sidecar is
 * already gone or never commits, in which case it times out silently.
 */
async function drainSession(record: SessionRecord): Promise<string | null> {
  try {
    await vstApi.editorRect(record.pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
  } catch {
    return null; // backend unreachable; nothing left to drain
  }
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    try {
      const res = await vstApi.editorResult(record.pluginPath);
      if (isTerminalStatus(res.status)) {
        if (res.status === 'ok' && res.raw_state) {
          record.sink(record.entryId, res.raw_state);
          return res.raw_state;
        }
        return null;
      }
    } catch {
      // Transient fetch failure; keep waiting until the deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  }
  return null;
}

export const useVstEditorStore = create<VstEditorState>()((set, get) => ({
  entryId: null,
  pluginPath: null,
  pluginName: null,
  error: null,
  ownerTab: null,

  open: (entry, sinkRawState) => {
    if (!entry.vst) return;
    if (get().entryId === entry.id) return; // already open for this entry
    const path = entry.vst.plugin_path;
    const name = entry.vst.plugin_name;
    const rawState = entry.vst.raw_state;
    const status = useStatusBarStore.getState();
    // Capture the owning tab BEFORE any await: the user can switch tabs while
    // the open round-trip is in flight, and the session must belong to the tab
    // that started it or be closed when that tab is gone by launch time.
    const ownerTab = useAppUiStore.getState().centerTab;
    // Bump the generation so any previous poll loop retires without sinking;
    // the drain below captures the old session's final state instead.
    const gen = ++sessionGen;
    // Take ownership of the outstanding session (still recorded, or already
    // closed but not yet captured) so its final state drains into ITS entry.
    const prevRecord = uncaptured;
    uncaptured = null;
    // Clear any old session record up front so its embed host unmounts and
    // stops pushing rect updates that would overwrite the drain's close request.
    if (get().entryId) {
      set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null });
    }
    const clearEmbed = () => {
      if (get().entryId === entry.id) {
        set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null });
      }
    };
    void (async () => {
      // Drain the previous session before open-editor resets the shared result
      // file. When the drained editor belonged to THIS entry (close followed by
      // an immediate reopen), seed the new editor with the just-captured state
      // rather than the snapshot taken before the close.
      let openState = rawState;
      if (prevRecord) {
        const drained = await drainSession(prevRecord);
        if (drained && prevRecord.entryId === entry.id) openState = drained;
      }
      // In Electron, embed the editor inside the owning view; in a browser it
      // falls back to a floating native window (no parent handle available).
      const hwnd = await getNativeWindowHandle();
      const embed = hwnd
        ? { parentHwnd: hwnd, rect: { x: 0, y: 0, w: 480, h: 320, dpr: window.devicePixelRatio || 1 } }
        : undefined;
      try {
        await vstApi.openEditor(path, openState, embed);
        // The user may have switched tabs, or another open() may have
        // superseded this one, while the POST was in flight. A session that no
        // view hosts must be closed (the same editor-rect close the tab
        // subscription uses), not recorded.
        if (gen !== sessionGen || useAppUiStore.getState().centerTab !== ownerTab) {
          void vstApi.editorRect(path, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
          return;
        }
        // Record the session in BOTH modes (embedded and floating) so the
        // same-entry guard above debounces repeat clicks: without a record, a
        // plain browser would spawn a new sidecar process and poll loop on
        // every click of the same entry.
        set({ entryId: entry.id, pluginPath: path, pluginName: name, error: null, ownerTab });
        uncaptured = { gen, entryId: entry.id, pluginPath: path, sink: sinkRawState };
        status.setText(embed
          ? `VST GUI: ${name} embedding...`
          : `VST GUI: ${name} opened - close the window to save its settings`);
        const startedAt = performance.now();
        const poll = () => {
          // A newer open() owns the result file now; it drained this session,
          // so exiting without sinking loses nothing.
          if (gen !== sessionGen) return;
          vstApi.editorResult(path)
            .then((res) => {
              if (gen !== sessionGen) return;
              if (res.status === 'ok' && res.raw_state) {
                if (uncaptured?.gen === gen) uncaptured = null;
                sinkRawState(entry.id, res.raw_state);
                status.setText(`VST GUI: ${name} settings captured`);
                clearEmbed();
                return;
              }
              if (res.status === 'error') {
                if (uncaptured?.gen === gen) uncaptured = null;
                const msg = res.error || 'editor unavailable';
                status.setText(`VST GUI: ${msg}`);
                // Keep the host visible (Electron) so the failure is on-screen,
                // not just in the status bar; otherwise there is nothing to clear.
                if (get().entryId === entry.id) set({ error: msg });
                return;
              }
              if (performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500);
            })
            .catch(() => {
              if (gen === sessionGen && performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500);
            });
        };
        window.setTimeout(poll, 1500);
      } catch (e) {
        clearEmbed();
        status.setText(`VST GUI FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  },

  close: () => {
    const { pluginPath } = get();
    if (pluginPath) void vstApi.editorRect(pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
    // The session's poll loop keeps running on purpose: the sidecar writes the
    // final raw_state when the native window actually closes, and that
    // commit-on-close capture must still reach the owning entry.
    set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null });
  },
}));

// Leaving the tab that owns the embed closes it: the editor is a NATIVE OS
// window pinned over the web UI, so without this it would keep floating over
// whatever tab the user switched to.
useAppUiStore.subscribe((state, prevState) => {
  if (state.centerTab === prevState.centerTab) return;
  const s = useVstEditorStore.getState();
  if (s.entryId && s.ownerTab && state.centerTab !== s.ownerTab) s.close();
});
