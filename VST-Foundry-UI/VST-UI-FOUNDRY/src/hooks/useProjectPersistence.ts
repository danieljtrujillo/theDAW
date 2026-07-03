import { useEffect, useState } from "react";
import { get, set } from "idb-keyval";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import {
  UIElement,
  CanvasState,
  Asset,
  Texture,
  CustomModule,
} from "../types";
import { SavedProject } from "../components/ProjectLibraryModal";
import { clearElementSignals } from "../lib/elementSignalBus";
import { parseGan } from "../lib/ganImport";

type ClearHistory = (newPresent: UIElement[]) => void;
type SetCanvasState = (
  value: CanvasState | ((prev: CanvasState) => CanvasState),
) => void;
type SetAssets = (value: Asset[] | ((prev: Asset[]) => Asset[])) => void;
type SetTextures = (value: Texture[] | ((prev: Texture[]) => Texture[])) => void;
type SetCustomModules = (
  value: CustomModule[] | ((prev: CustomModule[]) => CustomModule[]),
) => void;
type SetSelectedIds = (
  value: string[] | ((prev: string[]) => string[]),
) => void;
type SetBool = (value: boolean | ((prev: boolean) => boolean)) => void;

interface UseProjectPersistenceArgs {
  elements: UIElement[];
  canvasState: CanvasState;
  assets: Asset[];
  textures: Texture[];
  clearHistory: ClearHistory;
  setCanvasState: SetCanvasState;
  setAssets: SetAssets;
  setTextures: SetTextures;
  setCustomModules: SetCustomModules;
  setSelectedElementIds: SetSelectedIds;
  setIsLibraryOpen: SetBool;
  setSaveProjectOpen: SetBool;
  hasLoadedAutosave: { current: boolean };
}

// All project I/O: the mount-time load (server > idb autosave, with legacy
// custom-module migration), saving named projects to the library, exporting
// (JSON download + zip package), and loading/deleting library projects. Load
// paths use clearHistory (never setElements) so undo history starts clean, and
// the empty-`{}` server guard prevents an empty server response from wiping
// idb-backed state.
export function useProjectPersistence({
  elements,
  canvasState,
  assets,
  textures,
  clearHistory,
  setCanvasState,
  setAssets,
  setTextures,
  setCustomModules,
  setSelectedElementIds,
  setIsLibraryOpen,
  setSaveProjectOpen,
  hasLoadedAutosave,
}: UseProjectPersistenceArgs) {
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [loadProjectTarget, setLoadProjectTarget] =
    useState<SavedProject | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);

  // Load saved projects and autosave on mount
  useEffect(() => {
    const loadStorage = async () => {
      try {
        const savedProjectsData = await get("ui-modeler-projects");
        if (savedProjectsData) {
          setSavedProjects(savedProjectsData);
        }
      } catch (e) {
        console.error("Failed to load projects", e);
      }

      // Migrate legacy sidebar-local custom modules (localStorage 'vst-custom-code')
      // into the unified store, so existing user-made modules aren't lost when we
      // switch persistence to the autosave path. Used as a fallback whenever the
      // loaded state carries no modules of its own.
      let migratedModules: CustomModule[] = [];
      try {
        const legacy = localStorage.getItem("vst-custom-code");
        if (legacy) {
          const parsed = JSON.parse(legacy);
          if (Array.isArray(parsed)) {
            migratedModules = parsed
              .filter((m: any) => m && (m.customCode || m.variant))
              .map((m: any) => ({
                type: "CustomCode" as const,
                variant: String(m.variant || m.label || "Custom"),
                label: String(m.label || m.variant || "Custom"),
                defaultWidth: Number(m.defaultWidth) || 100,
                defaultHeight: Number(m.defaultHeight) || 100,
                customCode: String(m.customCode || ""),
              }))
              .filter((m: CustomModule) => m.customCode.trim().length > 0);
          }
        }
      } catch (e) {
        console.error("Failed to migrate legacy custom modules", e);
      }

      // Also persist to server
      try {
        const serverStateResp = await fetch("/api/state");
        if (serverStateResp.ok) {
          const serverState = await serverStateResp.json();
          if (serverState && (serverState.elements || serverState.canvasState)) {
            // Server state takes priority over idb-keyval if both exist
            if (serverState.elements) clearHistory(serverState.elements);
            if (serverState.canvasState) setCanvasState(serverState.canvasState);
            if (serverState.assets) setAssets(serverState.assets);
            if (serverState.textures) setTextures(serverState.textures);
            setCustomModules(
              Array.isArray(serverState.customModules) &&
                serverState.customModules.length
                ? serverState.customModules
                : migratedModules,
            );
            hasLoadedAutosave.current = true;
            return; // Skip idb-keyval if server state exists
          }
        }
      } catch {
        /* server not available, fall through to idb-keyval */
      }

      let loadedModules: CustomModule[] | undefined;
      try {
        const autosave = await get("ui-modeler-autosave");
        if (autosave) {
          const {
            elements: savedElements,
            canvasState: savedCanvas,
            assets: savedAssets,
            textures: savedTextures,
            customModules: savedModules,
          } = autosave;
          if (savedElements) clearHistory(savedElements);
          if (savedCanvas) setCanvasState(savedCanvas);
          if (savedAssets) setAssets(savedAssets);
          if (savedTextures) setTextures(savedTextures);
          if (Array.isArray(savedModules)) loadedModules = savedModules;
        }
      } catch (e) {
        console.error("Failed to load autosave", e);
      }
      setCustomModules(
        loadedModules && loadedModules.length ? loadedModules : migratedModules,
      );
      hasLoadedAutosave.current = true;
    };

    loadStorage();
  }, []);

  const handleSaveProject = (name: string) => {
    if (!name.trim()) return;

    const newProject: SavedProject = {
      id: Math.random().toString(36).substring(2, 9),
      name: name.trim(),
      createdAt: Date.now(),
      elements,
      canvasState,
      assets,
      textures,
    };

    const updatedProjects = [newProject, ...savedProjects];
    setSavedProjects(updatedProjects);
    set("ui-modeler-projects", updatedProjects).catch((e) =>
      console.error("Failed to save project", e),
    );
    setSaveProjectOpen(false);
  };

  const handleDownloadProject = () => {
    const data = JSON.stringify(
      {
        version: 1,
        elements,
        canvasState,
        assets,
        textures,
      },
      null,
      2,
    );
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "project.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPackage = async () => {
    const zip = new JSZip();

    // Add main project JSON
    const projectData = JSON.stringify(
      {
        version: 1,
        elements,
        canvasState,
        assets,
        textures,
      },
      null,
      2,
    );
    zip.file("project.json", projectData);

    // Add background image if present
    if (canvasState.backgroundImage) {
      try {
        const base64Data = canvasState.backgroundImage.split(",")[1];
        if (base64Data) {
          zip.file("background.png", base64Data, { base64: true });
        }
      } catch (e) {
        console.error("Failed to export background image", e);
      }
    }

    // Export each element to an elements folder
    const elementsFolder = zip.folder("elements");
    if (elementsFolder) {
      elements.forEach((el, i) => {
        const fileName = `${el.name || "element"}_${i}.json`;
        elementsFolder.file(fileName, JSON.stringify(el, null, 2));
      });
    }

    // Auto-generate documentation README
    let readme = `# VST Foundry Project

## Overview
This is a UI layout project generated by VST Foundry.

## Canvas Settings
- Width: ${canvasState.width}px
- Height: ${canvasState.height}px
- Has Background: ${canvasState.backgroundImage ? "Yes (background.png)" : "No"}

## UI Elements
Total Elements: ${elements.length}

### Element List
`;
    elements.forEach((el) => {
      readme += `- **${el.name || el.type}** (${el.type}) at x:${Math.round(el.x)}, y:${Math.round(el.y)}
`;
    });

    readme += `
## Instructions
You can import \`project.json\` back into VST Foundry to edit this layout.
The \`elements/\` folder contains the JSON representation of each individual UI component.
`;
    zip.file("README.md", readme);

    // Generate zip
    try {
      const blob = await zip.generateAsync({ type: "blob" });
      saveAs(blob, "vst-project-package.zip");
    } catch (e) {
      console.error("Failed to generate zip package", e);
      alert("Failed to create package export.");
    }
  };

  const handleLoadProject = (project: SavedProject) => {
    if (elements.length > 0) {
      setLoadProjectTarget(project);
    } else {
      executeLoadProject(project);
    }
  };

  const executeLoadProject = (project: SavedProject) => {
    // Drop runtime modulation signals from the previous document so a loaded
    // project can never replay stale element-route values (review finding:
    // clearElementSignals was defined but never wired).
    clearElementSignals();
    clearHistory(project.elements || []);
    setCanvasState(
      project.canvasState ?? {
        backgroundImage: null,
        width: 800,
        height: 600,
        scale: 1,
        panX: 0,
        panY: 0,
        showRulers: true,
      },
    );
    setAssets(project.assets || []);
    setTextures(project.textures || []);
    setSelectedElementIds([]);
    setIsLibraryOpen(false);
    setLoadProjectTarget(null);
  };

  // Open a .gan (theDAW's plugin filetype) and continue editing it. A .gan this
  // app wrote carries its full editable project (source/foundry-project.json) for
  // a lossless round-trip; a foreign .gan is reconstructed from its manifest.
  // Uses clearHistory (not setElements) so undo history starts clean.
  const handleImportGanFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const { project, sourceKind } = await parseGan(buf);
      clearElementSignals();
      clearHistory(project.elements || []);
      setCanvasState(project.canvasState);
      setAssets(project.assets || []);
      setTextures(project.textures || []);
      setCustomModules(project.customModules || []);
      setSelectedElementIds([]);
      setIsLibraryOpen(false);
      if (sourceKind === "reconstructed") {
        console.info(
          "[gan] No embedded Foundry source in this .gan; reconstructed an " +
            "editable layout from the manifest.",
        );
      }
    } catch (e) {
      console.error("Failed to open .gan", e);
      alert("Could not open that .gan file. See the console for details.");
    }
  };

  const handleDeleteProject = (id: string) => {
    setDeleteProjectId(id);
  };

  const executeDeleteProject = () => {
    if (deleteProjectId) {
      const updatedProjects = savedProjects.filter(
        (p) => p.id !== deleteProjectId,
      );
      setSavedProjects(updatedProjects);
      set("ui-modeler-projects", updatedProjects).catch((e) =>
        console.error("Failed to save project", e),
      );
      setDeleteProjectId(null);
    }
  };

  return {
    savedProjects,
    loadProjectTarget,
    setLoadProjectTarget,
    deleteProjectId,
    setDeleteProjectId,
    handleSaveProject,
    handleDownloadProject,
    handleExportPackage,
    handleLoadProject,
    executeLoadProject,
    handleDeleteProject,
    executeDeleteProject,
    handleImportGanFile,
  };
}
