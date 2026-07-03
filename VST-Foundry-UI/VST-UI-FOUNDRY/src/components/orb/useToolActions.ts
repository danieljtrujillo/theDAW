import type React from "react";
import type { UIElement, CanvasState, CustomParam } from "../../types";
import { ELEMENT_TYPES } from "../../types";
import { normalizeElementType, coerceNumericElementFields } from "./elements";
import { sanitizeCustomParams } from "../../lib/customParams";
import { customCodeDiagnostics } from "../../lib/customCodeBridge";
import { generateCanvasScreenshot } from "../../lib/canvasMockup";
import { annotationBounds } from "../canvas/AnnotationLayer";
// Namespace imports so we can feature-detect the listen-side exports a
// concurrent agent is still landing on dawControlBus without a static import of a
// symbol that may not exist yet (which would break tsc).
import * as bus from "../../lib/dawControlBus";
import * as routing from "../../lib/routing";
import { VST_BINDS } from "../../lib/vstBinds";
import { startVstBindRuntime } from "../../lib/vstBindRuntime";

// ---------------------------------------------------------------------------
// Client-side tool execution + MCP relay (Claude Code)
// ---------------------------------------------------------------------------
//
// Tool calls arrive as SSE "client_tool_call" frames. The browser owns the
// canvas/app state, so it executes the tool locally and — for Claude Code —
// POSTs the result back to /api/mcp-relay/result, which lets mcp-server.cjs
// return it to the CLI. Element CRUD and canvas tools run directly against the
// orb's props; tools whose data/handlers live in App.tsx are delegated via a
// window "vst-ai-action" event.
//
// App.tsx contract:
//   - Listen for window "vst-ai-action" events. detail = {
//       requestId, toolCallId, action, args, ...args (flattened for convenience)
//     }
//   - For READ actions (getAssets, getTextures), respond by dispatching a
//     window "vst-ai-action-result" event with detail = { requestId, result }
//     (or { requestId, error }). Mutations need no response.

export interface UseToolActionsParams {
  // LIVE-STATE MIRRORS — see AIAssistantOrb. Tool handlers can run from an SSE
  // closure captured at mount, so they resolve against these refs (kept fresh
  // every render) rather than a frozen props snapshot.
  elementsRef: React.RefObject<UIElement[]>;
  canvasStateRef: React.RefObject<CanvasState>;
  // Provider-agnostic relay session id target for relayToolResult.
  toolSessionIdRef: React.RefObject<string | null>;
  setElements: React.Dispatch<React.SetStateAction<UIElement[]>>;
  setCanvasState: React.Dispatch<React.SetStateAction<CanvasState>>;
  setStatusText: React.Dispatch<React.SetStateAction<string | null>>;
  onRegisterModule?: (
    name: string,
    code: string,
    params?: CustomParam[],
  ) => void;
}

export function useToolActions({
  elementsRef,
  canvasStateRef,
  toolSessionIdRef,
  setElements,
  setCanvasState,
  setStatusText,
  onRegisterModule,
}: UseToolActionsParams) {
  // Tools whose data/handlers live in App.tsx (not passed to the orb as props).
  const APP_READ_TOOLS = ["getAssets", "getTextures", "getCustomModules"];
  const APP_MUTATION_TOOLS = [
    "reorderElement",
    "reorderElementTo",
    "groupElements",
    "ungroupElements",
    "setSelection",
    "alignElements",
    "distributeElements",
    "undo",
    "redo",
    "setTheme",
    "setFontScale",
    "addCustomModule",
  ];

  // POST a client tool result back to the relay so the streaming loop can
  // continue. Used by every provider that loops over tool calls (Claude CLI and
  // the direct-API providers). No-op until a session id has arrived.
  const relayToolResult = async (
    toolCallId: string,
    payload: { result?: any; error?: string; imageData?: string }
  ) => {
    const sessionId = toolSessionIdRef.current;
    if (!sessionId || !toolCallId) return;
    try {
      await fetch("/api/mcp-relay/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, toolCallId, ...payload }),
      });
    } catch (e) {
      console.error("Failed to POST MCP relay result", e);
    }
  };

  // Delegate an operation to App.tsx via a window event. Read tools wait for an
  // answering "vst-ai-action-result" event (keyed by requestId); mutations
  // resolve optimistically so the relay never blocks on an acknowledgement.
  const dispatchAppAction = (
    name: string,
    args: any,
    toolCallId: string | undefined,
    expectResult: boolean,
    fallback: any
  ): Promise<any> =>
    new Promise((resolve) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onResult = (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
        if (detail.requestId !== requestId) return;
        finish(detail.error ? { error: detail.error } : detail.result ?? { ok: true });
      };

      function finish(val: any) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        window.removeEventListener("vst-ai-action-result", onResult as EventListener);
        resolve(val);
      }

      const safeArgs =
        args && typeof args === "object" && !Array.isArray(args) ? args : {};

      if (expectResult) {
        window.addEventListener("vst-ai-action-result", onResult as EventListener);
        timer = setTimeout(() => finish(fallback), 4000);
      }

      window.dispatchEvent(
        new CustomEvent("vst-ai-action", {
          detail: { requestId, toolCallId, action: name, args, ...safeArgs },
        })
      );

      if (!expectResult) finish(fallback);
    });

  // Execute a single client tool and return its result payload.
  const executeClientTool = async (
    name: string,
    rawArgs: any,
    toolCallId?: string
  ): Promise<any> => {
    const args = rawArgs || {};

    // ----- READ (local props) -----
    if (name === "getElements") {
      const ids: string[] | undefined =
        Array.isArray(args.ids) && args.ids.length ? args.ids : undefined;
      const live = elementsRef.current;
      const result = ids ? live.filter((el) => ids.includes(el.id)) : live;
      setStatusText(`Read ${result.length} element(s).`);
      return result;
    }

    if (name === "getCanvasState") {
      setStatusText("Read canvas state.");
      return canvasStateRef.current;
    }

    // The user's hand-drawn annotations (freehand strokes, rect/ellipse shapes,
    // text notes) in canvas coordinates, plus the color legend mapping colors
    // to intended element types. A legend-colored shape is a placement
    // instruction: "put that element here, this size".
    if (name === "getAnnotations") {
      const cs = canvasStateRef.current;
      const legend = cs.annotationLegend || [];
      const meaningFor = (color: string) =>
        legend.find((l) => l.color.toLowerCase() === color.toLowerCase())?.meaning || null;
      // Shared loop-based bounds (never Math.min(...spread) — a long freehand
      // stroke has thousands of points and would blow the JS argument limit).
      const bounds = (a: Parameters<typeof annotationBounds>[0]) => {
        const b = annotationBounds(a);
        return {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height),
        };
      };
      const annotations = (cs.annotations || []).map((a) => ({
        id: a.id,
        kind: a.kind,
        color: a.color,
        meaning: meaningFor(a.color),
        bounds: bounds(a),
        ...(a.kind === "text" ? { text: a.text } : {}),
      }));
      setStatusText(`Read ${annotations.length} annotation(s).`);
      return {
        visible: cs.showAnnotations !== false,
        legend,
        count: annotations.length,
        annotations,
        note:
          "Coordinates are canvas px (same space as element x/y). A shape whose color has a legend meaning is a placement instruction for that element type at those bounds. Text notes are free-form instructions anchored at their position.",
      };
    }

    // REAL on-screen geometry: reads each element's actual rendered DOM rect and
    // maps it back to canvas coordinates (un-zoomed against the canvas root).
    // Lets the model verify where things truly land vs the model's x/y — catches
    // rotation, overflow, and layout drift the data model alone can't show.
    if (name === "getRenderedGeometry") {
      const ids =
        Array.isArray(args.ids) && args.ids.length ? new Set<string>(args.ids) : null;
      const root = document.querySelector(
        '[data-vst-canvas="root"]'
      ) as HTMLElement | null;
      const rootRect = root?.getBoundingClientRect();
      const scale = canvasStateRef.current.scale || 1;
      const nodes = Array.from(
        document.querySelectorAll("[data-element-id]")
      ) as HTMLElement[];
      const out = nodes
        .filter((n) => !ids || ids.has(n.getAttribute("data-element-id") || ""))
        .map((n) => {
          const id = n.getAttribute("data-element-id") || "";
          const r = n.getBoundingClientRect();
          const model = elementsRef.current.find((e) => e.id === id);
          const canvasX = rootRect ? (r.left - rootRect.left) / scale : null;
          const canvasY = rootRect ? (r.top - rootRect.top) / scale : null;
          return {
            id,
            name: model?.name,
            type: model?.type,
            model: model
              ? { x: model.x, y: model.y, width: model.width, height: model.height, rotation: model.rotation || 0 }
              : null,
            rendered: {
              screen: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
              canvas:
                canvasX != null
                  ? { x: Math.round(canvasX), y: Math.round(canvasY!), width: Math.round(r.width / scale), height: Math.round(r.height / scale) }
                  : null,
            },
          };
        });
      setStatusText(`Measured ${out.length} element(s).`);
      return {
        canvas: { width: canvasStateRef.current.width, height: canvasStateRef.current.height, scale },
        elements: out,
      };
    }

    // Group/layer hierarchy + z-order (array order == paint/layer index).
    if (name === "getElementTree") {
      const els = elementsRef.current;
      const byId = new Map(els.map((e) => [e.id, e]));
      const node = (e: UIElement): any => ({
        id: e.id,
        name: e.name,
        type: e.type,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        locked: !!e.isLocked,
        // Surface custom-code existence so layout reads stop hiding these
        // elements' nature — the model can spot them (and their param count)
        // without pulling full source via getCustomCode.
        ...(e.type === "CustomCode"
          ? { hasCustomCode: !!e.customCode, paramCount: e.params?.length ?? 0 }
          : {}),
        children: (e.childrenIds || [])
          .map((cid) => byId.get(cid))
          .filter(Boolean)
          .map((c) => node(c as UIElement)),
      });
      const roots = els.filter((e) => !e.groupId).map(node);
      const zOrder = els.map((e, i) => ({ index: i, id: e.id, name: e.name, type: e.type }));
      setStatusText("Read element tree.");
      return { count: els.length, roots, zOrder };
    }

    // Full, never-truncated source of one CustomCode element, plus its params,
    // fit mode, and any runtime diagnostics the sandboxed code reported (errors
    // it threw) — so the model edits the real current source and can see whether
    // its last edit broke the element.
    if (name === "getCustomCode") {
      const id: string = args.id;
      const el = elementsRef.current.find((e) => e.id === id);
      if (!el) {
        setStatusText(`getCustomCode: no element with id ${id}.`);
        return { error: `No element with id ${id}` };
      }
      if (el.type !== "CustomCode") {
        setStatusText(`getCustomCode: element ${id} is a ${el.type}, not CustomCode.`);
        return { error: `Element ${id} is a ${el.type}, not a CustomCode element` };
      }
      setStatusText(`Read custom code for "${el.name}".`);
      return {
        id: el.id,
        name: el.name,
        customCode: el.customCode ?? "",
        params: el.params ?? [],
        customCodeFit: el.customCodeFit ?? "scale",
        diagnostics: customCodeDiagnostics.get(el.id) ?? [],
      };
    }

    if (name === "captureCanvasScreenshot") {
      setStatusText("Capturing canvas screenshot...");
      // PRIMARY: real OS capture of the live window — true composited pixels,
      // including CustomCode (sandboxed iframes) that the old mockup could never
      // render. Cropped to the canvas region when geometry is resolvable.
      try {
        const resp = await fetch("/api/screen-capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data?.dataUrl) {
            setStatusText(null);
            return data.dataUrl;
          }
        }
      } catch (e) {
        console.warn("Real screen capture failed, falling back to mockup", e);
      }
      // FALLBACK: synthetic redraw — now from LIVE refs (no longer stale), but
      // still cannot show CustomCode. Only used if the OS capture is unavailable.
      const dataUrl = await generateCanvasScreenshot(
        elementsRef.current,
        canvasStateRef.current.width,
        canvasStateRef.current.height,
        canvasStateRef.current.backgroundImage,
        canvasStateRef.current.showAnnotations !== false
          ? canvasStateRef.current.annotations
          : undefined
      );
      setStatusText(null);
      return dataUrl;
    }

    // Complete map of the binding/modulation system the agent needs BEFORE it
    // wires anything: the live theDAW target manifest (write + listen), which
    // target kinds each element TYPE may bind/listen to, element→element route
    // destinations, the route-processing options, and every current route. Reads
    // from the theDAW control bus (dawControlBus) and the routing engine
    // (routing) — never writes.
    if (name === "getBindingCapabilities") {
      const includeCurrentRoutes = args.includeCurrentRoutes !== false; // default true
      // Warm the bus so its manifest snapshot is populated for this read. The
      // built-in bind runtime rides along so `vst:` wiring the agent performs
      // is live immediately.
      try {
        bus.startDawControlBus();
        startVstBindRuntime();
      } catch {
        /* already running or unavailable — the snapshot read below stays safe */
      }
      // Bounded wait for the first manifest: right after app load the socket
      // may still be handshaking, and answering with an empty capability map
      // would mislead the agent (the system prompt tells it to call this
      // FIRST). Poll the snapshot briefly; never longer than ~1.5s.
      let snap = bus.getDawBusSnapshot();
      for (let i = 0; i < 5 && snap.targets.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        snap = bus.getDawBusSnapshot();
      }
      const targets = Array.isArray(snap.targets) ? snap.targets : [];

      const writeRules: Record<string, string[]> = {};
      const listenRules: Record<string, string[]> = {};
      const routeSources: Record<string, string[]> = {};
      // ELEMENT_TYPES is the compiler-enforced source of truth — a new element
      // type lands in these maps automatically (review: the previous
      // hand-copied list could silently go stale).
      for (const t of ELEMENT_TYPES) {
        const kinds = bus.bindableKindsFor(t);
        if (kinds && kinds.length) writeRules[t] = kinds;
        const lk = bus.listenKindsFor(t);
        if (lk && lk.length) listenRules[t] = lk;
        const axes = routing.sourceAxesFor(t);
        if (axes.length) routeSources[t] = axes;
      }

      // Full live manifest — every theDAW target (write + listen). `readonly`
      // marks input-only sources (sway/pose): listen-capable, never drivable.
      const dawTargets = targets.map((t) => ({
        id: t.id,
        area: t.area,
        group: t.group,
        label: t.label,
        kind: t.kind,
        min: t.min,
        max: t.max,
        step: t.step,
        unit: t.unit,
        readonly: !!t.readonly,
      }));

      // Built-in VST bind catalog (src/lib/vstBinds.ts) — always available,
      // independent of theDAW's live manifest: MIDI (CC/notes/bend/AT/program),
      // transport, plugin master, presets, macros, LFOs, metering. Same
      // routing/dispatch semantics as dawTargets; ids are namespaced `vst:`.
      const builtinVstTargets = VST_BINDS.map((t) => ({
        id: t.id,
        area: t.area,
        group: t.group,
        label: t.label,
        kind: t.kind,
        min: t.min,
        max: t.max,
        step: t.step,
        unit: t.unit,
        readonly: !!t.readonly,
        listen: !!t.listen,
        previewLive: !!t.preview,
      }));

      // Canvas elements that can RECEIVE an element-to-element route.
      const live = elementsRef.current;
      const elementDestinations = live
        .map((el) => ({ el, props: routing.elementDestProps(el.type) }))
        .filter((entry) => entry.props.length > 0)
        .map(({ el, props }) => ({
          elementId: el.id,
          name: el.name,
          type: el.type,
          props,
        }));

      const result: Record<string, any> = {
        busConnected: !!snap.connected,
        dawTargets,
        builtinVstTargets,
        writeRules,
        listenRules,
        routeSources,
        elementDestinations,
        routeProcessing: {
          amount: "-100..100, negative inverts",
          curve: ["linear", "exp", "log", "scurve"],
          range: "rangeMin/rangeMax 0-100",
        },
      };

      if (includeCurrentRoutes) {
        result.currentRoutes = live
          .map((el) => ({ el, routes: routing.routesOf(el) }))
          .filter((entry) => entry.routes.length > 0)
          .map(({ el, routes }) => ({
            elementId: el.id,
            name: el.name,
            type: el.type,
            routes,
          }));
      }

      setStatusText(
        `Read binding capabilities: ${dawTargets.length} theDAW + ${builtinVstTargets.length} built-in target(s), ${elementDestinations.length} route destination(s).`
      );
      return result;
    }

    // ----- ELEMENT CRUD (local props) -----
    if (name === "addElements") {
      const list = Array.isArray(args.elements) ? args.elements : [];
      const added: UIElement[] = list.map((el: any) => {
        const src: any = el && typeof el === "object" ? { ...el } : {};
        delete src.id;
        const legacyColor = src.color;
        delete src.color;
        const typeName = normalizeElementType(src.type);
        // Coerce top-level numeric fields the model may have sent as strings so
        // the default-value math (value = (min + max) / 2) and geometry never
        // string-concatenate — mirrors the sanitizeCustomParams coercion below.
        coerceNumericElementFields(src);
        return {
          ...src,
          id: Math.random().toString(36).substring(2, 9),
          type: typeName,
          name: src.name || `${typeName}_${Math.floor(Math.random() * 900) + 100}`,
          x: src.x !== undefined ? src.x : 120 + Math.random() * 150,
          y: src.y !== undefined ? src.y : 120 + Math.random() * 150,
          width: src.width !== undefined ? src.width : 80,
          height: src.height !== undefined ? src.height : 80,
          baseColor: src.baseColor ?? legacyColor,
          value: src.value !== undefined ? src.value : (((src.min ?? 0) + (src.max ?? 100)) / 2),
          // Coerce AI-provided param values (sent as strings for schema
          // validity) into real number/boolean/string types so window.PARAMS
          // is correct.
          params: src.params ? sanitizeCustomParams(src.params) : undefined,
        } as UIElement;
      });
      setElements((prev) => [...prev, ...added]);
      // Auto-persist any AI-authored CustomCode element to the reusable library
      // so it survives reloads and lands in the sidebar palette — mirrors the
      // manual "Save to Library" button in the properties panel.
      added.forEach((el) => {
        if (el.type === "CustomCode" && el.customCode && onRegisterModule) {
          onRegisterModule(el.name, el.customCode, el.params);
        }
      });
      setStatusText(`Added ${added.length} element(s).`);
      return added;
    }

    if (name === "updateElements") {
      let updatedIds: string[] = [];
      let updatedElements: UIElement[] = [];
      if (args.updates && !Array.isArray(args.updates) && Array.isArray(args.ids)) {
        // New MCP schema: one patch applied to every listed id.
        const ids: string[] = args.ids;
        const patch = { ...args.updates };
        coerceNumericElementFields(patch);
        updatedIds = ids;
        setElements((prev) =>
          prev.map((el) => (ids.includes(el.id) ? { ...el, ...patch } : el))
        );
        updatedElements = elementsRef.current
          .filter((el) => ids.includes(el.id))
          .map((el) => ({ ...el, ...patch }));
      } else if (Array.isArray(args.updates)) {
        // Legacy schema: array of per-element patches keyed by id.
        const patches: any[] = args.updates.map((u: any) => {
          const c = { ...u };
          coerceNumericElementFields(c);
          return c;
        });
        updatedIds = patches.map((u) => u.id).filter(Boolean);
        setElements((prev) =>
          prev.map((el) => {
            const u = patches.find((p) => p.id === el.id);
            return u ? { ...el, ...u } : el;
          })
        );
        updatedElements = elementsRef.current
          .map((el) => {
            const u = patches.find((p) => p.id === el.id);
            return u ? ({ ...el, ...u } as UIElement) : null;
          })
          .filter(Boolean) as UIElement[];
      }
      setStatusText(`Updated ${updatedIds.length} element(s).`);
      return updatedElements;
    }

    // Atomic custom-code (+ optional params) replacement that ALSO re-syncs the
    // saved reusable library module — closing the drift gap where updateElements
    // edits left the auto-registered module stale (mirrors addElements).
    if (name === "setCustomCode") {
      const id: string = args.id;
      const el = elementsRef.current.find((e) => e.id === id);
      if (!el) {
        setStatusText(`setCustomCode: no element with id ${id}.`);
        return { error: `No element with id ${id}` };
      }
      if (el.type !== "CustomCode") {
        setStatusText(`setCustomCode: element ${id} is a ${el.type}, not CustomCode.`);
        return { error: `Element ${id} is a ${el.type}, not a CustomCode element` };
      }
      const customCode = String(args.customCode ?? "");
      const nextParams: CustomParam[] | undefined =
        args.params !== undefined ? sanitizeCustomParams(args.params) : el.params;
      const patch: Partial<UIElement> = { customCode };
      if (args.params !== undefined) patch.params = nextParams;
      setElements((prev) =>
        prev.map((e) => (e.id === id ? { ...e, ...patch } : e))
      );
      // Re-register the reusable module under the element's name so the library
      // copy tracks the edit instead of drifting.
      if (onRegisterModule) onRegisterModule(el.name, customCode, nextParams);
      setStatusText(`Set custom code for "${el.name}".`);
      return { ...el, ...patch };
    }

    if (name === "deleteElements") {
      const ids: string[] = Array.isArray(args.ids) ? args.ids : [];
      setElements((prev) => {
        const toDelete = new Set(ids);
        prev.forEach((el) => {
          if (toDelete.has(el.id) && el.type === "Group" && el.childrenIds) {
            el.childrenIds.forEach((cid) => toDelete.add(cid));
          }
        });
        return prev.filter((el) => !toDelete.has(el.id));
      });
      setStatusText(`Deleted ${ids.length} element(s).`);
      return { deletedIds: ids };
    }

    if (name === "duplicateElements") {
      const ids: string[] = Array.isArray(args.ids) ? args.ids : [];
      const offsetX = args.offsetX ?? 20;
      const offsetY = args.offsetY ?? 20;
      // Include group children so duplicated groups stay intact.
      const idSet = new Set(ids);
      const liveEls = elementsRef.current;
      liveEls.forEach((el) => {
        if (idSet.has(el.id) && el.type === "Group" && el.childrenIds) {
          el.childrenIds.forEach((cid) => idSet.add(cid));
        }
      });
      const source = liveEls.filter((el) => idSet.has(el.id));
      const idMap = new Map<string, string>();
      source.forEach((el) =>
        idMap.set(el.id, Math.random().toString(36).substring(2, 9))
      );
      const copies: UIElement[] = source.map((el) => {
        const copy: any = { ...el, id: idMap.get(el.id)!, name: `${el.name}_copy` };
        if (!el.groupId) {
          copy.x = el.x + offsetX;
          copy.y = el.y + offsetY;
        } else if (idMap.has(el.groupId)) {
          copy.groupId = idMap.get(el.groupId);
        }
        if (el.type === "Group" && el.childrenIds) {
          copy.childrenIds = el.childrenIds.map((cid) => idMap.get(cid) || cid);
        }
        return copy as UIElement;
      });
      setElements((prev) => [...prev, ...copies]);
      setStatusText(`Duplicated ${copies.length} element(s).`);
      return copies;
    }

    // ----- CANVAS (local props) -----
    if (name === "updateCanvas") {
      const updates =
        args.updates && typeof args.updates === "object" ? args.updates : {};
      setCanvasState((prev) => ({ ...prev, ...updates }));
      setStatusText("Updated canvas state.");
      return { ...canvasStateRef.current, ...updates };
    }

    if (name === "setCanvasBackground") {
      const imageUrl = args.imageUrl ?? null;
      setCanvasState((prev) => ({ ...prev, backgroundImage: imageUrl }));
      setStatusText(imageUrl ? "Set canvas background." : "Cleared canvas background.");
      return { ok: true, backgroundImage: imageUrl };
    }

    // ----- DELEGATED TO App.tsx (window events) -----
    if (APP_READ_TOOLS.includes(name)) {
      setStatusText(`Reading ${name}...`);
      return await dispatchAppAction(name, args, toolCallId, true, []);
    }

    if (APP_MUTATION_TOOLS.includes(name)) {
      setStatusText(`AI Action: ${name}...`);
      return await dispatchAppAction(name, args, toolCallId, false, { ok: true });
    }

    // ----- TEXTURE OVERLAY (local element props) -----
    if (name === "applyTexture") {
      const ids: string[] = Array.isArray(args.ids) ? args.ids : [];
      if (!ids.length || !args.textureId) {
        return { ok: false, error: "applyTexture requires ids[] and textureId" };
      }
      // Only set the texture props that were actually provided.
      const patch: Record<string, unknown> = { textureId: args.textureId };
      const optional = [
        "textureBlendMode",
        "textureOpacity",
        "textureScale",
        "textureOffsetX",
        "textureOffsetY",
        "textureRotation",
        "textureSize",
        "textureRepeat",
      ];
      for (const k of optional) {
        if (args[k] !== undefined && args[k] !== null) patch[k] = args[k];
      }
      setElements((prev) =>
        prev.map((el) => (ids.includes(el.id) ? { ...el, ...patch } : el))
      );
      const updated = elementsRef.current
        .filter((el) => ids.includes(el.id))
        .map((el) => ({ ...el, ...patch }));
      setStatusText(`Applied texture to ${ids.length} element(s).`);
      return updated;
    }

    if (name === "removeTexture") {
      const ids: string[] = Array.isArray(args.ids) ? args.ids : [];
      if (!ids.length) {
        return { ok: false, error: "removeTexture requires ids[]" };
      }
      setElements((prev) =>
        prev.map((el) => {
          if (!ids.includes(el.id)) return el;
          const next: any = { ...el };
          delete next.textureId;
          delete next.textureBlendMode;
          delete next.textureOpacity;
          delete next.textureScale;
          delete next.textureOffsetX;
          delete next.textureOffsetY;
          delete next.textureRotation;
          delete next.textureSize;
          delete next.textureRepeat;
          return next;
        })
      );
      setStatusText(`Removed texture from ${ids.length} element(s).`);
      return { ok: true, ids };
    }

    console.warn(`Unknown client tool: ${name}`);
    return { ok: false, error: `Unknown tool: ${name}` };
  };

  // Entry point for every client_tool_call SSE frame. Executes the tool, then
  // (for Claude Code) relays the result/error back via the MCP relay endpoint.
  const handleClientToolCall = async (toolCall: {
    id?: string;
    name: string;
    args: any;
  }) => {
    setStatusText(`AI Action: Executing ${toolCall.name}...`);
    try {
      const result = await executeClientTool(toolCall.name, toolCall.args, toolCall.id);

      // Relay the result for EVERY provider (not just Claude). The server's
      // agentic loop blocks on this result to feed it back into the next API
      // turn; without it the loop times out and stops after one round.
      if (toolCall.id) {
        const isScreenshot =
          toolCall.name === "captureCanvasScreenshot" &&
          typeof result === "string" &&
          result.startsWith("data:");
        await relayToolResult(
          toolCall.id,
          isScreenshot ? { imageData: result.split(",")[1] } : { result }
        );
      }
      return result;
    } catch (e: any) {
      console.error(`Error executing tool ${toolCall.name}:`, e);
      setStatusText(`Error applying action: ${e?.message || e}`);
      if (toolCall.id) {
        await relayToolResult(toolCall.id, { error: e?.message || String(e) });
      }
      throw e;
    } finally {
      setTimeout(() => setStatusText(null), 3000);
    }
  };

  return { handleClientToolCall };
}
