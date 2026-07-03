import React, { useEffect, useMemo, useRef, useState } from "react";
import { CustomParam, UIElement } from "../types";
import { sanitizeCustomParams } from "../lib/customParams";
import {
  BRIDGE_MESSAGES,
  buildBridgeDoc,
  cssVarDeclarations,
  elementStyleTokens,
  pushCustomCodeDiagnostic,
} from "../lib/customCodeBridge";
import { getSkinLayers } from "../lib/skins";
import {
  getDawTarget,
  getDawValue,
  scaleFromTarget,
  scaleToTarget,
  setDawTarget,
  startDawControlBus,
  subscribeDawValue,
} from "../lib/dawControlBus";
import { startVstBindRuntime } from "../lib/vstBindRuntime";

// Theme CSS custom properties applied by the app on document.documentElement.
// Injected into the sandboxed CustomCode iframe so embedded markup can reference
// the same theme tokens as the rest of the app.
const THEME_VAR_NAMES = [
  "--app-base",
  "--app-surface",
  "--app-surface-hover",
  "--app-main",
  "--app-muted",
  "--app-border",
  "--app-accent",
  "--app-accent-hover",
  "--app-accent-subtle",
];

function readThemeVars(): string {
  if (typeof document === "undefined" || typeof window === "undefined") return "";
  const styles = getComputedStyle(document.documentElement);
  return THEME_VAR_NAMES.map((name) => {
    const value = styles.getPropertyValue(name).trim();
    return value ? `${name}: ${value};` : "";
  })
    .filter(Boolean)
    .join(" ");
}

// Collapse a param schema into the flat { key: value } object exposed to the
// iframe as window.PARAMS.
export function paramsToObject(
  params: CustomParam[] | undefined,
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  (params || []).forEach((p) => {
    if (p && typeof p.key === "string" && p.key) out[p.key] = p.value;
  });
  return out;
}

// Size tokens exposed to responsive custom code (used by the 'stretch' fit).
// Kept in the style var map so they ride the same live setStyle push as skins.
function sizeVars(el: UIElement): Record<string, string> {
  return {
    "--foundry-width": `${Math.round(el.width || 0)}px`,
    "--foundry-height": `${Math.round(el.height || 0)}px`,
  };
}

function styleVarsFor(el: UIElement): Record<string, string> {
  return { ...elementStyleTokens(el), ...sizeVars(el) };
}

interface CustomCodeFrameProps {
  el: UIElement;
  isPreview: boolean;
  // Resolved texture image URL (from the element's textureId), for the host
  // material shell composited around the iframe.
  textureUrl?: string;
  // Called when the running code self-registers a parameter schema via
  // window.foundryRegisterParams([...]) (or auto-discovery). The host decides
  // whether to adopt/merge it.
  onRegisterParams?: (elementId: string, params: CustomParam[]) => void;
  // Called when a control INSIDE the iframe changes a value (window.foundrySetParam
  // or an auto-discovered input), so the host params + panel stay in sync.
  onParamValueChange?: (elementId: string, key: string, value: number | string | boolean) => void;
}

// Renders a CustomCode element inside an isolated, sandboxed iframe with a live
// two-way bridge (params, skin/material style tokens, size, content-size,
// runtime errors). The document is rebuilt only when the code (or theme)
// changes — parameter values and style tokens are pushed in over postMessage so
// tweaking a control or applying a skin never reloads / flickers the element.
export default function CustomCodeFrame({
  el,
  isPreview,
  textureUrl,
  onRegisterParams,
  onParamValueChange,
}: CustomCodeFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Read theme vars ONCE (lazy state init), not on every render. As a stable
  // state value the string keeps the srcDoc memo stable across unrelated
  // re-renders (reading getComputedStyle in render pulls mutable external DOM).
  const [themeVars] = useState(readThemeVars);

  // Natural content size reported by the iframe, driving the 'scale' fit.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // Latest el + callbacks mirrored into refs so the single message listener
  // (subscribed by el.id only) always reads current values without re-binding.
  const elRef = useRef(el);
  const onParamValueChangeRef = useRef(onParamValueChange);
  const onRegisterParamsRef = useRef(onRegisterParams);
  useEffect(() => {
    elRef.current = el;
    onParamValueChangeRef.current = onParamValueChange;
    onRegisterParamsRef.current = onRegisterParams;
  });

  const srcDoc = useMemo(
    () =>
      buildBridgeDoc({
        code: el.customCode || "",
        paramsJson: JSON.stringify(paramsToObject(el.params)),
        themeCss: themeVars,
        styleVarsCss: cssVarDeclarations(styleVarsFor(el)),
      }),
    // Intentionally excludes el.params + style fields: live values/tokens are
    // delivered via postMessage, not by rebuilding (and reloading) the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [el.customCode, themeVars],
  );

  const postToFrame = (msg: unknown) => {
    const win = iframeRef.current?.contentWindow;
    if (win) win.postMessage(msg, "*");
  };

  // Push live parameter values into the running iframe on every change.
  const paramSignature = JSON.stringify(paramsToObject(el.params));
  useEffect(() => {
    postToFrame({ type: BRIDGE_MESSAGES.setParams, params: paramsToObject(el.params) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramSignature]);

  // Push skin/material style tokens (and size vars) live — no reload.
  const styleSignature = JSON.stringify(styleVarsFor(el));
  useEffect(() => {
    postToFrame({ type: BRIDGE_MESSAGES.setStyle, vars: styleVarsFor(el) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleSignature]);

  // Single inbound message listener for everything the iframe reports. Bound by
  // el.id (stable) — reads current el/callbacks via refs.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      const d = e.data;
      if (!d || typeof d !== "object") return;
      const cur = elRef.current;
      switch (d.type) {
        case BRIDGE_MESSAGES.registerParams: {
          if (!onRegisterParamsRef.current || !Array.isArray(d.params)) return;
          const sanitized = sanitizeCustomParams(d.params);
          if (sanitized.length === 0) return;
          onRegisterParamsRef.current(cur.id, sanitized);
          break;
        }
        case BRIDGE_MESSAGES.paramChanged: {
          if (typeof d.key !== "string") return;
          onParamValueChangeRef.current?.(cur.id, d.key, d.value);
          // If this param is bound to a theDAW target, drive the target too.
          const binding = (cur.paramBindings || []).find((b) => b.key === d.key);
          if (binding && typeof d.value === "number") {
            const param = (cur.params || []).find((p) => p.key === d.key);
            const min = param?.min ?? 0;
            const max = param?.max ?? 100;
            const pct = max === min ? 0 : ((d.value - min) / (max - min)) * 100;
            setDawTarget(binding.targetId, scaleToTarget(pct, getDawTarget(binding.targetId)));
          }
          break;
        }
        case BRIDGE_MESSAGES.contentSize: {
          if (typeof d.w === "number" && typeof d.h === "number" && d.w > 0 && d.h > 0) {
            setNatural((prev) =>
              prev && prev.w === d.w && prev.h === d.h ? prev : { w: d.w, h: d.h },
            );
          }
          break;
        }
        case BRIDGE_MESSAGES.error: {
          pushCustomCodeDiagnostic(cur.id, {
            message: typeof d.message === "string" ? d.message : "script error",
            stack: typeof d.stack === "string" ? d.stack : undefined,
            ts: Date.now(),
          });
          break;
        }
        case BRIDGE_MESSAGES.ready: {
          // Beat any listener-registration race: re-push current state on ready.
          postToFrame({ type: BRIDGE_MESSAGES.setParams, params: paramsToObject(cur.params) });
          postToFrame({ type: BRIDGE_MESSAGES.setStyle, vars: styleVarsFor(cur) });
          break;
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [el.id]);

  // theDAW → iframe: for each per-param binding, subscribe to its target and
  // push the scaled value into the matching param. Re-subscribes only when the
  // set of bindings changes.
  const bindingSignature = JSON.stringify(el.paramBindings || []);
  useEffect(() => {
    const bindings = elRef.current.paramBindings || [];
    if (bindings.length === 0) return;
    startDawControlBus();
    // Params may bind built-in `vst:` targets (LFOs / macros / transport) —
    // the local runtime animates those.
    startVstBindRuntime();
    const pushInto = (key: string, targetId: string, raw: number | boolean) => {
      const param = (elRef.current.params || []).find((p) => p.key === key);
      const min = param?.min ?? 0;
      const max = param?.max ?? 100;
      const pct = scaleFromTarget(raw, getDawTarget(targetId));
      postToFrame({
        type: BRIDGE_MESSAGES.setParams,
        params: { [key]: min + (pct / 100) * (max - min) },
      });
    };
    const unsubs = bindings.map((b) => {
      const seed = getDawValue(b.targetId);
      if (seed !== undefined) pushInto(b.key, b.targetId, seed);
      return subscribeDawValue(b.targetId, (v) => pushInto(b.key, b.targetId, v));
    });
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingSignature]);

  // Fit mode: 'scale' auto-fits natural content to the element box; 'stretch'
  // fills the box (responsive code reads --foundry-width/height); 'none' is the
  // legacy 1:1 iframe. Before the first contentSize arrives, 'scale' falls back
  // to filling the box so the element is never invisible.
  const fit = el.customCodeFit || "scale";
  const useScale = fit === "scale" && natural && natural.w > 0 && natural.h > 0;
  const iframeStyle: React.CSSProperties = useScale
    ? {
        width: natural!.w,
        height: natural!.h,
        border: "none",
        background: "transparent",
        transform: `scale(${(el.width || natural!.w) / natural!.w}, ${(el.height || natural!.h) / natural!.h})`,
        transformOrigin: "top left",
      }
    : { width: "100%", height: "100%", border: "none", background: "transparent" };

  // Host material shell (composited under/around the iframe). Mirrors the
  // texture/glow/skin layers InteractiveControl paints so skins & materials
  // apply to custom content regardless of whether its code cooperates.
  const opacityPct = el.opacity ?? 100;
  const showBackground = !el.transparentBackground && !!el.baseColor;
  const skinLayers = el.skin
    ? getSkinLayers(el.skin, {
        base: el.baseColor || "var(--app-surface)",
        active: el.activeColor || "var(--app-accent)",
      })
    : null;
  let glowDiv: React.ReactNode = null;
  if (el.glow) {
    const gColor = el.glowColor || el.activeColor || "var(--app-accent)";
    const gOpacity = el.glowOpacity !== undefined ? el.glowOpacity / 100 : 1;
    const gAmount = (el.glowAmount ?? 50) / 100;
    const blur = ((el.glowAmount ?? 50) / 2) * gAmount;
    const spread = (el.glowSpread ?? 10) * gAmount;
    glowDiv =
      el.glowStyle === "inner" ? (
        <div
          className="absolute inset-0 pointer-events-none rounded-[inherit]"
          style={{ boxShadow: `inset 0 0 ${blur}px ${spread}px ${gColor}`, opacity: gOpacity }}
        />
      ) : (
        <div
          className="absolute inset-0 pointer-events-none rounded-[inherit]"
          style={{ boxShadow: `0 0 ${blur}px ${spread}px ${gColor}`, opacity: gOpacity }}
        />
      );
  }

  return (
    <div
      className={`w-full h-full relative overflow-hidden rounded-[inherit] ${isPreview ? "pointer-events-auto" : "pointer-events-none"}`}
    >
      {showBackground && (
        <div
          className="absolute inset-0 pointer-events-none rounded-[inherit]"
          style={{
            background: `color-mix(in srgb, ${el.baseColor} ${opacityPct}%, transparent)`,
          }}
        />
      )}
      {glowDiv}
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        onLoad={() => {
          // The bootstrap posts foundry:ready which re-pushes state, but push
          // once here too in case ready is missed on a fast load.
          postToFrame({ type: BRIDGE_MESSAGES.setParams, params: paramsToObject(el.params) });
          postToFrame({ type: BRIDGE_MESSAGES.setStyle, vars: styleVarsFor(el) });
        }}
        style={iframeStyle}
        title={`custom-${el.id}`}
      />
      {skinLayers?.overlayStyles.map((s, i) => (
        <div
          key={`skin-${i}`}
          style={{ ...s, position: "absolute", inset: 0, pointerEvents: "none", borderRadius: "inherit", zIndex: 2 }}
        />
      ))}
      {textureUrl && (
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none rounded-[inherit]"
          style={{ mixBlendMode: (el.textureBlendMode as any) || "normal", zIndex: 2 }}
        >
          <div
            className="w-full h-full origin-center"
            style={{
              backgroundImage: `url(${textureUrl})`,
              backgroundSize: el.textureSize || "cover",
              backgroundPosition: `calc(50% + ${el.textureOffsetX || 0}px) calc(50% + ${el.textureOffsetY || 0}px)`,
              backgroundRepeat: el.textureRepeat || "no-repeat",
              opacity: (el.textureOpacity ?? 100) / 100,
              transform: `scale(${(el.textureScale ?? 100) / 100}) rotate(${el.textureRotation || 0}deg)`,
            }}
          />
        </div>
      )}
      {/* Design mode: a transparent overlay captures pointer events so the
          element can still be dragged/resized/rotated. Preview mode removes it
          so the iframe is interactive. */}
      {!isPreview && <div style={{ position: "absolute", inset: 0, zIndex: 3 }} />}
    </div>
  );
}
