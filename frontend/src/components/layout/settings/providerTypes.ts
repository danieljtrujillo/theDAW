/**
 * Provider-card payload extensions (GET /api/storage/model-status).
 *
 * `ModelProviderStatus` in lib/storageClient.ts is the shared base; the
 * Magenta and Lyria providers add machine-readable extras so the card can
 * offer the right fix without parsing prose. These intersections type them
 * where they are consumed (the Settings cards) until storageClient grows the
 * optional fields itself.
 */
import type { ModelOptionStatus, ModelProviderStatus } from '../../../lib/storageClient';
import type { MagentaCheckpointJob, MagentaEngineState, MagentaRunnable } from '../../../lib/magentaEngineClient';

export interface MagentaProviderExtras {
  active_model: string;
  running_model: string | null;
  restart_required: boolean;
  installable: boolean;
  gpu: { gpus: Array<{ name: string; vram_gb: number }>; best_vram_gb: number | null };
  engine_status?: string | null;
}

export interface LyriaInstallState {
  status: 'idle' | 'cloning' | 'installing' | 'done' | 'error' | string;
  step?: string | null;
  message?: string;
  error?: string | null;
  log_path?: string;
}

/** Where the FIRST key of a provider comes from. */
export type LyriaKeySource = 'env' | 'file' | 'pool' | 'none' | string;

/** gemini | openrouter, or null for "let Lyria decide". */
export type LyriaProvider = 'gemini' | 'openrouter';

export interface LyriaProviderExtras {
  /** Absent pieces by id: project | deps | git | node | key. `key` means BOTH
   *  providers are empty — either one on its own can generate. */
  missing: string[];
  installable: boolean;
  installing: boolean;
  install: LyriaInstallState;
  gemini_key: boolean;
  gemini_key_source: LyriaKeySource;
  openrouter_key?: boolean;
  openrouter_key_source?: LyriaKeySource;
  /** How many keys theDAW holds for the sidecar per provider (counts, never
   *  values). A checkout with server/keys.ts gets up to ten and skips a
   *  rejected one; an older checkout gets the first only. */
  gemini_keys?: number;
  openrouter_keys?: number;
  /** The provider the user pinned for the child, null for "let Lyria decide". */
  provider_preference?: LyriaProvider | null;
  mock: boolean;
  project_path: string;
  repo: string;
  repo_url: string;
  git: boolean;
  node: boolean;
  npm: boolean;
  listening: boolean;
}

export type ModelOption = ModelOptionStatus & {
  installed?: boolean;
  runnable?: MagentaRunnable;
  checkpoint?: string;
  download?: MagentaCheckpointJob | null;
};

export type ProviderStatus = Omit<ModelProviderStatus, 'models'> & {
  models?: ModelOption[];
  engine_state?: MagentaEngineState;
  magenta?: MagentaProviderExtras;
  lyria?: LyriaProviderExtras;
};
