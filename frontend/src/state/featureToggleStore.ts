/**
 * Feature toggle store — mirrors the backend `/api/settings` payload.
 *
 * Backend is authoritative (it persists to data/settings.json and the
 * background workers read from it). The frontend keeps a local zustand-
 * persist mirror so toggles read instantly from cache and survive a
 * reload before the first /api/settings round-trip resolves.
 *
 * Write flow: any user-facing toggle calls `patch({...})` which (a)
 * optimistically updates the local store and (b) PATCHes the backend.
 * If the PATCH fails the optimistic value is ROLLED BACK — the toggle
 * visibly flips back — `error` names the reason, and an error notice with a
 * Retry button is raised, so a toggle can never look saved while the backend
 * never heard about it.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';
import type { DeviceRef } from '../lib/ioResolve';
import { dismissFeatureGate, requireFeature } from '../notices/featureGateStore';
import { logError } from './logStore';

export interface AnalysisSettings {
  auto_on_import: boolean;
  auto_on_generate: boolean;
  include_genre: boolean;
  include_key: boolean;
}

export interface StemsSettings {
  auto_on_import: boolean;
  auto_on_generate: boolean;
  default_count: number;
  /** 'cuda' | 'cpu' | 'auto'. Default 'cuda' — demucs on CPU is glacial. */
  device: string;
  /** 'fast' | 'balanced' | 'hq'. Default 'balanced' — sidecar's old
   *  default of 'hq' (overlap=0.9, shifts=10) routinely takes 10+ min
   *  per track and stalls at single percent points. */
  quality: string;
}

export interface MidiSettings {
  auto_on_import: boolean;
  auto_on_generate: boolean;
  from_stems: boolean;
}

export interface IdleSettings {
  min_idle_seconds: number;
  respect_vram_pressure: boolean;
}

export interface VjSettings {
  /** Root folder for VJ recording exports. Relative paths resolve
   *  against the backend project root; absolute paths are used as-is.
   *  Each take also lands in a per-export subfolder named in the VJ bar. */
  export_root: string;
}

export interface AppSettings {
  /** How theDAW opens on the next launch: 'web' (browser) | 'desktop' (Electron).
   *  Read by theDAW.bat before it starts anything. */
  launch_mode: string;
}

export interface NotationSettings {
  /** Global artist/composer name, stamped on every generated sheet + appended
   *  to song titles. Defaults to GANTASMO. */
  artist: string;
  /** Path to the MuseScore executable the user pointed theDAW at (Settings →
   *  artist popover → MuseScore, or the SCORE tab's LOCATE MUSESCORE…). Empty
   *  = the backend auto-detects (PATH, then the standard install folders).
   *  MuseScore engraves PDF/SVG when the headless OSMD renderer (node) is
   *  missing. */
  musescore_path: string;
}

/** Which MIDI input ports are let through. 'all' = every port, including one
 *  plugged in after the choice was made. */
export interface MidiInputSelection {
  mode: string;
  ports: DeviceRef[];
}

/**
 * Global input/output device choices + per-surface overrides.
 *
 * Every slot is a {id,label} pair, never a bare deviceId: ids are salted per
 * origin and rotate when site data is cleared, and the same user opens theDAW
 * both as a browser tab and as the desktop app. The label is the recovery key
 * (see lib/ioResolve). Empty id AND label = "the system default".
 *
 * `overrides` is keyed by surface id (state/ioSurfaces). A surface with NO
 * entry follows its global slot; an entry of {id:'',label:''} means "the OS
 * default, ignoring the global".
 *
 * Every value here is replaced WHOLESALE by the backend's patch() — it does not
 * deep-merge — so a writer must always send the complete object.
 */
export interface IoSettings {
  audio_output: DeviceRef;
  cue_output: DeviceRef;
  audio_input: DeviceRef;
  midi_inputs: MidiInputSelection;
  midi_output: DeviceRef;
  visual_display: DeviceRef;
  overrides: Record<string, DeviceRef>;
}

/** Local model discovery. `extra_folders` are additional directories theDAW
 *  scans for model checkpoints, on top of its built-in locations. Absolute or
 *  project-relative paths; order is preserved; no fixed count. Replaced
 *  wholesale by a patch (like `io`), never element-merged. */
export interface ModelsSettings {
  extra_folders: string[];
  /** Blanked for the same reason as `media_roots_redacted`. */
  extra_folders_redacted?: boolean;
}

/** Library storage. `media_roots` are folders holding the user's own copies
 *  of library media, named after the entry they belong to (the full id, or the
 *  `[xxxxxxxx]` short tag). The backend resolves an entry that has no file of
 *  its own from these before it asks any remote source. Replaced wholesale by
 *  a patch, like `models.extra_folders`. */
export interface LibrarySettings {
  media_roots: string[];
  /** The backend blanked the list because this caller may not set it (a LAN
   *  device, not the machine theDAW runs on -- see settings/router.py's
   *  `_redacted_for`). Absent means the list is the real one. */
  media_roots_redacted?: boolean;
}

/** The in-app Claude Code session's setup (backend settings `assistant`). */
export interface AssistantSettings {
  /** "Use my Claude settings and MCP servers". True (the default): the session
   *  loads the user's own ~/.claude settings, CLAUDE.md, skills, agents and MCP
   *  servers next to theDAW's relay, and the user's own allow rules approve
   *  what they match, except in Read-only mode and for edits to the
   *  assistant's own code. False: only this project's settings and theDAW's
   *  own MCP servers. The backend reads it on every turn and respawns the
   *  session when it changes. */
  use_user_claude_config: boolean;
  /** Loaded Claude allow rules that run without a prompt in Ask mode. In Ask
   *  mode every other loaded allow rule asks first (AllowRulesList). Exact
   *  rule strings as the settings files spell them. */
  always_allow_rules: string[];
}

export interface FeatureSettings {
  schema_version: number;
  app: AppSettings;
  analysis: AnalysisSettings;
  stems: StemsSettings;
  midi: MidiSettings;
  idle: IdleSettings;
  vj: VjSettings;
  notation: NotationSettings;
  io: IoSettings;
  models: ModelsSettings;
  library: LibrarySettings;
  assistant: AssistantSettings;
}

export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  schema_version: 1,
  app: {
    launch_mode: 'web',
  },
  analysis: {
    auto_on_import: false,
    auto_on_generate: false,
    include_genre: false,
    include_key: true,
  },
  stems: {
    auto_on_import: false,
    auto_on_generate: false,
    default_count: 4,
    device: 'cuda',
    quality: 'balanced',
  },
  midi: {
    auto_on_import: false,
    auto_on_generate: false,
    from_stems: true,
  },
  idle: {
    min_idle_seconds: 30,
    respect_vram_pressure: true,
  },
  vj: {
    export_root: 'exports/vj',
  },
  notation: {
    artist: 'GANTASMO',
    musescore_path: '',
  },
  io: {
    audio_output: { id: '', label: '' },
    cue_output: { id: '', label: '' },
    audio_input: { id: '', label: '' },
    midi_inputs: { mode: 'all', ports: [] },
    midi_output: { id: '', label: '' },
    visual_display: { id: '', label: '' },
    overrides: {},
  },
  models: {
    extra_folders: [],
  },
  library: {
    media_roots: [],
  },
  assistant: {
    use_user_claude_config: true,
    always_allow_rules: [],
  },
};

interface FeatureToggleState {
  settings: FeatureSettings;
  loaded: boolean;
  loading: boolean;
  /** Last load/save failure, human-readable. Cleared by the next success. */
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Save a partial change. Resolves true when the backend confirmed it,
   * false when it was rolled back (the reason is in `error` and on the
   * notice card). Never throws.
   */
  patch: (partial: FeatureSettingsPatch) => Promise<boolean>;
  clearError: () => void;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * `io` is deliberately NOT deep-partial: the backend store assigns a
 * dict-valued key wholesale, so half an `audio_output` would REPLACE the whole
 * slot and drop the label. Writers send complete slot objects; the io store's
 * helpers are what build them.
 */
export type FeatureSettingsPatch = DeepPartial<Omit<FeatureSettings, 'io' | 'models' | 'library'>> & {
  io?: Partial<IoSettings>;
  // `models.extra_folders` is a list assigned wholesale, so it is kept out of
  // DeepPartial (which would fragment the array into partial index keys) and
  // sent as a complete array, mirroring the backend's replace semantics.
  models?: Partial<ModelsSettings>;
  // `library.media_roots` is a list assigned wholesale for the same reason.
  library?: Partial<LibrarySettings>;
};

function mergeSettings(base: FeatureSettings, patch: FeatureSettingsPatch): FeatureSettings {
  const next: FeatureSettings = {
    ...base,
    app: { ...DEFAULT_FEATURE_SETTINGS.app, ...(base.app ?? {}), ...(patch.app ?? {}) },
    analysis: { ...base.analysis, ...(patch.analysis ?? {}) },
    stems: { ...base.stems, ...(patch.stems ?? {}) },
    midi: { ...base.midi, ...(patch.midi ?? {}) },
    idle: { ...base.idle, ...(patch.idle ?? {}) },
    vj: { ...base.vj, ...(patch.vj ?? {}) },
    notation: { ...DEFAULT_FEATURE_SETTINGS.notation, ...(base.notation ?? {}), ...(patch.notation ?? {}) },
    // ONE level only, on purpose: it mirrors the backend's wholesale-replace
    // semantics. Deep-merging here would make a deleted per-surface override
    // resurrect itself on the next patch.
    io: { ...DEFAULT_FEATURE_SETTINGS.io, ...(base.io ?? {}), ...(patch.io ?? {}) },
    // Wholesale replace, and tolerant of the key being absent from the server
    // payload (older backend / T01 not yet merged) — falls back to [].
    models: { ...DEFAULT_FEATURE_SETTINGS.models, ...(base.models ?? {}), ...(patch.models ?? {}) },
    // Same wholesale-replace rule, same tolerance for an older backend that
    // does not send the section at all.
    library: { ...DEFAULT_FEATURE_SETTINGS.library, ...(base.library ?? {}), ...(patch.library ?? {}) },
    // Tolerant of a backend (or a persisted mirror) that predates the section:
    // the switch then reads as its default, ON.
    assistant: { ...DEFAULT_FEATURE_SETTINGS.assistant, ...(base.assistant ?? {}), ...(patch.assistant ?? {}) },
  };
  if (patch.schema_version != null) next.schema_version = patch.schema_version;
  return next;
}

/** "stems.auto_on_import = on" — what the failed save was, for the notice. */
function describePatch(partial: FeatureSettingsPatch): string {
  const parts: string[] = [];
  for (const [section, values] of Object.entries(partial)) {
    if (!values || typeof values !== 'object') continue;
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      const shown =
        typeof value === 'boolean'
          ? value
            ? 'on'
            : 'off'
          : value && typeof value === 'object'
            ? // Device slots are {id,label}; the label is the half a person
              // reads. Anything else nested (overrides, midi_inputs) just says
              // it changed rather than printing [object Object].
              typeof (value as { label?: unknown }).label === 'string'
              ? (value as { label: string }).label || 'system default'
              : 'updated'
            : String(value);
      parts.push(`${section}.${key} = ${shown}`);
    }
  }
  return parts.join(', ') || 'setting';
}

const PATCH_NOTICE_ID = 'settings:patch';

/** The last sentence of a "Setting not saved" notice, by how far the PATCH got. */
const PATCH_OUTCOME_TEXT = {
  unsent: 'The backend never received it.',
  refused: 'The backend refused it.',
  unreadable: 'The backend answered, but its reply could not be read.',
} as const;

export const useFeatureToggleStore = create<FeatureToggleState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_FEATURE_SETTINGS,
      loaded: false,
      loading: false,
      error: null,

      refresh: async () => {
        if (get().loading) return;
        set({ loading: true, error: null });
        try {
          const res = await fetch('/api/settings');
          if (!res.ok) throw new Error(`GET /api/settings → ${res.status}`);
          const payload = (await res.json()) as FeatureSettings;
          set({
            settings: mergeSettings(DEFAULT_FEATURE_SETTINGS, payload),
            loaded: true,
            loading: false,
          });
        } catch (e) {
          set({ loading: false, error: e instanceof Error ? e.message : String(e) });
        }
      },

      patch: async (partial) => {
        const previous = get().settings;
        const optimistic = mergeSettings(previous, partial);
        set({ settings: optimistic });
        // How far the request got, so the notice says what really happened:
        // a LAN device's 403 reached the backend and was refused there.
        let outcome: 'unsent' | 'refused' | 'unreadable' = 'unsent';
        try {
          const res = await fetch('/api/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(partial),
          });
          if (!res.ok) {
            outcome = 'refused';
            let reason = `HTTP ${res.status}`;
            try {
              const body = (await res.json()) as { detail?: unknown };
              if (typeof body?.detail === 'string') reason = body.detail;
            } catch {
              /* non-JSON error body */
            }
            throw new Error(`PATCH /api/settings → ${reason}`);
          }
          outcome = 'unreadable';
          const payload = (await res.json()) as FeatureSettings;
          set({ settings: mergeSettings(DEFAULT_FEATURE_SETTINGS, payload), loaded: true, error: null });
          dismissFeatureGate(PATCH_NOTICE_ID);
          return true;
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          const what = describePatch(partial);
          // Roll the optimistic value back so the control shows the truth,
          // then say why where the user is looking.
          set({ settings: previous, error: `${what} was not saved: ${reason}` });
          logError('settings', `${what} was not saved (${reason}); reverted.`);
          requireFeature({
            id: PATCH_NOTICE_ID,
            kind: 'error',
            title: 'Setting not saved',
            message: `${what} was reverted — ${reason}. ${PATCH_OUTCOME_TEXT[outcome]}`,
            action: {
              label: 'Retry',
              run: async () => {
                if (!(await get().patch(partial))) throw new Error(reason);
              },
            },
          });
          return false;
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'thedaw-feature-settings',
      storage: persistStorage(),
      partialize: (s) => ({ settings: s.settings }),
      // A mirror saved by an older build lacks the sections added since (the
      // `assistant` switch, the folder lists); fill them from the defaults so
      // a reader never finds a section missing before the first refresh.
      merge: (persisted, current) => {
        const saved = (persisted as { settings?: FeatureSettingsPatch } | undefined)?.settings;
        return saved && typeof saved === 'object'
          ? { ...current, settings: mergeSettings(DEFAULT_FEATURE_SETTINGS, saved) }
          : current;
      },
    },
  ),
);
