import { create } from 'zustand';
import {
  canImport,
  dawApi,
  hasHint,
  type DawDetect,
  type DawExportHint,
  type DawProject,
} from '../lib/dawImportClient';
import { dawProjectToTasmo, projectApi } from '../lib/projectClient';
import { loadProjectIntoEditor } from '../lib/projectImport';
import { useProjectStore } from './projectStore';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

interface DawImportState {
  isOpen: boolean;
  sourcePath: string;
  detected: DawDetect | null;
  project: DawProject | null;
  hint: DawExportHint | null;
  busy: boolean;
  error: string | null;

  open: () => void;
  close: () => void;
  setSourcePath: (path: string) => void;
  detectAndImport: () => Promise<void>;
  /** Convert the parsed project, autosave an embedded .tasmo to the default
   *  projects folder, then load it straight onto the EDIT timeline. */
  loadIntoEditor: () => Promise<void>;
  reset: () => void;
}

const status = (text: string) => useStatusBarStore.getState().setText(text);

export const useDawImportStore = create<DawImportState>()((set, get) => ({
  isOpen: false,
  sourcePath: '',
  detected: null,
  project: null,
  hint: null,
  busy: false,
  error: null,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setSourcePath: (path) => set({ sourcePath: path, error: null }),

  detectAndImport: async () => {
    const path = get().sourcePath.trim();
    if (!path) {
      set({ error: 'Choose a DAW project file first.' });
      return;
    }
    set({ busy: true, error: null, project: null, hint: null, detected: null });
    try {
      logInfo('dawimport', `POST /api/dawimport/detect — ${path}`);
      const detected = await dawApi.detect(path);
      set({ detected });

      if (canImport(detected.daw)) {
        const project = await dawApi.import(detected.daw, path);
        set({ project, busy: false });
        status(`IMPORTED ${detected.daw.toUpperCase()}: ${project.tracks.length} track(s)`);
      } else if (hasHint(detected.daw)) {
        const hint = await dawApi.hint(detected.daw);
        set({ hint, busy: false });
        status(`${detected.daw.toUpperCase()}: export-to-audio required`);
      } else {
        set({ busy: false, error: `Unsupported project type: ${detected.format || 'unknown'}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import failed.';
      set({ busy: false, error: msg });
      status(`IMPORT FAILED: ${msg}`);
      logError('dawimport', msg);
    }
  },

  loadIntoEditor: async () => {
    const project = get().project;
    if (!project) return;
    set({ busy: true, error: null });
    try {
      const tasmo = dawProjectToTasmo(project);
      // Autosave under the default projects folder, embedding the on-disk sample
      // files so the .tasmo is portable. Then reload it (extracts + relinks the
      // embedded audio) and materialize it onto the EDIT timeline.
      const ps = useProjectStore.getState();
      await ps.ensureDefaultDir();
      const dir = useProjectStore.getState().defaultDir.trim();
      const safe =
        (project.name || 'imported').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'imported';
      const sep = dir.includes('\\') ? '\\' : '/';
      const base = dir ? (dir.endsWith(sep) ? dir : dir + sep) : '';
      const savePath = `${base}${safe}.tasmo`;

      logInfo('dawimport', `Autosaving import (embed) -> ${savePath}`);
      const saved = await projectApi.save(tasmo, savePath, true);
      const loaded = await projectApi.load(saved.path);
      const summary = await loadProjectIntoEditor(loaded.project);
      void useProjectStore.getState().refreshRecent();

      set({ busy: false, isOpen: false });
      status(
        `IMPORTED -> theDAW: ${summary.tracks} track(s), ${summary.clips} clip(s)` +
          (summary.skipped ? `, ${summary.skipped} skipped` : '') +
          (summary.effects
            ? `, ${summary.effects} fx (${summary.effectsLive} live)`
            : '') +
          ` — saved ${saved.path}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import into theDAW failed.';
      set({ busy: false, error: msg });
      status(`IMPORT FAILED: ${msg}`);
      logError('dawimport', msg);
    }
  },

  reset: () =>
    set({ sourcePath: '', detected: null, project: null, hint: null, error: null, busy: false }),
}));
