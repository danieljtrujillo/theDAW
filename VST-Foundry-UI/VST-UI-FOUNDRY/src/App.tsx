import React, { useState, useEffect } from "react";
import {
  ElementType,
  UIElement,
  CanvasState,
  CanvasTool,
  Asset,
  Texture,
  CustomModule,
  CustomParam,
} from "./types";
import { mergeCustomParams, sanitizeCustomParams } from "./lib/customParams";
import { generateBuiltinTextures } from "./lib/proceduralTextures";
import { useHistory } from "./hooks/useHistory";
import { useClipboard } from "./hooks/useClipboard";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAutosave } from "./hooks/useAutosave";
import { useProjectPersistence } from "./hooks/useProjectPersistence";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import AssetManager from "./components/AssetManager";
import TextureManager from "./components/TextureManager";
import Canvas from "./components/Canvas";
import ExportModal from "./components/ExportModal";
import LayersPanel from "./components/LayersPanel";
import ProjectLibraryModal from "./components/ProjectLibraryModal";
import SettingsModal, { applyTheme } from "./components/SettingsModal";
import { ConfirmModal, PromptModal } from "./components/Modals";
import ContextMenu from "./components/ContextMenu";
import {
  Copy,
  CopyPlus,
  Trash,
  ArrowUp,
  ArrowDown,
  ChevronsUp,
  ChevronsDown,
  ClipboardPaste,
  Layers,
  Image,
  Lock,
  Unlock,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Scissors,
  SquarePen,
  FlipHorizontal2,
  FlipVertical2,
  RotateCw,
  MessageSquarePlus,
} from "lucide-react";
import CompactElementProperties from "./components/CompactElementProperties";
import InpaintModal from "./components/InpaintModal";
import AIAssistantOrb from "./components/AIAssistantOrb";
import EventLog from "./components/EventLog";
import TextureGenerateModal from "./components/TextureGenerateModal";
import ExtractorModal, {
  PlacedLayer,
} from "./components/extractor/ExtractorModal";
import { boundsToCanvasRect } from "./lib/extractor/mapping";
import {
  loadArsenal,
  addToArsenal,
  removeFromArsenal,
  type ArsenalEntry,
} from "./lib/arsenal";

export default function App() {
  const {
    elements,
    setElements,
    setElementsWithoutHistory,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
  } = useHistory([]);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isExtractorOpen, setIsExtractorOpen] = useState(false);
  const hasLoadedAutosave = React.useRef(false);
  // Hidden picker for opening a .gan plugin (theDAW's plugin filetype) to edit.
  const ganInputRef = React.useRef<HTMLInputElement>(null);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [textures, setTextures] = useState<Texture[]>([]);
  // Reusable custom UI modules (sidebar palette). Lifted to App state so they
  // ride the SAME autosave (idb + server) as the rest of the project — created
  // by the user OR the AI, persisted regardless of who made them.
  const [customModules, setCustomModules] = useState<CustomModule[]>([]);
  // The global Arsenal palette (saved image-face controls). Unlike customModules
  // this is NOT project state / autosaved with the rest — it lives under its own
  // idb-keyval key (see src/lib/arsenal.ts) so it's shared across every project
  // and reload. Loaded once on mount; mutated only through the arsenal helpers,
  // each of which returns the fresh list straight into this setter.
  const [arsenal, setArsenal] = useState<ArsenalEntry[]>([]);
  const [activeTool, setActiveTool] = useState<CanvasTool>("select");

  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [generateTarget, setGenerateTarget] = useState<"texture" | "asset">(
    "texture",
  );

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const [colorblindMode, setColorblindMode] = useState(false);
  const [currentTheme, setCurrentTheme] = useState("default");

  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [saveProjectOpen, setSaveProjectOpen] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: "canvas" | "element";
    elementId?: string;
    // "menu" = compact action list (default on right-click); "editor" = the
    // full CompactElementProperties panel, opened via the menu's Editor item.
    mode: "menu" | "editor";
  } | null>(null);

  // Object-removal (LaMa inpaint) modal target: the Image element being cleaned
  // and its current image URL. Null = closed.
  const [inpaintTarget, setInpaintTarget] = useState<{
    elementId: string;
    imageUrl: string;
    name: string;
  } | null>(null);

  const [isCategoriesOpen, setIsCategoriesOpen] = useState(true);
  const [isExplorerOpen, setIsExplorerOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [isHeaderOpen, setIsHeaderOpen] = useState(true);

  const [canvasState, setCanvasState] = useState<CanvasState>({
    backgroundImage: null,
    width: 800,
    height: 600,
    scale: 1,
    panX: 0,
    panY: 0,
    showRulers: true,
  });

  // Project I/O: mount-time load (server > idb autosave, legacy migration),
  // save-to-library, JSON/zip export, and load/delete library projects.
  const {
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
  } = useProjectPersistence({
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
  });

  // Copy/paste/duplicate/cut clipboard, shared by keyboard and context menu.
  const {
    clipboard,
    copyFromKeyboard,
    pasteFromKeyboard,
    copyFromMenu,
    pasteFromMenu,
    duplicateFromMenu,
    cutSelection,
  } = useClipboard({
    elements,
    selectedElementIds,
    setElements,
    setSelectedElementIds,
  });

  // Register/overwrite a reusable custom module. Shared by the sidebar form AND
  // the AI's addCustomModule tool — both paths land here, so a module persists
  // regardless of who made it. De-dupes by name (re-using a name overwrites).
  const handleAddCustomModule = (
    name: string,
    code: string,
    params?: CustomParam[],
  ): CustomModule | null => {
    const moduleName = (name || "").trim();
    const moduleCode = (code || "").trim();
    if (!moduleName || !moduleCode) return null;
    const entry: CustomModule = {
      type: "CustomCode",
      variant: moduleName,
      label: moduleName,
      defaultWidth: 100,
      defaultHeight: 100,
      customCode: moduleCode,
      params: params && params.length ? params : undefined,
    };
    setCustomModules((prev) => {
      const idx = prev.findIndex((m) => m.variant === moduleName);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = entry;
        return next;
      }
      return [...prev, entry];
    });
    return entry;
  };

  // Adopt a parameter schema a CustomCode element registers about itself (via
  // window.foundryRegisterParams or the bridge's DOM auto-discovery). Reconcile
  // rather than seed-once: the registered schema defines structure/order, but
  // values the user has already set survive (mergeCustomParams). Bail BEFORE
  // touching state when nothing changes, and use the history-bypassing setter so
  // this automatic (non-user) mutation never pollutes undo/redo (it fires on
  // every iframe reload).
  const handleRegisterParams = (elementId: string, params: CustomParam[]) => {
    const clean = sanitizeCustomParams(params);
    if (clean.length === 0) return;
    const target = elements.find((el) => el.id === elementId);
    if (!target) return;
    const merged = mergeCustomParams(target.params, clean);
    if (JSON.stringify(merged) === JSON.stringify(target.params || [])) return;
    setElementsWithoutHistory((prev) =>
      prev.map((el) =>
        el.id === elementId ? { ...el, params: mergeCustomParams(el.params, clean) } : el,
      ),
    );
  };

  // A control INSIDE a CustomCode iframe moved (window.foundrySetParam or an
  // auto-discovered input). The iframe already reflects the value in its own DOM
  // during the drag, so the host only needs to persist it — debounced into a
  // SINGLE history commit so a drag becomes one undo step (mirroring how native
  // control drags seal on release). Not touching present between bursts keeps the
  // recorded undo `past` at the true pre-drag state. Changes accumulate across
  // keys/elements so a burst spanning several params is still one step.
  const paramValuePending = React.useRef<
    Map<string, Map<string, number | string | boolean>>
  >(new Map());
  const paramValueTimer = React.useRef<number | undefined>(undefined);
  const handleParamValueChange = (
    elementId: string,
    key: string,
    value: number | string | boolean,
  ) => {
    let keys = paramValuePending.current.get(elementId);
    if (!keys) {
      keys = new Map();
      paramValuePending.current.set(elementId, keys);
    }
    keys.set(key, value);
    if (paramValueTimer.current !== undefined) {
      window.clearTimeout(paramValueTimer.current);
    }
    paramValueTimer.current = window.setTimeout(() => {
      const committed = paramValuePending.current;
      paramValuePending.current = new Map();
      paramValueTimer.current = undefined;
      setElements((prev) =>
        prev.map((el) => {
          const changed = committed.get(el.id);
          if (!changed || !el.params) return el;
          return {
            ...el,
            params: el.params.map((p) =>
              changed.has(p.key) ? { ...p, value: changed.get(p.key)! } : p,
            ),
          };
        }),
      );
    }, 300);
  };

  const handleDragStart = (
    e: React.DragEvent,
    type: ElementType,
    defaultWidth: number,
    defaultHeight: number,
    variant?: string,
    customCode?: string,
    presetData?: any,
  ) => {
    e.dataTransfer.setData("elementType", type);
    e.dataTransfer.setData("defaultWidth", defaultWidth.toString());
    e.dataTransfer.setData("defaultHeight", defaultHeight.toString());
    if (variant) {
      e.dataTransfer.setData("variant", variant);
    }
    if (customCode) {
      e.dataTransfer.setData("customCode", customCode);
    }
    if (presetData) {
      e.dataTransfer.setData("presetData", JSON.stringify(presetData));
    }
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleDropElement = (
    type: ElementType,
    x: number,
    y: number,
    defaultWidth: number,
    defaultHeight: number,
    assetId?: string,
    variant?: string,
    customCode?: string,
    presetData?: any,
  ) => {
    let finalWidth = defaultWidth;
    let finalHeight = defaultHeight;

    if (type === "Image") {
      const maxWidth = canvasState.width;
      const maxHeight = canvasState.height;
      if (finalWidth > maxWidth || finalHeight > maxHeight) {
        const ratio = Math.min(maxWidth / finalWidth, maxHeight / finalHeight);
        finalWidth = Math.round(finalWidth * ratio);
        finalHeight = Math.round(finalHeight * ratio);
      }
    }

    const newElement: UIElement = {
      ...presetData,
      id: Math.random().toString(36).substring(2, 9),
      name: `${type.toLowerCase()}${variant ? "_" + variant.toLowerCase() : ""}_${elements.length + 1}`,
      type,
      variant,
      x: Math.round(x),
      y: Math.round(y),
      width: finalWidth,
      height: finalHeight,
      label:
        type === "Button" || type === "Label" || type === "Toggle"
          ? type
          : undefined,
      assetId,
      customCode,
    };

    // If presetData had specific values we don't want to override immediately (like name/label), preserve them
    if (presetData?.label) newElement.label = presetData.label;
    if (presetData?.name) newElement.name = presetData.name;

    setElements((prev) => [...prev, newElement]);
    setSelectedElementIds([newElement.id]);
  };

  // Extractor → design sinks. PlacedLayer bounds are normalized to the
  // background image; canvasState.width/height match the background's natural
  // dims (Canvas.tsx sets them on upload), so boundsToCanvasRect is exact.
  const handleExtractorAddAssets = (newAssets: Asset[]) =>
    setAssets((prev) => [...prev, ...newAssets]);

  // Apply an inpaint result: store the cleaned image as a NEW asset (the
  // original is preserved) and repoint the target Image element at it. Rides the
  // normal history/autosave paths like any other element edit.
  const handleInpaintApply = (elementId: string, dataUrl: string) => {
    const el = elements.find((e) => e.id === elementId);
    const srcName = assets.find((a) => a.id === el?.assetId)?.name || el?.name || "Image";
    const newAsset: Asset = {
      id: Math.random().toString(36).substring(2, 9),
      name: `${srcName} (cleaned)`,
      url: dataUrl,
    };
    setAssets((prev) => [...prev, newAsset]);
    setElements((prev) =>
      prev.map((e) => (e.id === elementId ? { ...e, assetId: newAsset.id } : e)),
    );
    setInpaintTarget(null);
  };

  const handleExtractorPlaceLayers = (items: PlacedLayer[]) => {
    const newEls: UIElement[] = items.map(
      ({ asset, bounds, label, controlType, faceUrl }) => {
        const r = boundsToCanvasRect(bounds, canvasState);
        const base = {
          id: Math.random().toString(36).substring(2, 9),
          name: label || asset.name,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
        // "Make Control" path (C4): a chosen non-Image target spawns a native
        // control wearing the cutout as its faceSrc (falling back to the raw
        // asset url when the durable upload didn't run). assetId is deliberately
        // omitted so this never falls into the Image branch — faceSrc drives it.
        if (controlType && controlType !== "Image") {
          return {
            ...base,
            type: controlType,
            faceSrc: faceUrl ?? asset.url,
            label,
            value: 50,
          };
        }
        // Default (unchanged) path: an assetId-backed Image layer.
        return {
          ...base,
          type: "Image" as const,
          assetId: asset.id,
        };
      },
    );
    setElements((prev) => [...prev, ...newEls]);
    setSelectedElementIds(newEls.map((e) => e.id));
  };

  // Save-to-Arsenal signal (C5). ControlParamsSection dispatches
  // "vst-arsenal-save" carrying the element id; App owns the listener (same
  // pattern as vst-preset-saved / vst-ai-action). We clone that element into a
  // global ArsenalEntry — stripping instance identity (id/x/y) exactly like the
  // Saved Presets flow — name it via a prompt defaulting to the element name,
  // then persist through addToArsenal, which returns the fresh list into state.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const el = elements.find((x) => x.id === detail.elementId);
      if (!el) return;
      const name = window.prompt("Name this Arsenal control:", el.name);
      if (!name) return;
      const presetData: Record<string, unknown> = { ...el };
      delete presetData.id;
      delete presetData.x;
      delete presetData.y;
      const entry: ArsenalEntry = {
        id: crypto.randomUUID(),
        name,
        type: el.type,
        defaultWidth: el.width,
        defaultHeight: el.height,
        presetData,
        previewUrl: el.faceSrc,
        createdAt: Date.now(),
      };
      void addToArsenal(entry).then(setArsenal);
    };
    window.addEventListener("vst-arsenal-save", handler as EventListener);
    return () =>
      window.removeEventListener("vst-arsenal-save", handler as EventListener);
  }, [elements]);

  // Drop an Arsenal entry (Sidebar delete-X). removeFromArsenal returns the
  // updated list, which flows straight back into state.
  const handleRemoveArsenal = (id: string) => {
    void removeFromArsenal(id).then(setArsenal);
  };

  // Convert-type signal. ControlParamsSection dispatches "vst-convert-type"
  // when the user re-picks what a placed image-bearing element IS (Image layer
  // → working control, control → different control, control → back to Image).
  // App owns the conversion because Image↔face translation needs the asset
  // store: an Image's picture rides assetId, a control's rides faceSrc.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { elementId?: string; targetType?: ElementType }
        | undefined;
      const el = elements.find((x) => x.id === detail?.elementId);
      const targetType = detail?.targetType;
      if (!el || !targetType || targetType === el.type) return;

      if (targetType === "Image") {
        // Control → Image: the Image branch renders from an Asset, so
        // materialize the face URL as an asset entry and hand over its id.
        const url = el.faceSrc;
        if (!url) return;
        const asset: Asset = {
          id: crypto.randomUUID(),
          name: el.name || el.label || "converted",
          url,
        };
        setAssets((prev) => [...prev, asset]);
        setElements((prev) =>
          prev.map((x) =>
            x.id === el.id
              ? {
                  ...x,
                  type: "Image" as const,
                  assetId: asset.id,
                  faceSrc: undefined,
                }
              : x,
          ),
        );
        return;
      }

      // Image → control (or control → control): the picture becomes/stays the
      // face; value fields get sane defaults only where missing.
      const faceSrc =
        el.faceSrc ??
        (el.type === "Image"
          ? assets.find((a) => a.id === el.assetId)?.url
          : undefined);
      setElements((prev) =>
        prev.map((x) =>
          x.id === el.id
            ? {
                ...x,
                type: targetType,
                faceSrc,
                assetId: undefined,
                value: x.value ?? 50,
              }
            : x,
        ),
      );
    };
    window.addEventListener("vst-convert-type", handler as EventListener);
    return () =>
      window.removeEventListener("vst-convert-type", handler as EventListener);
  }, [elements, assets]);

  const handleUpdateElements = (
    ids: string[],
    updates: Partial<UIElement> | ((el: UIElement) => Partial<UIElement>),
  ) => {
    setElements((prev) =>
      prev.map((el) => {
        if (!ids.includes(el.id)) return el;
        const computedUpdates =
          typeof updates === "function" ? updates(el) : updates;
        return { ...el, ...computedUpdates };
      }),
    );
  };

  const handleSelectElements = (ids: string[], multi: boolean) => {
    if (multi) {
      setSelectedElementIds((prev) => {
        const newSelection = [...prev];
        ids.forEach((id) => {
          if (!newSelection.includes(id)) newSelection.push(id);
        });
        return newSelection;
      });
    } else {
      setSelectedElementIds(ids);
    }
  };

  const handleReorderElement = (
    id: string,
    direction: "up" | "down" | "top" | "bottom",
  ) => {
    setElements((prev) => {
      const index = prev.findIndex((el) => el.id === id);
      if (index === -1) return prev;

      const next = [...prev];
      const [item] = next.splice(index, 1);

      if (direction === "up") next.splice(index + 1, 0, item);
      else if (direction === "down") next.splice(index - 1, 0, item);
      else if (direction === "top") next.push(item);
      else if (direction === "bottom") next.unshift(item);

      return next;
    });
  };

  const handleReorderTo = (id: string, newIndex: number) => {
    setElements((prev) => {
      const oldIndex = prev.findIndex((el) => el.id === id);
      if (oldIndex === -1 || newIndex < 0 || newIndex >= prev.length)
        return prev;

      const next = [...prev];
      const [item] = next.splice(oldIndex, 1);
      next.splice(newIndex, 0, item);
      return next;
    });
  };

  // ---- Context-menu element ops -------------------------------------------
  // All operate on the current selection. Right-clicking an unselected element
  // selects it first (see the Canvas onContextMenu handler), so the clicked
  // element is always included.
  const deleteSelectedFromMenu = () => {
    const idsToDelete = new Set(selectedElementIds);
    setElements(
      elements
        .filter((el) => !idsToDelete.has(el.id))
        .map((el) =>
          el.type === "Group" && el.childrenIds
            ? {
                ...el,
                childrenIds: el.childrenIds.filter(
                  (id) => !idsToDelete.has(id),
                ),
              }
            : el,
        ),
    );
    setSelectedElementIds([]);
  };

  const toggleFlipSelected = (axis: "flipX" | "flipY") => {
    const targets = new Set(selectedElementIds);
    setElements(
      elements.map((el) =>
        targets.has(el.id) ? { ...el, [axis]: !el[axis] } : el,
      ),
    );
  };

  // "Flip Z" — a 2D element's Z-axis flip is a 180° spin.
  const rotateSelected180 = () => {
    const targets = new Set(selectedElementIds);
    setElements(
      elements.map((el) =>
        targets.has(el.id)
          ? { ...el, rotation: ((el.rotation || 0) + 180) % 360 }
          : el,
      ),
    );
  };

  // Toggle lock on the whole selection, driven by the anchor element's state so
  // a mixed selection converges instead of flipping each element individually.
  const toggleLockFromMenu = (anchorId: string) => {
    const targetIds = selectedElementIds.includes(anchorId)
      ? selectedElementIds
      : [anchorId];
    const isLocked = elements.find((e) => e.id === anchorId)?.isLocked;
    setElements(
      elements.map((e) =>
        targetIds.includes(e.id) ? { ...e, isLocked: !isLocked } : e,
      ),
    );
  };

  // "Add to Chat" — hand the selection to the AI assistant orb as referenced
  // items (chips in its composer). The orb listens for this event, resolves the
  // ids against the live canvas, and opens itself.
  const addSelectionToChat = () => {
    if (selectedElementIds.length === 0) return;
    window.dispatchEvent(
      new CustomEvent("vst-ai-add-reference", {
        detail: { ids: selectedElementIds },
      }),
    );
  };

  // Global keyboard shortcuts (tool switch, undo/redo, copy/paste/cut, group,
  // delete, arrow-nudge). Copy/paste/cut are delegated to useClipboard.
  useKeyboardShortcuts({
    elements,
    selectedElementIds,
    setElements,
    setSelectedElementIds,
    setActiveTool,
    undo,
    redo,
    copyFromKeyboard,
    pasteFromKeyboard,
    cutSelection,
  });

  // Debounced autosave (idb + server), gated until the mount-time load finishes.
  useAutosave({
    elements,
    canvasState,
    assets,
    textures,
    customModules,
    hasLoadedAutosave,
  });

  // Ship the built-in procedural texture pack. This runs once, AFTER the
  // mount-time project load settles (useProjectPersistence flips
  // hasLoadedAutosave and always calls setCustomModules on every load path, so
  // that state change re-fires this effect at the right moment). Built-ins not
  // already present by stable id are prepended so they head the library; the
  // id-dedupe returns `prev` unchanged once they're there (autosave echoes them
  // back on later loads), so this never spins the autosave dirty cycle.
  const builtinsMergedRef = React.useRef(false);
  useEffect(() => {
    if (builtinsMergedRef.current || !hasLoadedAutosave.current) return;
    builtinsMergedRef.current = true;
    const builtins = generateBuiltinTextures();
    if (builtins.length === 0) return;
    setTextures((prev) => {
      const existing = new Set(prev.map((t) => t.id));
      const missing = builtins.filter((t) => !existing.has(t.id));
      return missing.length ? [...missing, ...prev] : prev;
    });
  }, [textures, customModules]);

  // Hydrate the global Arsenal palette once on mount. It lives outside project
  // state (its own idb key), so it loads independently of the project restore.
  useEffect(() => {
    void loadArsenal().then(setArsenal);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--font-scale",
      fontScale.toString(),
    );
  }, [fontScale]);

  useEffect(() => {
    if (colorblindMode) {
      document.body.classList.add("colorblind-mode");
    } else {
      document.body.classList.remove("colorblind-mode");
    }
  }, [colorblindMode]);

  useEffect(() => {
    applyTheme(currentTheme);
  }, [currentTheme]);

  // ---------------------------------------------------------------------------
  // AI Assistant action bridge.
  //
  // The orb (AIAssistantOrb) runs most tools directly against canvas props, but
  // delegates READ tools (getTextures/getAssets) and a set of APP-LEVEL
  // MUTATIONS (selection, grouping, alignment, distribution, z-order, undo/redo,
  // theme, font scale) to App.tsx via a "vst-ai-action" window event, expecting
  // an answering "vst-ai-action-result" event keyed by requestId. That listener
  // was never implemented — so reads timed out to [] and mutations resolved
  // {ok:true} while doing nothing. This effect is that missing contract.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const respond = (requestId: string, payload: any) => {
      if (!requestId) return;
      window.dispatchEvent(
        new CustomEvent("vst-ai-action-result", {
          detail: { requestId, ...payload },
        }),
      );
    };

    // Mirrors AlignmentPanel.handleAlign so AI and manual alignment match.
    const computeAlign = (ids: string[], type: string) => {
      const sel = elements.filter((el) => ids.includes(el.id));
      if (sel.length === 0) return;
      const movable = sel.filter((el) => !el.isLocked);
      if (movable.length === 0) return;

      if (sel.length === 1) {
        const el = sel[0];
        let newX = el.x;
        let newY = el.y;
        switch (type) {
          case "left": newX = 0; break;
          case "centerH": newX = (canvasState.width - el.width) / 2; break;
          case "right": newX = canvasState.width - el.width; break;
          case "top": newY = 0; break;
          case "centerV": newY = (canvasState.height - el.height) / 2; break;
          case "bottom": newY = canvasState.height - el.height; break;
        }
        handleUpdateElements([el.id], { x: newX, y: newY });
        return;
      }

      const minX = Math.min(...sel.map((el) => el.x));
      const maxX = Math.max(...sel.map((el) => el.x + el.width));
      const minY = Math.min(...sel.map((el) => el.y));
      const maxY = Math.max(...sel.map((el) => el.y + el.height));
      const avgCenterH =
        sel.reduce((a, el) => a + el.x + el.width / 2, 0) / sel.length;
      const avgCenterV =
        sel.reduce((a, el) => a + el.y + el.height / 2, 0) / sel.length;
      const updates: Record<string, Partial<UIElement>> = {};
      movable.forEach((el) => {
        let newX = el.x;
        let newY = el.y;
        switch (type) {
          case "left": newX = minX; break;
          case "centerH": newX = avgCenterH - el.width / 2; break;
          case "right": newX = maxX - el.width; break;
          case "top": newY = minY; break;
          case "centerV": newY = avgCenterV - el.height / 2; break;
          case "bottom": newY = maxY - el.height; break;
        }
        updates[el.id] = { x: newX, y: newY };
      });
      if (Object.keys(updates).length)
        handleUpdateElements(Object.keys(updates), (el) => updates[el.id]);
    };

    const computeDistribute = (
      ids: string[],
      axis: "horizontal" | "vertical",
    ) => {
      const movable = elements.filter(
        (el) => ids.includes(el.id) && !el.isLocked,
      );
      if (movable.length <= 2) return;
      const updates: Record<string, Partial<UIElement>> = {};
      if (axis === "horizontal") {
        const sorted = [...movable].sort((a, b) => a.x - b.x);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const gap =
          (last.x + last.width - first.x -
            sorted.reduce((a, el) => a + el.width, 0)) /
          (sorted.length - 1);
        let cur = first.x;
        sorted.forEach((el, idx) => {
          if (idx !== 0 && idx !== sorted.length - 1) updates[el.id] = { x: cur };
          cur += el.width + gap;
        });
      } else {
        const sorted = [...movable].sort((a, b) => a.y - b.y);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const gap =
          (last.y + last.height - first.y -
            sorted.reduce((a, el) => a + el.height, 0)) /
          (sorted.length - 1);
        let cur = first.y;
        sorted.forEach((el, idx) => {
          if (idx !== 0 && idx !== sorted.length - 1) updates[el.id] = { y: cur };
          cur += el.height + gap;
        });
      }
      if (Object.keys(updates).length)
        handleUpdateElements(Object.keys(updates), (el) => updates[el.id]);
    };

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const { requestId, action } = detail;
      const args = detail.args && typeof detail.args === "object" ? detail.args : {};
      try {
        switch (action) {
          case "getTextures":
            respond(requestId, { result: textures });
            return;
          case "getAssets":
            respond(requestId, { result: assets });
            return;
          case "getCustomModules":
            respond(requestId, { result: customModules });
            return;
          case "addCustomModule": {
            const created = handleAddCustomModule(
              args.name ?? args.variant ?? args.label,
              args.code ?? args.customCode ?? args.html,
            );
            if (!created) {
              respond(requestId, { error: "addCustomModule requires a name and code" });
              return;
            }
            respond(requestId, { result: created });
            return;
          }
          case "setSelection":
            setSelectedElementIds(Array.isArray(args.ids) ? args.ids : []);
            break;
          case "reorderElement":
            if (args.id && args.direction)
              handleReorderElement(args.id, args.direction);
            break;
          case "reorderElementTo":
            if (args.id && typeof args.index === "number")
              handleReorderTo(args.id, args.index);
            break;
          case "alignElements":
            if (Array.isArray(args.ids) && args.alignment)
              computeAlign(args.ids, args.alignment);
            break;
          case "distributeElements":
            if (Array.isArray(args.ids) && args.axis)
              computeDistribute(args.ids, args.axis);
            break;
          case "groupElements": {
            const ids: string[] = Array.isArray(args.ids) ? args.ids : [];
            const toGroup = elements.filter(
              (el) => ids.includes(el.id) && !el.groupId,
            );
            if (toGroup.length > 1) {
              const minX = Math.min(...toGroup.map((el) => el.x));
              const minY = Math.min(...toGroup.map((el) => el.y));
              const maxX = Math.max(...toGroup.map((el) => el.x + el.width));
              const maxY = Math.max(...toGroup.map((el) => el.y + el.height));
              const groupId = Math.random().toString(36).substring(2, 9);
              const groupElement: UIElement = {
                id: groupId,
                name: `Group_${elements.length + 1}`,
                type: "Group",
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
                childrenIds: toGroup.map((el) => el.id),
              };
              setElements((prev) => {
                const next = [...prev];
                toGroup.forEach((tg) => {
                  const idx = next.findIndex((n) => n.id === tg.id);
                  if (idx !== -1)
                    next[idx] = {
                      ...next[idx],
                      groupId,
                      x: next[idx].x - minX,
                      y: next[idx].y - minY,
                    };
                });
                return [...next, groupElement];
              });
              setSelectedElementIds([groupId]);
              respond(requestId, { result: groupElement });
              return;
            }
            respond(requestId, {
              error: "groupElements needs 2+ ungrouped elements",
            });
            return;
          }
          case "ungroupElements": {
            const groupId = args.groupId;
            setElements((prev) => {
              const group = prev.find(
                (el) => el.id === groupId && el.type === "Group",
              );
              if (!group) return prev;
              return prev
                .map((el) =>
                  el.groupId === groupId
                    ? {
                        ...el,
                        groupId: undefined,
                        x: el.x + group.x,
                        y: el.y + group.y,
                      }
                    : el,
                )
                .filter((el) => el.id !== groupId);
            });
            break;
          }
          case "undo":
            undo();
            break;
          case "redo":
            redo();
            break;
          case "setTheme":
            if (args.themeId) setCurrentTheme(args.themeId);
            break;
          case "setFontScale":
            if (typeof args.scale === "number") setFontScale(args.scale);
            break;
          default:
            respond(requestId, { error: `Unhandled AI action: ${action}` });
            return;
        }
        respond(requestId, { result: { ok: true } });
      } catch (err: any) {
        respond(requestId, { error: err?.message || String(err) });
      }
    };

    window.addEventListener("vst-ai-action", handler as EventListener);
    return () =>
      window.removeEventListener("vst-ai-action", handler as EventListener);
  }, [elements, textures, assets, canvasState, customModules, undo, redo]);

  const isPreview = canvasState.isPreviewMode;

  useEffect(() => {
    if (isPreview) {
      setSelectedElementIds([]);
    }
  }, [isPreview]);

  // The left sidebar (component categories + palette) collapses and expands as
  // a single unit via its edge handlebar, mirroring the removed header toggle.
  const isLeftOpen = isCategoriesOpen || isExplorerOpen;
  const toggleLeftPanel = () => {
    const anyOpen = isCategoriesOpen || isExplorerOpen;
    setIsCategoriesOpen(!anyOpen);
    setIsExplorerOpen(!anyOpen);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#050507] p-0 sm:p-1.5 lg:p-2 overflow-hidden font-sans relative">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808008_1px,transparent_1px),linear-gradient(to_bottom,#80808008_1px,transparent_1px)] bg-[size:32px_32px]"></div>

      <div className="flex flex-col flex-1 w-full bg-app-base text-app-main rounded-xl overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.8)] border border-app-border/60 relative z-10">
        <div className="shrink-0">
          <div
            className={`grid transition-[grid-template-rows] duration-300 ${isHeaderOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
          >
            <div className="overflow-hidden">
              <Header
                canvasState={canvasState}
                onUpdateCanvas={(updates) =>
                  setCanvasState((prev) => ({ ...prev, ...updates }))
                }
                onExport={() => setIsExportModalOpen(true)}
                onClear={() => setConfirmClearOpen(true)}
                hasElements={elements.length > 0}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={undo}
                onRedo={redo}
                onSaveProject={() => setSaveProjectOpen(true)}
                onDownloadProject={handleDownloadProject}
                onExportPackage={handleExportPackage}
                onOpenProjects={() => setIsLibraryOpen(true)}
                onOpenSettings={() => setIsSettingsOpen(true)}
                onOpenExtractor={() => setIsExtractorOpen(true)}
                onOpenGan={() => ganInputRef.current?.click()}
              />
            </div>
          </div>
          {/* Horizontal edge handlebar — collapses the toolbar upward. Stays
              visible at the top of the canvas area when the header is closed. */}
          <div className="flex justify-center shrink-0">
            <button
              type="button"
              onClick={() => setIsHeaderOpen(!isHeaderOpen)}
              aria-label={isHeaderOpen ? "Collapse toolbar" : "Expand toolbar"}
              aria-expanded={isHeaderOpen}
              title={isHeaderOpen ? "Collapse toolbar" : "Expand toolbar"}
              className="flex items-center justify-center w-16 h-3.5 rounded-b-md border border-t-0 border-app-border bg-app-base text-app-muted hover:bg-app-surface-hover hover:text-white transition-colors shadow-[0_8px_24px_rgba(0,0,0,0.4)] cursor-pointer z-30"
            >
              {isHeaderOpen ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden relative min-h-0">
          {!isPreview && (
            <div className="flex shrink-0 min-h-0 z-20 h-full">
              <div
                className={`flex flex-col bg-app-base min-h-0 transition-all duration-300 overflow-hidden ${isLeftOpen ? "w-auto" : "w-0"}`}
              >
                <div className="flex flex-col h-full">
                  <Sidebar
                    onDragStart={handleDragStart}
                    customModules={customModules}
                    onAddCustomModule={handleAddCustomModule}
                    arsenal={arsenal}
                    onRemoveArsenal={handleRemoveArsenal}
                    isCategoriesOpen={isCategoriesOpen}
                    isExplorerOpen={isExplorerOpen}
                  />
                </div>
              </div>
              {/* Edge handlebar — collapses the component palette leftward.
                  Stays visible at the screen edge when collapsed. */}
              <button
                type="button"
                onClick={toggleLeftPanel}
                aria-label={
                  isLeftOpen
                    ? "Collapse components panel"
                    : "Expand components panel"
                }
                aria-expanded={isLeftOpen}
                title={
                  isLeftOpen
                    ? "Collapse components panel"
                    : "Expand components panel"
                }
                className="flex items-center justify-center w-4 shrink-0 self-stretch border-r border-app-border bg-app-base text-app-muted hover:bg-app-surface-hover hover:text-white transition-colors shadow-[8px_0_32px_rgba(0,0,0,0.8)] cursor-pointer z-30"
              >
                {isLeftOpen ? (
                  <ChevronLeft className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>
            </div>
          )}

          <Canvas
            canvasState={canvasState}
            elements={elements}
            assets={assets}
            textures={textures}
            selectedElementIds={selectedElementIds}
            activeTool={activeTool}
            onSetActiveTool={setActiveTool}
            onUpdateCanvas={(updates) =>
              setCanvasState((prev) => ({ ...prev, ...updates }))
            }
            onDrop={handleDropElement}
            onUpdateElements={handleUpdateElements}
            onSelectElements={handleSelectElements}
            onRegisterParams={handleRegisterParams}
            onParamValueChange={handleParamValueChange}
            onContextMenu={(x, y, elementId) => {
              // Right-clicking an unselected element selects it (standard UX),
              // so every menu action operates on the current selection.
              if (elementId && !selectedElementIds.includes(elementId)) {
                setSelectedElementIds([elementId]);
              }
              setContextMenu({
                x,
                y,
                type: elementId ? "element" : "canvas",
                elementId,
                mode: "menu",
              });
            }}
          />

          {!isPreview && (
            <div className="flex shrink-0 min-h-0 z-20 h-full">
              {/* Edge handlebar — collapses the right panel rightward.
                  Stays visible at the screen edge when collapsed. */}
              <button
                type="button"
                onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
                aria-label={
                  isRightPanelOpen
                    ? "Collapse layers panel"
                    : "Expand layers panel"
                }
                aria-expanded={isRightPanelOpen}
                title={
                  isRightPanelOpen
                    ? "Collapse layers panel"
                    : "Expand layers panel"
                }
                className="flex items-center justify-center w-4 shrink-0 self-stretch border-l border-app-border bg-app-base text-app-muted hover:bg-app-surface-hover hover:text-white transition-colors shadow-[-8px_0_32px_rgba(0,0,0,0.8)] cursor-pointer z-30"
              >
                {isRightPanelOpen ? (
                  <ChevronRight className="w-4 h-4" />
                ) : (
                  <ChevronLeft className="w-4 h-4" />
                )}
              </button>
              <div
                className={`flex flex-col bg-app-base h-full min-h-0 transition-all duration-300 overflow-hidden ${isRightPanelOpen ? "w-auto" : "w-0"}`}
              >
                <div className="w-72 md:w-80 flex flex-col h-full min-h-0 overflow-y-auto">
                  <LayersPanel
                    elements={elements}
                    assets={assets}
                    selectedElementIds={selectedElementIds}
                    onSelectElement={(id, multi) => {
                      if (multi) {
                        setSelectedElementIds((prev) =>
                          prev.includes(id)
                            ? prev.filter((i) => i !== id)
                            : [...prev, id],
                        );
                      } else {
                        setSelectedElementIds([id]);
                      }
                    }}
                    onReorder={handleReorderElement}
                    onReorderTo={handleReorderTo}
                  />
                  <AssetManager
                    assets={assets}
                    onAddAsset={(asset) =>
                      setAssets((prev) => [...prev, asset])
                    }
                    onDeleteAsset={(id) =>
                      setAssets((prev) => prev.filter((a) => a.id !== id))
                    }
                    onOpenGenerateModal={() => {
                      setGenerateTarget("asset");
                      setIsGenerateModalOpen(true);
                    }}
                    onAddToCanvas={(asset) => {
                      const img = new window.Image();
                      img.onload = () => {
                        const w = img.width || 100;
                        const h = img.height || 100;
                        // Put it roughly in center of view
                        const x =
                          (-canvasState.panX + window.innerWidth / 2 - 150) /
                            canvasState.scale -
                          w / 2;
                        const y =
                          (-canvasState.panY + window.innerHeight / 2 - 50) /
                            canvasState.scale -
                          h / 2;
                        handleDropElement("Image", x, y, w, h, asset.id);
                      };
                      img.src = asset.url;
                    }}
                  />
                  <TextureManager
                    textures={textures}
                    onAddTexture={(texture) =>
                      setTextures((prev) => [...prev, texture])
                    }
                    onDeleteTexture={(id) =>
                      setTextures((prev) => prev.filter((t) => t.id !== id))
                    }
                    onOpenGenerateModal={() => {
                      setGenerateTarget("texture");
                      setIsGenerateModalOpen(true);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <ExportModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          elements={elements}
          canvasState={canvasState}
          assets={assets}
          textures={textures}
          customModules={customModules}
        />

        {/* Hidden picker for opening a .gan plugin to continue editing it. */}
        <input
          ref={ganInputRef}
          id="gan-import-input"
          name="gan-import-input"
          aria-label="Open .gan plugin file"
          type="file"
          accept=".gan"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportGanFile(file);
            e.target.value = "";
          }}
        />

        <ProjectLibraryModal
          isOpen={isLibraryOpen}
          onClose={() => setIsLibraryOpen(false)}
          projects={savedProjects}
          onLoadProject={handleLoadProject}
          onDeleteProject={handleDeleteProject}
        />
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          fontScale={fontScale}
          setFontScale={setFontScale}
          colorblindMode={colorblindMode}
          setColorblindMode={setColorblindMode}
          currentTheme={currentTheme}
          setTheme={setCurrentTheme}
        />

        <TextureGenerateModal
          isOpen={isGenerateModalOpen}
          onClose={() => setIsGenerateModalOpen(false)}
          target={generateTarget}
          onTexturesGenerated={(newTextures) =>
            setTextures((prev) => [...prev, ...newTextures])
          }
          onAssetsGenerated={(newAssets) =>
            setAssets((prev) => [...prev, ...newAssets])
          }
        />

        <ExtractorModal
          isOpen={isExtractorOpen}
          onClose={() => setIsExtractorOpen(false)}
          sourceImage={canvasState.backgroundImage}
          onAddAssets={handleExtractorAddAssets}
          onPlaceLayers={handleExtractorPlaceLayers}
          onAddTextures={(newTextures) =>
            setTextures((prev) => [...prev, ...newTextures])
          }
        />

        <ConfirmModal
          isOpen={confirmClearOpen}
          title="Clear Canvas"
          message="Are you sure you want to clear all elements? This cannot be undone."
          onConfirm={() => {
            clearHistory([]);
            setSelectedElementIds([]);
            setConfirmClearOpen(false);
          }}
          onCancel={() => setConfirmClearOpen(false)}
          confirmText="Clear All"
        />

        <PromptModal
          isOpen={saveProjectOpen}
          title="Save Project"
          message="Enter a name for your project:"
          defaultValue="My Project"
          onConfirm={handleSaveProject}
          onCancel={() => setSaveProjectOpen(false)}
          confirmText="Save"
        />

        <ConfirmModal
          isOpen={deleteProjectId !== null}
          title="Delete Project"
          message="Are you sure you want to delete this project?"
          onConfirm={executeDeleteProject}
          onCancel={() => setDeleteProjectId(null)}
          confirmText="Delete"
        />

        <ConfirmModal
          isOpen={loadProjectTarget !== null}
          title="Load Project"
          message="Loading a project will replace your current work. Continue?"
          onConfirm={() => {
            if (loadProjectTarget) executeLoadProject(loadProjectTarget);
          }}
          onCancel={() => setLoadProjectTarget(null)}
          confirmText="Load Project"
        />

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            actions={
              contextMenu.type === "element"
                ? contextMenu.mode === "menu"
                  ? [
                      // Compact action list — the actual right-click menu. The
                      // full properties editor is opt-in via "Editor".
                      {
                        label: "Editor",
                        icon: <SquarePen className="w-4 h-4" />,
                        keepOpen: true,
                        onClick: () =>
                          setContextMenu((prev) =>
                            prev ? { ...prev, mode: "editor" } : prev,
                          ),
                      },
                      ...(elements.find((e) => e.id === contextMenu.elementId)
                        ?.type === "Image"
                        ? [
                            {
                              label: elements.find(
                                (e) => e.id === contextMenu.elementId,
                              )?.imageModifiers?.removeBg
                                ? "Restore Background"
                                : "Remove Background",
                              icon: <Image className="w-4 h-4" />,
                              onClick: async () => {
                                if (contextMenu.elementId) {
                                  const el = elements.find(
                                    (e) => e.id === contextMenu.elementId,
                                  );
                                  if (el) {
                                    const currentBgEnabled =
                                      el.imageModifiers?.removeBg || false;
                                    setElements(
                                      elements.map((e) =>
                                        e.id === el.id
                                          ? {
                                              ...e,
                                              imageModifiers: {
                                                ...(e.imageModifiers || {}),
                                                removeBg: !currentBgEnabled,
                                                tolerance:
                                                  e.imageModifiers?.tolerance ||
                                                  30,
                                              },
                                            }
                                          : e,
                                      ),
                                    );
                                  }
                                }
                              },
                            },
                            {
                              label: "Remove Object (Inpaint)…",
                              icon: <Sparkles className="w-4 h-4" />,
                              onClick: () => {
                                const el = elements.find(
                                  (e) => e.id === contextMenu.elementId,
                                );
                                const url = assets.find(
                                  (a) => a.id === el?.assetId,
                                )?.url;
                                if (el && url) {
                                  setInpaintTarget({
                                    elementId: el.id,
                                    imageUrl: url,
                                    name: el.name,
                                  });
                                }
                              },
                            },
                          ]
                        : []),
                      { divider: true, label: "1", onClick: () => {} },
                      {
                        label: "Cut",
                        icon: <Scissors className="w-4 h-4" />,
                        shortcut: "Ctrl+X",
                        onClick: () => {
                          cutSelection();
                        },
                      },
                      {
                        label: "Copy",
                        icon: <Copy className="w-4 h-4" />,
                        shortcut: "Ctrl+C",
                        onClick: () => {
                          copyFromMenu();
                        },
                      },
                      {
                        label: "Duplicate",
                        icon: <CopyPlus className="w-4 h-4" />,
                        onClick: () => {
                          duplicateFromMenu();
                        },
                      },
                      { divider: true, label: "2", onClick: () => {} },
                      {
                        label: "Flip Horizontal",
                        icon: <FlipHorizontal2 className="w-4 h-4" />,
                        onClick: () => toggleFlipSelected("flipX"),
                      },
                      {
                        label: "Flip Vertical",
                        icon: <FlipVertical2 className="w-4 h-4" />,
                        onClick: () => toggleFlipSelected("flipY"),
                      },
                      {
                        label: "Flip Z (Rotate 180°)",
                        icon: <RotateCw className="w-4 h-4" />,
                        onClick: rotateSelected180,
                      },
                      {
                        label: elements.find(
                          (e) => e.id === contextMenu.elementId,
                        )?.isLocked
                          ? "Unlock"
                          : "Lock",
                        icon: elements.find(
                          (e) => e.id === contextMenu.elementId,
                        )?.isLocked ? (
                          <Unlock className="w-4 h-4" />
                        ) : (
                          <Lock className="w-4 h-4" />
                        ),
                        onClick: () =>
                          toggleLockFromMenu(contextMenu.elementId!),
                      },
                      { divider: true, label: "3", onClick: () => {} },
                      {
                        label: "Move Forward",
                        icon: <ChevronUp className="w-4 h-4" />,
                        onClick: () => {
                          if (contextMenu.elementId)
                            handleReorderElement(contextMenu.elementId, "up");
                        },
                      },
                      {
                        label: "Move Backward",
                        icon: <ChevronDown className="w-4 h-4" />,
                        onClick: () => {
                          if (contextMenu.elementId)
                            handleReorderElement(contextMenu.elementId, "down");
                        },
                      },
                      {
                        label: "Move to Front",
                        icon: <ChevronsUp className="w-4 h-4" />,
                        onClick: () => {
                          if (contextMenu.elementId)
                            handleReorderElement(contextMenu.elementId, "top");
                        },
                      },
                      {
                        label: "Move to Back",
                        icon: <ChevronsDown className="w-4 h-4" />,
                        onClick: () => {
                          if (contextMenu.elementId)
                            handleReorderElement(
                              contextMenu.elementId,
                              "bottom",
                            );
                        },
                      },
                      { divider: true, label: "4", onClick: () => {} },
                      {
                        label: "Add to Chat",
                        icon: <MessageSquarePlus className="w-4 h-4" />,
                        onClick: addSelectionToChat,
                      },
                      { divider: true, label: "5", onClick: () => {} },
                      {
                        label: "Delete",
                        icon: <Trash className="w-4 h-4" />,
                        danger: true,
                        shortcut: "Del",
                        onClick: deleteSelectedFromMenu,
                      },
                    ]
                  : [
                      // Editor mode — quick-action icon toolbar under the
                      // properties panel (the pre-menu popup experience).
                      {
                        label: "Copy",
                        icon: <Copy className="w-4 h-4" />,
                        iconOnly: true,
                        onClick: () => {
                          copyFromMenu();
                        },
                      },
                      {
                        label: "Duplicate",
                        icon: <CopyPlus className="w-4 h-4" />,
                        iconOnly: true,
                        onClick: () => {
                          duplicateFromMenu();
                        },
                      },
                      {
                        label: "Delete",
                        icon: <Trash className="w-4 h-4" />,
                        danger: true,
                        iconOnly: true,
                        onClick: deleteSelectedFromMenu,
                      },
                      {
                        label: elements.find(
                          (e) => e.id === contextMenu.elementId,
                        )?.isLocked
                          ? "Unlock"
                          : "Lock",
                        icon: elements.find(
                          (e) => e.id === contextMenu.elementId,
                        )?.isLocked ? (
                          <Unlock className="w-4 h-4" />
                        ) : (
                          <Lock className="w-4 h-4" />
                        ),
                        iconOnly: true,
                        onClick: () =>
                          toggleLockFromMenu(contextMenu.elementId!),
                      },
                      {
                        label: "Bring to Front",
                        icon: <ArrowUp className="w-4 h-4" />,
                        iconOnly: true,
                        onClick: () => {
                          if (contextMenu.elementId)
                            handleReorderTo(
                              contextMenu.elementId,
                              elements.length - 1,
                            );
                        },
                      },
                      {
                        label: "Send to Back",
                        icon: <ArrowDown className="w-4 h-4" />,
                        iconOnly: true,
                        onClick: () => {
                          if (contextMenu.elementId)
                            handleReorderTo(contextMenu.elementId, 0);
                        },
                      },
                    ]
                : [
                    {
                      label: "Paste",
                      icon: <ClipboardPaste className="w-4 h-4" />,
                      disabled: clipboard.length === 0,
                      onClick: () => {
                        pasteFromMenu();
                      },
                    },
                    {
                      label: "Select All",
                      icon: <Layers className="w-4 h-4" />,
                      disabled: elements.length === 0,
                      onClick: () => {
                        setSelectedElementIds(elements.map((e) => e.id));
                      },
                    },
                  ]
            }
          >
            {contextMenu.type === "element" &&
              contextMenu.mode === "editor" &&
              contextMenu.elementId &&
              elements.some((e) => e.id === contextMenu.elementId) && (
                <div className="border-b border-app-border mb-1 pb-1">
                  <CompactElementProperties
                    element={
                      elements.find((e) => e.id === contextMenu.elementId)!
                    }
                    elements={elements}
                    onUpdateElements={handleUpdateElements}
                    textures={textures}
                  />
                </div>
              )}
          </ContextMenu>
        )}
        {inpaintTarget && (
          <InpaintModal
            imageUrl={inpaintTarget.imageUrl}
            title={inpaintTarget.name}
            onApply={(dataUrl) =>
              handleInpaintApply(inpaintTarget.elementId, dataUrl)
            }
            onClose={() => setInpaintTarget(null)}
          />
        )}
        <AIAssistantOrb
          elements={elements}
          setElements={setElements}
          canvasState={canvasState}
          setCanvasState={setCanvasState}
          onRegisterModule={handleAddCustomModule}
        />
        <EventLog />
      </div>
    </div>
  );
}
