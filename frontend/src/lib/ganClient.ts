// Client for the .gan web-plugin backend (/api/plugin/*).
import { getJson, postJson } from './apiJson';

export interface GanControl {
  id: string;
  name: string;
  kind: string;
}

export interface GanPluginSummary {
  id: string;
  name: string;
  kind: string;
  description: string;
  controls: GanControl[];
  gan_path: string;
  entry_url: string;
}

export interface GanPackageResult {
  manifest: Record<string, unknown>;
  gan_path: string;
}

export interface GanOpenResult {
  manifest: Record<string, unknown>;
  entry_url: string;
}

export const ganApi = {
  /** List installed .gan plugins (data/plugins). */
  list: () => getJson<{ plugins: GanPluginSummary[] }>('/api/plugin/list'),
  /** Install + open a .gan at an arbitrary path; returns the entry URL to iframe. */
  open: (path: string) => postJson<GanOpenResult>('/api/plugin/open', { path }),
  /** Open an already-installed plugin by id. */
  openById: (id: string) => postJson<GanOpenResult>('/api/plugin/open', { id }),
  /** Import a VST Foundry export (project.json or its folder) into a .gan. */
  importOwl: (projectPath: string) =>
    postJson<{ manifest: Record<string, unknown>; gan_path: string; entry_url: string }>(
      '/api/plugin/import-owl',
      { project_path: projectPath },
    ),
  /** Build (or rebuild) the bundled "The Owl" sidecar .gan; returns its path. */
  packageOwl: () => postJson<GanPackageResult>('/api/plugin/package-owl'),
  /** Build (or rebuild) the bundled "Ares" control surface .gan; returns its path. */
  packageAres: () =>
    postJson<{ manifest: Record<string, unknown>; gan_path: string; entry_url: string }>(
      '/api/plugin/package-ares',
    ),
  /** Reveal a file in the OS file manager (Explorer/Finder), selecting it. */
  reveal: (path: string) => postJson<{ status: string; path: string }>('/api/plugin/reveal', { path }),
};
