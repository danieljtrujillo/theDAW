// Typed client for the VST3 hosting backend (/api/vst/*).
// MIX consumes VSTs as effect-chain nodes: it scans for plugins here, and the
// per-stage processing is an UPLOAD POST to /api/vst/process-file driven from
// studioStore (mirroring /api/studio/process), so no other client calls are
// needed here.
import { getJson, postJson } from './apiJson';

export interface Vst3PluginInfo {
  name: string;
  path: string;
  manufacturer: string;
  version: string;
  category: string; // "effect" | "instrument" | "unknown"
  file_size_mb: number;
  last_modified: number;
}

// Result of a native-GUI editor session (see /api/vst/open-editor). When status
// is 'ok', raw_state is the base64 plugin state to store on the chain node.
export interface VstEditorResult {
  status: 'none' | 'launching' | 'opening' | 'ok' | 'error';
  raw_state?: string;
  error?: string;
  plugin_path?: string;
}

// Embed rect for reparenting the editor into the MIX area (CSS px + DPR).
export interface VstEmbedRect { x: number; y: number; w: number; h: number; dpr: number; }

type ElectronEmbedApi = {
  getNativeWindowHandle?: () => Promise<string | null>;
  getContentBounds?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
};

// Electron exposes the host window handle via the preload bridge; null in a
// plain browser (the editor then opens as a floating native window).
export async function getNativeWindowHandle(): Promise<string | null> {
  const api = (window as unknown as { electronAPI?: ElectronEmbedApi }).electronAPI;
  if (!api?.getNativeWindowHandle) return null;
  try {
    return await api.getNativeWindowHandle();
  } catch {
    return null;
  }
}

// Screen-space content bounds (DIP) of the Electron window, for converting an
// element's client rect into absolute screen coordinates.
export async function getContentBounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const api = (window as unknown as { electronAPI?: ElectronEmbedApi }).electronAPI;
  if (!api?.getContentBounds) return null;
  try {
    return await api.getContentBounds();
  } catch {
    return null;
  }
}

export const vstApi = {
  scan: (refresh = false) =>
    getJson<{ plugins: Vst3PluginInfo[] }>(`/api/vst/scan?refresh=${refresh ? 'true' : 'false'}`),
  // Open the plugin's real native editor window (sidecar process). Pass the
  // node's current raw_state so the editor opens where the user left off. When
  // `embed` is given (Electron), the editor is reparented into the MIX area over
  // its rect; otherwise it opens as a floating window.
  openEditor: (
    pluginPath: string,
    rawState?: string | null,
    embed?: { parentHwnd: string; rect: VstEmbedRect },
  ) =>
    postJson<{ status: string; preset_path: string }>('/api/vst/open-editor', {
      plugin_path: pluginPath,
      raw_state: rawState ?? null,
      parent_hwnd: embed?.parentHwnd ?? null,
      rect: embed?.rect ?? null,
    }),
  // Push a live embed-rect update (viewport + scroll offset), or close the
  // embedded editor (close=true). sx/sy let an oversized editor pan as the host
  // scrolls. All values are physical px.
  editorRect: (
    pluginPath: string,
    rect: VstEmbedRect & { sx?: number; sy?: number; close?: boolean },
  ) =>
    postJson<{ status: string }>('/api/vst/editor-rect', { plugin_path: pluginPath, ...rect }),
  editorResult: (pluginPath: string) =>
    getJson<VstEditorResult>(`/api/vst/editor-result?plugin_path=${encodeURIComponent(pluginPath)}`),
  // The editor's natural (physical px) size, so the host can size its scroll area.
  editorSize: (pluginPath: string) =>
    getJson<{ status: string; w?: number; h?: number }>(`/api/vst/editor-size?plugin_path=${encodeURIComponent(pluginPath)}`),
};
