import { useEffect } from "react";
import { set } from "idb-keyval";
import { UIElement, CanvasState, Asset, Texture, CustomModule } from "../types";

interface UseAutosaveArgs {
  elements: UIElement[];
  canvasState: CanvasState;
  assets: Asset[];
  textures: Texture[];
  customModules: CustomModule[];
  hasLoadedAutosave: { current: boolean };
}

// Debounced (400ms) persist of the full project state to idb-keyval AND the
// server. Gated on hasLoadedAutosave so we never clobber storage with the empty
// initial state before the mount-time load has finished.
export function useAutosave({
  elements,
  canvasState,
  assets,
  textures,
  customModules,
  hasLoadedAutosave,
}: UseAutosaveArgs) {
  useEffect(() => {
    if (!hasLoadedAutosave.current) return;
    const state = { elements, canvasState, assets, textures, customModules };
    const timer = setTimeout(() => {
      set("ui-modeler-autosave", state).catch((e) =>
        console.error("Failed to autosave", e),
      );
      // Save to server (fire-and-forget)
      fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      }).catch(() => {}); // silent fail
    }, 400);
    return () => clearTimeout(timer);
  }, [elements, canvasState, assets, textures, customModules]);
}
