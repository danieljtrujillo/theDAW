import React from "react";
import { BaseControlProps } from "./shared";
import { styleParam } from "./controlParams";

interface ButtonControlProps extends BaseControlProps {
  isPressed: boolean;
  setIsPressed: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function ButtonControl({
  el,
  variant,
  isPreview,
  isPressed,
  setIsPressed,
}: ButtonControlProps) {
  // Adjustable params (schema defaults reproduce the pre-parameterization look).
  const labelSize = styleParam(el, "labelSize", 12);
  const pressDepth = styleParam(el, "pressDepth", 2);
  // Bezel padding + LED strip height are factor-anchored so the schema defaults
  // (bezelWidth 3, ledStripHeight 4) reproduce the previous hard-coded look
  // exactly: LED Push bezel = 10% × (bezel/3), Chrome bezel = 13% × (bezel/3),
  // LED Push strip = 9% × (strip/4).
  const bezelWidth = styleParam(el, "bezelWidth", 3);
  const ledStripHeight = styleParam(el, "ledStripHeight", 4);
  // Glow is a relative intensity (%): the schema default (60) is the baseline
  // that reproduces today's glow, so blur radii scale by (glow / 60).
  const glow = styleParam(el, "glowStrength", 60);
  // --- Image face (opt-in). When el.faceSrc is set the button wears the
  // supplied cutout, reusing the Blank variant's onMouseDown/Up/Leave wiring so
  // setIsPressed still flows and the button "clicks". The pressed treatment is
  // chosen by facePressed: "brightness" dims the image by facePressedAmount%,
  // "scale" shrinks it, "offset" nudges it down facePressedAmount px, "swap"
  // shows styleParams.facePressedSrc while held (falling back to a brightness
  // dim when no swap image is stored). faceHideBase (default true) swaps the
  // image IN PLACE OF the variant (press wiring + button role/aria live on the
  // face container); false composites it OVER a full re-render of the variant
  // (wiring lives on that variant, the face floats inert above it — the C2
  // "composites over" path). Absent faceSrc this branch never runs, so the
  // variants below are unchanged.
  if (el.faceSrc) {
    const faceFit = styleParam<string>(el, "faceFit", "contain");
    const faceOpacity = styleParam<number>(el, "faceOpacity", 100);
    const faceHideBase = styleParam<boolean>(el, "faceHideBase", true);
    const facePressed = styleParam<string>(el, "facePressed", "brightness");
    const facePressedAmount = styleParam<number>(el, "facePressedAmount", 30);
    const facePressedSrc = styleParam<string>(el, "facePressedSrc", "");
    const doSwap = facePressed === "swap" && !!facePressedSrc;
    const src = isPressed && doSwap ? facePressedSrc : el.faceSrc;
    // Brightness runs for the explicit "brightness" mode and as the "swap"
    // fallback when no second image exists, so a press always reads visually.
    const applyBrightness =
      isPressed && (facePressed === "brightness" || (facePressed === "swap" && !doSwap));
    const filter = applyBrightness
      ? `brightness(${Math.max(0, 1 - facePressedAmount / 100)})`
      : undefined;
    const scale =
      isPressed && facePressed === "scale"
        ? Math.max(0, 1 - facePressedAmount / 100)
        : 1;
    const translateY = isPressed && facePressed === "offset" ? facePressedAmount : 0;
    const transform =
      scale !== 1 || translateY !== 0
        ? `translateY(${translateY}px) scale(${scale})`
        : undefined;
    // The cutout, authored absolute so it drops in unchanged whether it replaces
    // the variant or composites over it. Inert to pointer events — the press
    // wiring lives on the container below (replace) or the re-rendered variant.
    const faceLayer = (
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute inset-0 w-full h-full select-none pointer-events-none transition-all"
        style={{
          objectFit: faceFit as React.CSSProperties["objectFit"],
          opacity: faceOpacity / 100,
          filter,
          transform,
        }}
      />
    );
    // Composite path: re-render the variant sans face for its programmatic look +
    // onMouseDown/Up/Leave wiring, then float the cutout over it. The wrapper
    // takes no handlers — the variant root fills it and owns the press.
    if (!faceHideBase) {
      return (
        <div className="w-full h-full relative">
          <ButtonControl
            el={{ ...el, faceSrc: undefined }}
            variant={variant}
            isPreview={isPreview}
            isPressed={isPressed}
            setIsPressed={setIsPressed}
          />
          {faceLayer}
        </div>
      );
    }
    // Replace path (default): the image stands in for the variant, so the press
    // wiring + button role/aria-pressed ride this container.
    return (
      <div
        className={`w-full h-full relative select-none transition-all ${isPreview ? "cursor-pointer" : ""}`}
        role="button"
        aria-pressed={isPressed}
        aria-label={el.label || "Button"}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        {faceLayer}
      </div>
    );
  }
  if (variant === "Outline") {
    return (
      <div
        className={`w-full h-full bg-transparent border rounded flex items-center justify-center text-xs font-medium truncate px-2 select-none transition-all ${isPreview ? "cursor-pointer" : ""} ${isPressed ? "scale-[0.98] opacity-80" : ""}`}
        style={{
          borderColor: "var(--active-color)",
          color: "var(--active-color)",
          fontSize: `${labelSize}px`,
        }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        {el.label || "Button"}
      </div>
    );
  }
  if (variant === "Neumorphic") {
    return (
      <div
        className={`w-full h-full rounded-lg flex items-center justify-center text-xs font-medium truncate px-2 select-none transition-all ${isPreview ? "cursor-pointer" : ""} ${isPressed ? "shadow-[inset_2px_2px_4px_rgba(0,0,0,0.6),inset_-2px_-2px_4px_rgba(255,255,255,0.05)] scale-[0.98]" : "shadow-[4px_4px_8px_rgba(0,0,0,0.5),-2px_-2px_4px_rgba(255,255,255,0.05)]"}`}
        style={{
          backgroundColor: "var(--base-color)",
          color: isPressed
            ? "rgba(255,255,255,0.5)"
            : "rgba(255,255,255,0.8)",
          fontSize: `${labelSize}px`,
        }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        {el.label || "Button"}
      </div>
    );
  }
  if (variant === "Brutalist") {
    return (
      <div
        className={`w-full h-full border-[3px] border-black flex items-center justify-center text-xs font-bold uppercase truncate px-2 select-none transition-all ${isPreview ? "cursor-pointer hover:bg-gray-100" : ""} ${isPressed ? "translate-x-[3px] translate-y-[3px] shadow-none" : "shadow-[4px_4px_0_0_#000]"}`}
        style={{
          backgroundColor: "var(--base-color)",
          color: "var(--active-color)",
          fontSize: `${labelSize}px`,
        }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        {el.label || "BTN"}
      </div>
    );
  }
  if (variant === "CellShaded") {
    return (
      <div
        className={`w-full h-full border-[3px] border-black flex items-center justify-center text-xs text-black font-black uppercase truncate px-2 select-none transition-all transform -skew-x-6 ${isPreview ? "cursor-pointer" : ""} ${isPressed ? "translate-x-[3px] translate-y-[3px] shadow-none" : "shadow-[4px_4px_0_0_#000]"}`}
        style={{ backgroundColor: "var(--base-color)", fontSize: `${labelSize}px` }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        <div className="skew-x-6">{el.label || "PUSH!"}</div>
      </div>
    );
  }
  if (variant === "Drum Pad") {
    return (
      <div
        className={`w-full h-full border-2 rounded-lg flex items-center justify-center select-none transition-all duration-75 ${isPreview ? "cursor-pointer" : ""} ${isPressed ? "scale-[0.97]" : "shadow-[inset_0_4px_10px_rgba(255,255,255,0.1),0_8px_15px_rgba(0,0,0,0.5)]"}`}
        style={{
          backgroundColor: isPressed
            ? "var(--active-color)"
            : "var(--base-color)",
          borderColor: isPressed
            ? "var(--active-color)"
            : "rgba(255,255,255,0.1)",
          boxShadow: isPressed
            ? `0 0 20px var(--active-color), inset 0 0 20px rgba(255,255,255,0.5)`
            : undefined,
        }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        <div
          className="w-full h-full m-1 rounded bg-white/5 opacity-50 flex items-center justify-center text-xs font-bold text-[color:var(--text-color)]"
          style={{ fontSize: `${labelSize}px` }}
        >
          {el.label}
        </div>
      </div>
    );
  }
  if (variant === "LED Push") {
    return (
      <div
        className={`w-full h-full rounded-md select-none transition-all ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          padding: `${(10 * bezelWidth) / 3}%`,
          background: "linear-gradient(145deg, #1c1c22, #0b0b0f)",
          boxShadow:
            "inset 0 1px 2px rgba(0,0,0,0.85), inset 0 -1px 1px rgba(255,255,255,0.05), 0 1px 1px rgba(255,255,255,0.04)",
        }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        <div
          className="relative w-full h-full rounded-[22%] flex items-center justify-center transition-all duration-75"
          style={{
            background: isPressed
              ? "linear-gradient(160deg, #202026, #101014)"
              : "linear-gradient(160deg, #2f2f38, #17171c)",
            transform: isPressed
              ? `translateY(${pressDepth}px) scale(0.985)`
              : "none",
            boxShadow: isPressed
              ? "0 1px 2px rgba(0,0,0,0.5), inset 0 2px 4px rgba(0,0,0,0.7), inset 0 -1px 1px rgba(255,255,255,0.05)"
              : "0 4px 6px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.14), inset 0 -2px 3px rgba(0,0,0,0.4)",
          }}
        >
          <div
            className="absolute top-[12%] left-1/2 -translate-x-1/2 w-1/2 min-h-[3px] rounded-full transition-all duration-75"
            style={{
              height: `${(9 * ledStripHeight) / 4}%`,
              backgroundColor: isPressed
                ? "var(--active-color)"
                : "color-mix(in srgb, var(--active-color) 22%, #08080b)",
              boxShadow: isPressed
                ? `0 0 ${(6 * glow) / 60}px var(--active-color), 0 0 ${(12 * glow) / 60}px var(--active-color), inset 0 0 2px rgba(255,255,255,0.6)`
                : "inset 0 1px 2px rgba(0,0,0,0.8)",
            }}
          />
          <span
            className="mt-[8%] text-xs font-medium truncate px-1 text-[color:var(--text-color)]"
            style={{ fontSize: `${labelSize}px` }}
          >
            {el.label || "Button"}
          </span>
        </div>
      </div>
    );
  }
  if (variant === "Chrome") {
    return (
      <div
        className={`w-full h-full rounded-full flex items-center justify-center select-none transition-all ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          padding: `${(13 * bezelWidth) / 3}%`,
          background:
            "conic-gradient(from 90deg, #ededf0, #85858c, #f6f6f8, #6b6b72, #e2e2e5, #9a9aa1, #fcfcfe, #78787f, #ededf0)",
          boxShadow: isPressed
            ? `0 1px 2px rgba(0,0,0,0.6), inset 0 1px 3px rgba(0,0,0,0.5), 0 0 ${(10 * glow) / 60}px var(--active-color)`
            : "0 3px 6px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.5)",
        }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        <div
          className="relative w-full h-full rounded-full flex items-center justify-center overflow-hidden transition-all"
          style={{
            background: isPressed
              ? "radial-gradient(circle at 50% 55%, color-mix(in srgb, var(--base-color) 75%, #000) 0%, color-mix(in srgb, var(--base-color) 60%, #000) 60%, color-mix(in srgb, var(--base-color) 40%, #000) 100%)"
              : "radial-gradient(circle at 35% 28%, color-mix(in srgb, var(--base-color) 55%, #fff) 0%, var(--base-color) 42%, color-mix(in srgb, var(--base-color) 70%, #000) 100%)",
            boxShadow: isPressed
              ? `inset 0 2px 6px rgba(0,0,0,0.65), 0 0 ${(8 * glow) / 60}px var(--active-color)`
              : "inset 0 1px 2px rgba(255,255,255,0.25), inset 0 -2px 5px rgba(0,0,0,0.45)",
          }}
        >
          <div
            className="pointer-events-none absolute top-[10%] left-[18%] w-1/2 h-1/3 rounded-full"
            style={{
              background:
                "radial-gradient(ellipse at center, rgba(255,255,255,0.55), rgba(255,255,255,0) 70%)",
              opacity: isPressed ? 0.25 : 0.8,
            }}
          />
          <span
            className="relative text-xs font-medium truncate px-1 text-[color:var(--text-color)]"
            style={{ fontSize: `${labelSize}px` }}
          >
            {el.label || "Button"}
          </span>
        </div>
      </div>
    );
  }
  if (variant === "Blank") {
    // Minimal neutral push: plain rounded rect in --base-color with a hairline
    // border; label centered in --text-color. Pressed = flat --active-color
    // fill + a simple translateY (no shadow tricks). All materials come from
    // the element colors / skin system, not from this render.
    return (
      <div
        className={`w-full h-full rounded border flex items-center justify-center text-xs font-medium truncate px-2 select-none transition-all ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          backgroundColor: isPressed
            ? "var(--active-color)"
            : "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
          color: "var(--text-color)",
          fontSize: `${labelSize}px`,
          transform: isPressed ? `translateY(${pressDepth}px)` : "none",
        }}
        onMouseDown={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsPressed(true);
          }
        }}
        onMouseUp={() => setIsPressed(false)}
        onMouseLeave={() => setIsPressed(false)}
      >
        {el.label || "Button"}
      </div>
    );
  }
  // Default (Solid)
  return (
    <div
      className={`w-full h-full rounded flex items-center justify-center text-xs text-[color:var(--text-color)] font-medium shadow truncate px-2 select-none transition-all ${isPreview ? "cursor-pointer" : ""} ${isPressed ? "scale-[0.98] brightness-90" : ""}`}
      style={{ backgroundColor: "var(--active-color)", fontSize: `${labelSize}px` }}
      onMouseDown={(e) => {
        if (isPreview) {
          e.stopPropagation();
          setIsPressed(true);
        }
      }}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
    >
      {el.label || "Button"}
    </div>
  );
}
