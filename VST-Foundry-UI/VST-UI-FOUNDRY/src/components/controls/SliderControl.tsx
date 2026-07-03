import React from "react";
import { BaseControlProps, ControlContainerRef } from "./shared";
import { styleParam } from "./controlParams";

interface SliderControlProps extends BaseControlProps {
  val: number;
  containerRef: ControlContainerRef;
}

/**
 * Optional printed tick scale, rendered down the right edge of a slider when
 * `tickCount > 0` (the generic `tickCount` param, default 0 → nothing, so every
 * variant's default output is unchanged). Percentage-positioned so it stays
 * size-responsive; every 5th line is drawn longer/brighter like a dB scale.
 */
function SliderTicks({ count }: { count: number }) {
  if (!count || count <= 0) return null;
  const lines = Array.from({ length: count });
  return (
    <svg
      className="absolute right-0 top-0 h-full w-2 pointer-events-none"
      style={{ color: "var(--text-color)" }}
      aria-hidden="true"
    >
      {lines.map((_, i) => {
        const y = count === 1 ? "50%" : `${(i / (count - 1)) * 100}%`;
        const long = i % 5 === 0;
        return (
          <line
            key={i}
            x1={long ? 0 : 4}
            x2="8"
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeWidth="1"
            opacity={long ? 0.38 : 0.16}
          />
        );
      })}
    </svg>
  );
}

export default function SliderControl({
  el,
  variant,
  val,
  isPreview,
  containerRef,
}: SliderControlProps) {
  const tickCount = styleParam(el, "tickCount", 0);

  // Image-face branch: when el.faceSrc is set the slider wears a cutout. Two
  // roles (C2): "thumb" rides the value up a neutral track (the Blank variant's
  // flat track, so the skin/texture systems still supply material); "track"
  // paints the image as the full backdrop with the Blank cap riding on top so
  // the value stays legible. Both keep vertical drag live by hanging
  // containerRef on the root, and honor faceFit / faceOpacity. Gated on faceSrc
  // so every default (unset) render below is byte-identical to today.
  if (el.faceSrc) {
    const faceRole = styleParam<string>(el, "faceRole", "thumb");
    const faceFit = styleParam(
      el,
      "faceFit",
      "contain",
    ) as React.CSSProperties["objectFit"];
    const faceOpacity = styleParam(el, "faceOpacity", 100) / 100;
    if (faceRole === "track") {
      // Face fills the control (faceFit); the Blank variant's flat cap rides on
      // top at bottom:${val}% exactly like every other slider cap.
      const capWidth = styleParam(el, "capWidth", 90);
      const capHeight = styleParam(el, "capHeight", 20);
      return (
        <div
          ref={containerRef}
          className={`w-full h-[calc(100%-8px)] mx-auto relative my-1 flex justify-center ${isPreview ? "cursor-ns-resize" : ""}`}
        >
          <img
            src={el.faceSrc}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ objectFit: faceFit, opacity: faceOpacity }}
          />
          {/* Blank cap on top */}
          <div
            className="absolute left-1/2 min-w-4 pointer-events-none"
            style={{
              width: `${capWidth}%`,
              height: `${capHeight}px`,
              bottom: `${val}%`,
              transform: "translate(-50%, 50%)",
              backgroundColor: "var(--active-color)",
            }}
          />
        </div>
      );
    }
    // "thumb" (default): neutral Blank track with the cutout as the moving cap.
    // Width is faceThumbSize% of the element; height auto keeps the cutout's
    // aspect. Position matches every existing thumb: bottom:${val}% + translate.
    const trackWidth = styleParam(el, "trackWidth", 40);
    const faceThumbSize = styleParam(el, "faceThumbSize", 60);
    return (
      <div
        ref={containerRef}
        className={`w-full h-[calc(100%-8px)] mx-auto relative my-1 flex justify-center ${isPreview ? "cursor-ns-resize" : ""}`}
      >
        {/* neutral track (Blank variant styling) */}
        <div
          className="h-full border"
          style={{
            width: `${trackWidth}%`,
            backgroundColor: "var(--base-color)",
            borderColor: "color-mix(in srgb, var(--text-color) 30%, transparent)",
          }}
        />
        {/* cutout thumb */}
        <img
          src={el.faceSrc}
          alt=""
          draggable={false}
          className="absolute left-1/2 pointer-events-none"
          style={{
            width: `${faceThumbSize}%`,
            height: "auto",
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            objectFit: faceFit,
            opacity: faceOpacity,
          }}
        />
      </div>
    );
  }

  if (variant === "Blank") {
    // Unbranded hardware blank: a plain rectangular track (--base-color,
    // hairline border) with a plain rectangular cap in --active-color (matching
    // the default variant's cap). trackWidth/capWidth/capHeight/tickCount are
    // all wired. No rounding, gradients, or shadows — flat colors only so the
    // skin and texture systems supply all material.
    const trackWidth = styleParam(el, "trackWidth", 40);
    const capWidth = styleParam(el, "capWidth", 90);
    const capHeight = styleParam(el, "capHeight", 20);
    return (
      <div
        ref={containerRef}
        className={`w-full h-[calc(100%-8px)] mx-auto relative my-1 flex justify-center ${isPreview ? "cursor-ns-resize" : ""}`}
      >
        <SliderTicks count={tickCount} />
        {/* track */}
        <div
          className="h-full border"
          style={{
            width: `${trackWidth}%`,
            backgroundColor: "var(--base-color)",
            borderColor: "color-mix(in srgb, var(--text-color) 30%, transparent)",
          }}
        />
        {/* cap */}
        <div
          className="absolute left-1/2 min-w-4 pointer-events-none"
          style={{
            width: `${capWidth}%`,
            height: `${capHeight}px`,
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
    );
  }
  if (variant === "Bipole") {
    const isVertical = el.height! > el.width!;
    // fillFromCenter: true → bipolar fill anchored at the 50% center; false →
    // unipolar fill from the bottom/left edge up to `val`.
    const fillFromCenter = styleParam(el, "fillFromCenter", true);
    const fillSize = fillFromCenter ? Math.abs(val - 50) : val;
    const fillStart = fillFromCenter ? Math.min(val, 50) : 0;
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded border relative my-1 ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "rgba(0,0,0,0.5)",
        }}
      >
        <SliderTicks count={tickCount} />
        {isVertical ? (
          <div className="absolute top-1/2 left-0 right-0 h-px bg-white/20" />
        ) : (
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/20" />
        )}
        <div
          className="absolute shadow pointer-events-none"
          style={{
            ...(isVertical
              ? {
                  bottom: `${fillStart}%`,
                  height: `${fillSize}%`,
                  left: 0,
                  right: 0,
                }
              : {
                  left: `${fillStart}%`,
                  width: `${fillSize}%`,
                  top: 0,
                  bottom: 0,
                }),
            backgroundColor: "var(--active-color)",
          }}
        />
        <div
          className="absolute w-full h-4 shadow pointer-events-none rounded"
          style={{
            ...(isVertical
              ? { bottom: `${val}%`, transform: "translateY(50%)" }
              : {
                  left: `${val}%`,
                  transform: "translateX(-50%)",
                  width: "16px",
                  height: "100%",
                }),
            backgroundColor: "rgba(255,255,255,0.8)",
          }}
        />
      </div>
    );
  }
  if (variant === "Thin") {
    return (
      <div
        ref={containerRef}
        className={`w-1 h-full rounded-full relative mx-auto ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ backgroundColor: "var(--base-color)" }}
      >
        <SliderTicks count={tickCount} />
        <div
          className="absolute left-1/2 -translate-x-1/2 w-4 h-4 rounded-full shadow pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
    );
  }
  if (variant === "Neumorphic") {
    return (
      <div
        ref={containerRef}
        className={`w-full max-w-10 mx-auto h-[calc(100%-8px)] rounded-[10px] shadow-[inset_2px_2px_4px_rgba(0,0,0,0.6),inset_-2px_-2px_4px_rgba(255,255,255,0.05)] relative my-1 ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ backgroundColor: "var(--base-color)" }}
      >
        <SliderTicks count={tickCount} />
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[80%] min-w-6 h-6 rounded-lg shadow-[2px_2px_4px_rgba(0,0,0,0.5),-1px_-1px_2px_rgba(255,255,255,0.1)] flex items-center justify-center pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            backgroundColor: "var(--base-color)",
          }}
        >
          <div
            className="w-3 h-0.5 rounded-full"
            style={{ backgroundColor: "var(--active-color)" }}
          />
        </div>
      </div>
    );
  }
  if (variant === "Brutalist") {
    return (
      <div
        ref={containerRef}
        className={`w-full max-w-8 mx-auto h-[calc(100%-8px)] border-[3px] relative my-1 ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "var(--active-color)",
        }}
      >
        <SliderTicks count={tickCount} />
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[150%] min-w-6 h-4 pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
    );
  }
  if (variant === "CellShaded") {
    return (
      <div
        ref={containerRef}
        className={`w-full max-w-10 mx-auto h-[calc(100%-8px)] border-4 border-black relative my-1 ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ backgroundColor: "var(--base-color)" }}
      >
        <SliderTicks count={tickCount} />
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[140%] min-w-8 h-6 border-4 border-black shadow-[2px_2px_0_0_#000] pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
    );
  }
  if (variant === "Channel Fader") {
    // Pro mixing-console fader: recessed groove, machined cap with center
    // indicator + grip ridges, printed dB-style tick scale, vertical.
    const showTicks = styleParam(el, "showTicks", true);
    const railDepth = styleParam(el, "railDepth", 4);
    // The printed scale keeps its historical 11-line layout by default; when the
    // generic tickCount is set (>0) it drives the line count instead.
    const tickN = tickCount > 0 ? tickCount : 11;
    const ticks = Array.from({ length: tickN });
    // railDepth drives the groove's inset shadow; at the default (4) the formula
    // reproduces the previous hard-coded "inset 1px 0 2px / 0 1px 2px" exactly.
    const railOffset = railDepth / 4;
    const railBlur = railDepth / 2;
    return (
      <div
        ref={containerRef}
        className={`w-full h-[calc(100%-8px)] relative my-1 flex justify-center ${isPreview ? "cursor-ns-resize" : ""}`}
      >
        {/* printed dB-style tick scale down the right edge */}
        {showTicks ? (
          <svg
            className="absolute right-1 top-0 h-full w-2 pointer-events-none"
            style={{ color: "var(--text-color)" }}
            aria-hidden="true"
          >
            {ticks.map((_, i) => {
              const long = i % 5 === 0;
              const y = `${(i / (ticks.length - 1)) * 100}%`;
              return (
                <line
                  key={i}
                  x1={long ? 0 : 4}
                  x2="8"
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth="1"
                  opacity={long ? 0.38 : 0.16}
                />
              );
            })}
          </svg>
        ) : null}

        {/* recessed center rail / groove */}
        <div
          className="relative h-full w-2 rounded-full"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.3) 44%, rgba(255,255,255,0.07) 52%, rgba(0,0,0,0.55) 100%)",
            boxShadow: `inset ${railOffset}px 0 ${railBlur}px rgba(0,0,0,0.85), inset -${railOffset}px 0 ${railBlur}px rgba(0,0,0,0.6), 0 ${railOffset}px ${railBlur}px rgba(0,0,0,0.4)`,
          }}
        >
          {/* machined fader cap */}
          <div
            className="absolute left-1/2 w-[280%] min-w-8 h-7 rounded-sm flex flex-col items-center justify-center gap-0.5 pointer-events-none"
            style={{
              bottom: `${val}%`,
              transform: "translate(-50%, 50%)",
              background:
                "linear-gradient(180deg, #4a4a52 0%, #2c2c32 18%, #191a1e 48%, #27272c 52%, #3b3b42 82%, #131316 100%)",
              border: "1px solid rgba(0,0,0,0.65)",
              boxShadow:
                "0 3px 6px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.55)",
            }}
          >
            {/* upper grip ridges */}
            <div
              className="w-[72%] h-px"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)",
              }}
            />
            <div
              className="w-[72%] h-px"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(0,0,0,0.6), transparent)",
              }}
            />
            {/* center indicator line */}
            <div
              className="w-[86%] h-0.5 rounded-full my-0.5"
              style={{
                background: "var(--active-color)",
                boxShadow: "0 0 4px var(--active-color)",
              }}
            />
            {/* lower grip ridges */}
            <div
              className="w-[72%] h-px"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)",
              }}
            />
            <div
              className="w-[72%] h-px"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(0,0,0,0.6), transparent)",
              }}
            />
          </div>
        </div>
      </div>
    );
  }
  if (variant === "LED Slider") {
    // Illuminated track: dark channel with faint unlit texture, glowing
    // filled portion below the handle, compact glowing handle. Vertical.
    // glowStrength scales the glow blur radii; at the default (60) the factor is
    // 1.0 so the illumination matches the previous hard-coded values exactly.
    const glowStrength = styleParam(el, "glowStrength", 60);
    const g = glowStrength / 60;
    return (
      <div
        ref={containerRef}
        className={`w-full max-w-2.5 mx-auto h-[calc(100%-8px)] rounded-full relative my-1 ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{
          background: "linear-gradient(180deg, #0a0a0c 0%, #141418 100%)",
          boxShadow:
            "inset 0 1px 3px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.05)",
        }}
      >
        <SliderTicks count={tickCount} />
        {/* faint unlit track texture */}
        <div
          className="absolute inset-0 rounded-full opacity-25 pointer-events-none"
          style={{
            background:
              "repeating-linear-gradient(180deg, transparent 0, transparent 3px, rgba(255,255,255,0.05) 3px, rgba(255,255,255,0.05) 4px)",
          }}
        />
        {/* illuminated filled portion below handle */}
        <div
          className="absolute left-0 right-0 bottom-0 rounded-full pointer-events-none"
          style={{
            height: `${val}%`,
            background:
              "linear-gradient(180deg, var(--active-color) 0%, color-mix(in srgb, var(--active-color) 50%, transparent) 100%)",
            boxShadow: `0 0 ${10 * g}px color-mix(in srgb, var(--active-color) 65%, transparent), 0 0 ${3 * g}px var(--active-color), inset 0 0 2px rgba(255,255,255,0.3)`,
          }}
        />
        {/* compact glowing handle */}
        <div
          className="absolute left-1/2 w-[180%] min-w-4 h-2 rounded-full pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            background:
              "linear-gradient(180deg, #ffffff 0%, var(--active-color) 55%, color-mix(in srgb, var(--active-color) 55%, #000) 100%)",
            boxShadow: `0 0 ${6 * g}px var(--active-color), 0 0 ${13 * g}px color-mix(in srgb, var(--active-color) 55%, transparent), 0 1px 2px rgba(0,0,0,0.6)`,
          }}
        />
      </div>
    );
  }
  if (variant === "Mod Wheel") {
    // Classic synth mod wheel seen edge-on: a recessed dark well (slot) with a
    // wide cylindrical wheel that rides vertically with `val`. Horizontal grip
    // grooves + cylindrical top/bottom shading sell the depth.
    const wellDepth = styleParam(el, "wellDepth", 4);
    const wheelGrooves = styleParam(el, "wheelGrooves", 8);
    const groovePeriod = 100 / Math.max(wheelGrooves, 1); // % per groove
    return (
      <div
        ref={containerRef}
        className={`w-full h-[calc(100%-8px)] mx-auto my-1 relative rounded-md overflow-hidden ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{
          background:
            "linear-gradient(90deg, #0a0a0c 0%, #17171b 50%, #0a0a0c 100%)",
          boxShadow: `inset 0 ${wellDepth}px ${wellDepth * 2}px rgba(0,0,0,0.85), inset 0 -${wellDepth}px ${wellDepth * 2}px rgba(0,0,0,0.85), inset ${wellDepth}px 0 ${wellDepth}px rgba(0,0,0,0.6), inset -${wellDepth}px 0 ${wellDepth}px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.5)`,
        }}
      >
        <SliderTicks count={tickCount} />
        {/* cylindrical wheel */}
        <div
          className="absolute left-1/2 w-[86%] h-[42%] rounded-md pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            background: `repeating-linear-gradient(180deg, rgba(0,0,0,0.55) 0, rgba(0,0,0,0.55) ${groovePeriod * 0.16}%, rgba(255,255,255,0.08) ${groovePeriod * 0.16}%, rgba(255,255,255,0.08) ${groovePeriod * 0.32}%, transparent ${groovePeriod * 0.32}%, transparent ${groovePeriod}%), linear-gradient(180deg, #17171c 0%, #3a3a44 15%, #6b6b78 50%, #3a3a44 85%, #17171c 100%)`,
            border: "1px solid rgba(0,0,0,0.7)",
            boxShadow:
              "0 2px 4px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.12), inset 0 -2px 3px rgba(0,0,0,0.5)",
          }}
        />
        {/* subtle top sheen inside the well */}
        <div
          className="absolute top-0 left-0 right-0 h-[16%] pointer-events-none"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 100%)",
          }}
        />
      </div>
    );
  }
  if (variant === "Pitch Wheel") {
    // Same edge-on wheel construction as the mod wheel, but center-detented:
    // a marked center line on the well and an --active-color glow whose
    // intensity grows with the wheel's distance from center.
    const wellDepth = styleParam(el, "wellDepth", 4);
    const wheelGrooves = styleParam(el, "wheelGrooves", 8);
    const groovePeriod = 100 / Math.max(wheelGrooves, 1); // % per groove
    const centerDist = Math.min(Math.abs(val - 50) / 50, 1); // 0 center → 1 edge
    return (
      <div
        ref={containerRef}
        className={`w-full h-[calc(100%-8px)] mx-auto my-1 relative rounded-md overflow-hidden ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{
          background:
            "linear-gradient(90deg, #0a0a0c 0%, #17171b 50%, #0a0a0c 100%)",
          boxShadow: `inset 0 ${wellDepth}px ${wellDepth * 2}px rgba(0,0,0,0.85), inset 0 -${wellDepth}px ${wellDepth * 2}px rgba(0,0,0,0.85), inset ${wellDepth}px 0 ${wellDepth}px rgba(0,0,0,0.6), inset -${wellDepth}px 0 ${wellDepth}px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.5)`,
        }}
      >
        <SliderTicks count={tickCount} />
        {/* center detent line on the well */}
        <div
          className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-0.5 pointer-events-none"
          style={{
            background: "var(--active-color)",
            opacity: 0.45,
            boxShadow: "0 0 3px var(--active-color)",
          }}
        />
        {/* cylindrical wheel with center-distance glow */}
        <div
          className="absolute left-1/2 w-[86%] h-[42%] rounded-md pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            background: `repeating-linear-gradient(180deg, rgba(0,0,0,0.55) 0, rgba(0,0,0,0.55) ${groovePeriod * 0.16}%, rgba(255,255,255,0.08) ${groovePeriod * 0.16}%, rgba(255,255,255,0.08) ${groovePeriod * 0.32}%, transparent ${groovePeriod * 0.32}%, transparent ${groovePeriod}%), linear-gradient(180deg, #17171c 0%, #3a3a44 15%, #6b6b78 50%, #3a3a44 85%, #17171c 100%)`,
            border: "1px solid rgba(0,0,0,0.7)",
            boxShadow: `0 2px 4px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.12), inset 0 -2px 3px rgba(0,0,0,0.5), 0 0 ${centerDist * 12}px color-mix(in srgb, var(--active-color) ${centerDist * 70}%, transparent)`,
          }}
        />
        {/* subtle top sheen inside the well */}
        <div
          className="absolute top-0 left-0 right-0 h-[16%] pointer-events-none"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 100%)",
          }}
        />
      </div>
    );
  }
  // Default (Standard) — also the catch-all for the palette variants that fall
  // through here (Modernism, Japandi, Bauhaus, Contemporary Luxury Minimalism).
  // Pixel-identity restore: before the param wave this branch had fixed geometry
  // (track max-w-6, cap w-[140%]/min-16px/h-4). The trackWidth/capWidth/capHeight
  // schema defaults (40/90/20) do NOT reproduce that look, so when the user has
  // set NONE of the three we render the exact legacy geometry; once ANY is set we
  // switch to the parameterized rendering.
  const usesLegacyGeometry =
    el.styleParams?.trackWidth === undefined &&
    el.styleParams?.capWidth === undefined &&
    el.styleParams?.capHeight === undefined;
  if (usesLegacyGeometry) {
    return (
      <div
        ref={containerRef}
        className={`w-full max-w-6 mx-auto h-[calc(100%-8px)] rounded-full border relative my-1 ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "rgba(0,0,0,0.5)",
        }}
      >
        <SliderTicks count={tickCount} />
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[140%] min-w-4 h-4 rounded shadow pointer-events-none"
          style={{
            bottom: `${val}%`,
            transform: "translate(-50%, 50%)",
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
    );
  }
  const trackWidth = styleParam(el, "trackWidth", 40);
  const capWidth = styleParam(el, "capWidth", 90);
  const capHeight = styleParam(el, "capHeight", 20);
  return (
    <div
      ref={containerRef}
      className={`w-full h-[calc(100%-8px)] mx-auto relative my-1 flex justify-center ${isPreview ? "cursor-ns-resize" : ""}`}
    >
      <SliderTicks count={tickCount} />
      {/* track */}
      <div
        className="h-full rounded-full border"
        style={{
          width: `${trackWidth}%`,
          backgroundColor: "var(--base-color)",
          borderColor: "rgba(0,0,0,0.5)",
        }}
      />
      {/* cap */}
      <div
        className="absolute left-1/2 min-w-4 rounded shadow pointer-events-none"
        style={{
          width: `${capWidth}%`,
          height: `${capHeight}px`,
          bottom: `${val}%`,
          transform: "translate(-50%, 50%)",
          backgroundColor: "var(--active-color)",
        }}
      />
    </div>
  );
}
