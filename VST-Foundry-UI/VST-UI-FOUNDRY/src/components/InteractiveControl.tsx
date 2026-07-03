import React, { useState, useRef, useEffect, useCallback } from "react";
import { UIElement, ElementType } from "../types";
import { getDefaultColors } from "../lib/colorUtils";
import {
  startDawControlBus,
  setDawTarget,
  getDawTarget,
  scaleToTarget,
  scaleFromTarget,
  subscribeDawValue,
  getDawValue,
} from "../lib/dawControlBus";
import { routesOf, applyRoute, elementDestProps } from "../lib/routing";
import { startVstBindRuntime } from "../lib/vstBindRuntime";
import {
  publishElementSignal,
  subscribeElementSignal,
} from "../lib/elementSignalBus";
import CustomCodeFrame from "./CustomCodeFrame";
import KnobControl from "./controls/KnobControl";
import SliderControl from "./controls/SliderControl";
import ToggleControl from "./controls/ToggleControl";
import ButtonControl from "./controls/ButtonControl";
import SelectControl from "./controls/SelectControl";
import LabelControl from "./controls/LabelControl";
import WaveformControl from "./controls/WaveformControl";
import MeterControl from "./controls/MeterControl";
import XYPadControl from "./controls/XYPadControl";
import Spatial3DControl from "./controls/Spatial3DControl";
import WaveShaperControl from "./controls/WaveShaperControl";
import EnvelopeControl from "./controls/EnvelopeControl";
import StepSequencerControl from "./controls/StepSequencerControl";
import KeyboardControl from "./controls/KeyboardControl";
import FrameControl from "./controls/FrameControl";
import { styleParam } from "./controls/controlParams";
import { getSkinLayers } from "../lib/skins";

// Control types that receive the UNIVERSAL static image-face layer (painted by
// wrapElement() below). This is EVERYTHING that renders real content EXCEPT the
// six face-aware controls — Knob/Button/Toggle/Slider/XYPad/Meter — which paint
// their own value-reactive faces internally, and EXCEPT the non-control branches
// (CustomCode's sandboxed iframe + the null fallback). Enumerated explicitly so
// the universal layer never double-paints over a control that handles faceSrc
// itself, nor over an empty render.
const UNIVERSAL_FACE_TYPES = new Set<ElementType>([
  "Select",
  "Label",
  "Waveform",
  "Spatial3D",
  "WaveShaper",
  "Envelope",
  "StepSequencer",
  "Keyboard",
  // Frame is decorative — a backplate/frame. A static face lets an extracted
  // backplate IMAGE stand in for the programmatic plate (faceHideBase hides it).
  "Frame",
]);

interface Props {
  el: UIElement;
  isPreview: boolean;
  textureUrl?: string;
  // Persist style/param edits from self-editing controls (Envelope drag,
  // StepSequencer toggles) back to the element store. Wired from Canvas.
  onUpdateElements?: (ids: string[], updates: Partial<UIElement>) => void;
}

export default function InteractiveControl({
  el,
  isPreview,
  textureUrl,
  onUpdateElements,
}: Props) {
  const [val, setVal] = useState(0);
  const [xVal, setXVal] = useState(el.valueX ?? 50);
  const [yVal, setYVal] = useState(el.valueY ?? 50);
  const [isOn, setIsOn] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  // LISTEN binding: a bound Waveform's live amplitude (0–100). Undefined when
  // unbound, which keeps WaveformControl's render byte-identical to before.
  const [liveWaveVal, setLiveWaveVal] = useState<number | undefined>(undefined);
  // INBOUND element route → Label readout text. Undefined keeps LabelControl's
  // render byte-identical (falls back to el.label). Set by the destination
  // subscription below when a "text" route publishes to this element.
  const [liveText, setLiveText] = useState<string | undefined>(undefined);

  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingXYRef = useRef(false);
  const isDraggingRef = useRef(false);
  const activeDragCleanupRef = useRef<(() => void) | null>(null);
  const routesRef = useRef(routesOf(el));
  const isPreviewRef = useRef(isPreview);
  // Live control values mirrored into refs so the gesture-setup effect can read
  // the drag-start value at mousedown without listing val/xVal/yVal in its deps.
  // Inbound modulation drives these setters per frame; keeping them in the deps
  // would tear down/re-add the mousedown listener on passive destinations ~60fps.
  const valRef = useRef(val);
  const xValRef = useRef(xVal);
  const yValRef = useRef(yVal);

  // Mirror the current route list + preview flag + live values into refs. The
  // drag handlers are created inside the gesture effect below, whose deps do NOT
  // include el.binding or val/xVal/yVal, so the handlers must read these refs to
  // dispatch against the latest routes and capture the current drag-start value.
  useEffect(() => {
    routesRef.current = routesOf(el);
    isPreviewRef.current = isPreview;
    valRef.current = val;
    xValRef.current = xVal;
    yValRef.current = yVal;
  });

  // Route-stack OUTBOUND dispatch: fan this source control's shaped value out
  // to every route whose axis matches the moving seam. Reads the live route
  // list + preview flag via refs so the gesture effect never re-subscribes when
  // the binding changes. daw routes are preview-gated (and, for buttons,
  // leading-edge only via `allowDaw`); element routes publish on the signal bus.
  const dispatchRoutes = useCallback(
    (
      matchAxis: "value" | "x" | "y",
      sourceVal0to100: number,
      allowDaw: boolean,
    ) => {
      for (const route of routesRef.current) {
        if ((route.axis ?? "value") !== matchAxis) continue;
        const shaped = applyRoute(sourceVal0to100, route);
        if (route.dest === "daw") {
          if (allowDaw && isPreviewRef.current) {
            setDawTarget(
              route.targetId,
              scaleToTarget(shaped, getDawTarget(route.targetId)),
            );
          }
        } else {
          publishElementSignal(route.targetId, route.prop ?? "value", shaped);
        }
      }
    },
    [],
  );

  // Warm up the theDAW control bus as soon as a routed control (or a Meter /
  // Waveform LISTEN binding) mounts, so the socket is connected before the user
  // starts dragging.
  useEffect(() => {
    const hasRoutes = routesOf(el).length > 0;
    const hasListen =
      (el.type === "Meter" || el.type === "Waveform") && !!el.binding?.targetId;
    if (hasRoutes || hasListen) {
      startDawControlBus();
      // Built-in `vst:` binds (LFOs / macros / local transport) animate from
      // the local runtime — start it alongside the bus.
      startVstBindRuntime();
    }
  }, [el.type, el.binding]);

  // LISTEN binding — Meter: a bound target's live value drives `val` (0–100).
  // Runs in preview AND edit so displays animate while designing; starts the bus
  // so frames flow, seeds from the last-known value, and re-subscribes when the
  // bound id changes. Review fixes: a live drag on the meter itself wins over
  // inbound frames (isDraggingRef guard — no 60fps tug-of-war), and unbinding
  // resets `val` to the stored element value instead of freezing the last
  // live reading.
  useEffect(() => {
    if (el.type !== "Meter") return;
    const id = el.binding?.targetId;
    if (!id) {
      setVal(el.value ?? 0);
      return;
    }
    startDawControlBus();
    startVstBindRuntime();
    const apply = (v: number | boolean) => {
      if (!isDraggingRef.current) setVal(scaleFromTarget(v, getDawTarget(id)));
    };
    const seed = getDawValue(id);
    if (seed !== undefined) apply(seed);
    return subscribeDawValue(id, apply);
  }, [el.type, el.binding?.targetId, el.value]);

  // LISTEN binding — Waveform: a bound target's live value drives amplitude via
  // `liveWaveVal`, threaded to WaveformControl. Cleared to undefined when
  // unbound so the scope renders byte-identical to its static form.
  useEffect(() => {
    if (el.type !== "Waveform") return;
    const id = el.binding?.targetId;
    if (!id) {
      setLiveWaveVal(undefined);
      return;
    }
    startDawControlBus();
    startVstBindRuntime();
    const apply = (v: number | boolean) =>
      setLiveWaveVal(scaleFromTarget(v, getDawTarget(id)));
    const seed = getDawValue(id);
    if (seed !== undefined) apply(seed);
    return subscribeDawValue(id, apply);
  }, [el.type, el.binding?.targetId]);

  // INBOUND route destinations — subscribe this element (as a DESTINATION) to
  // the runtime element-signal bus for every property a route can drive on its
  // type (elementDestProps). Active in edit AND preview so ganged controls / LED
  // readouts animate while designing. Value drives are dropped while the user is
  // actively dragging THIS element so a live gesture always wins over inbound
  // modulation. O(props) subscriptions per element.
  useEffect(() => {
    const props = elementDestProps(el.type);
    if (props.length === 0) return;
    const unsubs = props.map(({ prop }) =>
      subscribeElementSignal(el.id, prop, (v) => {
        switch (prop) {
          case "value":
            // Waveform merges into liveWaveVal (shared with the daw LISTEN path
            // — last writer wins); other types drive `val`.
            if (el.type === "Waveform") setLiveWaveVal(Number(v));
            else if (!isDraggingRef.current) setVal(Number(v));
            break;
          case "valueX":
            if (!isDraggingXYRef.current) setXVal(Number(v));
            break;
          case "valueY":
            if (!isDraggingXYRef.current) setYVal(Number(v));
            break;
          case "on":
            setIsOn(Boolean(v));
            break;
          case "text":
            setLiveText(typeof v === "number" ? v.toFixed(0) : String(v));
            break;
        }
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [el.id, el.type]);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setVal(el.value ?? 0);
    }
  }, [el.value]);

  useEffect(() => {
    if (!isDraggingXYRef.current) {
      setXVal(el.valueX ?? 50);
      setYVal(el.valueY ?? 50);
    }
  }, [el.valueX, el.valueY]);

  useEffect(() => {
    return () => {
      activeDragCleanupRef.current?.();
      activeDragCleanupRef.current = null;
    };
  }, [isPreview]);

  // Preview→edit boundary: clear any live signal-driven state so a value a
  // preview session pushed into this element (a route driving this Label to
  // "42", a ganged knob, an LED toggle) doesn't leak into edit mode — Canvas
  // keys by el.id, so this component never remounts across the toggle. Inbound
  // signals stay subscribed in edit and may immediately re-drive these values
  // (ganged controls / LED readouts animate while designing); we only wipe the
  // STALE snapshot at the boundary, matching each field's design default (the
  // liveText fallback, the isOn useState init, and el.value/valueX/valueY).
  // liveWaveVal is owned by the daw LISTEN path when bound, so only reset it
  // when there is no bound target — otherwise that path re-seeds it.
  useEffect(() => {
    if (isPreview) return;
    setLiveText(undefined);
    setIsOn(false);
    setVal(el.value ?? 0);
    setXVal(el.valueX ?? 50);
    setYVal(el.valueY ?? 50);
    if (!el.binding?.targetId) setLiveWaveVal(undefined);
  }, [isPreview]);

  useEffect(() => {
    if (!isPreview) {
      setIsPressed(false);
      setIsOpen(false);
      return;
    }

    const elNode = containerRef.current;
    if (!elNode) return;

    if (
      el.type === "Slider" ||
      el.type === "Knob" ||
      el.type === "Meter" ||
      el.type === "WaveShaper"
    ) {
      const handleMouseDown = (e: MouseEvent) => {
        e.stopPropagation();
        isDraggingRef.current = true;
        const startY = e.clientY;
        const startVal = valRef.current;

        const handleMouseMove = (me: MouseEvent) => {
          const dy = startY - me.clientY;
          const sensitivity =
            el.type === "Knob" ? 0.5 : 100 / Math.max(el.height || 100, 50);
          let newVal = startVal + dy * sensitivity;
          newVal = Math.max(0, Math.min(100, newVal));
          setVal(newVal);

          // Route-stack dispatch: fan this value out to every "value"-axis
          // route (daw targets + element signals). Legacy single-target
          // bindings are folded into routesOf(), so this covers them too.
          dispatchRoutes("value", newVal, true);
        };

        const handleMouseUp = () => {
          isDraggingRef.current = false;
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
          activeDragCleanupRef.current = null;
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        activeDragCleanupRef.current = () => {
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
        };
      };

      elNode.addEventListener("mousedown", handleMouseDown);
      return () => elNode.removeEventListener("mousedown", handleMouseDown);
    }

    if (el.type === "XYPad" || el.type === "Spatial3D") {
      const handleMouseDown = (e: MouseEvent) => {
        e.stopPropagation();
        isDraggingXYRef.current = true;

        const updateXY = (me: MouseEvent) => {
          const rect = elNode.getBoundingClientRect();
          let newX = ((me.clientX - rect.left) / rect.width) * 100;
          let newY = 100 - ((me.clientY - rect.top) / rect.height) * 100;
          newX = Math.max(0, Math.min(100, newX));
          newY = Math.max(0, Math.min(100, newY));
          setXVal(newX);
          setYVal(newY);

          // Route-stack dispatch: "x" routes get newX, "y" routes get newY.
          // Legacy xTargetId/yTargetId are folded into routesOf() as x/y routes.
          dispatchRoutes("x", newX, true);
          dispatchRoutes("y", newY, true);
        };

        updateXY(e);

        const handleMouseMove = (me: MouseEvent) => updateXY(me);

        const handleMouseUp = () => {
          isDraggingXYRef.current = false;
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
          activeDragCleanupRef.current = null;
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        activeDragCleanupRef.current = () => {
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
        };
      };

      elNode.addEventListener("mousedown", handleMouseDown);
      return () => elNode.removeEventListener("mousedown", handleMouseDown);
    }
  }, [isPreview, el.type, el.height, dispatchRoutes]);

  const defaultColors = getDefaultColors(el.variant);
  const variant = (() => {
    if (el.variant === "Skeuomorphic") return "Classic";
    if (el.variant === "Minimalist") return "Minimal";
    if (el.variant === "Apple-esque Minimalism") return "Neumorphic";
    if (el.variant === "Swiss Style") return "Brutalist";
    if (el.variant === "Space Age Design") return "3D";
    if (el.variant === "Morphogenetic Design") return "CellShaded";
    if (el.variant === "Neo-minimalism") return "Checkbox";
    if (el.variant === "Streamline Moderne") return "Neumorphic";
    if (el.variant === "Soft Minimalism") return "Outline";
    if (el.variant === "Retrofuturism") return "Mono";
    return el.variant;
  })();

  // Determine active state for glowing
  const isActive = (() => {
    if (el.type === "Button") return isPressed;
    if (el.type === "Toggle") return isOn;
    if (el.type === "Select") return isOpen;
    return val > 0;
  })();

  const showGlow = el.glow;

  const opacityPct = el.opacity ?? 100;

  const baseStyle: React.CSSProperties = {
    "--base-color": el.transparentBackground
      ? "transparent"
      : `color-mix(in srgb, ${el.baseColor || defaultColors.baseColor} ${opacityPct}%, transparent)`,
    "--active-color": `color-mix(in srgb, ${el.activeColor || defaultColors.activeColor} ${opacityPct}%, transparent)`,
    "--text-color": el.textColor || defaultColors.textColor,
    "--border-color": `color-mix(in srgb, ${el.borderColor || defaultColors.borderColor} ${opacityPct}%, transparent)`,
    "--indicator-color": `color-mix(in srgb, ${el.indicatorColor || "var(--active-color)"} ${opacityPct}%, transparent)`,
  } as any;

  let glowDiv = null;
  if (showGlow) {
    let currentGlow = (el.glowAmount ?? 50) / 100;

    if (el.glowActiveOnly) {
      if (el.type === "Knob" || el.type === "Slider" || el.type === "Meter") {
        currentGlow *= val / 100;
      } else if (el.type === "XYPad" || el.type === "Spatial3D") {
        currentGlow *= Math.max(xVal, yVal) / 100;
      } else {
        currentGlow = isActive ? currentGlow : 0;
      }
    }

    const gColor = el.glowColor || "var(--active-color)";
    const gStyle = el.glowStyle || "solid";
    const gOpacity = el.glowOpacity !== undefined ? el.glowOpacity / 100 : 1;
    const gGradient = el.glowGradient;
    const gSpread = el.glowSpread !== undefined ? el.glowSpread : 10;

    const blur = ((el.glowAmount ?? 50) / 2) * currentGlow;
    const spread = gSpread * currentGlow;

    if (gGradient) {
      glowDiv = (
        <div
          className="absolute -inset-2 pointer-events-none rounded-[inherit]"
          style={{
            background: gGradient,
            filter: `blur(${blur}px)`,
            opacity: gOpacity * currentGlow,
          }}
        />
      );
    } else if (gStyle === "center" || gStyle === "radial") {
      glowDiv = (
        <div
          className="absolute pointer-events-none rounded-full"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: `calc(100% + ${spread * 2}px)`,
            height: `calc(100% + ${spread * 2}px)`,
            background: `radial-gradient(circle, ${gColor} 0%, color-mix(in srgb, ${gColor} 30%, transparent) 60%, transparent 100%)`,
            opacity: gOpacity * currentGlow,
            filter: `blur(${blur || 1}px)`,
            zIndex: -1,
          }}
        />
      );
    } else if (gStyle === "inner") {
      glowDiv = (
        <div
          className="absolute inset-0 pointer-events-none rounded-[inherit]"
          style={{
            boxShadow: `inset 0 0 ${blur}px ${spread}px ${gColor}`,
            opacity: gOpacity,
          }}
        />
      );
    } else {
      // outer, solid, neon, or undefined
      glowDiv = (
        <div
          className="absolute inset-0 pointer-events-none rounded-[inherit]"
          style={{
            boxShadow: `0 0 ${blur}px ${spread}px ${gColor}`,
            opacity: gOpacity,
          }}
        />
      );
    }
  }

  const effectClass =
    el.effect === "pulsing"
      ? "animate-pulse"
      : el.effect === "orbital"
        ? "animate-[spin_3s_linear_infinite]"
        : el.effect === "audioReactive"
          ? "animate-bounce"
          : el.effect === "breathing"
            ? "animate-slow-breath"
            : el.effect === "flickering"
              ? "animate-neon-flicker"
              : el.effect === "floating"
                ? "animate-bob-float"
                : "";

  const roundedClass = (() => {
    if (el.type === "Knob")
      return variant === "Brutalist" ? "rounded-none" : "rounded-full";
    if (el.type === "Spatial3D") return "rounded-full";
    if (el.type === "Toggle") return "rounded-full";
    if (el.type === "Button" && variant === "Brutalist") return "rounded-none";
    if (el.type === "Meter" && variant === "VU Meter") return "rounded";
    return el.cornerRadius ? "" : "rounded";
  })();

  const cornerRadiusStyle: React.CSSProperties =
    roundedClass === "" && el.cornerRadius
      ? { borderRadius: `${el.cornerRadius}px` }
      : {};

  // Universal skins: when el.skin is set, resolve decorative layers from the
  // skins lib against this element's resolved colors, merge the container style
  // onto the wrapper, and paint the overlays above the control render. When no
  // skin is set this is null and the wrapper output stays byte-identical.
  const skinLayers = el.skin
    ? getSkinLayers(el.skin, {
        base: el.baseColor || defaultColors.baseColor,
        active: el.activeColor || defaultColors.activeColor,
      })
    : null;

  // Universal image face for the NON-face-aware control types (Select, Label,
  // Waveform, Spatial3D, WaveShaper, Envelope, StepSequencer, Keyboard — see
  // UNIVERSAL_FACE_TYPES). The six face-aware controls paint their own
  // value-reactive faces internally; CustomCode / the null fallback get none.
  // Opt-in via el.faceSrc: when it is unset `showFace` is false and every face
  // branch below is skipped, so the wrapper output stays byte-identical to
  // before — the load-bearing default-rendering contract.
  const showFace = !!el.faceSrc && UNIVERSAL_FACE_TYPES.has(el.type);
  // faceFit / faceOpacity / faceHideBase carry explicit fallbacks because these
  // keys are NOT declared in CONTROL_PARAMS for the non-face-aware types (they
  // live on the face-aware set), so styleParam() resolves them straight from the
  // stored value or, absent that, from the fallback supplied right here.
  const faceFit = styleParam<string>(el, "faceFit", "contain");
  const faceOpacity = styleParam<number>(el, "faceOpacity", 100);
  const faceHideBase = styleParam<boolean>(el, "faceHideBase", true);
  // objectFit → backgroundSize: contain / cover pass straight through; "fill"
  // stretches to the box (100% 100%), matching CSS object-fit: fill.
  const faceBgSize = faceFit === "fill" ? "100% 100%" : faceFit;

  const wrapElement = (content: React.ReactNode) => {
    return (
      <div
        className={`w-full h-full relative ${effectClass} ${roundedClass} transition-shadow duration-300`}
        style={{ ...baseStyle, ...cornerRadiusStyle, ...(skinLayers?.containerStyle || {}) }}
      >
        {glowDiv}
        {showFace && faceHideBase ? (
          // Hide the programmatic render UNDER the face via opacity 0 ONLY —
          // never visibility/display — so the control keeps its box, its layout,
          // and (for the interactive display types like Spatial3D / WaveShaper)
          // its pointer wiring on containerRef. The face composites on top.
          <div className="w-full h-full" style={{ opacity: 0 }}>
            {content}
          </div>
        ) : (
          content
        )}
        {showFace && (
          // Full-cover static cutout, UNDER the skin overlays (zIndex 2) at
          // zIndex 1 and above the base render. borderRadius:inherit clips the
          // background to the wrapper's rounded corners; pointerEvents:none keeps
          // every gesture (drag seams, self-editing handlers) flowing underneath.
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `url(${el.faceSrc})`,
              backgroundSize: faceBgSize,
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              opacity: faceOpacity / 100,
              borderRadius: "inherit",
              zIndex: 1,
            }}
          />
        )}
        {skinLayers?.overlayStyles.map((s, i) => (
          <div
            key={`skin-${i}`}
            style={{
              ...s,
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              borderRadius: "inherit",
              zIndex: 2,
            }}
          />
        ))}
        {textureUrl && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-[inherit]" style={{ mixBlendMode: (el.textureBlendMode as any) || "normal" }}>
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
      </div>
    );
  };

  const renderElement = () => {
    if (el.type === "Knob") {
      return (
        <KnobControl
          el={el}
          variant={variant}
          val={val}
          isPreview={isPreview}
          containerRef={containerRef}
        />
      );
    }

    if (el.type === "Slider") {
      return (
        <SliderControl
          el={el}
          variant={variant}
          val={val}
          isPreview={isPreview}
          containerRef={containerRef}
        />
      );
    }

    if (el.type === "Toggle") {
      return (
        <ToggleControl
          el={el}
          variant={variant}
          isPreview={isPreview}
          isOn={isOn}
          setIsOn={(v) => {
            setIsOn(v);
            // Route-stack dispatch: boolean → 0/100 on the "value" axis. Both
            // edges dispatch (daw + element). Preview-gated as before.
            if (isPreview && typeof v === "boolean") {
              dispatchRoutes("value", v ? 100 : 0, true);
            }
          }}
        />
      );
    }

    if (el.type === "Button") {
      return (
        <ButtonControl
          el={el}
          variant={variant}
          isPreview={isPreview}
          isPressed={isPressed}
          setIsPressed={(v) => {
            setIsPressed(v);
            // Route-stack dispatch: boolean → 0/100 on the "value" axis.
            // LEADING EDGE ONLY for daw routes (allowDaw = v === true): theDAW
            // pad targets fire their action on every inbound frame, so emitting
            // the release would double-trigger — and ButtonControl calls
            // setIsPressed(false) on mouseleave, which would fire on mere
            // hover-out. Element routes may send both edges. Preview-gated so
            // edit-mode mouseup/mouseleave never publishes. (Audit finding:
            // Button→pad double/spurious trigger.)
            if (isPreview && typeof v === "boolean") {
              dispatchRoutes("value", v ? 100 : 0, v === true);
            }
          }}
        />
      );
    }

    if (el.type === "Select") {
      return (
        <SelectControl
          el={el}
          variant={variant}
          isPreview={isPreview}
          isOpen={isOpen}
          setIsOpen={setIsOpen}
        />
      );
    }

    if (el.type === "Label") {
      return <LabelControl el={el} variant={variant} liveText={liveText} />;
    }

    if (el.type === "Waveform") {
      return <WaveformControl el={el} variant={variant} liveVal={liveWaveVal} />;
    }

    if (el.type === "Meter") {
      return <MeterControl el={el} variant={variant} val={val} />;
    }

    if (el.type === "XYPad") {
      return (
        <XYPadControl
          el={el}
          variant={variant}
          isPreview={isPreview}
          xVal={xVal}
          yVal={yVal}
          containerRef={containerRef}
        />
      );
    }

    if (el.type === "CustomCode") {
      // Security: never inject CustomCode HTML into the app origin. Canvas
      // already routes CustomCode to the sandboxed CustomCodeFrame; this dead
      // branch is kept sandboxed as defense-in-depth in case InteractiveControl
      // ever renders a CustomCode element directly.
      return <CustomCodeFrame el={el} isPreview={isPreview} />;
    }

    if (el.type === "Spatial3D") {
      return (
        <Spatial3DControl
          el={el}
          isPreview={isPreview}
          xVal={xVal}
          yVal={yVal}
          containerRef={containerRef}
        />
      );
    }

    if (el.type === "WaveShaper") {
      // Shares the vertical-drag seam above (val = 0–100 drive) via containerRef,
      // so the existing theDAW-binding dispatch drives the bound target unchanged.
      return (
        <WaveShaperControl
          el={el}
          variant={variant}
          val={val}
          isPreview={isPreview}
          containerRef={containerRef}
        />
      );
    }

    if (el.type === "Envelope") {
      return (
        <EnvelopeControl
          el={el}
          variant={variant}
          isPreview={isPreview}
          onStyleParams={(patch) =>
            onUpdateElements?.([el.id], {
              styleParams: { ...el.styleParams, ...patch },
            })
          }
        />
      );
    }

    if (el.type === "StepSequencer") {
      return (
        <StepSequencerControl
          el={el}
          variant={variant}
          isPreview={isPreview}
          onStyleParams={(patch) =>
            onUpdateElements?.([el.id], {
              styleParams: { ...el.styleParams, ...patch },
            })
          }
        />
      );
    }

    if (el.type === "Keyboard") {
      return <KeyboardControl el={el} variant={variant} isPreview={isPreview} />;
    }

    if (el.type === "Frame") {
      return <FrameControl el={el} variant={variant} isPreview={isPreview} />;
    }

    return null;
  };

  return wrapElement(renderElement());
}
