/**
 * How a native VST3 editor opens: EMBEDDED in theDAW's panel, or FLOATING in
 * the plugin's own OS window.
 *
 * Embedding pins and clips the plugin's real window over the host panel, which
 * keeps the editor inside the app but cuts off anything the plugin draws
 * OUTSIDE that window — preset browsers, dropdowns and modal dialogs that many
 * plugins render as separate top-level windows. Floating gives up the in-app
 * placement and shows the plugin exactly as its vendor built it. Neither is
 * right for every plugin, so this is a per-plugin preference with an app-wide
 * default, remembered by absolute plugin path.
 *
 * View preferences only: they persist per browser in localStorage and are never
 * part of the project document or the undo history. Nothing here is sent
 * anywhere — the paths stay on this machine, exactly as the scan cache does.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';

/** Where the plugin's native editor window lives while it is open. */
export type VstEditorMode = 'embedded' | 'floating';

const MODES: readonly VstEditorMode[] = ['embedded', 'floating'];

/** Embedding is the default because it is what keeps the editor inside theDAW;
 *  a plugin whose extra windows get clipped is switched over per plugin. */
const DEFAULT_MODE: VstEditorMode = 'embedded';

export interface VstEditorPrefsData {
  /** Per-plugin overrides, keyed by the plugin's absolute path (the same key
   *  the scan and the chain entries use). Absent = follow `defaultMode`. */
  byPluginPath: Record<string, VstEditorMode>;
  /** The mode every plugin without an override opens in. */
  defaultMode: VstEditorMode;
}

export interface VstEditorPrefsState extends VstEditorPrefsData {
  /** The mode a plugin path opens in: its own override, else `defaultMode`.
   *  Total — any junk path answers `defaultMode` rather than throwing. */
  modeFor(pluginPath: string): VstEditorMode;
  setDefaultMode(mode: VstEditorMode): void;
  /** Remember `mode` for this exact plugin path. Ignores an empty/non-string
   *  path or an unknown mode, so a bad call cannot poison the map. */
  setModeForPlugin(pluginPath: string, mode: VstEditorMode): void;
  /** Drop a path's override so it follows `defaultMode` again. */
  clearModeForPlugin(pluginPath: string): void;
  /** Every field back to its default (a fresh, empty override map). */
  reset(): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isMode = (v: unknown): v is VstEditorMode =>
  typeof v === 'string' && (MODES as readonly string[]).includes(v);
const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function defaultData(): VstEditorPrefsData {
  return { byPluginPath: {}, defaultMode: DEFAULT_MODE };
}

/** Keep only `path -> mode` pairs that are both well-formed; anything else is
 *  dropped rather than allowed to decide where an editor opens. */
function sanitizeOverrides(raw: unknown): Record<string, VstEditorMode> {
  const out: Record<string, VstEditorMode> = {};
  if (!isRecord(raw)) return out;
  for (const [path, mode] of Object.entries(raw)) {
    if (isPath(path) && isMode(mode)) out[path] = mode;
  }
  return out;
}

/**
 * What a persisted blob becomes on hydrate (the store's `merge`) and on a
 * version change (its `migrate`). Every field is validated on its own; a wrong
 * type or unknown mode falls back to that field's default, and the override map
 * is rebuilt entry by entry so the live state never aliases the parsed blob.
 * Exported because zustand's own hydrate cannot be driven from a node test.
 */
export function sanitizeVstEditorPrefs<S extends VstEditorPrefsData>(
  persisted: unknown,
  current: S,
): S {
  const d = defaultData();
  const p = isRecord(persisted) ? persisted : {};
  return {
    ...current,
    byPluginPath: sanitizeOverrides(p.byPluginPath),
    defaultMode: isMode(p.defaultMode) ? p.defaultMode : d.defaultMode,
  };
}

export const useVstEditorPrefs = create<VstEditorPrefsState>()(
  persist(
    (set, get) => ({
      ...defaultData(),
      modeFor: (pluginPath) => {
        const s = get();
        if (!isPath(pluginPath)) return s.defaultMode;
        return s.byPluginPath[pluginPath] ?? s.defaultMode;
      },
      setDefaultMode: (mode) => {
        if (isMode(mode)) set({ defaultMode: mode });
      },
      setModeForPlugin: (pluginPath, mode) => {
        if (!isPath(pluginPath) || !isMode(mode)) return;
        set((s) => ({ byPluginPath: { ...s.byPluginPath, [pluginPath]: mode } }));
      },
      clearModeForPlugin: (pluginPath) => {
        if (!isPath(pluginPath)) return;
        set((s) => {
          if (!(pluginPath in s.byPluginPath)) return s; // no-op: keep the same map
          const next = { ...s.byPluginPath };
          delete next[pluginPath];
          return { byPluginPath: next };
        });
      },
      reset: () => set(defaultData()),
    }),
    {
      name: 'thedaw.vsteditorprefs.v1',
      version: 1,
      storage: persistStorage(),
      partialize: (s): VstEditorPrefsData => ({
        byPluginPath: s.byPluginPath,
        defaultMode: s.defaultMode,
      }),
      merge: (persisted, current) => sanitizeVstEditorPrefs(persisted, current),
      migrate: (persisted) => sanitizeVstEditorPrefs(persisted, defaultData()),
    },
  ),
);
