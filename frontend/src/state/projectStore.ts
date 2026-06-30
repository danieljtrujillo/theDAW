import { create } from 'zustand';
import {
  projectApi,
  type ProjectManifest,
  type RecentItem,
  type TasmoProjectInput,
  type TasmoProjectLoaded,
  type TasmoTrackInput,
} from '../lib/projectClient';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';
import { loadProjectIntoEditor, captureEditorSession } from '../lib/projectImport';

type ProjectTab = 'save' | 'open';

interface ProjectState {
  isOpen: boolean;
  tab: ProjectTab;
  busy: boolean;
  error: string | null;
  recent: RecentItem[];

  // Save form
  projectName: string;
  tempo: number;
  embedAudio: boolean;
  savePath: string;
  pendingTracks: TasmoTrackInput[];
  sourceDaw: string | null;
  importWarnings: string[];
  lastSaved: { path: string; manifest: ProjectManifest } | null;

  // Open form
  openPath: string;
  loaded: { project: TasmoProjectLoaded; manifest: ProjectManifest } | null;

  // Default folder for .tasmo saves (changeable; persisted in localStorage).
  defaultDir: string;

  open: (tab?: ProjectTab, seed?: TasmoProjectInput) => void;
  close: () => void;
  setTab: (tab: ProjectTab) => void;
  setProjectName: (name: string) => void;
  setTempo: (tempo: number) => void;
  setEmbedAudio: (embed: boolean) => void;
  setSavePath: (path: string) => void;
  setOpenPath: (path: string) => void;
  setDefaultDir: (dir: string) => void;
  ensureDefaultDir: () => Promise<void>;
  prefillSavePath: () => Promise<void>;
  refreshRecent: () => Promise<void>;
  save: () => Promise<void>;
  loadPath: (path?: string) => Promise<void>;
  clearError: () => void;
}

const PROJECTS_DIR_KEY = 'thedaw-projects-dir';
const readDefaultDir = (): string => {
  try {
    return localStorage.getItem(PROJECTS_DIR_KEY) || '';
  } catch {
    return '';
  }
};

const status = (text: string) => useStatusBarStore.getState().setText(text);

export const useProjectStore = create<ProjectState>()((set, get) => ({
  isOpen: false,
  tab: 'save',
  busy: false,
  error: null,
  recent: [],

  projectName: 'Untitled',
  tempo: 120,
  embedAudio: false,
  savePath: '',
  pendingTracks: [],
  sourceDaw: null,
  importWarnings: [],
  lastSaved: null,

  openPath: '',
  loaded: null,

  defaultDir: readDefaultDir(),

  open: (tab = 'save', seed) => {
    if (seed) {
      set({
        projectName: seed.project_name || 'Untitled',
        tempo: seed.tempo ?? 120,
        pendingTracks: seed.tracks ?? [],
        sourceDaw: seed.source_daw ?? null,
        importWarnings: seed.import_warnings ?? [],
        lastSaved: null,
      });
    }
    set({ isOpen: true, tab, error: null });
    void get().refreshRecent();
    if (tab === 'save') void get().prefillSavePath();
  },

  close: () => set({ isOpen: false }),
  setTab: (tab) => {
    set({ tab, error: null });
    if (tab === 'save') void get().prefillSavePath();
  },
  setProjectName: (projectName) => set({ projectName }),
  setTempo: (tempo) => set({ tempo: Number.isFinite(tempo) ? tempo : 120 }),
  setEmbedAudio: (embedAudio) => set({ embedAudio }),
  setSavePath: (savePath) => set({ savePath, error: null }),
  setOpenPath: (openPath) => set({ openPath, error: null }),

  setDefaultDir: (defaultDir) => {
    try {
      localStorage.setItem(PROJECTS_DIR_KEY, defaultDir);
    } catch {
      /* ignore — non-persistent fallback */
    }
    set({ defaultDir });
  },

  ensureDefaultDir: async () => {
    if (get().defaultDir.trim()) return;
    try {
      const res = await projectApi.defaultDir();
      if (res?.path && !get().defaultDir.trim()) get().setDefaultDir(res.path);
    } catch {
      /* no backend default available */
    }
  },

  // Prefill the save path from the default folder + project name, so the user can
  // hit Save without browsing (and still change it). No-op if a path is set.
  prefillSavePath: async () => {
    if (get().savePath.trim()) return;
    await get().ensureDefaultDir();
    const dir = get().defaultDir.trim();
    if (!dir || get().savePath.trim()) return;
    const name =
      (get().projectName || 'project').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'project';
    const sep = dir.includes('\\') ? '\\' : '/';
    const base = dir.endsWith(sep) ? dir : dir + sep;
    set({ savePath: `${base}${name}.tasmo` });
  },

  refreshRecent: async () => {
    try {
      const recent = await projectApi.recent();
      set({ recent });
    } catch (e) {
      logError('project', e instanceof Error ? e.message : 'Failed to list recent projects.');
    }
  },

  save: async () => {
    const { projectName, tempo, embedAudio, savePath, pendingTracks, sourceDaw, importWarnings } =
      get();
    if (!savePath.trim()) {
      set({ error: 'Choose where to save the .tasmo file.' });
      return;
    }
    const name = projectName.trim() || 'Untitled';
    const path = savePath.trim();
    set({ busy: true, error: null });
    try {
      // Two distinct save paths:
      //  - An imported DAW project (pendingTracks seeded): save that structure,
      //    linking/embedding the sample files already on disk.
      //  - Otherwise: capture the LIVE EDIT session, embedding each clip's audio
      //    bytes (editor clips are in-memory blobs with no path to link).
      let res: { path: string; manifest: ProjectManifest };
      if (pendingTracks.length > 0) {
        const project: TasmoProjectInput = {
          project_name: name,
          tempo,
          tracks: pendingTracks,
          source_daw: sourceDaw,
          import_warnings: importWarnings,
        };
        logInfo('project', `POST /api/project/save — ${path} embed=${embedAudio}`);
        res = await projectApi.save(project, path, embedAudio);
      } else {
        const session = captureEditorSession();
        if (session.clipCount === 0) {
          set({
            busy: false,
            error:
              'Nothing to save yet — the EDIT timeline is empty. Generate, import, or record audio first.',
          });
          status('PROJECT SAVE SKIPPED: timeline is empty');
          return;
        }
        const project: TasmoProjectInput = {
          project_name: name,
          tempo: session.bpm,
          tracks: session.tracks,
        };
        logInfo(
          'project',
          `POST /api/project/save-session — ${path} (${session.tracks.length} tracks, ${session.clipCount} clips embedded)`,
        );
        res = await projectApi.saveSession(project, path, session.files);
      }
      set({ busy: false, lastSaved: { path: res.path, manifest: res.manifest } });
      status(`PROJECT SAVED (${res.manifest.audio_mode}): ${res.path}`);
      void get().refreshRecent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed.';
      set({ busy: false, error: msg });
      status(`PROJECT SAVE FAILED: ${msg}`);
      logError('project', msg);
    }
  },

  loadPath: async (path) => {
    const target = (path ?? get().openPath).trim();
    if (!target) {
      set({ error: 'Choose a .tasmo file to open.' });
      return;
    }
    set({ busy: true, error: null, openPath: target });
    try {
      logInfo('project', `POST /api/project/load — ${target}`);
      const res = await projectApi.load(target);
      set({ loaded: res });
      // Actually bring the project into theDAW: build tracks + clips on the EDIT
      // timeline (this is what "Open" must do — a preview alone isn't opening it).
      // The helper also switches the center view to EDIT.
      const summary = await loadProjectIntoEditor(res.project);
      const skippedNote = summary.skipped
        ? ` (${summary.skipped} clip(s) skipped — missing audio or empty MIDI)`
        : '';
      // The project is now open in theDAW; close the modal and report via the
      // status bar + log (a warning there stays visible after the modal closes).
      set({ busy: false, isOpen: false, error: null });
      status(
        `PROJECT OPENED: ${res.project.project_name} — ${summary.tracks} track(s), ${summary.clips} clip(s)${skippedNote}`,
      );
      void get().refreshRecent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Open failed.';
      set({ busy: false, error: msg });
      status(`PROJECT OPEN FAILED: ${msg}`);
      logError('project', msg);
    }
  },

  clearError: () => set({ error: null }),
}));
