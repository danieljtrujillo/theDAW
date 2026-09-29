import { create } from 'zustand';
import {
  projectApi,
  type ProjectManifest,
  type RecentItem,
  type TasmoProjectInput,
  type TasmoProjectLoaded,
  type TasmoTrackInput,
} from '../lib/projectClient';
import { placesApi } from '../lib/placesClient';
import { decideProjectsDir, looksAbsolute, type BackendProjectsDir } from '../lib/projectsDirSync';
import { mergeRecentProjects } from '../lib/recentProjects';
import type { PerformRoutingSnapshot } from './performRouting';
import { logError, logInfo, logWarn } from './logStore';
import { useStatusBarStore } from './statusBarStore';
import { useEditorStore } from './editorStore';
import { meterToTasmo } from '../lib/timeSignatureIO';
import {
  loadProjectIntoEditor,
  captureEditorSession,
  captureProjectDocument,
} from '../lib/projectImport';
import { captureLiveVstStates } from './vstEditorStore';

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
  /** The payload a seeded open (PERFORM's Save as .tasmo) handed over, kept
   *  whole so a save writes every field it carries (the scene names, the tempo
   *  and meter maps). Null when the dialog was opened without a seed. */
  pendingProject: TasmoProjectInput | null;
  pendingTracks: TasmoTrackInput[];
  /** Meter of a seeded (imported) project, carried through so saving it does
   *  not drop the source's time signature. Null when nothing seeded one. */
  pendingTimeSignature: number[] | null;
  sourceDaw: string | null;
  importWarnings: string[];
  // Perform-tab routing carried from a Perform save seed, so save() persists it
  // into the .tasmo alongside the imported project structure.
  pendingPerformRouting: PerformRoutingSnapshot | null;
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
// Set once this browser's folder has reached the backend, or the backend's
// folder has replaced it. From then on the backend's projects folder is the one
// every client and asset install uses.
const PROJECTS_DIR_SYNCED_KEY = 'thedaw-projects-dir-synced';

const readLocal = (key: string): string => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};

const writeLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore — non-persistent fallback */
  }
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The parts of a save payload beside its tracks and its time: the mix buses,
 *  the markers, the loop, the master chains, the automation, the controller
 *  mappings, the roll voice and the tuning. */
type ProjectDocument = Pick<
  TasmoProjectInput,
  | 'buses'
  | 'locators'
  | 'loop'
  | 'master_fx_chain'
  | 'master_vst_chain'
  | 'automation_lanes'
  | 'controller_mappings'
  | 'roll_voice'
  | 'tuning'
>;
const DOCUMENT_KEYS = [
  'buses',
  'locators',
  'loop',
  'master_fx_chain',
  'master_vst_chain',
  'automation_lanes',
  'controller_mappings',
  'roll_voice',
  'tuning',
] as const satisfies readonly (keyof ProjectDocument)[];

/**
 * The document a seeded save (PERFORM's Save as .tasmo) writes.
 *
 * EDIT's, when EDIT holds the project being saved: a .tasmo opened in EDIT
 * seeds PERFORM from the same load, so its tracks carry the ids EDIT's tracks
 * have, and an edit made in EDIT since (a bus renamed, a master insert added)
 * belongs in the file. Otherwise EDIT holds some other project, and the seed's
 * own fields are the project's: a .tasmo PERFORM opened by itself carries its
 * buses, markers, loop, master chains, automation, controller mappings, roll
 * voice and tuning. EDIT's fill only what the seed does not carry, which is all
 * of it for a seed with none (a DAW import carries only its markers).
 */
function seededDocument(
  seed: TasmoProjectInput | null,
  seedTracks: readonly TasmoTrackInput[],
  edit: ProjectDocument,
): ProjectDocument {
  if (!seed) return edit;
  const inEdit = new Set(useEditorStore.getState().tracks.map((t) => t.id));
  if (seedTracks.some((t) => inEdit.has(t.id))) return edit;
  const own: ProjectDocument = { ...edit };
  for (const key of DOCUMENT_KEYS) {
    if (seed[key] !== undefined) Object.assign(own, { [key]: seed[key] });
  }
  return own;
}

const applyDefaultDir = (dir: string) => {
  writeLocal(PROJECTS_DIR_KEY, dir);
  useProjectStore.setState({ defaultDir: dir });
};

// The folder field calls setDefaultDir on every keystroke; only the value the
// user stops on is sent to the backend.
const PUSH_DELAY_MS = 600;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

const pushProjectsDir = (dir: string) => {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  const target = dir.trim();
  if (!target || !looksAbsolute(target)) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    placesApi.setProjectsDir(target).then(
      () => writeLocal(PROJECTS_DIR_SYNCED_KEY, '1'),
      (e: unknown) => logWarn('project', `Projects folder ${target} was not stored: ${errMsg(e)}`),
    );
  }, PUSH_DELAY_MS);
};

// Boot, an asset install, the backup dialog and a save prefill can all ask at
// once; they share one read, so a handover is never sent twice.
let ensureInFlight: Promise<void> | null = null;

// The backend holds the projects folder, so asset installs and every client
// use the same one. decideProjectsDir says whether this browser shows the
// backend's folder or hands its own over.
async function syncProjectsDir(): Promise<void> {
  const state = () => useProjectStore.getState();
  const before = state().defaultDir;
  let backend: BackendProjectsDir;
  try {
    const res = await placesApi.projectsDir();
    backend = {
      path: typeof res?.path === 'string' ? res.path : '',
      configured: res?.configured === true,
    };
  } catch {
    // A backend without /api/places: keep this browser's folder, or take the
    // project module's default.
    if (state().defaultDir.trim()) return;
    try {
      const res = await projectApi.defaultDir();
      if (res?.path && !state().defaultDir.trim()) applyDefaultDir(res.path);
    } catch {
      /* no backend default available */
    }
    return;
  }
  // The user changed the folder while the request ran; that edit is the one
  // on its way to the backend.
  if (state().defaultDir !== before || pushTimer) return;
  const decision = decideProjectsDir({
    local: before,
    backend,
    synced: Boolean(readLocal(PROJECTS_DIR_SYNCED_KEY)),
  });
  if (decision.push) {
    try {
      const stored = await placesApi.setProjectsDir(decision.push);
      writeLocal(PROJECTS_DIR_SYNCED_KEY, '1');
      if (state().defaultDir === before) applyDefaultDir(stored);
    } catch (e) {
      // Keep this browser's folder and try again the next time it is needed.
      logWarn('project', `Projects folder ${decision.push} was not stored: ${errMsg(e)}`);
    }
    return;
  }
  if (decision.markSynced) writeLocal(PROJECTS_DIR_SYNCED_KEY, '1');
  if (decision.show && decision.show !== before) applyDefaultDir(decision.show);
}

// A slower, older refresh must not replace the list a newer one set.
let recentSeq = 0;

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
  pendingProject: null,
  pendingTracks: [],
  pendingTimeSignature: null,
  sourceDaw: null,
  importWarnings: [],
  pendingPerformRouting: null,
  lastSaved: null,

  openPath: '',
  loaded: null,

  defaultDir: readLocal(PROJECTS_DIR_KEY),

  open: (tab = 'save', seed) => {
    if (seed) {
      set({
        projectName: seed.project_name || 'Untitled',
        tempo: seed.tempo ?? 120,
        pendingProject: seed,
        pendingTracks: seed.tracks ?? [],
        pendingTimeSignature: seed.time_signature ?? null,
        sourceDaw: seed.source_daw ?? null,
        importWarnings: seed.import_warnings ?? [],
        pendingPerformRouting: seed.perform_routing ?? null,
        lastSaved: null,
      });
    } else {
      // No seed: Ctrl+S, the App menu's Save, or Open. The dialog saves the
      // EDIT timeline, so a seed an earlier PERFORM save left behind is let
      // go. Kept, it made every later Save write that PERFORM structure over
      // the work done in EDIT since.
      set({
        pendingProject: null,
        pendingTracks: [],
        pendingTimeSignature: null,
        sourceDaw: null,
        importWarnings: [],
        pendingPerformRouting: null,
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
    applyDefaultDir(defaultDir);
    pushProjectsDir(defaultDir);
  },

  ensureDefaultDir: () => {
    if (!ensureInFlight) {
      ensureInFlight = syncProjectsDir()
        .catch((e: unknown) => logWarn('project', `Projects folder was not read: ${errMsg(e)}`))
        .finally(() => {
          ensureInFlight = null;
        });
    }
    return ensureInFlight;
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

  // Every .tasmo the app wrote or opened: the project router's list, plus the
  // .tasmo files known places holds, such as a Save a copy of a project asset.
  refreshRecent: async () => {
    const seq = ++recentSeq;
    const [projects, places] = await Promise.all([
      projectApi.recent().then(
        (rows) => (Array.isArray(rows) ? rows : []),
        (e: unknown) => {
          logError('project', e instanceof Error ? e.message : 'Failed to list recent projects.');
          return null;
        },
      ),
      placesApi.recent({ exts: ['.tasmo'] }),
    ]);
    if (seq !== recentSeq) return;
    // Neither list answered: keep the rows already shown.
    if (projects === null && places.length === 0) return;
    set({ recent: mergeRecentProjects(projects ?? [], places) });
  },

  save: async () => {
    const {
      projectName,
      tempo,
      embedAudio,
      savePath,
      pendingProject,
      pendingTracks,
      pendingTimeSignature,
      sourceDaw,
      importWarnings,
      pendingPerformRouting,
    } = get();
    if (!savePath.trim()) {
      set({ error: 'Choose where to save the .tasmo file.' });
      return;
    }
    const name = projectName.trim() || 'Untitled';
    const path = savePath.trim();
    set({ busy: true, error: null });
    try {
      // Whatever a live plugin is holding right now is part of this document.
      // Without this the file records the state captured the last time an
      // editor happened to be open, so a plugin dialed in from the FX row — or
      // left running with its window closed — saves at settings it left long
      // ago and loads back sounding different. Bounded, parallel, and it never
      // rejects: a save must not fail because a plugin was slow.
      await captureLiveVstStates();
      // Two distinct save paths:
      //  - An imported DAW project (pendingTracks seeded): save that structure,
      //    linking/embedding the sample files already on disk.
      //  - Otherwise: capture the LIVE EDIT session, embedding each clip's audio
      //    bytes (editor clips are in-memory blobs with no path to link).
      let res: { path: string; manifest: ProjectManifest };
      if (pendingTracks.length > 0) {
        // The TRACKS are the seed's structure. The rest of the document comes
        // from the same capture helper the live-session branch uses, unless
        // the seed carries its own and EDIT holds another project
        // (seededDocument). This branch used to build its own payload from
        // four fields, so saving an imported project wrote no markers, no
        // loop, no buses, no master chains and no automation.
        //
        // The lane filter is the reason the helper takes the track ids: an
        // automation lane keys off a TRACK id, and these tracks are the
        // importer's, so a lane naming an editor track is left out rather than
        // written as a dangler.
        const doc = captureProjectDocument(pendingTracks.map((t) => t.id));
        const document = seededDocument(pendingProject, pendingTracks, {
          buses: doc.buses,
          locators: doc.locators,
          loop: doc.loop,
          master_fx_chain: doc.masterFxChain,
          master_vst_chain: doc.masterVstChain,
          automation_lanes: doc.automationLanes,
          controller_mappings: doc.controllerMappings ?? null,
          roll_voice: doc.rollVoice,
          tuning: doc.tuning,
        });
        const project: TasmoProjectInput = {
          // Every field the seed carries (the scene names, the tempo and meter
          // maps, the sample rate); the fields below replace their own keys.
          ...pendingProject,
          // The dialog's Tempo is the start tempo, which a tempo map states
          // again in its first event; the map wins on load, so it follows.
          ...(pendingProject?.tempo_map?.length
            ? { tempo_map: pendingProject.tempo_map.map((e) => (e.beat === 0 && !e.fermata ? { ...e, bpm: tempo } : e)) }
            : {}),
          project_name: name,
          tempo,
          time_signature: pendingTimeSignature ?? [4, 4],
          tracks: pendingTracks,
          source_daw: sourceDaw,
          import_warnings: importWarnings,
          ...document,
          perform_routing: pendingPerformRouting,
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
          // The meter is document state exactly as the tempo is; without it a
          // 7/8 session reopened in whatever meter the session it replaced held.
          time_signature: meterToTasmo(session.timeSignature),
          // The arrangement's whole tempo map and meter map. `tempo` and
          // `time_signature` above stay the start tempo and bar 1's meter, so a
          // reader that knows only those still opens the song at its start.
          tempo_map: session.tempoMap,
          meter_map: session.meterMap,
          tracks: session.tracks,
          // The mix buses the tracks' output_routing / send_amounts name. Without
          // this the file could name a bus that had nowhere to live, and the
          // session reopened with every edge collapsed onto the master.
          buses: session.buses,
          // Timeline markers and the transport's cycle region. Both are cleared
          // by loadProject, so before these two keys existed a saved session
          // reopened with every marker and the loop region gone.
          locators: session.locators,
          loop: session.loop,
          // The master bus's insert rack, its hosted-VST chain and the
          // automation lanes. Written even when empty: an empty array is what
          // tells the loader this project HAS none, so the master rack of the
          // project opened before it does not carry over into this one.
          master_fx_chain: session.masterFxChain,
          master_vst_chain: session.masterVstChain,
          automation_lanes: session.automationLanes,
          controller_mappings: session.controllerMappings ?? null,
          // The piano roll's own voice, so a reopened project's roll auditions
          // and bounces on the instrument it was left on.
          roll_voice: session.rollVoice,
          // The project tuning, so a reopened project plays at the pitch and temperament it was left in.
          tuning: session.tuning,
        };
        logInfo(
          'project',
          `POST /api/project/save-session — ${path} (${session.tracks.length} tracks, ${session.clipCount} clips embedded)`,
        );
        res = await projectApi.saveSession(project, path, session.files);
      }
      set({ busy: false, lastSaved: { path: res.path, manifest: res.manifest } });
      // The document now matches what is on disk — clear the unsaved-changes guard.
      useEditorStore.getState().markSaved();
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
