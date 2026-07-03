import React from "react";
import { BaseControlProps } from "./shared";
import { styleParam } from "./controlParams";

interface ToggleControlProps extends BaseControlProps {
  isOn: boolean;
  setIsOn: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function ToggleControl({
  el,
  variant,
  isPreview,
  isOn,
  setIsOn,
}: ToggleControlProps) {
  // Adjustable params (schema defaults reproduce the pre-parameterization look).
  const switchScale = styleParam(el, "switchScale", 100);
  const s = switchScale / 100; // 100% -> scale(1), identity at default
  const showLegends = styleParam(el, "showLegends", true);
  // Lever throw angle: schema default (24) reproduces the previous ±24deg throw.
  const leverAngle = styleParam(el, "leverAngle", 24);
  // On-glow is a relative intensity (%): the schema default (50) is the baseline
  // that reproduces today's glow, so blur radii scale by (glow / 50).
  const glow = styleParam(el, "glowStrength", 50);
  // Housing depth (Rocker/Lever): the schema default (3) is the baseline, so the
  // inset-shadow offsets/blurs scale by (housingDepth / 3) — default renders 1:1.
  const housingDepth = styleParam(el, "housingDepth", 3);
  const hd = housingDepth / 3;
  // --- Image face (opt-in). When el.faceSrc is set the toggle wears the
  // supplied cutout, reusing the Blank variant's onClick wiring so setIsOn still
  // flips. The on-state treatment is chosen by faceOn: "brightness" lifts the
  // image by faceOnAmount% (reads as lit), "tint" lays an --active-color overlay
  // at faceOnAmount% opacity, "swap" shows styleParams.faceOnSrc while on
  // (falling back to a brightness lift when no swap image is stored).
  // faceHideBase (default true) swaps the image IN PLACE OF the variant (click
  // wiring + toggle role/aria live on the face container); false composites it
  // OVER a full re-render of the variant (wiring lives on that variant, the face
  // floats inert above it — the C2 "composites over" path). Absent faceSrc this
  // branch never runs, so the variants below are byte-identical to before.
  if (el.faceSrc) {
    const faceFit = styleParam<string>(el, "faceFit", "contain");
    const faceOpacity = styleParam<number>(el, "faceOpacity", 100);
    const faceHideBase = styleParam<boolean>(el, "faceHideBase", true);
    const faceOn = styleParam<string>(el, "faceOn", "brightness");
    const faceOnAmount = styleParam<number>(el, "faceOnAmount", 30);
    const faceOnSrc = styleParam<string>(el, "faceOnSrc", "");
    const doSwap = faceOn === "swap" && !!faceOnSrc;
    const src = isOn && doSwap ? faceOnSrc : el.faceSrc;
    // Brightness runs for the explicit "brightness" mode and as the "swap"
    // fallback when no second image exists, so the on-state always reads.
    const applyBrightness =
      isOn && (faceOn === "brightness" || (faceOn === "swap" && !doSwap));
    const filter = applyBrightness
      ? `brightness(${1 + faceOnAmount / 100})`
      : undefined;
    const showTint = isOn && faceOn === "tint";
    // The cutout (+ optional on-state tint), authored absolute so it drops in
    // unchanged whether it replaces the variant or composites over it. Inert to
    // pointer events — the click wiring lives on the container below (replace) or
    // the re-rendered variant beneath (composite).
    const faceLayer = (
      <>
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full select-none pointer-events-none transition-all"
          style={{
            objectFit: faceFit as React.CSSProperties["objectFit"],
            opacity: faceOpacity / 100,
            filter,
          }}
        />
        {showTint && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundColor: "var(--active-color)",
              opacity: faceOnAmount / 100,
            }}
          />
        )}
      </>
    );
    // Composite path: re-render the variant sans face for its programmatic look +
    // onClick wiring, then float the cutout over it. The wrapper takes no
    // handler — the variant root fills it and owns the flip.
    if (!faceHideBase) {
      return (
        <div className="w-full h-full relative">
          <ToggleControl
            el={{ ...el, faceSrc: undefined }}
            variant={variant}
            isPreview={isPreview}
            isOn={isOn}
            setIsOn={setIsOn}
          />
          {faceLayer}
        </div>
      );
    }
    // Replace path (default): the image stands in for the variant, so the click
    // wiring + toggle role/aria-pressed ride this container.
    return (
      <div
        className={`w-full h-full relative select-none ${isPreview ? "cursor-pointer" : ""}`}
        role="button"
        aria-pressed={isOn}
        aria-label={el.label || "Toggle"}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOn(!isOn);
          }
        }}
      >
        {faceLayer}
      </div>
    );
  }
  if (variant === "Checkbox") {
    return (
      <div
        className={`w-full h-full rounded border flex items-center justify-center transition-all ${!isOn ? "opacity-50 grayscale" : ""} ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          backgroundColor: "var(--active-color)",
          borderColor: "var(--active-color)",
        }}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOn(!isOn);
          }
        }}
      >
        <div
          className="w-1/2 h-1/2 bg-white"
          style={{
            clipPath:
              "polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%)",
            transform: `scale(${s})`,
          }}
        />
      </div>
    );
  }
  if (variant === "Brutalist") {
    return (
      <div
        className={`w-full h-full min-h-4 border-[3px] relative flex transition-colors ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "var(--active-color)",
        }}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOn(!isOn);
          }
        }}
      >
        <div className="flex w-full h-full" style={{ transform: `scale(${s})` }}>
          <div
            className="w-1/2 h-full transition-opacity"
            style={{
              opacity: isOn ? 0 : 1,
              backgroundColor: "var(--active-color)",
            }}
          />
          <div
            className="w-1/2 h-full transition-opacity"
            style={{
              opacity: isOn ? 1 : 0,
              backgroundColor: "var(--active-color)",
            }}
          />
        </div>
      </div>
    );
  }
  if (variant === "Neumorphic") {
    return (
      <div
        className={`w-full h-full min-h-4 rounded-full shadow-[inset_2px_2px_4px_rgba(0,0,0,0.6),inset_-2px_-2px_4px_rgba(255,255,255,0.05)] relative ${isPreview ? "cursor-pointer" : ""}`}
        style={{ backgroundColor: "var(--base-color)" }}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOn(!isOn);
          }
        }}
      >
        <div
          className={`absolute top-[10%] h-[80%] aspect-square rounded-full transition-all shadow-[2px_2px_4px_rgba(0,0,0,0.5),-1px_-1px_2px_rgba(255,255,255,0.1)]`}
          style={{
            left: isOn ? "calc(100% - 10%)" : "10%",
            transform: isOn
              ? `translate(-100%, 0) scale(${s})`
              : `translate(0, 0) scale(${s})`,
            backgroundColor: isOn
              ? "var(--active-color)"
              : "var(--base-color)",
          }}
        />
      </div>
    );
  }
  if (variant === "Rocker") {
    return (
      <div
        className={`relative w-full h-full min-h-4 rounded-sm p-[8%] select-none ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          background: "linear-gradient(145deg, #26262c, #0d0d11)",
          boxShadow: `inset 0 ${1 * hd}px ${2 * hd}px rgba(0,0,0,0.8), inset 0 ${-1 * hd}px ${1 * hd}px rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.5)`,
        }}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOn(!isOn);
          }
        }}
      >
        <div
          className="w-full h-full rounded-[3px] overflow-hidden flex flex-col transition-transform duration-200"
          style={{
            transform: isOn
              ? `perspective(240px) rotateX(-12deg) scale(${s})`
              : `perspective(240px) rotateX(12deg) scale(${s})`,
            transformOrigin: "center",
          }}
        >
          <div
            className="h-1/2 flex items-center justify-center text-[8px] font-bold leading-none transition-all"
            style={{
              background: isOn
                ? "var(--active-color)"
                : "linear-gradient(180deg, #1c1c21, #101014)",
              boxShadow: isOn
                ? `0 0 ${(8 * glow) / 50}px var(--active-color), inset 0 1px 2px rgba(255,255,255,0.3)`
                : "inset 0 2px 4px rgba(0,0,0,0.7)",
              color: "var(--text-color)",
              opacity: isOn ? 1 : 0.5,
            }}
          >
            {showLegends ? "I" : ""}
          </div>
          <div
            className="h-1/2 flex items-center justify-center text-[8px] font-bold leading-none transition-all"
            style={{
              background: !isOn
                ? "color-mix(in srgb, var(--active-color) 42%, #0b0b0e)"
                : "linear-gradient(180deg, #101014, #1c1c21)",
              boxShadow: !isOn
                ? `0 0 ${(5 * glow) / 50}px color-mix(in srgb, var(--active-color) 50%, transparent), inset 0 -1px 2px rgba(255,255,255,0.15)`
                : "inset 0 -2px 4px rgba(0,0,0,0.7)",
              color: "var(--text-color)",
              opacity: !isOn ? 0.9 : 0.5,
            }}
          >
            {showLegends ? "O" : ""}
          </div>
        </div>
      </div>
    );
  }
  if (variant === "Lever") {
    return (
      <div
        className={`relative w-full h-full min-h-4 flex items-center justify-center overflow-hidden select-none ${isPreview ? "cursor-pointer" : ""}`}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOn(!isOn);
          }
        }}
      >
        <div
          className="relative h-full aspect-square flex items-end justify-center"
          style={{ transform: `scale(${s})` }}
        >
          <div
            className="absolute left-1/2 bottom-[8%] -translate-x-1/2 rounded-full"
            style={{
              width: "62%",
              aspectRatio: "1",
              background:
                "radial-gradient(circle at 50% 42%, #42424a 0%, #26262c 34%, #14141a 58%, #08080b 74%), repeating-radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.28) 2px 3px)",
              boxShadow: `inset 0 ${1 * hd}px ${2 * hd}px rgba(255,255,255,0.15), inset 0 ${-2 * hd}px ${4 * hd}px rgba(0,0,0,0.7), 0 2px 4px rgba(0,0,0,0.6)`,
            }}
          />
          <div
            className="absolute left-1/2 bottom-[14%] rounded-full transition-all duration-200"
            style={{
              width: "20%",
              height: "56%",
              transformOrigin: "50% 100%",
              transform: isOn
                ? `translateX(-50%) rotate(-${leverAngle}deg)`
                : `translateX(-50%) rotate(${leverAngle}deg)`,
              background:
                "linear-gradient(90deg, #0d0d10 0%, #34343d 42%, #1d1d23 60%, #0a0a0d 100%)",
              boxShadow: isOn
                ? `0 0 ${(8 * glow) / 50}px var(--active-color), inset 0 1px 1px rgba(255,255,255,0.2)`
                : "inset 0 1px 1px rgba(255,255,255,0.12), inset 0 -1px 2px rgba(0,0,0,0.6)",
              filter: isOn
                ? "drop-shadow(-3px 4px 3px rgba(0,0,0,0.55))"
                : "drop-shadow(3px 4px 3px rgba(0,0,0,0.55))",
            }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/4 rounded-full transition-all duration-200"
              style={{
                width: "80%",
                aspectRatio: "1",
                background: isOn
                  ? "radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--active-color) 70%, #fff) 0%, var(--active-color) 60%, color-mix(in srgb, var(--active-color) 60%, #000) 100%)"
                  : "radial-gradient(circle at 35% 30%, #3a3a42, #17171c 70%, #0b0b0e 100%)",
                boxShadow: isOn
                  ? `0 0 ${(6 * glow) / 50}px var(--active-color)`
                  : "inset 0 -1px 2px rgba(0,0,0,0.6)",
              }}
            />
          </div>
        </div>
      </div>
    );
  }
  if (variant === "Blank") {
    // Minimal neutral switch: plain pill track (hairline border) + flat
    // circular thumb. Off track = --base-color, on track = --active-color;
    // thumb is a flat --text-color disc (no shadow/glow). switchScale drives
    // the thumb size via `s`.
    return (
      <div
        className={`w-full h-full min-h-4 rounded-full relative border transition-colors ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          backgroundColor: isOn ? "var(--active-color)" : "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
        }}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOn(!isOn);
          }
        }}
      >
        <div
          className="absolute top-[10%] h-[80%] aspect-square rounded-full transition-all"
          style={{
            left: isOn ? "calc(100% - 10%)" : "10%",
            transform: isOn
              ? `translate(-100%, 0) scale(${s})`
              : `translate(0, 0) scale(${s})`,
            backgroundColor: "var(--text-color)",
          }}
        />
      </div>
    );
  }
  // Default (Switch)
  return (
    <div
      className={`w-full h-full min-h-4 rounded-full relative transition-colors ${isPreview ? "cursor-pointer" : ""}`}
      style={{
        backgroundColor: isOn ? "var(--active-color)" : "var(--base-color)",
      }}
      onClick={(e) => {
        if (isPreview) {
          e.stopPropagation();
          setIsOn(!isOn);
        }
      }}
    >
      <div
        className={`absolute top-[10%] h-[80%] aspect-square bg-white rounded-full transition-all shadow`}
        style={{
          left: isOn ? "calc(100% - 10%)" : "10%",
          transform: isOn
            ? `translate(-100%, 0) scale(${s})`
            : `translate(0, 0) scale(${s})`,
        }}
      />
    </div>
  );
}
